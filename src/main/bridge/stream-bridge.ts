import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

export interface ChannelHooks {
  onData: (data: Buffer) => void
  onResize?: (cols: number, rows: number) => void
  onClose?: (reason: string) => void
}

const MAX_BACKLOG = 512 * 1024

/**
 * 仅内置 VNC 使用的 WebSocket 桥：noVNC 只支持 WebSocket 传输，无法走 MessagePort。
 *
 * 采用懒启动：只有真正打开 VNC 时才监听一个 127.0.0.1 随机端口，
 * 最后一个 VNC 通道关闭后立即关闭监听 —— 平时运行应用不占任何端口。
 */
export class StreamBridge {
  private wss: WebSocketServer | null = null
  private readonly token = randomUUID()
  private readonly sockets = new Map<string, WebSocket>()
  private readonly hooks = new Map<string, ChannelHooks>()
  private readonly backlog = new Map<string, Buffer[]>()
  private readonly backlogSize = new Map<string, number>()
  private port = 0

  get running(): boolean {
    return this.wss !== null
  }

  /** 懒启动：首次打开 VNC 时调用 */
  async ensureStarted(): Promise<void> {
    if (this.wss) return
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    this.wss = wss

    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve())
      wss.once('error', (err) => reject(err))
    })

    this.port = (wss.address() as AddressInfo).port
    wss.on('connection', (ws, req) => this.handleConnection(ws, req.url ?? '/'))
  }

  async stop(): Promise<void> {
    for (const id of [...this.sockets.keys()]) this.release(id, 'app-quit')
    this.sockets.clear()
    this.hooks.clear()
    this.backlog.clear()
    this.backlogSize.clear()
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve()
      this.wss.close(() => resolve())
    })
    this.wss = null
  }

  endpoint(channelId: string): string {
    return `ws://127.0.0.1:${this.port}/stream?id=${channelId}&token=${this.token}`
  }

  /** 没有活跃通道时关闭监听，避免常驻端口 */
  private maybeStop(): void {
    if (this.sockets.size > 0 || this.hooks.size > 0) return
    const wss = this.wss
    if (!wss) return
    this.wss = null
    this.port = 0
    this.backlog.clear()
    this.backlogSize.clear()
    try {
      wss.close()
    } catch {
      /* ignore */
    }
  }

  bind(channelId: string, hooks: ChannelHooks): void {
    this.hooks.set(channelId, hooks)
  }

  push(channelId: string, data: Buffer): void {
    const socket = this.sockets.get(channelId)
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data, { binary: true })
      return
    }
    const queue = this.backlog.get(channelId) ?? []
    queue.push(data)
    let size = (this.backlogSize.get(channelId) ?? 0) + data.length
    while (size > MAX_BACKLOG && queue.length > 1) {
      const dropped = queue.shift()
      size -= dropped?.length ?? 0
    }
    this.backlog.set(channelId, queue)
    this.backlogSize.set(channelId, size)
  }

  release(channelId: string, reason = 'closed'): void {
    const socket = this.sockets.get(channelId)
    this.sockets.delete(channelId)
    this.hooks.delete(channelId)
    this.backlog.delete(channelId)
    this.backlogSize.delete(channelId)
    if (socket && socket.readyState <= WebSocket.OPEN) {
      try {
        socket.close(1000, reason)
      } catch {
        /* ignore */
      }
    }
    this.maybeStop()
  }

  private flushBacklog(channelId: string, socket: WebSocket): void {
    const queue = this.backlog.get(channelId)
    if (!queue) return
    for (const chunk of queue) {
      if (socket.readyState !== WebSocket.OPEN) break
      socket.send(chunk, { binary: true })
    }
    this.backlog.delete(channelId)
    this.backlogSize.delete(channelId)
  }

  private handleConnection(ws: WebSocket, rawUrl: string): void {
    const url = new URL(rawUrl, `http://127.0.0.1:${this.port}`)
    const channelId = url.searchParams.get('id') ?? ''

    if (url.searchParams.get('token') !== this.token) {
      ws.close(4401, 'unauthorized')
      return
    }

    const hooks = this.hooks.get(channelId)
    if (!hooks) {
      ws.close(4404, 'no-channel')
      return
    }

    this.sockets.set(channelId, ws)
    this.flushBacklog(channelId, ws)

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        hooks.onData(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))
        return
      }
      try {
        const msg = JSON.parse(String(raw)) as { t?: string; cols?: number; rows?: number }
        if (msg.t === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          hooks.onResize?.(msg.cols, msg.rows)
        }
      } catch {
        /* 忽略非法控制帧 */
      }
    })

    ws.on('close', () => {
      this.sockets.delete(channelId)
      hooks.onClose?.('renderer-disconnected')
    })

    ws.on('error', () => {
      /* 交给 close 事件处理 */
    })
  }
}
