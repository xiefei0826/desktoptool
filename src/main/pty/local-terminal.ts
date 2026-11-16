import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { BridgeEndpoint } from '../../shared/types'
import type { PortBridge } from '../bridge/port-bridge'
import type { ChannelRegistry } from '../channel-registry'

interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (event: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

interface PtyModule {
  spawn(file: string, args: string[] | string, options: Record<string, unknown>): PtyProcess
}

let ptyModule: PtyModule | null = null
let ptyLoadError = ''

try {
  // 原生模块按需加载：若未编译到当前 Electron ABI，则降级为管道模式
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ptyModule = require('node-pty') as PtyModule
} catch (error) {
  ptyLoadError = (error as Error).message
}

function resolveShell(override?: string): { file: string; args: string[] } {
  if (override && override.trim()) {
    return { file: override.trim(), args: process.platform === 'win32' ? ['-NoLogo'] : [] }
  }
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

function resolvePipeShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'cmd.exe', args: ['/Q'] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] }
}

export class LocalTerminalService {
  constructor(
    private readonly bridge: PortBridge,
    private readonly channels: ChannelRegistry
  ) {}

  get available(): boolean {
    return ptyModule !== null
  }

  get driver(): 'pty' | 'pipe' {
    return ptyModule ? 'pty' : 'pipe'
  }

  get unavailableReason(): string {
    return ptyLoadError
  }

  create(
    cols: number,
    rows: number,
    shellOverride?: string
  ): BridgeEndpoint & { driver: 'pty' | 'pipe' } {
    const channelId = randomUUID()

    if (ptyModule) {
      this.createPty(channelId, cols, rows, shellOverride)
      return { channelId, driver: 'pty' }
    }

    this.createPipe(channelId)
    return { channelId, driver: 'pipe' }
  }

  private createPty(channelId: string, cols: number, rows: number, shellOverride?: string): void {
    const pty = ptyModule as PtyModule
    const shell = resolveShell(shellOverride)
    const term = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    this.bridge.create(channelId, {
      onData: (data) => term.write(data.toString('utf8')),
      onResize: (nextCols, nextRows) => term.resize(nextCols, nextRows),
      onClose: () => {
        try {
          term.kill()
        } catch {
          /* ignore */
        }
      }
    })

    term.onData((data) => this.bridge.push(channelId, Buffer.from(data, 'utf8')))
    term.onExit(() => {
      this.channels.remove(channelId)
      this.bridge.release(channelId, 'exited')
    })

    this.channels.add({
      id: channelId,
      kind: 'pty',
      sessionId: 'local',
      close: () => {
        try {
          term.kill()
        } catch {
          /* ignore */
        }
      }
    })
  }

  private createPipe(channelId: string): void {
    const shell = resolvePipeShell()
    const child: ChildProcessWithoutNullStreams = spawn(shell.file, shell.args, {
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
      windowsHide: true
    })

    const notice =
      '\r\n\x1b[33m[提示] 本机终端运行在管道模式：node-pty 未编译到当前 Electron ABI，' +
      'vim / top 等全屏程序不可用。安装 Visual Studio Build Tools 后执行 npm run rebuild 可启用 PTY。\x1b[0m\r\n'

    this.bridge.push(channelId, Buffer.from(notice, 'utf8'))

    this.bridge.create(channelId, {
      onData: (data) => {
        const text = data.toString('utf8')
        // 管道模式没有 TTY 回显，这里做本地回显以保证基本可用
        this.bridge.push(channelId, Buffer.from(text, 'utf8'))
        child.stdin.write(text)
      },
      onClose: () => {
        child.kill()
      }
    })

    child.stdout.on('data', (data: Buffer) => this.bridge.push(channelId, data))
    child.stderr.on('data', (data: Buffer) => this.bridge.push(channelId, data))
    child.on('exit', () => {
      this.channels.remove(channelId)
      this.bridge.release(channelId, 'exited')
    })

    this.channels.add({
      id: channelId,
      kind: 'pty',
      sessionId: 'local',
      close: () => child.kill()
    })
  }
}
