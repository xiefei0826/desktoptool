import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionConfig } from '../../shared/types'

export interface RdpTarget {
  host: string
  port: number
}

/** 生成标准 .rdp 文件（UTF-16LE + BOM，mstsc 与 macOS 客户端都认） */
export async function writeRdpFile(session: SessionConfig, target: RdpTarget): Promise<string> {
  const rdp = session.rdp
  const audioMode = rdp.audio === 'local' ? 0 : rdp.audio === 'remote' ? 1 : 2

  const lines = [
    `full address:s:${target.host}:${target.port}`,
    `username:s:${session.username}`,
    rdp.domain ? `domain:s:${rdp.domain}` : '',
    `screen mode id:i:${rdp.fullscreen ? 2 : 1}`,
    `desktopwidth:i:${rdp.width}`,
    `desktopheight:i:${rdp.height}`,
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    `session bpp:i:${rdp.colorDepth}`,
    `audiomode:i:${audioMode}`,
    `redirectclipboard:i:${rdp.clipboard ? 1 : 0}`,
    'authentication level:i:2',
    'prompt for credentials:i:0',
    'promptcredentialonce:i:1',
    'negotiate security layer:i:1',
    'enablecredsspsupport:i:1',
    'bandwidthautodetect:i:1',
    'networkautodetect:i:1',
    'connection type:i:7'
  ].filter(Boolean)

  const file = path.join(os.tmpdir(), `desktop-tool-${randomUUID()}.rdp`)
  await fs.writeFile(file, `\ufeff${lines.join('\r\n')}\r\n`, 'utf16le')
  return file
}

/** 生成 Linux Remmina 配置（.remmina），供 remmina -c 使用 */
export function buildRemminaFile(session: SessionConfig, target: RdpTarget): string {
  const rdp = session.rdp
  return [
    '[remmina]',
    `name=${session.name}`,
    'protocol=RDP',
    `server=${target.host}:${target.port}`,
    `username=${session.username}`,
    rdp.domain ? `domain=${rdp.domain}` : '',
    `colordepth=${rdp.colorDepth}`,
    `disableclipboard=${rdp.clipboard ? 0 : 1}`,
    `window_maximize=${rdp.fullscreen ? 1 : 0}`,
    `quality=9`,
    ''
  ]
    .filter(Boolean)
    .join('\n')
}
