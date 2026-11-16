import { randomUUID } from 'node:crypto'
import nodePath from 'node:path'
import path from 'node:path/posix'
import type { FileEntryWithStats } from 'ssh2'
import type { SftpEntry, SftpProgress } from '../../shared/types'
import type { SshManager } from './manager'

const MAX_TEXT_FILE = 2 * 1024 * 1024

function toEntry(base: string, entry: FileEntryWithStats): SftpEntry {
  const attrs = entry.attrs
  const type: SftpEntry['type'] = attrs.isDirectory()
    ? 'dir'
    : attrs.isSymbolicLink()
      ? 'link'
      : attrs.isFile()
        ? 'file'
        : 'other'
  return {
    name: entry.filename,
    path: path.join(base, entry.filename),
    type,
    size: attrs.size ?? 0,
    mtime: (attrs.mtime ?? 0) * 1000,
    mode: attrs.mode ?? 0,
    owner: String(attrs.uid ?? ''),
    group: String(attrs.gid ?? '')
  }
}

export class SftpService {
  constructor(
    private readonly ssh: SshManager,
    private readonly emitProgress: (progress: SftpProgress) => void
  ) {}

  async list(sessionId: string, dir: string): Promise<SftpEntry[]> {
    const sftp = await this.ssh.sftp(sessionId)
    const target = dir || '.'
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(target, (error, list) => {
        if (error) reject(error)
        else resolve(list)
      })
    })
    return entries
      .map((entry) => toEntry(target, entry))
      .sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (a.type !== 'dir' && b.type === 'dir') return 1
        return a.name.localeCompare(b.name)
      })
  }

  async home(sessionId: string): Promise<string> {
    const sftp = await this.ssh.sftp(sessionId)
    return await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (error, resolved) => {
        if (error) reject(error)
        else resolve(resolved)
      })
    })
  }

  async mkdir(sessionId: string, target: string): Promise<void> {
    const sftp = await this.ssh.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(target, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.ssh.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async remove(sessionId: string, target: string, isDir: boolean): Promise<void> {
    const sftp = await this.ssh.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error) reject(error)
        else resolve()
      }
      if (isDir) sftp.rmdir(target, done)
      else sftp.unlink(target, done)
    })
  }

  async readText(sessionId: string, target: string): Promise<string> {
    const sftp = await this.ssh.sftp(sessionId)
    const stats = await new Promise<{ size: number }>((resolve, reject) => {
      sftp.stat(target, (error, attrs) => {
        if (error) reject(error)
        else resolve({ size: attrs.size ?? 0 })
      })
    })
    if (stats.size > MAX_TEXT_FILE) throw new Error('文件超过 2MB，请下载到本地后编辑')
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(target, (error, data) => {
        if (error) reject(error)
        else resolve(data)
      })
    })
    return buffer.toString('utf8')
  }

  async writeText(sessionId: string, target: string, content: string): Promise<void> {
    const sftp = await this.ssh.sftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(target, Buffer.from(content, 'utf8'), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async upload(sessionId: string, remoteDir: string, localPaths: string[]): Promise<{ uploaded: number }> {
    const sftp = await this.ssh.sftp(sessionId)
    let uploaded = 0

    for (const localPath of localPaths) {
      const name = path.basename(localPath.replace(/\\/g, '/'))
      const remotePath = path.join(remoteDir, name)
      const progress = this.createProgress(name, 'upload')
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.fastPut(
            localPath,
            remotePath,
            {
              step: (transferred: number, _chunk: number, total: number) => {
                this.pushProgress(progress, transferred, total, false, '')
              }
            },
            (error) => {
              if (error) reject(error)
              else resolve()
            }
          )
        })
        uploaded += 1
        this.pushProgress(progress, 1, 1, true, '')
      } catch (error) {
        this.pushProgress(progress, 0, 1, true, (error as Error).message)
        throw error
      }
    }

    return { uploaded }
  }

  async download(sessionId: string, remotePaths: string[], localDir: string): Promise<{ downloaded: number }> {
    const sftp = await this.ssh.sftp(sessionId)
    let downloaded = 0

    for (const remotePath of remotePaths) {
      const name = path.basename(remotePath)
      const localPath = nodePath.join(localDir, name)
      const progress = this.createProgress(name, 'download')
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(
            remotePath,
            localPath,
            {
              step: (transferred: number, _chunk: number, total: number) => {
                this.pushProgress(progress, transferred, total, false, '')
              }
            },
            (error) => {
              if (error) reject(error)
              else resolve()
            }
          )
        })
        downloaded += 1
        this.pushProgress(progress, 1, 1, true, '')
      } catch (error) {
        this.pushProgress(progress, 0, 1, true, (error as Error).message)
        throw error
      }
    }

    return { downloaded }
  }

  private createProgress(name: string, direction: 'upload' | 'download'): SftpProgress {
    return {
      id: randomUUID(),
      name,
      direction,
      transferred: 0,
      total: 0,
      done: false,
      error: ''
    }
  }

  private lastEmit = 0

  private pushProgress(
    progress: SftpProgress,
    transferred: number,
    total: number,
    done: boolean,
    error: string
  ): void {
    progress.transferred = transferred
    progress.total = total
    progress.done = done
    progress.error = error

    const now = Date.now()
    if (!done && now - this.lastEmit < 120) return
    this.lastEmit = now
    this.emitProgress({ ...progress })
  }
}
