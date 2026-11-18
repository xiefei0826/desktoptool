import { contextBridge, ipcRenderer } from 'electron'
import type { Api, StreamHandlers } from '../shared/api'
import type {
  ChannelClosedEvent,
  ForwardState,
  K8sWatchEvent,
  SftpProgress,
  SshStatusEvent
} from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener as never)
  return () => {
    ipcRenderer.removeListener(channel, listener as never)
  }
}

interface ActiveStream {
  port: MessagePort
  onData: (data: Uint8Array) => void
  onClose: (reason: string) => void
}

const activeStreams = new Map<string, ActiveStream>()
const pendingStreams = new Map<string, { resolve: (port: MessagePort) => void }>()

ipcRenderer.on('stream:port', (event, payload: { channelId?: string }) => {
  const channelId = payload?.channelId ?? ''
  const pending = channelId ? pendingStreams.get(channelId) : undefined
  if (channelId) pendingStreams.delete(channelId)

  const port = event.ports?.[0]
  if (!port || !pending) {
    port?.close()
    return
  }
  pending.resolve(port)
})

/**
 * 终端数据走 Electron MessagePort：主进程转移端口对象给 preload，
 * 全程不监听 TCP 端口，也不需要握手 token。
 */
async function openStream(channelId: string, handlers: StreamHandlers): Promise<void> {
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    pendingStreams.set(channelId, { resolve })
    setTimeout(() => {
      if (!pendingStreams.has(channelId)) return
      pendingStreams.delete(channelId)
      reject(new Error('数据通道建立超时'))
    }, 5000)
  })

  const attached = await invoke<boolean>('stream:attach', channelId)
  if (!attached) {
    pendingStreams.delete(channelId)
    throw new Error('数据通道不存在或已关闭')
  }

  const port = await portPromise
  const active: ActiveStream = { port, onData: handlers.onData, onClose: handlers.onClose }

  port.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data
    if (data instanceof Uint8Array) {
      active.onData(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      active.onData(new Uint8Array(data))
      return
    }
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data) as { t?: string; reason?: string }
        if (message.t === 'close') active.onClose(message.reason ?? 'closed')
      } catch {
        /* 忽略非法控制帧 */
      }
    }
  }
  port.start()
  activeStreams.set(channelId, active)
}

function writeStream(channelId: string, data: Uint8Array): void {
  activeStreams.get(channelId)?.port.postMessage(data)
}

function resizeStream(channelId: string, cols: number, rows: number): void {
  activeStreams.get(channelId)?.port.postMessage(JSON.stringify({ t: 'resize', cols, rows }))
}

function closeStream(channelId: string): void {
  const active = activeStreams.get(channelId)
  if (active) {
    activeStreams.delete(channelId)
    try {
      active.port.close()
    } catch {
      /* ignore */
    }
  }
  void invoke('channel:close', channelId).catch(() => undefined)
}

const api: Api = {
  app: {
    info: () => invoke('app:info'),
    openUserData: () => invoke('app:openUserData'),
    pickFile: (title) => invoke('app:pickFile', title),
    newWindow: (sessionId) => invoke('window:new', sessionId)
  },
  config: {
    get: () => invoke('config:get'),
    saveSession: (input) => invoke('config:saveSession', input),
    deleteSession: (id) => invoke('config:deleteSession', id),
    touchSession: (id) => invoke('config:touchSession', id),
    saveGroup: (input) => invoke('config:saveGroup', input),
    deleteGroup: (id) => invoke('config:deleteGroup', id),
    saveSettings: (patch) => invoke('config:saveSettings', patch),
    saveForward: (input) => invoke('config:saveForward', input),
    deleteForward: (id) => invoke('config:deleteForward', id),
    exportConfig: (includeSecrets) => invoke('config:exportConfig', includeSecrets),
    importConfig: () => invoke('config:importConfig')
  },
  credential: {
    status: () => invoke('credential:status'),
    set: (ref, secret, allowPlaintext) => invoke('credential:set', ref, secret, allowPlaintext),
    remove: (ref) => invoke('credential:remove', ref),
    has: (ref) => invoke('credential:has', ref)
  },
  ssh: {
    connect: (input) => invoke('ssh:connect', input),
    disconnect: (sessionId) => invoke('ssh:disconnect', sessionId),
    openShell: (options) => invoke('ssh:openShell', options),
    isConnected: (sessionId) => invoke('ssh:isConnected', sessionId)
  },
  pty: {
    create: (options) => invoke('pty:create', options)
  },
  stream: {
    open: (channelId, handlers) => openStream(channelId, handlers),
    write: (channelId, data) => writeStream(channelId, data),
    resize: (channelId, cols, rows) => resizeStream(channelId, cols, rows),
    close: (channelId) => closeStream(channelId)
  },
  channel: {
    close: (channelId) => invoke('channel:close', channelId)
  },
  sftp: {
    list: (sessionId, target) => invoke('sftp:list', sessionId, target),
    home: (sessionId) => invoke('sftp:home', sessionId),
    mkdir: (sessionId, target) => invoke('sftp:mkdir', sessionId, target),
    rename: (sessionId, from, to) => invoke('sftp:rename', sessionId, from, to),
    remove: (sessionId, target, isDir) => invoke('sftp:remove', sessionId, target, isDir),
    readText: (sessionId, target) => invoke('sftp:readText', sessionId, target),
    writeText: (sessionId, target, content) => invoke('sftp:writeText', sessionId, target, content),
    upload: (options) => invoke('sftp:upload', options),
    download: (options) => invoke('sftp:download', options)
  },
  forward: {
    list: () => invoke('forward:list'),
    start: (ruleId) => invoke('forward:start', ruleId),
    stop: (ruleId) => invoke('forward:stop', ruleId)
  },
  rd: {
    detect: () => invoke('rd:detect'),
    launch: (sessionId) => invoke('rd:launch', sessionId)
  },
  vnc: {
    open: (sessionId) => invoke('vnc:open', sessionId)
  },
  k8s: {
    listClusters: () => invoke('k8s:listClusters'),
    importFromFile: () => invoke('k8s:importFromFile'),
    importFromDefault: () => invoke('k8s:importFromDefault'),
    importFromText: (text, name) => invoke('k8s:importFromText', text, name),
    importFromWsl: (distro, configPath) => invoke('k8s:importFromWsl', distro, configPath),
    listWslDistros: () => invoke('k8s:listWslDistros'),
    defaultKubeconfigPath: () => invoke('k8s:defaultKubeconfigPath'),
    removeCluster: (id) => invoke('k8s:removeCluster', id),
    setContext: (clusterId, context) => invoke('k8s:setContext', clusterId, context),
    setNamespace: (clusterId, namespace) => invoke('k8s:setNamespace', clusterId, namespace),
    setTunnel: (clusterId, sessionId) => invoke('k8s:setTunnel', clusterId, sessionId),
    podContainers: (clusterId, namespace, pod) =>
      invoke('k8s:podContainers', clusterId, namespace, pod),
    connect: (clusterId) => invoke('k8s:connect', clusterId),
    listNamespaces: (clusterId) => invoke('k8s:listNamespaces', clusterId),
    resourceTypes: (clusterId) => invoke('k8s:resourceTypes', clusterId),
    listObjects: (clusterId, query) => invoke('k8s:listObjects', clusterId, query),
    getObjectYaml: (clusterId, query) => invoke('k8s:getObjectYaml', clusterId, query),
    applyObject: (clusterId, yamlText) => invoke('k8s:applyObject', clusterId, yamlText),
    deleteObject: (clusterId, query) => invoke('k8s:deleteObject', clusterId, query),
    scaleObject: (clusterId, query) => invoke('k8s:scaleObject', clusterId, query),
    restartObject: (clusterId, query) => invoke('k8s:restartObject', clusterId, query),
    startWatch: (clusterId, query) => invoke('k8s:startWatch', clusterId, query),
    stopWatch: (watchId) => invoke('k8s:stopWatch', watchId),
    openLog: (request) => invoke('k8s:openLog', request),
    openExec: (request) => invoke('k8s:openExec', request)
  },
  db: {
    listConnections: () => invoke('db:listConnections'),
    saveConnection: (input) => invoke('db:saveConnection', input),
    deleteConnection: (id) => invoke('db:deleteConnection', id),
    testConnection: (connection, password) => invoke('db:testConnection', connection, password),
    connect: (id) => invoke('db:connect', id),
    disconnect: (id) => invoke('db:disconnect', id),
    cancel: (id) => invoke('db:cancel', id),
    metadata: (id) => invoke('db:metadata', id),
    listDatabases: (id) => invoke('db:listDatabases', id),
    switchDatabase: (id, database) => invoke('db:switchDatabase', id, database),
    transaction: (id, action) => invoke('db:transaction', id, action),
    query: (request) => invoke('db:query', request),
    parse: (kind, sql) => invoke('db:parse', kind, sql)
  },
  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (text) => invoke('clipboard:write', text)
  },
  events: {
    onSshStatus: (callback) => subscribe<SshStatusEvent>('ssh:status', callback),
    onSftpProgress: (callback) => subscribe<SftpProgress>('sftp:progress', callback),
    onForwardState: (callback) => subscribe<ForwardState>('forward:state', callback),
    onChannelClosed: (callback) => subscribe<ChannelClosedEvent>('channel:closed', callback),
    onConfigChanged: (callback) => subscribe<null>('config:changed', () => callback()),
    onK8sWatch: (callback) => subscribe<K8sWatchEvent>('k8s:watch', callback)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as unknown as { api: Api }).api = api
}
