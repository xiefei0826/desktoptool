import type {
  AppConfig,
  AppInfo,
  AppSettings,
  BridgeEndpoint,
  ChannelClosedEvent,
  CredentialStatus,
  DbConnectResult,
  DbConnection,
  DbKind,
  DbMetadata,
  DbParseResult,
  DbQueryRequest,
  DbQueryResponse,
  ForwardRule,
  ForwardState,
  GroupConfig,
  K8sCluster,
  K8sClusterInfo,
  K8sExecRequest,
  K8sListQuery,
  K8sListResult,
  K8sObjectRef,
  K8sPodLogRequest,
  K8sResourceType,
  K8sWatchEvent,
  K8sWatchQuery,
  LaunchResult,
  RdClientInfo,
  SessionConfig,
  SessionInput,
  SftpEntry,
  SftpProgress,
  SshStatusEvent
} from './types'

export interface SshConnectInput {
  sessionId: string
  password?: string
  passphrase?: string
  /** 连接成功后把凭据写入系统密钥环 */
  remember?: boolean
}

export interface StreamHandlers {
  onData(data: Uint8Array): void
  onClose(reason: string): void
}

export interface SshOpenShellOptions {
  sessionId: string
  cols: number
  rows: number
}

export interface LocalTerminalOptions {
  cols: number
  rows: number
  shell?: string
}

export interface SftpUploadOptions {
  sessionId: string
  remoteDir: string
  localPaths?: string[]
}

export interface SftpDownloadOptions {
  sessionId: string
  remotePaths: string[]
  localDir?: string
}

export interface Api {
  app: {
    info(): Promise<AppInfo>
    openUserData(): Promise<void>
    pickFile(title?: string): Promise<string>
    /** 新开一个窗口，可选地在该窗口里自动打开指定连接 */
    newWindow(sessionId?: string): Promise<void>
  }
  config: {
    get(): Promise<AppConfig>
    saveSession(input: SessionInput): Promise<SessionConfig>
    deleteSession(id: string): Promise<void>
    touchSession(id: string): Promise<void>
    saveGroup(input: Partial<GroupConfig>): Promise<GroupConfig>
    deleteGroup(id: string): Promise<void>
    saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    saveForward(input: Partial<ForwardRule>): Promise<ForwardRule>
    deleteForward(id: string): Promise<void>
    exportConfig(includeSecrets: boolean): Promise<{ ok: boolean; path: string }>
    importConfig(): Promise<{ ok: boolean; message: string }>
  }
  credential: {
    status(): Promise<CredentialStatus>
    set(ref: string, secret: string, allowPlaintext?: boolean): Promise<void>
    remove(ref: string): Promise<void>
    has(ref: string): Promise<boolean>
  }
  ssh: {
    connect(input: SshConnectInput): Promise<void>
    disconnect(sessionId: string): Promise<void>
    openShell(options: SshOpenShellOptions): Promise<BridgeEndpoint>
    isConnected(sessionId: string): Promise<boolean>
  }
  pty: {
    create(options: LocalTerminalOptions): Promise<BridgeEndpoint & { driver: string }>
  }
  stream: {
    /** 建立 MessagePort 数据通道（不占用任何 TCP 端口） */
    open(channelId: string, handlers: StreamHandlers): Promise<void>
    write(channelId: string, data: Uint8Array): void
    resize(channelId: string, cols: number, rows: number): void
    close(channelId: string): void
  }
  channel: {
    close(channelId: string): Promise<void>
  }
  sftp: {
    list(sessionId: string, path: string): Promise<SftpEntry[]>
    home(sessionId: string): Promise<string>
    mkdir(sessionId: string, path: string): Promise<void>
    rename(sessionId: string, from: string, to: string): Promise<void>
    remove(sessionId: string, path: string, isDir: boolean): Promise<void>
    readText(sessionId: string, path: string): Promise<string>
    writeText(sessionId: string, path: string, content: string): Promise<void>
    upload(options: SftpUploadOptions): Promise<{ uploaded: number; canceld: boolean }>
    download(options: SftpDownloadOptions): Promise<{ downloaded: number }>
  }
  forward: {
    list(): Promise<ForwardState[]>
    start(ruleId: string): Promise<ForwardState>
    stop(ruleId: string): Promise<ForwardState>
  }
  rd: {
    detect(): Promise<RdClientInfo[]>
    launch(sessionId: string): Promise<LaunchResult>
  }
  k8s: {
    listClusters(): Promise<K8sCluster[]>
    importFromFile(): Promise<K8sCluster>
    importFromDefault(): Promise<K8sCluster>
    importFromText(text: string, name: string): Promise<K8sCluster>
    importFromWsl(distro: string, configPath: string): Promise<K8sCluster>
    listWslDistros(): Promise<string[]>
    defaultKubeconfigPath(): Promise<string>
    removeCluster(id: string): Promise<void>
    setContext(clusterId: string, context: string): Promise<K8sCluster>
    setNamespace(clusterId: string, namespace: string): Promise<void>
    setTunnel(clusterId: string, sessionId: string | null): Promise<K8sCluster>
    podContainers(clusterId: string, namespace: string, pod: string): Promise<string[]>
    connect(clusterId: string): Promise<K8sClusterInfo>
    listNamespaces(clusterId: string): Promise<string[]>
    resourceTypes(clusterId: string): Promise<K8sResourceType[]>
    listObjects(clusterId: string, query: K8sListQuery): Promise<K8sListResult>
    getObjectYaml(clusterId: string, query: K8sObjectRef): Promise<string>
    applyObject(clusterId: string, yaml: string): Promise<string>
    deleteObject(clusterId: string, query: K8sObjectRef): Promise<void>
    scaleObject(clusterId: string, query: K8sObjectRef & { replicas: number }): Promise<void>
    restartObject(clusterId: string, query: K8sObjectRef): Promise<void>
    startWatch(clusterId: string, query: K8sWatchQuery): Promise<void>
    stopWatch(watchId: string): Promise<void>
    openLog(request: K8sPodLogRequest): Promise<BridgeEndpoint>
    openExec(request: K8sExecRequest): Promise<BridgeEndpoint>
  }
  vnc: {
    open(sessionId: string): Promise<BridgeEndpoint>
  }
  db: {
    listConnections(): Promise<DbConnection[]>
    saveConnection(input: Partial<DbConnection> & { password?: string }): Promise<DbConnection>
    deleteConnection(id: string): Promise<void>
    testConnection(connection: DbConnection, password: string): Promise<DbConnectResult>
    connect(id: string): Promise<DbConnectResult>
    disconnect(id: string): Promise<void>
    cancel(id: string): Promise<void>
    metadata(id: string): Promise<DbMetadata>
    listDatabases(id: string): Promise<string[]>
    switchDatabase(id: string, database: string): Promise<DbMetadata>
    transaction(id: string, action: 'begin' | 'commit' | 'rollback'): Promise<boolean>
    query(request: DbQueryRequest): Promise<DbQueryResponse>
    parse(kind: DbKind, sql: string): Promise<DbParseResult>
  }
  clipboard: {
    read(): Promise<string>
    write(text: string): Promise<void>
  }
  events: {
    onSshStatus(cb: (e: SshStatusEvent) => void): () => void
    onSftpProgress(cb: (e: SftpProgress) => void): () => void
    onForwardState(cb: (e: ForwardState) => void): () => void
    onChannelClosed(cb: (e: ChannelClosedEvent) => void): () => void
    onConfigChanged(cb: () => void): () => void
    onK8sWatch(cb: (e: K8sWatchEvent) => void): () => void
  }
}
