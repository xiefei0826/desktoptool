import { app } from 'electron'
import path from 'node:path'
import type { ForwardState, SftpProgress, SshStatusEvent } from '../shared/types'
import { PortBridge } from './bridge/port-bridge'
import { StreamBridge } from './bridge/stream-bridge'
import { ChannelRegistry } from './channel-registry'
import { ConfigStore } from './store/config-store'
import { CredentialStore } from './store/credential-store'
import { SshManager } from './ssh/manager'
import { SftpService } from './ssh/sftp'
import { ForwardService } from './ssh/forward'
import { TunnelService } from './ssh/tunnel'
import { RemoteDesktopService } from './remote-desktop'
import { VncService } from './vnc/service'
import { LocalTerminalService } from './pty/local-terminal'
import { K8sService } from './k8s/service'
import { DbService } from './db/service'
import { RedisService } from './redis/service'
import { MongoService } from './mongo/service'

export class AppServices {
  readonly channels = new ChannelRegistry()
  /** 终端 / 本机 PTY：MessagePort，不占端口 */
  readonly ports = new PortBridge()
  /** 内置 VNC：noVNC 只支持 WebSocket，懒启动、用完即关 */
  readonly vncBridge = new StreamBridge()

  config!: ConfigStore
  credentials!: CredentialStore
  ssh!: SshManager
  sftp!: SftpService
  forward!: ForwardService
  tunnels!: TunnelService
  rd!: RemoteDesktopService
  vnc!: VncService
  pty!: LocalTerminalService
  k8s!: K8sService
  db!: DbService
  redis!: RedisService
  mongo!: MongoService

  private initialized = false

  constructor(private readonly send: (channel: string, payload: unknown) => void) {}

  get userDataPath(): string {
    return app.getPath('userData')
  }

  async init(): Promise<void> {
    if (this.initialized) return

    const userData = this.userDataPath
    this.config = await ConfigStore.load(path.join(userData, 'config.json'))
    this.credentials = await CredentialStore.load(path.join(userData, 'credentials.json'))

    this.ssh = new SshManager(this.config, this.credentials, this.ports, this.channels, (event) => {
      this.emitSshStatus(event)
    })
    this.sftp = new SftpService(this.ssh, (progress) => this.sendProgress(progress))
    this.forward = new ForwardService(this.ssh, this.config, (state) => this.emitForwardState(state))
    this.tunnels = new TunnelService(this.ssh)
    this.rd = new RemoteDesktopService(this.config, this.credentials, this.tunnels)
    this.vnc = new VncService(this.vncBridge, this.channels, this.ssh)
    this.pty = new LocalTerminalService(this.ports, this.channels)
    this.k8s = new K8sService(
      this.config,
      this.credentials,
      this.tunnels,
      this.ports,
      this.channels,
      (event) => this.send('k8s:watch', event)
    )
    this.db = new DbService(this.config, this.credentials, this.tunnels)
    this.redis = new RedisService(this.config, this.credentials, this.tunnels)
    this.mongo = new MongoService(this.config, this.credentials, this.tunnels)

    this.initialized = true
  }

  async dispose(): Promise<void> {
    if (!this.initialized) return
    try {
      await this.forward.stopAll()
    } catch {
      /* ignore */
    }
    try {
      await this.ssh.closeAll()
    } catch {
      /* ignore */
    }
    try {
      await this.k8s.dispose()
    } catch {
      /* ignore */
    }
    try {
      await this.db.dispose()
    } catch {
      /* ignore */
    }
    try {
      await this.redis.dispose()
    } catch {
      /* ignore */
    }
    try {
      await this.mongo.dispose()
    } catch {
      /* ignore */
    }
    this.ports.closeAll()
    this.channels.closeAll()
    this.tunnels.closeAll()
    await this.vncBridge.stop()
    this.initialized = false
  }

  /** 配置发生变更时通知所有窗口刷新（多窗口保持一致） */
  notifyConfigChanged(): void {
    this.send('config:changed', null)
  }

  private emitSshStatus(event: SshStatusEvent): void {
    this.send('ssh:status', event)
    if (event.status === 'closed' || event.status === 'error') {
      this.forward?.stopBySession(event.sessionId).catch(() => {
        /* ignore */
      })
    }
  }

  private emitForwardState(state: ForwardState): void {
    this.send('forward:state', state)
  }

  private sendProgress(progress: SftpProgress): void {
    this.send('sftp:progress', progress)
  }
}
