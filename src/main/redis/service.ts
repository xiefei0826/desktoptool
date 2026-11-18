import Redis from 'ioredis'
import type {
  DbConnection,
  RedisCommandResult,
  RedisConnectResult,
  RedisKeyInfo,
  RedisScanResult,
  RedisValueResult
} from '../../shared/types'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { ConfigStore } from '../store/config-store'
import type { LocalTunnel, TunnelService } from '../ssh/tunnel'

const VALUE_PREVIEW = 200

export class RedisService {
  private readonly clients = new Map<string, { client: Redis; tunnel?: LocalTunnel }>()

  constructor(
    private readonly config: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly tunnels: TunnelService
  ) {}

  async connect(connectionId: string): Promise<RedisConnectResult> {
    const client = await this.ensureClient(connectionId)
    return await this.describe(client, connectionId)
  }

  async test(connection: DbConnection, password: string): Promise<RedisConnectResult> {
    const { client, tunnel } = await this.openClient(connection, password)
    try {
      return await this.describe(client, connection.id)
    } finally {
      client.disconnect()
      tunnel?.close()
    }
  }

  async scan(
    connectionId: string,
    cursor: string,
    pattern: string,
    count: number
  ): Promise<RedisScanResult> {
    const client = await this.ensureClient(connectionId)
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      pattern || '*',
      'COUNT',
      Math.max(10, Math.min(1000, count))
    )

    const pipeline = client.pipeline()
    for (const key of keys) {
      pipeline.type(key)
      pipeline.ttl(key)
    }
    const replies = (await pipeline.exec()) ?? []

    const infos: RedisKeyInfo[] = keys.map((key, index) => {
      const typeReply = replies[index * 2]
      const ttlReply = replies[index * 2 + 1]
      return {
        key,
        type: String(typeReply?.[1] ?? 'unknown'),
        ttl: Number(ttlReply?.[1] ?? -1),
        size: 0
      }
    })

    return { cursor: next, keys: infos, scanned: infos.length }
  }

  async value(connectionId: string, key: string): Promise<RedisValueResult> {
    const client = await this.ensureClient(connectionId)
    const type = await client.type(key)
    const ttl = await client.ttl(key)
    let value: unknown = null
    let size = 0

    switch (type) {
      case 'string':
        value = await client.get(key)
        size = await client.strlen(key)
        break
      case 'hash':
        value = await client.hgetall(key)
        size = await client.hlen(key)
        break
      case 'list':
        value = await client.lrange(key, 0, VALUE_PREVIEW - 1)
        size = await client.llen(key)
        break
      case 'set':
        value = (await client.smembers(key)).slice(0, VALUE_PREVIEW)
        size = await client.scard(key)
        break
      case 'zset':
        value = await client.zrange(key, 0, VALUE_PREVIEW - 1, 'WITHSCORES')
        size = await client.zcard(key)
        break
      case 'stream':
        value = await client.xrange(key, '-', '+', 'COUNT', 20)
        size = 0
        break
      case 'none':
        value = null
        break
      default:
        value = `（暂不支持预览的类型：${type}）`
    }

    return { key, type, ttl, size, value }
  }

  /** 任意命令：支持带引号的参数，如 SET "a b" 1 */
  async command(connectionId: string, raw: string): Promise<RedisCommandResult> {
    const client = await this.ensureClient(connectionId)
    const tokens = tokenize(raw)
    if (tokens.length === 0) throw new Error('命令为空')

    const started = Date.now()
    const [command, ...args] = tokens
    const value = await client.call(command.toLowerCase(), ...(args as string[]))
    return {
      command: raw,
      type: typeof value,
      value,
      durationMs: Date.now() - started
    }
  }

  async remove(connectionId: string, keys: string[]): Promise<number> {
    if (keys.length === 0) return 0
    const client = await this.ensureClient(connectionId)
    return await client.del(...keys)
  }

  async setTtl(connectionId: string, key: string, ttl: number): Promise<void> {
    const client = await this.ensureClient(connectionId)
    if (ttl <= 0) await client.persist(key)
    else await client.expire(key, ttl)
  }

  async setString(connectionId: string, key: string, value: string): Promise<void> {
    const client = await this.ensureClient(connectionId)
    await client.set(key, value)
  }

  async switchDb(connectionId: string, index: number): Promise<RedisConnectResult> {
    const entry = this.clients.get(connectionId)
    if (entry) {
      this.clients.delete(connectionId)
      entry.client.disconnect()
      entry.tunnel?.close()
    }
    const connection = this.config.getDbConnection(connectionId)
    if (!connection) throw new Error('Redis 连接配置不存在')
    await this.config.saveDbConnection({ id: connectionId, dbIndex: index })
    const client = await this.ensureClient(connectionId)
    return await this.describe(client, connectionId)
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.clients.get(connectionId)
    if (!entry) return
    this.clients.delete(connectionId)
    entry.client.disconnect()
    entry.tunnel?.close()
  }

  async dispose(): Promise<void> {
    for (const connectionId of [...this.clients.keys()]) await this.disconnect(connectionId)
  }

  private async describe(client: Redis, connectionId: string): Promise<RedisConnectResult> {
    const info = await client.info('server')
    const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown'
    const mode = /redis_mode:([^\r\n]+)/.exec(info)?.[1] ?? 'standalone'

    let databases = 16
    try {
      const config = (await client.config('GET', 'databases')) as unknown as string[]
      databases = Number(config?.[1] ?? 16)
    } catch {
      /* 托管实例可能禁用 CONFIG */
    }

    const connection = this.config.getDbConnection(connectionId)
    return {
      version,
      mode,
      databases,
      currentDb: connection?.dbIndex ?? 0,
      keyCount: await client.dbsize()
    }
  }

  private async ensureClient(connectionId: string): Promise<Redis> {
    const existing = this.clients.get(connectionId)
    if (existing) return existing.client

    const connection = this.config.getDbConnection(connectionId)
    if (!connection) throw new Error('Redis 连接配置不存在')

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
  ): Promise<{ client: Redis; tunnel?: LocalTunnel }> {
    let host = connection.host
    let port = connection.port
    let tunnel: LocalTunnel | undefined

    if (connection.tunnelSessionId) {
      tunnel = await this.tunnels.open(connection.tunnelSessionId, connection.host, connection.port)
      host = tunnel.host
      port = tunnel.port
    }

    const client = new Redis({
      host,
      port,
      password: password || undefined,
      username: connection.username || undefined,
      db: connection.dbIndex ?? 0,
      tls: connection.ssl ? {} : undefined,
      // 自动连接：失败通过 error 事件 + ready promise 处理，避免 connect() 的未处理拒绝
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => (times > 2 ? null : 300)
    })

    client.on('error', () => {
      /* 避免未处理错误导致主进程崩溃 */
    })

    // lazyConnect + enableOfflineQueue=false 时 connect() 可能「乐观」resolve，
    // 必须等 ready 事件（或 error/超时）才能确认真的连上
    const ready = new Promise<void>((resolve, reject) => {
      if (client.status === 'ready') {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('连接超时'))
      }, 8000)
      const cleanup = () => {
        clearTimeout(timer)
        client.off('ready', onReady)
        client.off('error', onError)
      }
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      client.once('ready', onReady)
      client.once('error', onError)
    })

    try {
      await ready
      await client.ping()
      return { client, tunnel }
    } catch (error) {
      client.disconnect()
      tunnel?.close()
      throw new Error(friendlyRedisError(error))
    }
  }
}

function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote = ''
  let hasToken = false

  for (const char of raw.trim()) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken || current) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
  }
  if (hasToken || current) tokens.push(current)
  return tokens
}

function friendlyRedisError(error: unknown): string {
  // ioredis 重试失败时抛的是 AggregateError，message 为空，真实原因在 errors[] 里
  const parts: string[] = [error instanceof Error ? error.message : String(error)]
  const aggregate = (error as { errors?: unknown[] }).errors
  if (Array.isArray(aggregate)) {
    for (const item of aggregate) {
      const detail = item as { code?: string; message?: string } | null
      parts.push(`${detail?.code ?? ''} ${detail?.message ?? ''}`)
    }
  }

  const text = parts.filter(Boolean).join(' | ')
  if (/WRONGPASS|NOAUTH|invalid password/i.test(text)) return '认证失败：密码不正确'
  if (/ECONNREFUSED/i.test(text)) return '连接被拒绝：目标主机端口未监听'
  if (/ETIMEDOUT|timeout|连接超时/i.test(text)) return '连接超时'
  if (/ENOTFOUND/i.test(text)) return '无法解析主机名'
  if (/Connection is closed|Stream isn't writeable|ECONNRESET/i.test(text)) {
    return '连接已断开：请检查主机、端口与网络是否可达'
  }
  return text || 'Redis 连接失败'
}
