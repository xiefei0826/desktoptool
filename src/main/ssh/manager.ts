import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import type { BridgeEndpoint, SessionConfig, SshStatusEvent } from '../../shared/types'
import type { SshConnectInput, SshOpenShellOptions } from '../../shared/api'
import type { ConfigStore } from '../store/config-store'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { PortBridge } from '../bridge/port-bridge'
import type { ChannelRegistry } from '../channel-registry'

interface Connection {
  sessionId: string
  client: Client
  /** 包含跳板机链路在内的所有客户端，断开时一并关闭 */
  clients: Client[]
}

interface Secrets {
  password?: string
  passphrase?: string
}

/**
 * 说明：当前未实现 known_hosts 校验（TOFU），
 * 连接时不做主机指纹比对，生产使用建议后续补上。
 */
export class SshManager {
  private readonly conns = new Map<string, Connection>()
  private readonly sftpCache = new Map<string, Promise<SFTPWrapper>>()

  constructor(
    private readonly store: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly bridge: PortBridge,
    private readonly channels: ChannelRegistry,
    private readonly emitStatus: (event: SshStatusEvent) => void
  ) {}

  isConnected(sessionId: string): boolean {
    return this.conns.has(sessionId)
  }

  async connect(input: SshConnectInput): Promise<void> {
    const cfg = this.store.getSession(input.sessionId)
    if (!cfg) throw new Error('连接配置不存在')
    if (cfg.protocol !== 'ssh') throw new Error('该连接不是 SSH 协议')
    if (this.conns.has(cfg.id)) return

    this.emitStatus({ sessionId: cfg.id, status: 'connecting', message: '' })
    try {
      const built = await this.dialChain(cfg, { password: input.password, passphrase: input.passphrase }, true)
      const conn: Connection = { sessionId: cfg.id, client: built.client, clients: built.clients }
      this.conns.set(cfg.id, conn)
      this.watch(cfg.id, built.client)

      if (input.remember) {
        if (input.password) await this.credentials.set(credentialRef.password(cfg.id), input.password)
        if (input.passphrase) await this.credentials.set(credentialRef.passphrase(cfg.id), input.passphrase)
      }

      this.emitStatus({ sessionId: cfg.id, status: 'ready', message: '' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emitStatus({ sessionId: cfg.id, status: 'error', message })
      throw new Error(message)
    }
  }

  async ensureClient(sessionId: string): Promise<Client> {
    const existing = this.conns.get(sessionId)
    if (existing) return existing.client

    const cfg = this.store.getSession(sessionId)
    if (!cfg) throw new Error('连接配置不存在')
    if (cfg.protocol !== 'ssh') throw new Error('该操作需要 SSH 会话')

    const built = await this.dialChain(cfg, {}, false)
    this.conns.set(cfg.id, { sessionId: cfg.id, client: built.client, clients: built.clients })
    this.watch(cfg.id, built.client)
    this.emitStatus({ sessionId: cfg.id, status: 'ready', message: '' })
    return built.client
  }

  async disconnect(sessionId: string): Promise<void> {
    const conn = this.conns.get(sessionId)
    this.conns.delete(sessionId)
    this.sftpCache.delete(sessionId)
    this.channels.closeBySession(sessionId)
    if (!conn) return
    for (const client of conn.clients) {
      try {
        client.end()
      } catch {
        /* ignore */
      }
    }
    this.emitStatus({ sessionId, status: 'closed', message: '已断开' })
  }

  async openShell(options: SshOpenShellOptions): Promise<BridgeEndpoint> {
    const client = await this.ensureClient(options.sessionId)
    const cols = Math.max(20, options.cols)
    const rows = Math.max(5, options.rows)

    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: 'xterm-256color', cols, rows, width: cols * 8, height: rows * 18 },
        (error, channel) => {
          if (error) reject(error)
          else resolve(channel)
        }
      )
    })

    const channelId = randomUUID()

    this.bridge.create(channelId, {
      onData: (data) => stream.write(data),
      onResize: (nextCols, nextRows) => stream.setWindow(nextRows, nextCols, 0, 0),
      onClose: () => stream.close()
    })

    stream.on('data', (data: Buffer) => this.bridge.push(channelId, data))
    stream.stderr.on('data', (data: Buffer) => this.bridge.push(channelId, data))
    stream.on('close', () => {
      this.channels.remove(channelId)
      this.bridge.release(channelId, 'closed')
    })

    this.channels.add({
      id: channelId,
      kind: 'ssh',
      sessionId: options.sessionId,
      close: () => stream.close()
    })

    return { channelId }
  }

  async openTcp(sessionId: string, destHost: string, destPort: number): Promise<ClientChannel> {
    const client = await this.ensureClient(sessionId)
    return await new Promise<ClientChannel>((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, destHost, destPort, (error, channel) => {
        if (error) reject(error)
        else resolve(channel)
      })
    })
  }

  async sftp(sessionId: string): Promise<SFTPWrapper> {
    const cached = this.sftpCache.get(sessionId)
    if (cached) return cached

    const client = await this.ensureClient(sessionId)
    const pending = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) reject(error)
        else resolve(sftp)
      })
    })

    this.sftpCache.set(sessionId, pending)
    try {
      return await pending
    } catch (error) {
      this.sftpCache.delete(sessionId)
      throw error
    }
  }

  async closeAll(): Promise<void> {
    for (const sessionId of [...this.conns.keys()]) {
      await this.disconnect(sessionId)
    }
  }

  private watch(sessionId: string, client: Client): void {
    const cleanup = (): void => {
      if (this.conns.get(sessionId)?.client !== client) return
      this.conns.delete(sessionId)
      this.sftpCache.delete(sessionId)
      this.channels.closeBySession(sessionId)
      this.emitStatus({ sessionId, status: 'closed', message: '连接已关闭' })
    }

    client.on('close', cleanup)
    client.on('end', cleanup)
    client.on('error', (error) => {
      if (this.conns.get(sessionId)?.client !== client) return
      this.emitStatus({ sessionId, status: 'error', message: error.message })
    })
  }

  /** 组装跳板机链路：[jump1, jump2, target] */
  private buildChain(cfg: SessionConfig): SessionConfig[] {
    const chain: SessionConfig[] = []
    const seen = new Set<string>([cfg.id])
    let cursor = cfg.tunnelSessionId ? this.store.getSession(cfg.tunnelSessionId) : undefined

    while (cursor) {
      if (seen.has(cursor.id)) throw new Error('隧道链路存在循环引用，请检查跳板机配置')
      seen.add(cursor.id)
      chain.unshift(cursor)
      if (chain.length > 4) throw new Error('跳板机链路最多支持 5 跳')
      cursor = cursor.tunnelSessionId ? this.store.getSession(cursor.tunnelSessionId) : undefined
    }

    chain.push(cfg)
    return chain
  }

  private async dialChain(
    cfg: SessionConfig,
    secrets: Secrets,
    interactive: boolean
  ): Promise<{ client: Client; clients: Client[] }> {
    const hops = this.buildChain(cfg)
    const clients: Client[] = []
    let sock: Duplex | undefined

    for (let index = 0; index < hops.length; index += 1) {
      const hop = hops[index]
      const isTarget = index === hops.length - 1
      const client = new Client()
      clients.push(client)

      try {
        await this.dial(client, hop, sock, secrets, interactive && isTarget)
      } catch (error) {
        for (const opened of clients) {
          try {
            opened.end()
          } catch {
            /* ignore */
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(isTarget ? message : `跳板机 ${hop.name} 连接失败：${message}`)
      }

      const next = hops[index + 1]
      if (next) {
        const nextPort = next.port || 22
        sock = await new Promise<Duplex>((resolve, reject) => {
          client.forwardOut('127.0.0.1', 0, next.host, nextPort, (error, channel) => {
            if (error) reject(new Error(`无法通过 ${hop.name} 转发到 ${next.host}:${nextPort}`))
            else resolve(channel)
          })
        })
      }
    }

    return { client: clients[clients.length - 1], clients }
  }

  private async dial(
    client: Client,
    cfg: SessionConfig,
    sock: Duplex | undefined,
    secrets: Secrets,
    interactive: boolean
  ): Promise<void> {
    let password = secrets.password
    let passphrase = secrets.passphrase

    if (password === undefined) password = await this.credentials.get(credentialRef.password(cfg.id))
    if (passphrase === undefined) passphrase = await this.credentials.get(credentialRef.passphrase(cfg.id))

    let privateKey: Buffer | undefined
    if (cfg.authType === 'privateKey') {
      if (!cfg.privateKeyPath) throw new Error('未配置私钥文件路径')
      try {
        privateKey = await readFile(cfg.privateKeyPath)
      } catch {
        throw new Error(`私钥文件无法读取：${cfg.privateKeyPath}`)
      }
    } else if (!password && interactive) {
      throw new Error(`AUTH_REQUIRED::${cfg.id}::请输入 ${cfg.username}@${cfg.host} 的登录密码`)
    } else if (!password) {
      throw new Error(`未保存 ${cfg.name} 的密码，请先手动连接并勾选"记住密码"`)
    }

    const config: ConnectConfig = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      password: cfg.authType === 'password' ? password : undefined,
      privateKey,
      passphrase,
      tryKeyboard: true,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      sock
    }

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        client.removeListener('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        client.removeListener('ready', onReady)
        reject(new Error(friendlyError(error, cfg)))
      }
      client.once('ready', onReady)
      client.once('error', onError)
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password ?? ''))
      })
      client.connect(config)
    })
  }
}

function friendlyError(error: Error, cfg: SessionConfig): string {
  const raw = error.message || String(error)
  if (/All configured authentication methods failed/i.test(raw)) {
    return `认证失败：请检查用户名、密码或私钥（${cfg.username}@${cfg.host}:${cfg.port}）`
  }
  if (/ECONNREFUSED/i.test(raw)) return `连接被拒绝：${cfg.host}:${cfg.port} 未监听 SSH 服务`
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `无法解析主机：${cfg.host}`
  if (/Timed out while waiting|ETIMEDOUT/i.test(raw)) return `连接超时：${cfg.host}:${cfg.port}`
  if (/Cannot parse privateKey|bad passphrase|Encrypted private key/i.test(raw)) {
    return '私钥无法解析，或私钥口令不正确'
  }
  return raw
}
