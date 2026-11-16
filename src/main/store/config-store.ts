import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppConfig,
  AppSettings,
  ForwardRule,
  GroupConfig,
  K8sCluster,
  SessionConfig,
  SessionInput
} from '../../shared/types'
import {
  defaultRdpOptions,
  defaultSettings,
  emptyConfig,
  emptySessionInput,
  SCHEMA_VERSION
} from '../../shared/defaults'

export { defaultRdpOptions, defaultSettings, emptySessionInput }

function normalizeSession(raw: Partial<SessionConfig>): SessionConfig {
  const now = Date.now()
  return {
    id: raw.id ?? randomUUID(),
    name: raw.name?.trim() || raw.host || '未命名连接',
    groupId: raw.groupId ?? null,
    protocol: raw.protocol ?? 'ssh',
    host: raw.host ?? '',
    port: raw.port ?? (raw.protocol === 'rdp' ? 3389 : raw.protocol === 'vnc' ? 5900 : 22),
    username: raw.username ?? '',
    authType: raw.authType ?? 'password',
    privateKeyPath: raw.privateKeyPath ?? '',
    tunnelSessionId: raw.tunnelSessionId ?? null,
    rdp: { ...defaultRdpOptions(), ...(raw.rdp ?? {}) },
    note: raw.note ?? '',
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    lastUsedAt: raw.lastUsedAt ?? null
  }
}

function normalizeCluster(raw: Partial<K8sCluster>): K8sCluster {
  const now = Date.now()
  return {
    id: raw.id ?? randomUUID(),
    name: raw.name?.trim() || '未命名集群',
    source: raw.source ?? 'file',
    kubeconfigPath: raw.kubeconfigPath ?? '',
    wslDistro: raw.wslDistro ?? '',
    context: raw.context ?? '',
    namespace: raw.namespace ?? '',
    tunnelSessionId: raw.tunnelSessionId ?? null,
    createdAt: raw.createdAt ?? now,
    lastUsedAt: raw.lastUsedAt ?? null
  }
}

export class ConfigStore {
  private data: AppConfig
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    data: AppConfig
  ) {
    this.data = data
  }

  static async load(filePath: string): Promise<ConfigStore> {
    let data = emptyConfig()
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      data = {
        schemaVersion: SCHEMA_VERSION,
        groups: (parsed.groups ?? []).map((g) => ({
          id: g.id ?? randomUUID(),
          name: g.name ?? '未命名分组',
          parentId: g.parentId ?? null,
          order: g.order ?? 0
        })),
        sessions: (parsed.sessions ?? []).map((s) => normalizeSession(s)),
        forwards: (parsed.forwards ?? []).map((f) => ({
          id: f.id ?? randomUUID(),
          name: f.name ?? '未命名转发',
          sessionId: f.sessionId ?? '',
          type: f.type ?? 'local',
          bindHost: f.bindHost ?? '127.0.0.1',
          bindPort: f.bindPort ?? 8080,
          destHost: f.destHost ?? '127.0.0.1',
          destPort: f.destPort ?? 80,
          autoStart: f.autoStart ?? false
        })),
        settings: { ...defaultSettings(), ...(parsed.settings ?? {}) },
        k8sClusters: (parsed.k8sClusters ?? []).map((cluster) => normalizeCluster(cluster))
      }
    } catch {
      data = emptyConfig()
    }
    const store = new ConfigStore(filePath, data)
    await store.persist()
    return store
  }

  snapshot(): AppConfig {
    return JSON.parse(JSON.stringify(this.data)) as AppConfig
  }

  settings(): AppSettings {
    return { ...this.data.settings }
  }

  getSession(id: string): SessionConfig | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  getSessions(): SessionConfig[] {
    return this.data.sessions.map((s) => ({ ...s }))
  }

  getForwards(): ForwardRule[] {
    return this.data.forwards.map((f) => ({ ...f }))
  }

  getForward(id: string): ForwardRule | undefined {
    return this.data.forwards.find((f) => f.id === id)
  }

  async saveSession(input: SessionInput): Promise<SessionConfig> {
    const now = Date.now()
    const existing = input.id ? this.getSession(input.id) : undefined
    const merged = normalizeSession({
      ...existing,
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    if (existing) {
      const index = this.data.sessions.findIndex((s) => s.id === existing.id)
      this.data.sessions[index] = merged
    } else {
      this.data.sessions.push(merged)
    }
    await this.persist()
    return { ...merged }
  }

  async deleteSession(id: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    this.data.forwards = this.data.forwards.filter((f) => f.sessionId !== id)
    for (const s of this.data.sessions) {
      if (s.tunnelSessionId === id) s.tunnelSessionId = null
    }
    await this.persist()
  }

  async touchSession(id: string): Promise<void> {
    const session = this.getSession(id)
    if (!session) return
    session.lastUsedAt = Date.now()
    await this.persist()
  }

  async saveGroup(input: Partial<GroupConfig>): Promise<GroupConfig> {
    if (input.id) {
      const existing = this.data.groups.find((g) => g.id === input.id)
      if (existing) {
        Object.assign(existing, input)
        await this.persist()
        return { ...existing }
      }
    }
    const group: GroupConfig = {
      id: input.id ?? randomUUID(),
      name: input.name?.trim() || '新建分组',
      parentId: input.parentId ?? null,
      order: input.order ?? this.data.groups.length
    }
    this.data.groups.push(group)
    await this.persist()
    return { ...group }
  }

  async deleteGroup(id: string): Promise<void> {
    const removed = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const group of this.data.groups) {
        if (group.parentId && removed.has(group.parentId) && !removed.has(group.id)) {
          removed.add(group.id)
          changed = true
        }
      }
    }
    this.data.groups = this.data.groups.filter((g) => !removed.has(g.id))
    for (const session of this.data.sessions) {
      if (session.groupId && removed.has(session.groupId)) session.groupId = null
    }
    await this.persist()
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.data.settings = { ...this.data.settings, ...patch }
    await this.persist()
    return { ...this.data.settings }
  }

  async saveForward(input: Partial<ForwardRule>): Promise<ForwardRule> {
    if (input.id) {
      const existing = this.data.forwards.find((f) => f.id === input.id)
      if (existing) {
        Object.assign(existing, input)
        await this.persist()
        return { ...existing }
      }
    }
    const rule: ForwardRule = {
      id: input.id ?? randomUUID(),
      name: input.name?.trim() || '新建转发',
      sessionId: input.sessionId ?? '',
      type: input.type ?? 'local',
      bindHost: input.bindHost ?? '127.0.0.1',
      bindPort: input.bindPort ?? 8080,
      destHost: input.destHost ?? '127.0.0.1',
      destPort: input.destPort ?? 80,
      autoStart: input.autoStart ?? false
    }
    this.data.forwards.push(rule)
    await this.persist()
    return { ...rule }
  }

  async deleteForward(id: string): Promise<void> {
    this.data.forwards = this.data.forwards.filter((f) => f.id !== id)
    await this.persist()
  }

  async replaceAll(input: Partial<AppConfig>): Promise<void> {
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      groups: input.groups ?? [],
      sessions: (input.sessions ?? []).map((s) => normalizeSession(s)),
      forwards: input.forwards ?? [],
      settings: { ...defaultSettings(), ...(input.settings ?? {}) },
      k8sClusters: (input.k8sClusters ?? []).map((cluster) => normalizeCluster(cluster))
    }
    await this.persist()
  }

  getClusters(): K8sCluster[] {
    return this.data.k8sClusters.map((cluster) => ({ ...cluster }))
  }

  getCluster(id: string): K8sCluster | undefined {
    return this.data.k8sClusters.find((cluster) => cluster.id === id)
  }

  async saveCluster(input: Partial<K8sCluster>): Promise<K8sCluster> {
    const existing = input.id ? this.getCluster(input.id) : undefined
    const merged = normalizeCluster({
      ...existing,
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? Date.now()
    })

    if (existing) {
      const index = this.data.k8sClusters.findIndex((cluster) => cluster.id === existing.id)
      this.data.k8sClusters[index] = merged
    } else {
      this.data.k8sClusters.push(merged)
    }
    await this.persist()
    return { ...merged }
  }

  async deleteCluster(id: string): Promise<void> {
    this.data.k8sClusters = this.data.k8sClusters.filter((cluster) => cluster.id !== id)
    await this.persist()
  }

  async touchCluster(id: string): Promise<void> {
    const cluster = this.getCluster(id)
    if (!cluster) return
    cluster.lastUsedAt = Date.now()
    await this.persist()
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(this.data, null, 2)
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await fs.writeFile(tmp, payload, 'utf8')
      await fs.rename(tmp, this.filePath)
    })
    return this.writeChain
  }
}
