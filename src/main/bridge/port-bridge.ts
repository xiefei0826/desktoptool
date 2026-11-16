import { MessageChannelMain } from 'electron'
import type { MessagePortMain, WebContents } from 'electron'

export interface ChannelHooks {
  onData: (data: Buffer) => void
  onResize?: (cols: number, rows: number) => void
  onClose?: (reason: string) => void
}

const MAX_BACKLOG = 512 * 1024

/**
 * 终端 / 本机 PTY 的数据通道。
 *
 * 用 Electron 原生 MessagePort 直接把数据从主进程转移到渲染进程，
 * 不监听任何 TCP 端口（对比 WebSocket 方案的优势）。
 *
 * 渲染进程 attach 之前产生的输出先进 backlog，attach 后按序刷出，
 * 避免丢掉 SSH banner / shell 首屏。
 */
export class PortBridge {
  private readonly ports = new Map<string, MessagePortMain>()
  private readonly hooks = new Map<string, ChannelHooks>()
  private readonly backlog = new Map<string, Buffer[]>()
  private readonly backlogSize = new Map<string, number>()

  create(channelId: string, hooks: ChannelHooks): void {
    this.hooks.set(channelId, hooks)
  }

  /** 由 IPC 处理器调用：把 port2 交给渲染进程，之后双向通信 */
  attach(channelId: string, target: WebContents): boolean {
    const hooks = this.hooks.get(channelId)
    if (!hooks) return false
    if (this.ports.has(channelId)) return true
    if (target.isDestroyed()) return false

    const { port1, port2 } = new MessageChannelMain()
    this.ports.set(channelId, port1)

    port1.on('message', (event) => {
      const data: unknown = event.data

      if (typeof data === 'string') {
        try {
          const message = JSON.parse(data) as { t?: string; cols?: number; rows?: number }
          if (
            message.t === 'resize' &&
            typeof message.cols === 'number' &&
            typeof message.rows === 'number'
          ) {
            hooks.onResize?.(message.cols, message.rows)
          }
        } catch {
          /* 忽略非法控制帧 */
        }
        return
      }

      if (ArrayBuffer.isView(data)) {
        hooks.onData(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      } else if (data instanceof ArrayBuffer) {
        hooks.onData(Buffer.from(data))
      }
    })
    port1.start()

    target.postMessage('stream:port', { channelId }, [port2])
    this.flush(channelId)
    return true
  }

  push(channelId: string, data: Buffer): void {
    const port = this.ports.get(channelId)
    if (port) {
      port.postMessage(new Uint8Array(data))
      return
    }

    const queue = this.backlog.get(channelId) ?? []
    queue.push(data)
    let size = (this.backlogSize.get(channelId) ?? 0) + data.length
    while (size > MAX_BACKLOG && queue.length > 1) {
      size -= queue.shift()?.length ?? 0
    }
    this.backlog.set(channelId, queue)
    this.backlogSize.set(channelId, size)
  }

  release(channelId: string, reason = 'closed'): void {
    const port = this.ports.get(channelId)
    if (port) {
      try {
        port.postMessage(JSON.stringify({ t: 'close', reason }))
      } catch {
        /* 通道可能已断开 */
      }
      try {
        port.close()
      } catch {
        /* ignore */
      }
    }
    this.ports.delete(channelId)
    this.hooks.delete(channelId)
    this.backlog.delete(channelId)
    this.backlogSize.delete(channelId)
  }

  closeAll(): void {
    for (const channelId of [...this.ports.keys()]) this.release(channelId, 'app-quit')
  }

  get activeCount(): number {
    return this.ports.size
  }

  private flush(channelId: string): void {
    const port = this.ports.get(channelId)
    const queue = this.backlog.get(channelId)
    if (!port || !queue) return
    for (const chunk of queue) port.postMessage(new Uint8Array(chunk))
    this.backlog.delete(channelId)
    this.backlogSize.delete(channelId)
  }
}
