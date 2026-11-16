import { randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { BridgeEndpoint, SessionConfig } from '../../shared/types'
import type { StreamBridge } from '../bridge/stream-bridge'
import type { ChannelRegistry } from '../channel-registry'
import type { SshManager } from '../ssh/manager'

/**
 * 内置 VNC：把 RFB 的原始 TCP 字节流灌进 StreamBridge，
 * 渲染进程用 noVNC 直接消费，协议握手/密码协商全部由 noVNC 处理。
 */
export class VncService {
  constructor(
    private readonly bridge: StreamBridge,
    private readonly channels: ChannelRegistry,
    private readonly ssh: SshManager
  ) {}

  async open(session: SessionConfig): Promise<BridgeEndpoint> {
    const host = session.host
    const port = session.port || 5900
    const channelId = randomUUID()

    // 只在真正需要 VNC 时监听本地 WS 端口
    await this.bridge.ensureStarted()

    let socket: Duplex
    if (session.tunnelSessionId) {
      socket = await this.ssh.openTcp(session.tunnelSessionId, host, port)
    } else {
      socket = net.connect({ host, port })
    }

    this.bridge.bind(channelId, {
      onData: (data) => socket.write(data),
      onClose: () => socket.destroy()
    })

    socket.on('data', (data: Buffer) => this.bridge.push(channelId, data))
    socket.on('error', () => {
      this.channels.remove(channelId)
      this.bridge.release(channelId, 'vnc-error')
    })
    socket.on('close', () => {
      this.channels.remove(channelId)
      this.bridge.release(channelId, 'vnc-closed')
    })

    this.channels.add({
      id: channelId,
      kind: 'vnc',
      sessionId: session.id,
      close: () => socket.destroy()
    })

    return { channelId, url: this.bridge.endpoint(channelId) }
  }
}
