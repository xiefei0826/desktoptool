import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { LaunchResult, RdClientInfo, SessionConfig } from '../../shared/types'
import { buildRemminaFile, type RdpTarget } from './rdp-file'

const execFileAsync = promisify(execFile)

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin])
    const found = stdout.trim()
    return found || null
  } catch {
    return null
  }
}

const RDP_CANDIDATES = [
  { id: 'xfreerdp', label: 'FreeRDP (xfreerdp)', bins: ['xfreerdp3', 'xfreerdp'] },
  { id: 'rdesktop', label: 'rdesktop', bins: ['rdesktop'] },
  { id: 'remmina', label: 'Remmina', bins: ['remmina'] }
]

const VNC_CANDIDATES = [
  { id: 'vncviewer', label: 'TigerVNC Viewer', bins: ['vncviewer'] },
  { id: 'remmina', label: 'Remmina', bins: ['remmina'] },
  { id: 'gvncviewer', label: 'gvncviewer', bins: ['gvncviewer'] }
]

export async function detectLinuxClients(): Promise<RdClientInfo[]> {
  const clients: RdClientInfo[] = []

  for (const candidate of RDP_CANDIDATES) {
    let foundPath = ''
    for (const bin of candidate.bins) {
      const resolved = await which(bin)
      if (resolved) {
        foundPath = resolved
        break
      }
    }
    clients.push({
      kind: 'rdp',
      id: candidate.id,
      label: candidate.label,
      available: Boolean(foundPath),
      detail: foundPath || `未安装（sudo apt install freerdp2-x11 或 remmina）`
    })
  }

  for (const candidate of VNC_CANDIDATES) {
    let foundPath = ''
    for (const bin of candidate.bins) {
      const resolved = await which(bin)
      if (resolved) {
        foundPath = resolved
        break
      }
    }
    clients.push({
      kind: 'vnc',
      id: candidate.id,
      label: candidate.label,
      available: Boolean(foundPath),
      detail: foundPath || '未安装（应用内已提供内置 VNC，可直接使用）'
    })
  }

  return clients
}

export async function launchLinuxRdp(
  session: SessionConfig,
  target: RdpTarget,
  password: string
): Promise<LaunchResult> {
  const freerdp = (await which('xfreerdp3')) ?? (await which('xfreerdp'))
  if (freerdp) {
    const args = [
      `/v:${target.host}:${target.port}`,
      `/u:${session.username}`,
      session.rdp.domain ? `/d:${session.rdp.domain}` : '',
      '/cert:ignore',
      '/dynamic-resolution',
      session.rdp.clipboard ? '+clipboard' : '-clipboard',
      session.rdp.fullscreen ? '/f' : `/w:${session.rdp.width}`,
      session.rdp.fullscreen ? '' : `/h:${session.rdp.height}`,
      password ? `/p:${password}` : ''
    ].filter(Boolean)

    const child = spawn(freerdp, args, { detached: true, stdio: 'ignore' })
    child.unref()

    return {
      ok: true,
      client: 'xfreerdp',
      message: password
        ? '已调用 xfreerdp；注意密码通过命令行传递，会短暂出现在进程列表中'
        : '已调用 xfreerdp，请在客户端窗口中输入密码',
      command: `${freerdp} ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`
    }
  }

  const rdesktop = await which('rdesktop')
  if (rdesktop) {
    const args = [
      `-u`, session.username,
      ...(password ? ['-p', password] : []),
      ...(session.rdp.domain ? ['-d', session.rdp.domain] : []),
      `-g`, `${session.rdp.width}x${session.rdp.height}`,
      `${target.host}:${target.port}`
    ]
    const child = spawn(rdesktop, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return {
      ok: true,
      client: 'rdesktop',
      message: '已调用 rdesktop',
      command: `${rdesktop} ${args.join(' ')}`
    }
  }

  const remmina = await which('remmina')
  if (remmina) {
    const file = path.join(os.tmpdir(), `desktop-tool-${randomUUID()}.remmina`)
    await fs.writeFile(file, buildRemminaFile(session, target), 'utf8')
    const child = spawn(remmina, ['-c', file], { detached: true, stdio: 'ignore' })
    child.unref()
    return {
      ok: true,
      client: 'remmina',
      message: '已调用 Remmina，需在客户端内输入密码',
      command: `remmina -c "${file}"`
    }
  }

  return {
    ok: false,
    client: 'none',
    message: '未找到可用的 RDP 客户端，请安装 FreeRDP：sudo apt install freerdp2-x11',
    command: `xfreerdp /v:${target.host}:${target.port} /u:${session.username} /cert:ignore /dynamic-resolution`
  }
}

export async function launchLinuxVnc(
  host: string,
  port: number,
  password: string
): Promise<LaunchResult> {
  const vncviewer = await which('vncviewer')
  if (vncviewer) {
    const child = spawn(vncviewer, [`${host}::${port}`], { detached: true, stdio: 'ignore' })
    child.unref()
    return {
      ok: true,
      client: 'vncviewer',
      message: password ? '已调用 TigerVNC（密码需在客户端输入）' : '已调用 TigerVNC',
      command: `vncviewer ${host}::${port}`
    }
  }

  const gvncviewer = await which('gvncviewer')
  if (gvncviewer) {
    const display = port >= 5900 ? String(port - 5900) : '0'
    const child = spawn(gvncviewer, [`${host}:${display}`], { detached: true, stdio: 'ignore' })
    child.unref()
    return {
      ok: true,
      client: 'gvncviewer',
      message: '已调用 gvncviewer',
      command: `gvncviewer ${host}:${display}`
    }
  }

  return {
    ok: false,
    client: 'none',
    message: '未找到 VNC 客户端，建议直接使用应用内置的 VNC 视图',
    command: `vncviewer ${host}::${port}`
  }
}
