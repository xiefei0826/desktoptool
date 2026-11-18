export type Protocol = 'ssh' | 'rdp' | 'vnc'
export type AuthType = 'password' | 'privateKey'
export type ForwardType = 'local' | 'remote' | 'dynamic'
export type ThemeMode = 'dark' | 'light'

export interface RdpOptions {
  width: number
  height: number
  fullscreen: boolean
  clipboard: boolean
  audio: 'local' | 'remote' | 'none'
  colorDepth: number
  domain: string
  adminSession: boolean
}

export interface SessionConfig {
  id: string
  name: string
  groupId: string | null
  protocol: Protocol
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath: string
  /** 通过哪条 SSH 会话建立隧道（跳板机 / RDP、VNC over SSH） */
  tunnelSessionId: string | null
  rdp: RdpOptions
  note: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export type SessionInput = Omit<SessionConfig, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'> & {
  id?: string
}

export interface GroupConfig {
  id: string
  name: string
  parentId: string | null
  order: number
}

export interface AppSettings {
  theme: ThemeMode
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  confirmOnClose: boolean
  /** 系统密钥环不可用时，是否允许以明文形式保存凭据 */
  allowPlaintextCredential: boolean
}

export interface ForwardRule {
  id: string
  name: string
  sessionId: string
  type: ForwardType
  bindHost: string
  bindPort: number
  destHost: string
  destPort: number
  autoStart: boolean
}

export interface ForwardState {
  ruleId: string
  status: 'stopped' | 'starting' | 'running' | 'error'
  message: string
  connections: number
  startedAt: number | null
}

export interface K8sCluster {
  id: string
  name: string
  source: 'file' | 'inline' | 'wsl'
  kubeconfigPath: string
  wslDistro: string
  context: string
  namespace: string
  /** 经哪条 SSH 会话建立到 API Server 的隧道 */
  tunnelSessionId: string | null
  createdAt: number
  lastUsedAt: number | null
}

export interface K8sClusterStatus {
  clusterId: string
  status: 'idle' | 'connecting' | 'ready' | 'error'
  message: string
  version: string
}

export type K8sCategory = 'workload' | 'network' | 'storage' | 'config' | 'cluster' | 'custom'

export interface K8sResourceType {
  apiVersion: string
  group: string
  version: string
  kind: string
  plural: string
  namespaced: boolean
  verbs: string[]
  shortNames: string[]
  category: K8sCategory
}

export interface K8sObjectSummary {
  uid: string
  name: string
  namespace: string
  kind: string
  apiVersion: string
  createdAt: string
  resourceVersion: string
  status: string
  ready: string
  restarts: number
  extra: string
}

export interface K8sObjectRef {
  apiVersion: string
  kind: string
  namespace: string
  name: string
}

export interface K8sListQuery {
  apiVersion: string
  kind: string
  namespace: string
  limit?: number
  labelSelector?: string
}

export interface K8sListResult {
  items: K8sObjectSummary[]
  resourceVersion: string
  truncated: boolean
}

export interface K8sWatchQuery extends K8sListQuery {
  watchId: string
}

export interface K8sWatchEvent {
  watchId: string
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR'
  object: K8sObjectSummary | null
  message: string
}

export interface K8sPodLogRequest {
  clusterId: string
  namespace: string
  pod: string
  container: string
  tailLines: number
  previous: boolean
  timestamps: boolean
  cols: number
  rows: number
}

export interface K8sExecRequest {
  clusterId: string
  namespace: string
  pod: string
  container: string
  command: string
  cols: number
  rows: number
}

export interface K8sClusterInfo {
  clusterId: string
  name: string
  version: string
  contexts: string[]
  currentContext: string
  tunnelActive: boolean
}

export interface AppConfig {
  schemaVersion: number
  groups: GroupConfig[]
  sessions: SessionConfig[]
  forwards: ForwardRule[]
  settings: AppSettings
  k8sClusters: K8sCluster[]
}

export interface SftpEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  mtime: number
  mode: number
  owner: string
  group: string
}

export interface SftpProgress {
  id: string
  name: string
  direction: 'upload' | 'download'
  transferred: number
  total: number
  done: boolean
  error: string
}

export interface RdClientInfo {
  kind: 'rdp' | 'vnc'
  id: string
  label: string
  available: boolean
  detail: string
}

export interface LaunchResult {
  ok: boolean
  client: string
  message: string
  command: string
}

export interface CredentialStatus {
  available: boolean
  backend: string
  degraded: boolean
}

export interface BridgeEndpoint {
  channelId: string
  /** 仅内置 VNC 使用：noVNC 只支持 WebSocket 传输 */
  url?: string
}

export interface ChannelClosedEvent {
  channelId: string
  reason: string
}

export interface SshStatusEvent {
  sessionId: string
  status: 'connecting' | 'ready' | 'closed' | 'error'
  message: string
}

export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  ptyAvailable: boolean
  userDataPath: string
}
