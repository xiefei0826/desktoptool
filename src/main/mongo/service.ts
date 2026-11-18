import { MongoClient, ObjectId } from 'mongodb'
import type {
  DbConnection,
  MongoCollectionInfo,
  MongoConnectResult,
  MongoFindRequest,
  MongoFindResult
} from '../../shared/types'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { ConfigStore } from '../store/config-store'
import type { LocalTunnel, TunnelService } from '../ssh/tunnel'

export class MongoService {
  private readonly clients = new Map<string, { client: MongoClient; tunnel?: LocalTunnel }>()

  constructor(
    private readonly config: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly tunnels: TunnelService
  ) {}

  async connect(connectionId: string): Promise<MongoConnectResult> {
    const client = await this.ensureClient(connectionId)
    return await this.describe(client)
  }

  async test(connection: DbConnection, password: string): Promise<MongoConnectResult> {
    const { client, tunnel } = await this.openClient(connection, password)
    try {
      return await this.describe(client)
    } finally {
      await client.close().catch(() => undefined)
      tunnel?.close()
    }
  }

  async collections(connectionId: string, database: string): Promise<MongoCollectionInfo[]> {
    const client = await this.ensureClient(connectionId)
    const db = client.db(database)
    const infos = await db.listCollections().toArray()
    const result: MongoCollectionInfo[] = []
    for (const info of infos) {
      if (info.type && info.type !== 'collection' && info.type !== 'view') continue
      let count = 0
      try {
        count = await db.collection(info.name).estimatedDocumentCount()
      } catch {
        count = 0
      }
      result.push({ name: info.name, count })
    }
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  async find(request: MongoFindRequest): Promise<MongoFindResult> {
    const client = await this.ensureClient(request.connectionId)
    const collection = client.db(request.database).collection(request.collection)

    const filter = parseJsonObject(request.filter, '过滤条件')
    const sort = parseJsonObject(request.sort, '排序')
    const limit = Math.max(1, Math.min(500, request.limit || 50))
    const skip = Math.max(0, request.skip || 0)

    const started = Date.now()
    const cursor = collection.find(filter).skip(skip).limit(limit)
    if (Object.keys(sort).length > 0) cursor.sort(sort as Record<string, 1 | -1>)
    const documents = await cursor.toArray()
    const matched = await collection.countDocuments(filter)

    return {
      documents: toPlain(documents) as unknown[],
      matched,
      durationMs: Date.now() - started
    }
  }

  async deleteOne(
    connectionId: string,
    database: string,
    collection: string,
    documentId: string
  ): Promise<boolean> {
    const client = await this.ensureClient(connectionId)
    const filter = /^[0-9a-fA-F]{24}$/.test(documentId)
      ? { _id: new ObjectId(documentId) }
      : { _id: documentId as unknown as ObjectId }
    const result = await client.db(database).collection(collection).deleteOne(filter)
    return result.deletedCount === 1
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.clients.get(connectionId)
    if (!entry) return
    this.clients.delete(connectionId)
    await entry.client.close().catch(() => undefined)
    entry.tunnel?.close()
  }

  async dispose(): Promise<void> {
    for (const connectionId of [...this.clients.keys()]) await this.disconnect(connectionId)
  }

  private async describe(client: MongoClient): Promise<MongoConnectResult> {
    const admin = client.db().admin()
    const info = await admin.serverInfo()
    const list = await admin.listDatabases()
    return {
      version: info.version ?? 'unknown',
      databases: list.databases
        .filter((item) => !['admin', 'local', 'config'].includes(item.name))
        .map((item) => ({ name: item.name, sizeOnDisk: item.sizeOnDisk ?? 0 }))
    }
  }

  private async ensureClient(connectionId: string): Promise<MongoClient> {
    const existing = this.clients.get(connectionId)
    if (existing) return existing.client

    const connection = this.config.getDbConnection(connectionId)
    if (!connection) throw new Error('MongoDB 连接配置不存在')

    const password = (await this.credentials.get(credentialRef.dbPassword(connectionId))) ?? ''
    if (!password && connection.username) {
      throw new Error(`连接「${connection.name}」未保存密码，请编辑连接补充密码`)
    }

    const { client, tunnel } = await this.openClient(connection, password)
    this.clients.set(connectionId, { client, tunnel })
    await this.config.touchDbConnection(connectionId)
    return client
  }

  private async openClient(
    connection: DbConnection,
    password: string
  ): Promise<{ client: MongoClient; tunnel?: LocalTunnel }> {
    let host = connection.host
    let port = connection.port
    let tunnel: LocalTunnel | undefined

    if (connection.tunnelSessionId) {
      tunnel = await this.tunnels.open(connection.tunnelSessionId, connection.host, connection.port)
      host = tunnel.host
      port = tunnel.port
    }

    const auth = connection.username
      ? `${encodeURIComponent(connection.username)}:${encodeURIComponent(password)}@`
      : ''
    const authSource = connection.authSource || 'admin'
    const options = [
      `authSource=${encodeURIComponent(authSource)}`,
      'directConnection=true',
      'serverSelectionTimeoutMS=8000'
    ]
    const uri = `mongodb://${auth}${host}:${port}/?${options.join('&')}`

    const client = new MongoClient(uri, { connectTimeoutMS: 8000 })
    try {
      await client.connect()
      await client.db().command({ ping: 1 })
      return { client, tunnel }
    } catch (error) {
      await client.close().catch(() => undefined)
      tunnel?.close()
      throw new Error(friendlyMongoError(error))
    }
  }
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    const value = JSON.parse(trimmed) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label}必须是 JSON 对象`)
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(`${label}解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function toPlain(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (item && typeof item === 'object' && typeof item.toHexString === 'function') {
        return item.toHexString()
      }
      return item
    })
  ) as unknown
}

function friendlyMongoError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/Authentication failed/i.test(raw)) return '认证失败：用户名或密码不正确'
  if (/ECONNREFUSED/i.test(raw)) return '连接被拒绝：目标主机端口未监听'
  if (/Server selection timed out|ETIMEDOUT/i.test(raw)) return '连接超时'
  if (/ENOTFOUND/i.test(raw)) return '无法解析主机名'
  return raw
}
