import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { SshManager } from './manager'

export interface LocalTunnel {
  host: string
  port: number
  close: () => void
}

/**
 * 一次性本地隧道：RDP / VNC / 远程桌面客户端 → 127.0.0.1:port → SSH → 目标主机。
 */
export class TunnelService {
  private readonly tunnels = new Set<LocalTunnel>()

  constructor(private readonly ssh: SshManager) {}

  async open(viaSessionId: string, destHost: string, destPort: number): Promise<LocalTunnel> {
    const server = net.createServer((socket) => {
      this.ssh
        .openTcp(viaSessionId, destHost, destPort)
        .then((channel) => {
          socket.pipe(channel).pipe(socket)
          channel.on('close', () => socket.destroy())
          channel.on('error', () => socket.destroy())
          socket.on('error', () => channel.destroy())
        })
        .catch(() => socket.destroy())
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as AddressInfo
    const tunnel: LocalTunnel = {
      host: '127.0.0.1',
      port: address.port,
      close: () => {
        this.tunnels.delete(tunnel)
        server.close()
      }
    }
    this.tunnels.add(tunnel)
    return tunnel
  }

  closeAll(): void {
    for (const tunnel of [...this.tunnels]) tunnel.close()
  }
}
