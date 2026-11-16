import net from 'node:net'
import type { Socket } from 'node:net'
import type { ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { ForwardRule, ForwardState } from '../../shared/types'
import type { ConfigStore } from '../store/config-store'
import type { SshManager } from './manager'

interface RunningForward {
  rule: ForwardRule
  connections: number
  startedAt: number
  close: () => void
}

function listen(server: net.Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      server.on('error', () => {
        /* 运行期错误忽略，避免进程崩溃 */
      })
      resolve()
    })
  })
}

function parseSocksRequest(buffer: Buffer): { host: string; port: number; rest: Buffer } | null {
  if (buffer.length < 4) return null
  if (buffer[0] !== 0x05 || buffer[1] !== 0x01) return null

  let offset = 4
  let host = ''
  const atyp = buffer[3]

  if (atyp === 0x01) {
    if (buffer.length < offset + 6) return null
    host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`
    offset += 4
  } else if (atyp === 0x03) {
    if (buffer.length < offset + 1) return null
    const length = buffer[offset]
    if (buffer.length < offset + 1 + length + 2) return null
    host = buffer.subarray(offset + 1, offset + 1 + length).toString('utf8')
    offset += 1 + length
  } else if (atyp === 0x04) {
    if (buffer.length < offset + 18) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16))
    host = parts.join(':')
    offset += 16
  } else {
    return null
  }

  const port = buffer.readUInt16BE(offset)
  return { host, port, rest: buffer.subarray(offset + 2) }
}

export class ForwardService {
  private readonly running = new Map<string, RunningForward>()
  private readonly failures = new Map<string, string>()

  constructor(
    private readonly ssh: SshManager,
    private readonly store: ConfigStore,
    private readonly emit: (state: ForwardState) => void
  ) {}

  list(): ForwardState[] {
    return this.store.getForwards().map((rule) => this.stateOf(rule))
  }

  stateOf(rule: ForwardRule): ForwardState {
    const running = this.running.get(rule.id)
    if (running) {
      return {
        ruleId: rule.id,
        status: 'running',
        message: '',
        connections: running.connections,
        startedAt: running.startedAt
      }
    }
    const failure = this.failures.get(rule.id)
    return {
      ruleId: rule.id,
      status: failure ? 'error' : 'stopped',
      message: failure ?? '',
      connections: 0,
      startedAt: null
    }
  }

  async start(ruleId: string): Promise<ForwardState> {
    const rule = this.store.getForward(ruleId)
    if (!rule) throw new Error('转发规则不存在')
    if (this.running.has(ruleId)) return this.stateOf(rule)

    this.failures.delete(ruleId)
    this.emit({ ruleId, status: 'starting', message: '', connections: 0, startedAt: null })

    try {
      await this.ssh.ensureClient(rule.sessionId)
      if (rule.type === 'local') await this.startLocal(rule)
      else if (rule.type === 'remote') await this.startRemote(rule)
      else await this.startDynamic(rule)

      const state = this.stateOf(rule)
      this.emit(state)
      return state
    } catch (error) {
      const message = (error as Error).message
      this.failures.set(ruleId, message)
      const state = this.stateOf(rule)
      this.emit(state)
      throw new Error(message)
    }
  }

  async stop(ruleId: string): Promise<ForwardState> {
    const running = this.running.get(ruleId)
    if (running) {
      this.running.delete(ruleId)
      try {
        running.close()
      } catch {
        /* ignore */
      }
    }
    this.failures.delete(ruleId)
    const rule = this.store.getForward(ruleId)
    const state: ForwardState = {
      ruleId,
      status: 'stopped',
      message: '',
      connections: 0,
      startedAt: null
    }
    this.emit(state)
    return rule ? this.stateOf(rule) : state
  }

  async stopBySession(sessionId: string): Promise<void> {
    for (const [ruleId, running] of [...this.running.entries()]) {
      if (running.rule.sessionId === sessionId) await this.stop(ruleId)
    }
  }

  async stopAll(): Promise<void> {
    for (const ruleId of [...this.running.keys()]) await this.stop(ruleId)
  }

  async startAutoRules(): Promise<void> {
    for (const rule of this.store.getForwards()) {
      if (!rule.autoStart) continue
      try {
        await this.start(rule.id)
      } catch {
        /* 自动启动失败不阻塞其他规则 */
      }
    }
  }

  private async startLocal(rule: ForwardRule): Promise<void> {
    const sockets = new Set<Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))

      const entry = this.running.get(rule.id)
      if (entry) entry.connections += 1

      this.ssh
        .openTcp(rule.sessionId, rule.destHost, rule.destPort)
        .then((channel) => {
          socket.pipe(channel).pipe(socket)
          channel.on('close', () => socket.destroy())
          channel.on('error', () => socket.destroy())
          socket.on('error', () => channel.destroy())
        })
        .catch(() => socket.destroy())
    })

    await listen(server, rule.bindHost, rule.bindPort)

    this.running.set(rule.id, {
      rule,
      connections: 0,
      startedAt: Date.now(),
      close: () => {
        for (const socket of sockets) socket.destroy()
        server.close()
      }
    })
  }

  private async startRemote(rule: ForwardRule): Promise<void> {
    const client = await this.ssh.ensureClient(rule.sessionId)

    await new Promise<void>((resolve, reject) => {
      client.forwardIn(rule.bindHost, rule.bindPort, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })

    const sockets = new Set<Socket>()
    const onTcpConnection = (details: TcpConnectionDetails, accept: () => ClientChannel): void => {
      const channel = accept()
      const connectHost = rule.destHost || details.destIP
      const connectPort = rule.destPort || details.destPort
      const socket = net.connect(connectPort, connectHost)
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.pipe(channel).pipe(socket)
      socket.on('error', () => channel.destroy())
      channel.on('close', () => socket.destroy())
    }

    client.on('tcp connection', onTcpConnection)

    this.running.set(rule.id, {
      rule,
      connections: 0,
      startedAt: Date.now(),
      close: () => {
        client.removeListener('tcp connection', onTcpConnection)
        for (const socket of sockets) socket.destroy()
        try {
          client.unforwardIn(rule.bindHost, rule.bindPort, () => {
            /* ignore */
          })
        } catch {
          /* ignore */
        }
      }
    })
  }

  private async startDynamic(rule: ForwardRule): Promise<void> {
    const sockets = new Set<Socket>()

    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))

      let buffer: Buffer = Buffer.alloc(0)
      let stage: 'greeting' | 'request' | 'piping' = 'greeting'

      const onData = (chunk: Buffer): void => {
        if (stage === 'piping') return
        buffer = Buffer.concat([buffer, chunk])

        if (stage === 'greeting') {
          if (buffer.length < 2) return
          if (buffer[0] !== 0x05) {
            socket.destroy()
            return
          }
          const methods = buffer[1]
          if (buffer.length < 2 + methods) return
          buffer = buffer.subarray(2 + methods)
          socket.write(Buffer.from([0x05, 0x00]))
          stage = 'request'
        }

        if (stage !== 'request') return
        const request = parseSocksRequest(buffer)
        if (!request) {
          if (buffer.length > 512) socket.destroy()
          return
        }

        buffer = request.rest
        stage = 'piping'
        socket.removeListener('data', onData)

        const entry = this.running.get(rule.id)
        if (entry) entry.connections += 1

        this.ssh
          .openTcp(rule.sessionId, request.host, request.port)
          .then((channel) => {
            socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
            if (buffer.length > 0) channel.write(buffer)
            buffer = Buffer.alloc(0)
            socket.pipe(channel).pipe(socket)
            channel.on('close', () => socket.destroy())
            channel.on('error', () => socket.destroy())
            socket.on('error', () => channel.destroy())
          })
          .catch(() => {
            try {
              socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))
            } catch {
              /* ignore */
            }
          })
      }

      socket.on('data', onData)
      socket.on('error', () => socket.destroy())
    })

    await listen(server, rule.bindHost, rule.bindPort)

    this.running.set(rule.id, {
      rule,
      connections: 0,
      startedAt: Date.now(),
      close: () => {
        for (const socket of sockets) socket.destroy()
        server.close()
      }
    })
  }
}
