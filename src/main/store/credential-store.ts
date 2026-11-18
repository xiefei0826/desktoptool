import { promises as fs } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import type { CredentialStatus } from '../../shared/types'

interface StoredEntry {
  v: 1
  /** true = 系统密钥环加密；false = 明文（仅在用户显式允许时） */
  enc: boolean
  data: string
}

type StoredFile = Record<string, StoredEntry>

function backendName(): string {
  if (process.platform === 'win32') return 'Windows DPAPI'
  if (process.platform === 'darwin') return 'macOS Keychain'
  return 'libsecret / KWallet'
}

/**
 * 凭据存储：优先用 Electron safeStorage（Win DPAPI / macOS Keychain / Linux libsecret），
 * 密钥环不可用时默认拒绝保存，避免"以为加密了其实是明文"。
 */
export class CredentialStore {
  private entries: StoredFile = {}
  private cache = new Map<string, string>()

  private constructor(private readonly filePath: string) {}

  static async load(filePath: string): Promise<CredentialStore> {
    const store = new CredentialStore(filePath)
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      store.entries = JSON.parse(raw) as StoredFile
    } catch {
      store.entries = {}
    }
    return store
  }

  status(): CredentialStatus {
    const available = safeStorage.isEncryptionAvailable()
    return {
      available,
      backend: backendName(),
      degraded: !available
    }
  }

  has(ref: string): boolean {
    return Boolean(this.entries[ref])
  }

  async set(ref: string, secret: string, allowPlaintext = false): Promise<void> {
    const available = safeStorage.isEncryptionAvailable()
    if (available) {
      this.entries[ref] = { v: 1, enc: true, data: safeStorage.encryptString(secret).toString('base64') }
    } else if (allowPlaintext) {
      this.entries[ref] = { v: 1, enc: false, data: Buffer.from(secret, 'utf8').toString('base64') }
    } else {
      throw new Error('系统密钥环不可用，已拒绝以明文形式保存凭据')
    }
    this.cache.set(ref, secret)
    await this.persist()
  }

  async get(ref: string): Promise<string | undefined> {
    const cached = this.cache.get(ref)
    if (cached !== undefined) return cached
    const entry = this.entries[ref]
    if (!entry) return undefined
    try {
      const buffer = Buffer.from(entry.data, 'base64')
      const secret = entry.enc ? safeStorage.decryptString(buffer) : buffer.toString('utf8')
      this.cache.set(ref, secret)
      return secret
    } catch {
      return undefined
    }
  }

  async remove(ref: string): Promise<void> {
    delete this.entries[ref]
    this.cache.delete(ref)
    await this.persist()
  }

  async removePrefix(prefix: string): Promise<void> {
    let changed = false
    for (const key of Object.keys(this.entries)) {
      if (key.startsWith(prefix)) {
        delete this.entries[key]
        this.cache.delete(key)
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  /** 导出（仅用于 includeSecrets 的显式导出，输出明文 map） */
  async exportAll(): Promise<Record<string, string>> {
    const result: Record<string, string> = {}
    for (const key of Object.keys(this.entries)) {
      const secret = await this.get(key)
      if (secret !== undefined) result[key] = secret
    }
    return result
  }

  async importAll(map: Record<string, string>, allowPlaintext = false): Promise<void> {
    for (const [key, value] of Object.entries(map)) {
      await this.set(key, value, allowPlaintext)
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}

export const credentialRef = {
  password: (sessionId: string): string => `session:${sessionId}:password`,
  passphrase: (sessionId: string): string => `session:${sessionId}:passphrase`,
  kubeconfig: (clusterId: string): string => `k8s:${clusterId}:kubeconfig`,
  dbPassword: (connectionId: string): string => `db:${connectionId}:password`
}
