import { defineStore } from 'pinia'
import { emptyConfig } from '@shared/defaults'
import type {
  AppConfig,
  AppInfo,
  AppSettings,
  CredentialStatus,
  ForwardRule,
  ForwardState,
  GroupConfig,
  LaunchResult,
  RdClientInfo,
  SessionConfig,
  SessionInput,
  SftpProgress,
  SshStatusEvent
} from '@shared/types'
import type { DbConnection, K8sCluster } from '@shared/types'
import { errorMessage } from '../lib/errors'
import { dispatchK8sWatch } from '../lib/k8s-watch'

export interface Tab {
  id: string
  kind: 'terminal' | 'sftp' | 'vnc' | 'forwards' | 'k8s' | 'db'
  title: string
  /** 同源标签共用的分组键，用于标签标题自动编号（同一连接多开时显示 (2)(3)） */
  groupKey: string
  sessionId?: string
  local?: boolean
  /** 已经由主进程建好的数据通道（K8s 日志 / Exec） */
  channelId?: string
  readOnly?: boolean
  clusterId?: string
  dbConnectionId?: string
}

export interface AuthPromptState {
  sessionId: string
  hint: string
}

let authResolver: ((value: { password: string; remember: boolean } | null) => void) | null = null

const AUTH_MARK = 'AUTH_REQUIRED::'

let tabSeq = 0

function makeTabId(prefix: string): string {
  tabSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${tabSeq}`
}

export const useAppStore = defineStore('app', {
  state: () => ({
    config: emptyConfig() as AppConfig,
    info: null as AppInfo | null,
    credentialStatus: { available: true, backend: '', degraded: false } as CredentialStatus,
    tabs: [] as Tab[],
    activeTabId: '',
    sshStatus: {} as Record<string, { status: string; message: string }>,
    forwards: [] as ForwardState[],
    rdClients: [] as RdClientInfo[],
    sftpProgress: [] as SftpProgress[],
    authPrompt: null as AuthPromptState | null,
    busySessions: {} as Record<string, boolean>,
    clusters: [] as K8sCluster[],
    dbConnections: [] as DbConnection[]
  }),

  getters: {
    settings: (state): AppSettings => state.config.settings,
    sessions: (state): SessionConfig[] => state.config.sessions,
    groups: (state): GroupConfig[] => state.config.groups,
    recentSessions: (state): SessionConfig[] =>
      [...state.config.sessions]
        .filter((session) => session.lastUsedAt)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, 6),
    runningForwardCount: (state): number =>
      state.forwards.filter((forward) => forward.status === 'running').length,
    connectedCount: (state): number =>
      Object.values(state.sshStatus).filter((item) => item.status === 'ready').length
  },

  actions: {
    async bootstrap(): Promise<void> {
      await this.reloadConfig()
      this.info = await window.api.app.info()
      this.credentialStatus = await window.api.credential.status()
      this.rdClients = await window.api.rd.detect()
      await this.refreshForwards()
      await this.reloadClusters()
      await this.reloadDbConnections()

      window.api.events.onSshStatus((event: SshStatusEvent) => {
        this.sshStatus = {
          ...this.sshStatus,
          [event.sessionId]: { status: event.status, message: event.message }
        }
      })

      window.api.events.onForwardState((state: ForwardState) => {
        const index = this.forwards.findIndex((item) => item.ruleId === state.ruleId)
        if (index >= 0) this.forwards.splice(index, 1, state)
        else this.forwards.push(state)
      })

      window.api.events.onSftpProgress((progress: SftpProgress) => {
        const index = this.sftpProgress.findIndex((item) => item.id === progress.id)
        if (index >= 0) this.sftpProgress.splice(index, 1, progress)
        else this.sftpProgress.unshift(progress)
        if (this.sftpProgress.length > 30) this.sftpProgress.length = 30
        if (progress.done) {
          setTimeout(() => {
            this.sftpProgress = this.sftpProgress.filter((item) => item.id !== progress.id)
          }, 6000)
        }
      })

      // 多窗口：其他窗口改了配置后同步刷新
      window.api.events.onConfigChanged(() => {
        void this.reloadConfig()
        void this.refreshForwards()
        void this.reloadClusters()
        void this.reloadDbConnections()
      })

      window.api.events.onK8sWatch((event) => dispatchK8sWatch(event))
    },

    async reloadClusters(): Promise<void> {
      this.clusters = await window.api.k8s.listClusters()
    },

    async reloadDbConnections(): Promise<void> {
      this.dbConnections = await window.api.db.listConnections()
    },

    openDbTab(connectionId: string): void {
      const connection = this.dbConnections.find((item) => item.id === connectionId)
      this.openTab({
        id: makeTabId('db'),
        kind: 'db',
        title: connection?.name ?? '数据库',
        groupKey: `db:${connectionId}`,
        dbConnectionId: connectionId
      })
    },

    async removeDbConnection(connectionId: string): Promise<void> {
      for (const tab of [...this.tabs]) {
        if (tab.dbConnectionId === connectionId) this.closeTab(tab.id)
      }
      await window.api.db.deleteConnection(connectionId)
      await this.reloadDbConnections()
    },

    async reloadConfig(): Promise<void> {
      this.config = await window.api.config.get()
    },

    statusOf(sessionId: string): string {
      return this.sshStatus[sessionId]?.status ?? 'idle'
    },

    openTab(tab: Tab): void {
      const existing = this.tabs.find((item) => item.id === tab.id)
      if (existing) {
        this.activeTabId = existing.id
        return
      }
      this.tabs.push(tab)
      this.activeTabId = tab.id
    },

    closeTab(id: string): void {
      const index = this.tabs.findIndex((tab) => tab.id === id)
      if (index < 0) return
      this.tabs.splice(index, 1)
      if (this.activeTabId === id) {
        const next = this.tabs[index] ?? this.tabs[index - 1]
        this.activeTabId = next?.id ?? ''
      }
    },

    closeTabsOfSession(sessionId: string): void {
      for (const tab of [...this.tabs]) {
        if (tab.sessionId === sessionId) this.closeTab(tab.id)
      }
    },

    async saveSession(input: SessionInput): Promise<SessionConfig> {
      const saved = await window.api.config.saveSession(input)
      await this.reloadConfig()
      return saved
    },

    async deleteSession(id: string): Promise<void> {
      this.closeTabsOfSession(id)
      await window.api.config.deleteSession(id)
      delete this.sshStatus[id]
      await this.reloadConfig()
    },

    async duplicateSession(id: string): Promise<SessionConfig | null> {
      const source = this.config.sessions.find((session) => session.id === id)
      if (!source) return null
      const { id: _id, createdAt: _c, updatedAt: _u, lastUsedAt: _l, ...rest } = source
      return await this.saveSession({ ...rest, name: `${source.name} 副本` })
    },

    async saveGroup(input: Partial<GroupConfig>): Promise<GroupConfig> {
      const group = await window.api.config.saveGroup(input)
      await this.reloadConfig()
      return group
    },

    async deleteGroup(id: string): Promise<void> {
      await window.api.config.deleteGroup(id)
      await this.reloadConfig()
    },

    async saveSettings(patch: Partial<AppSettings>): Promise<void> {
      const settings = await window.api.config.saveSettings(patch)
      this.config = { ...this.config, settings }
    },

    async refreshForwards(): Promise<void> {
      this.forwards = await window.api.forward.list()
    },

    async saveForward(input: Partial<ForwardRule>): Promise<void> {
      await window.api.config.saveForward(input)
      await this.refreshForwards()
    },

    async deleteForward(id: string): Promise<void> {
      await window.api.config.deleteForward(id)
      await this.refreshForwards()
    },

    async startForward(id: string): Promise<void> {
      const state = await window.api.forward.start(id)
      const index = this.forwards.findIndex((item) => item.ruleId === id)
      if (index >= 0) this.forwards.splice(index, 1, state)
      else this.forwards.push(state)
    },

    async stopForward(id: string): Promise<void> {
      const state = await window.api.forward.stop(id)
      const index = this.forwards.findIndex((item) => item.ruleId === id)
      if (index >= 0) this.forwards.splice(index, 1, state)
      else this.forwards.push(state)
    },

    async connectSsh(
      sessionId: string,
      secret?: { password?: string; passphrase?: string; remember?: boolean }
    ): Promise<void> {
      this.busySessions = { ...this.busySessions, [sessionId]: true }
      try {
        await window.api.ssh.connect({ sessionId, ...secret })
        await this.reloadConfig()
      } catch (error) {
        const raw = errorMessage(error)
        const markIndex = raw.indexOf(AUTH_MARK)
        if (markIndex >= 0 && !secret?.password) {
          const rest = raw.slice(markIndex + AUTH_MARK.length)
          const [hintSessionId, ...messageParts] = rest.split('::')
          const hint = messageParts.join('::') || '请输入登录密码'
          const answer = await this.askPassword(hintSessionId || sessionId, hint)
          if (!answer) throw new Error('已取消连接')
          await window.api.ssh.connect({
            sessionId,
            password: answer.password,
            remember: answer.remember
          })
          await this.reloadConfig()
          return
        }
        throw new Error(raw)
      } finally {
        const next = { ...this.busySessions }
        delete next[sessionId]
        this.busySessions = next
      }
    },

    askPassword(sessionId: string, hint: string): Promise<{ password: string; remember: boolean } | null> {
      this.authPrompt = { sessionId, hint }
      return new Promise((resolve) => {
        authResolver = resolve
      })
    },

    submitAuthPrompt(value: { password: string; remember: boolean } | null): void {
      const resolver = authResolver
      authResolver = null
      this.authPrompt = null
      resolver?.(value)
    },

    /** 打开连接：SSH/VNC 每次都在新标签里打开，RDP 拉起系统客户端 */
    async openSession(sessionId: string): Promise<LaunchResult | null> {
      const session = this.config.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('连接配置不存在')

      if (session.protocol === 'ssh') {
        const connected = await window.api.ssh.isConnected(sessionId)
        if (!connected) await this.connectSsh(sessionId)
        this.openTab({
          id: makeTabId('term'),
          kind: 'terminal',
          title: session.name,
          groupKey: `ssh:${sessionId}`,
          sessionId
        })
        return null
      }

      if (session.protocol === 'vnc') {
        this.openVncTab(sessionId)
        return null
      }

      const result = await window.api.rd.launch(sessionId)
      await this.reloadConfig()
      return result
    },

    /** 同一个连接再开一个终端标签 */
    async openNewTerminal(sessionId?: string): Promise<void> {
      if (!sessionId) {
        this.openLocalTerminal()
        return
      }
      const session = this.config.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('连接配置不存在')
      const connected = await window.api.ssh.isConnected(sessionId)
      if (!connected) await this.connectSsh(sessionId)
      this.openTab({
        id: makeTabId('term'),
        kind: 'terminal',
        title: session.name,
        groupKey: `ssh:${sessionId}`,
        sessionId
      })
    },

    openLocalTerminal(): void {
      this.openTab({
        id: makeTabId('local'),
        kind: 'terminal',
        title: '本机终端',
        groupKey: 'local',
        local: true
      })
    },

    async openSftp(sessionId: string): Promise<void> {
      const session = this.config.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('连接配置不存在')
      if (session.protocol !== 'ssh') throw new Error('SFTP 需要 SSH 连接')
      const connected = await window.api.ssh.isConnected(sessionId)
      if (!connected) await this.connectSsh(sessionId)
      this.openTab({
        id: makeTabId('sftp'),
        kind: 'sftp',
        title: `SFTP · ${session.name}`,
        groupKey: `sftp:${sessionId}`,
        sessionId
      })
    },

    openVncTab(sessionId: string): void {
      const session = this.config.sessions.find((item) => item.id === sessionId)
      this.openTab({
        id: makeTabId('vnc'),
        kind: 'vnc',
        title: session?.name ?? 'VNC',
        groupKey: `vnc:${sessionId}`,
        sessionId
      })
    },

    openForwards(): void {
      this.openTab({ id: 'forwards', kind: 'forwards', title: '端口转发', groupKey: 'forwards' })
    },

    async launchRemoteDesktop(sessionId: string): Promise<LaunchResult> {
      const result = await window.api.rd.launch(sessionId)
      await this.reloadConfig()
      return result
    },

    async openSessionInNewWindow(sessionId: string): Promise<void> {
      await window.api.app.newWindow(sessionId)
    },

    openK8sTab(clusterId: string): void {
      const cluster = this.clusters.find((item) => item.id === clusterId)
      this.openTab({
        id: makeTabId('k8s'),
        kind: 'k8s',
        title: cluster?.name ?? 'Kubernetes',
        groupKey: `k8s:${clusterId}`,
        clusterId
      })
    },

    async removeCluster(clusterId: string): Promise<void> {
      for (const tab of [...this.tabs]) {
        if (tab.clusterId === clusterId) this.closeTab(tab.id)
      }
      await window.api.k8s.removeCluster(clusterId)
      await this.reloadClusters()
    },

    /** Pod 日志：主进程建好通道后直接在终端标签里展示（只读） */
    async openK8sLog(input: {
      clusterId: string
      namespace: string
      pod: string
      container: string
      tailLines?: number
      previous?: boolean
    }): Promise<void> {
      const endpoint = await window.api.k8s.openLog({
        clusterId: input.clusterId,
        namespace: input.namespace,
        pod: input.pod,
        container: input.container,
        tailLines: input.tailLines ?? 300,
        previous: input.previous ?? false,
        timestamps: true,
        cols: 120,
        rows: 30
      })
      this.openTab({
        id: makeTabId('k8slog'),
        kind: 'terminal',
        title: `日志 · ${input.pod}`,
        groupKey: `k8slog:${input.clusterId}:${input.pod}`,
        channelId: endpoint.channelId,
        readOnly: true
      })
    },

    async openK8sExec(input: {
      clusterId: string
      namespace: string
      pod: string
      container: string
      command?: string
      cols?: number
      rows?: number
    }): Promise<void> {
      const endpoint = await window.api.k8s.openExec({
        clusterId: input.clusterId,
        namespace: input.namespace,
        pod: input.pod,
        container: input.container,
        command: input.command ?? '',
        cols: input.cols ?? 120,
        rows: input.rows ?? 30
      })
      this.openTab({
        id: makeTabId('k8sexec'),
        kind: 'terminal',
        title: `Exec · ${input.pod}`,
        groupKey: `k8sexec:${input.clusterId}:${input.pod}`,
        channelId: endpoint.channelId
      })
    },

    async disconnect(sessionId: string): Promise<void> {
      await window.api.ssh.disconnect(sessionId)
      await this.refreshForwards()
    },

    async exportConfig(includeSecrets: boolean): Promise<string> {
      const result = await window.api.config.exportConfig(includeSecrets)
      return result.ok ? result.path : ''
    },

    async importConfig(): Promise<string> {
      const result = await window.api.config.importConfig()
      await this.reloadConfig()
      await this.refreshForwards()
      return result.message
    }
  }
})
