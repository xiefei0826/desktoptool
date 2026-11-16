import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { LaunchResult, RdClientInfo, SessionConfig } from '../../shared/types'
import { writeRdpFile, type RdpTarget } from './rdp-file'

const execFileAsync = promisify(execFile)

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
export const MSTSC_PATH = path.join(SYSTEM_ROOT, 'System32', 'mstsc.exe')

export function detectWindowsClients(): RdClientInfo[] {
  const hasMstsc = existsSync(MSTSC_PATH)
  return [
    {
      kind: 'rdp',
      id: 'mstsc',
      label: 'Windows 远程桌面 (mstsc)',
      available: hasMstsc,
      detail: hasMstsc ? MSTSC_PATH : '未找到 mstsc.exe'
    }
  ]
}

export async function launchWindowsRdp(
  session: SessionConfig,
  target: RdpTarget,
  password: string
): Promise<LaunchResult> {
  if (!existsSync(MSTSC_PATH)) {
    return {
      ok: false,
      client: 'mstsc',
      message: '未找到 mstsc.exe，请确认系统为 Windows 专业版及以上',
      command: ''
    }
  }

  const rdpFile = await writeRdpFile(session, target)
  let injected = false

  if (password) {
    try {
      await execFileAsync('cmdkey.exe', [
        `/generic:TERMSRV/${target.host}`,
        `/user:${session.username}`,
        `/pass:${password}`
      ])
      injected = true
    } catch {
      injected = false
    }
  }

  const args = [rdpFile]
  if (session.rdp.fullscreen) args.push('/f')
  if (session.rdp.adminSession) args.push('/admin')

  const child = spawn(MSTSC_PATH, args, { detached: true, stdio: 'ignore' })
  child.unref()

  // mstsc 会把会话交接给已有进程后立即退出，延迟清理凭据与临时文件
  setTimeout(() => {
    if (injected) {
      execFile('cmdkey.exe', [`/delete:TERMSRV/${target.host}`], () => {
        /* ignore */
      })
    }
    fs.unlink(rdpFile).catch(() => {
      /* ignore */
    })
  }, 30_000)

  return {
    ok: true,
    client: 'mstsc',
    message: injected
      ? '已调用系统远程桌面，凭据已临时注入（30 秒后自动清除）'
      : '已调用系统远程桌面，请在客户端窗口中输入密码',
    command: `mstsc "${rdpFile}"${session.rdp.fullscreen ? ' /f' : ''}`
  }
}
