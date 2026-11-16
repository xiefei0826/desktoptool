import type { LaunchResult, RdClientInfo } from '../../shared/types'
import type { ConfigStore } from '../store/config-store'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { TunnelService } from '../ssh/tunnel'
import { detectWindowsClients, launchWindowsRdp } from './windows'
import { detectMacClients, launchMacRdp, launchMacVnc } from './macos'
import { detectLinuxClients, launchLinuxRdp, launchLinuxVnc } from './linux'
import type { RdpTarget } from './rdp-file'

export class RemoteDesktopService {
  constructor(
    private readonly store: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly tunnels: TunnelService
  ) {}

  async detect(): Promise<RdClientInfo[]> {
    const builtinVnc: RdClientInfo = {
      kind: 'vnc',
      id: 'builtin',
      label: '内置 VNC (noVNC)',
      available: true,
      detail: '应用内嵌，支持剪贴板与缩放'
    }

    if (process.platform === 'win32') {
      return [...detectWindowsClients(), builtinVnc]
    }
    if (process.platform === 'darwin') {
      return [...(await detectMacClients()), builtinVnc]
    }
    if (process.platform === 'linux') {
      return [...(await detectLinuxClients()), builtinVnc]
    }
    return [builtinVnc]
  }

  async launch(sessionId: string): Promise<LaunchResult> {
    const session = this.store.getSession(sessionId)
    if (!session) throw new Error('连接配置不存在')

    let target: RdpTarget = {
      host: session.host,
      port: session.port || (session.protocol === 'rdp' ? 3389 : 5900)
    }

    if (session.tunnelSessionId) {
      const tunnel = await this.tunnels.open(session.tunnelSessionId, target.host, target.port)
      target = { host: tunnel.host, port: tunnel.port }
    }

    const password = (await this.credentials.get(credentialRef.password(session.id))) ?? ''

    if (session.protocol === 'rdp') {
      if (process.platform === 'win32') return launchWindowsRdp(session, target, password)
      if (process.platform === 'darwin') return launchMacRdp(session, target)
      if (process.platform === 'linux') return launchLinuxRdp(session, target, password)
      throw new Error(`当前系统（${process.platform}）暂不支持拉起 RDP 客户端`)
    }

    if (session.protocol === 'vnc') {
      if (process.platform === 'darwin') return launchMacVnc(target.host, target.port, session.username)
      if (process.platform === 'linux') return launchLinuxVnc(target.host, target.port, password)
      return {
        ok: false,
        client: 'none',
        message: 'Windows 未内置 VNC 客户端，请使用应用内的 VNC 视图',
        command: `vnc://${target.host}:${target.port}`
      }
    }

    throw new Error('SSH 连接请直接在终端中打开')
  }
}
