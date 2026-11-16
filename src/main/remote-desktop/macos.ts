import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LaunchResult, RdClientInfo, SessionConfig } from '../../shared/types'
import { writeRdpFile, type RdpTarget } from './rdp-file'

const execFileAsync = promisify(execFile)

const RDP_APPS = ['Windows App', 'Microsoft Remote Desktop']

async function appExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('open', ['-Ra', name])
    return true
  } catch {
    return false
  }
}

export async function detectMacClients(): Promise<RdClientInfo[]> {
  const clients: RdClientInfo[] = []

  for (const app of RDP_APPS) {
    const available = await appExists(app)
    clients.push({
      kind: 'rdp',
      id: app,
      label: app,
      available,
      detail: available ? `已安装 ${app}` : `未安装 ${app}`
    })
  }

  // macOS 自带屏幕共享就是 VNC/ARD 服务端客户端
  clients.push({
    kind: 'vnc',
    id: 'screen-sharing',
    label: '系统屏幕共享',
    available: true,
    detail: 'open vnc://user@host'
  })

  return clients
}

export async function launchMacRdp(session: SessionConfig, target: RdpTarget): Promise<LaunchResult> {
  const rdpFile = await writeRdpFile(session, target)

  for (const app of RDP_APPS) {
    if (!(await appExists(app))) continue
    try {
      await execFileAsync('open', ['-a', app, rdpFile])
      return {
        ok: true,
        client: app,
        message: '已调用系统远程桌面客户端，密码需在该客户端内保存一次',
        command: `open -a "${app}" "${rdpFile}"`
      }
    } catch {
      /* 尝试下一个客户端 */
    }
  }

  try {
    await execFileAsync('open', [rdpFile])
    return {
      ok: true,
      client: 'system-default',
      message: '已用系统默认程序打开 .rdp 文件',
      command: `open "${rdpFile}"`
    }
  } catch {
    return {
      ok: false,
      client: 'none',
      message: '未安装 RDP 客户端，请从 App Store 安装 Windows App，或改用内置 VNC',
      command: `open -a "Windows App" "${rdpFile}"`
    }
  }
}

export async function launchMacVnc(host: string, port: number, username: string): Promise<LaunchResult> {
  const url = `vnc://${username ? `${username}@` : ''}${host}:${port}`
  try {
    await execFileAsync('open', [url])
    return {
      ok: true,
      client: 'screen-sharing',
      message: '已调用系统屏幕共享',
      command: `open "${url}"`
    }
  } catch {
    return { ok: false, client: 'screen-sharing', message: '无法调用系统屏幕共享', command: `open "${url}"` }
  }
}
