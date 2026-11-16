import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import {
  CoreV1Api,
  Exec,
  KubeConfig,
  KubernetesObjectApi,
  Log,
  VersionApi,
  Watch
} from '@kubernetes/client-node'
import yaml from 'js-yaml'
import type {
  BridgeEndpoint,
  K8sCategory,
  K8sCluster,
  K8sClusterInfo,
  K8sExecRequest,
  K8sListQuery,
  K8sListResult,
  K8sObjectSummary,
  K8sPodLogRequest,
  K8sResourceType,
  K8sWatchQuery
} from '../../shared/types'
import type { PortBridge } from '../bridge/port-bridge'
import type { ChannelRegistry } from '../channel-registry'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { ConfigStore } from '../store/config-store'
import type { TunnelService, LocalTunnel } from '../ssh/tunnel'

interface ApiResourceList {
  groupVersion: string
  resources: {
    name: string
    singularName?: string
    kind: string
    namespaced: boolean
    verbs: string[]
    shortNames?: string[]
    categories?: string[]
  }[]
}

interface ApiGroupList {
  groups: {
    name: string
    versions: { groupVersion: string; version: string }[]
    preferredVersion?: { groupVersion: string; version: string }
  }[]
}

interface RawList<T = unknown> {
  items: T[]
  metadata?: { resourceVersion?: string; continue?: string }
}

interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    labels?: Record<string, string>
    managedFields?: unknown
  }
  status?: Record<string, unknown>
  spec?: Record<string, unknown>
}

interface Runtime {
  cluster: K8sCluster
  kc: KubeConfig
  objects: KubernetesObjectApi
  version: string
  tunnel?: LocalTunnel
  resourceTypes?: K8sResourceType[]
}

interface WatchState {
  aborted: boolean
  timer?: NodeJS.Timeout
  abort?: () => void
  retries: number
  resourceVersion: string
}

const CATEGORY_BY_KIND: Record<string, K8sCategory> = {
  Pod: 'workload',
  Deployment: 'workload',
  StatefulSet: 'workload',
  DaemonSet: 'workload',
  ReplicaSet: 'workload',
  Job: 'workload',
  CronJob: 'workload',
  HorizontalPodAutoscaler: 'workload',
  Service: 'network',
  Ingress: 'network',
  IngressClass: 'network',
  NetworkPolicy: 'network',
  EndpointSlice: 'network',
  PersistentVolumeClaim: 'storage',
  PersistentVolume: 'storage',
  StorageClass: 'storage',
  ConfigMap: 'config',
  Secret: 'config',
  Namespace: 'cluster',
  Node: 'cluster',
  Event: 'cluster',
  ServiceAccount: 'cluster',
  Role: 'cluster',
  RoleBinding: 'cluster',
  ClusterRole: 'cluster',
  ClusterRoleBinding: 'cluster',
  CustomResourceDefinition: 'custom'
}

function categoryOf(kind: string, group: string): K8sCategory {
  if (CATEGORY_BY_KIND[kind]) return CATEGORY_BY_KIND[kind]
  if (group && !group.endsWith('k8s.io')) return 'custom'
  return 'cluster'
}

function ageOf(timestamp?: string): string {
  if (!timestamp) return '-'
  const diff = Date.now() - new Date(timestamp).getTime()
  if (Number.isNaN(diff) || diff < 0) return '-'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return `${Math.floor(diff / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y`
}

function summarize(object: KubeObject, kind: string): K8sObjectSummary {
  const status = (object.status ?? {}) as Record<string, unknown>
  const specs = (object.spec ?? {}) as Record<string, unknown>
  const statusObj = status as {
    phase?: string
    conditions?: { type?: string; status?: string; reason?: string }[]
    containerStatuses?: { ready?: boolean; restartCount?: number }[]
    readyReplicas?: number
    replicas?: number
    availableReplicas?: number
    loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] }
  }

  let phase = statusObj.phase ?? ''
  let ready = ''
  let restarts = 0
  let extra = ''

  if (kind === 'Pod') {
    const statuses = statusObj.containerStatuses ?? []
    ready = `${statuses.filter((item) => item.ready).length}/${statuses.length || 0}`
    restarts = statuses.reduce((sum, item) => sum + (item.restartCount ?? 0), 0)
    if (!phase && statusObj.conditions) {
      const readyCondition = statusObj.conditions.find((item) => item.type === 'Ready')
      phase = readyCondition?.status === 'True' ? 'Running' : 'NotReady'
    }
    extra = statusObj.phase === 'Succeeded' ? 'completed' : ''
  } else if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'ReplicaSet') {
    phase = `${statusObj.readyReplicas ?? 0}/${statusObj.replicas ?? 0}`
    ready = `${statusObj.availableReplicas ?? 0} 可用`
    extra = `${statusObj.readyReplicas ?? 0}/${statusObj.replicas ?? 0}`
  } else if (kind === 'DaemonSet') {
    const desired = (status as { desiredNumberScheduled?: number }).desiredNumberScheduled ?? 0
    const readyCount = (status as { numberReady?: number }).numberReady ?? 0
    phase = `${readyCount}/${desired}`
    extra = `${readyCount}/${desired}`
  } else if (kind === 'Job') {
    if (statusObj.conditions?.some((item) => item.type === 'Complete')) phase = 'Complete'
    else if (statusObj.conditions?.some((item) => item.type === 'Failed')) phase = 'Failed'
    else phase = 'Running'
  } else if (kind === 'CronJob') {
    phase = String((specs as { schedule?: string }).schedule ?? '-')
  } else if (kind === 'Service') {
    const type = (specs as { type?: string }).type ?? 'ClusterIP'
    const ingress = statusObj.loadBalancer?.ingress?.[0]
    phase = type
    extra = ingress?.ip ?? ingress?.hostname ?? (specs as { clusterIP?: string }).clusterIP ?? '-'
  } else if (kind === 'PersistentVolumeClaim') {
    phase = statusObj.phase ?? '-'
    extra = `${(specs as { resources?: { requests?: { storage?: string } } }).resources?.requests?.storage ?? ''}`
  } else if (kind === 'Node') {
    const conditions = statusObj.conditions ?? []
    const isReady = conditions.find((item) => item.type === 'Ready')?.status === 'True'
    phase = isReady ? 'Ready' : 'NotReady'
  } else if (kind === 'Event') {
    phase = String((object as { type?: string }).type ?? 'Normal')
    extra = String((object as { reason?: string }).reason ?? '')
  }

  if (!phase) {
    const available = statusObj.conditions?.find((item) => item.type === 'Available')
    if (available) phase = available.status === 'True' ? 'Available' : (available.reason ?? 'NotAvailable')
  }

  return {
    uid: object.metadata?.uid ?? '',
    name: object.metadata?.name ?? '',
    namespace: object.metadata?.namespace ?? '',
    kind: object.kind ?? kind,
    apiVersion: object.apiVersion ?? '',
    createdAt: object.metadata?.creationTimestamp ?? '',
    resourceVersion: object.metadata?.resourceVersion ?? '',
    status: phase || '-',
    ready,
    restarts,
    extra
  }
}

class ResizableSink extends Writable {
  columns: number
  rows: number

  constructor(
    private readonly sink: (chunk: Buffer) => void,
    cols: number,
    rows: number
  ) {
    super()
    this.columns = cols
    this.rows = rows
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.sink(Buffer.from(chunk))
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  resize(cols: number, rows: number): void {
    this.columns = cols
    this.rows = rows
    this.emit('resize')
  }
}

export class K8sService {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly watches = new Map<string, WatchState>()

  constructor(
    private readonly config: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly tunnels: TunnelService,
    private readonly ports: PortBridge,
    private readonly channels: ChannelRegistry,
    private readonly emitWatch: (event: {
      watchId: string
      type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'ERROR'
      object: K8sObjectSummary | null
      message: string
    }) => void
  ) {}

  listClusters(): K8sCluster[] {
    return this.config.getClusters()
  }

  /** 导入本地 kubeconfig 文件 */
  async importFromFile(filePath: string, displayName?: string): Promise<K8sCluster> {
    const content = await fs.readFile(filePath, 'utf8')
    return await this.importFromText(content, displayName || path.basename(path.dirname(filePath)), {
      source: 'file',
      kubeconfigPath: filePath
    })
  }

  /** 粘贴 kubeconfig 文本 */
  async importFromText(
    content: string,
    displayName: string,
    meta?: { source?: K8sCluster['source']; kubeconfigPath?: string; wslDistro?: string }
  ): Promise<K8sCluster> {
    const kc = new KubeConfig()
    kc.loadFromString(content)
    const contexts = kc.getContexts().map((context) => context.name)
    if (contexts.length === 0) throw new Error('kubeconfig 中没有可用的 context')

    const currentContext = kc.getCurrentContext() || contexts[0]
    const contextObject = kc.getContextObject(currentContext)
    const clusterName = contextObject?.cluster ?? ''

    const cluster = await this.config.saveCluster({
      name: displayName.trim() || clusterName || 'Kubernetes',
      source: meta?.source ?? 'inline',
      kubeconfigPath: meta?.kubeconfigPath ?? '',
      wslDistro: meta?.wslDistro ?? '',
      context: currentContext,
      namespace: contextObject?.namespace ?? ''
    })

    await this.credentials.set(credentialRef.kubeconfig(cluster.id), content)
    this.runtimes.delete(cluster.id)
    return cluster
  }

  /** 从 WSL 发行版读取 kubeconfig（并内联其中的文件型证书） */
  async importFromWsl(distro: string, configPath: string): Promise<K8sCluster> {
    const raw = await this.wslExec(distro, ['cat', configPath])
    let content = raw.toString('utf8')
    content = await this.inlineWslFiles(content, distro, path.posix.dirname(configPath))
    return await this.importFromText(content, `${distro} · ${configPath}`, {
      source: 'wsl',
      kubeconfigPath: configPath,
      wslDistro: distro
    })
  }

  async listWslDistros(): Promise<string[]> {
    try {
      const buffer = await this.wslExec(null, ['-l', '-q'])
      const text = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
      return text
        .split(/\r?\n/)
        .map((line) => line.replace(/\0/g, '').trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  async removeCluster(id: string): Promise<void> {
    this.stopWatchesOfCluster(id)
    const runtime = this.runtimes.get(id)
    runtime?.tunnel?.close()
    this.runtimes.delete(id)
    await this.credentials.remove(credentialRef.kubeconfig(id))
    await this.config.deleteCluster(id)
  }

  async setContext(clusterId: string, context: string): Promise<K8sCluster> {
    const cluster = this.config.getCluster(clusterId)
    if (!cluster) throw new Error('集群不存在')
    this.runtimes.delete(clusterId)
    return await this.config.saveCluster({ id: clusterId, context, namespace: '' })
  }

  async setNamespace(clusterId: string, namespace: string): Promise<void> {
    await this.config.saveCluster({ id: clusterId, namespace })
  }

  async setTunnel(clusterId: string, sessionId: string | null): Promise<K8sCluster> {
    const runtime = this.runtimes.get(clusterId)
    runtime?.tunnel?.close()
    this.runtimes.delete(clusterId)
    return await this.config.saveCluster({ id: clusterId, tunnelSessionId: sessionId })
  }

  /** 取 Pod 的容器名列表（日志 / Exec 需要指定容器） */
  async podContainers(clusterId: string, namespace: string, pod: string): Promise<string[]> {
    const runtime = await this.ensureRuntime(clusterId)
    const object = await this.rawGet<KubeObject>(
      runtime,
      `/api/v1/namespaces/${namespace}/pods/${pod}`
    )
    const spec = (object.spec ?? {}) as { containers?: { name?: string }[] }
    return (spec.containers ?? []).map((container) => container.name ?? '').filter(Boolean)
  }

  async connect(clusterId: string): Promise<K8sClusterInfo> {
    const runtime = await this.ensureRuntime(clusterId)
    await this.config.touchCluster(clusterId)
    return {
      clusterId,
      name: runtime.cluster.name,
      version: runtime.version,
      contexts: runtime.kc.getContexts().map((context) => context.name),
      currentContext: runtime.kc.getCurrentContext(),
      tunnelActive: Boolean(runtime.tunnel)
    }
  }

  async listNamespaces(clusterId: string): Promise<string[]> {
    const runtime = await this.ensureRuntime(clusterId)
    const result = await this.rawGet<RawList<KubeObject>>(runtime, '/api/v1/namespaces?limit=500')
    return result.items.map((item) => item.metadata?.name ?? '').filter(Boolean).sort()
  }

  async listResourceTypes(clusterId: string): Promise<K8sResourceType[]> {
    const runtime = await this.ensureRuntime(clusterId)
    if (runtime.resourceTypes) return runtime.resourceTypes

    const types: K8sResourceType[] = []

    const pushList = (list: ApiResourceList, group: string): void => {
      const version = list.groupVersion.includes('/')
        ? list.groupVersion.split('/')[1]
        : list.groupVersion
      for (const resource of list.resources) {
        if (resource.name.includes('/')) continue
        if (!resource.verbs?.includes('list')) continue
        types.push({
          apiVersion: list.groupVersion,
          group,
          version,
          kind: resource.kind,
          plural: resource.name,
          namespaced: resource.namespaced,
          verbs: resource.verbs ?? [],
          shortNames: resource.shortNames ?? [],
          category: categoryOf(resource.kind, group)
        })
      }
    }

    const core = await this.rawGet<ApiResourceList>(runtime, '/api/v1')
    pushList(core, '')

    try {
      const groups = await this.rawGet<ApiGroupList>(runtime, '/apis')
      for (const group of groups.groups) {
        const preferred = group.preferredVersion?.version ?? group.versions[0]?.version
        if (!preferred) continue
        try {
          const list = await this.rawGet<ApiResourceList>(runtime, `/apis/${group.name}/${preferred}`)
          pushList(list, group.name)
        } catch {
          /* 单个 group 失败不影响整体 */
        }
      }
    } catch {
      /* 忽略 */
    }

    types.sort((a, b) => a.kind.localeCompare(b.kind))
    runtime.resourceTypes = types
    return types
  }

  async listObjects(clusterId: string, query: K8sListQuery): Promise<K8sListResult> {
    const runtime = await this.ensureRuntime(clusterId)
    const url = this.collectionPath(runtime, query)
    const params = new URLSearchParams()
    params.set('limit', String(query.limit ?? 500))
    if (query.labelSelector) params.set('labelSelector', query.labelSelector)

    const result = await this.rawGet<RawList<KubeObject>>(runtime, `${url}?${params.toString()}`)
    return {
      items: (result.items ?? []).map((item) => summarize(item, query.kind)),
      resourceVersion: result.metadata?.resourceVersion ?? '',
      truncated: Boolean(result.metadata?.continue)
    }
  }

  async getObjectYaml(
    clusterId: string,
    query: { apiVersion: string; kind: string; namespace: string; name: string }
  ): Promise<string> {
    const runtime = await this.ensureRuntime(clusterId)
    const object = await this.rawGet<KubeObject>(
      runtime,
      `${this.collectionPath(runtime, query)}/${query.name}`
    )
    if (object.metadata) delete object.metadata.managedFields
    return yaml.dump(object, { noRefs: true, lineWidth: -1, sortKeys: false })
  }

  async startWatch(clusterId: string, query: K8sWatchQuery): Promise<void> {
    const runtime = await this.ensureRuntime(clusterId)
    this.stopWatch(query.watchId)

    const state: WatchState = { aborted: false, retries: 0, resourceVersion: '' }
    this.watches.set(query.watchId, state)
    const url = this.collectionPath(runtime, query)

    const start = (): void => {
      if (state.aborted) return
      const watcher = new Watch(runtime.kc)
      const params: Record<string, unknown> = {
        allowWatchBookmarks: true,
        timeoutSeconds: 240
      }
      if (state.resourceVersion) params.resourceVersion = state.resourceVersion

      void watcher
        .watch(
          url,
          params,
          (phase: string, apiObj: unknown) => {
            state.retries = 0
            const object = apiObj as KubeObject
            if (object?.metadata?.resourceVersion) state.resourceVersion = object.metadata.resourceVersion
            if (phase === 'BOOKMARK') return
            if (phase === 'ERROR') {
              this.emitWatch({
                watchId: query.watchId,
                type: 'ERROR',
                object: null,
                message: '资源版本已过期，正在重新同步'
              })
              return
            }
            if (phase !== 'ADDED' && phase !== 'MODIFIED' && phase !== 'DELETED') return
            this.emitWatch({
              watchId: query.watchId,
              type: phase,
              object: summarize(object, query.kind),
              message: ''
            })
          },
          (error: unknown) => {
            if (state.aborted) return
            const message = error instanceof Error ? error.message : String(error ?? '')
            state.retries += 1
            if (state.retries > 6) {
              this.emitWatch({
                watchId: query.watchId,
                type: 'ERROR',
                object: null,
                message: message || 'watch 连接中断'
              })
              return
            }
            const delay = Math.min(20000, 1000 * 2 ** state.retries)
            state.timer = setTimeout(start, delay)
          }
        )
        .then((result) => {
          state.abort = () => {
            try {
              result.abort()
            } catch {
              /* ignore */
            }
          }
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.emitWatch({ watchId: query.watchId, type: 'ERROR', object: null, message })
        })
    }

    start()
  }

  stopWatch(watchId: string): void {
    const state = this.watches.get(watchId)
    if (!state) return
    state.aborted = true
    if (state.timer) clearTimeout(state.timer)
    try {
      state.abort?.()
    } catch {
      /* ignore */
    }
    this.watches.delete(watchId)
  }

  async openPodLog(request: K8sPodLogRequest): Promise<BridgeEndpoint> {
    const runtime = await this.ensureRuntime(request.clusterId)
    const channelId = randomUUID()

    const sink = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.ports.push(channelId, Buffer.from(chunk))
        callback()
      }
    })

    const logger = new Log(runtime.kc)
    let handle: { abort: () => void } | null = null

    this.ports.create(channelId, {
      onData: () => undefined,
      onClose: () => {
        try {
          handle?.abort()
        } catch {
          /* ignore */
        }
        this.channels.remove(channelId)
      }
    })

    this.channels.add({
      id: channelId,
      kind: 'k8s',
      sessionId: `k8s:${request.clusterId}`,
      close: () => {
        try {
          handle?.abort()
        } catch {
          /* ignore */
        }
        this.ports.release(channelId, 'k8s-log-closed')
      }
    })

    handle = await logger.log(
      request.namespace,
      request.pod,
      request.container,
      sink,
      {
        follow: true,
        tailLines: request.tailLines,
        timestamps: request.timestamps,
        previous: request.previous
      }
    )

    sink.on('finish', () => this.ports.release(channelId, 'log-finished'))
    return { channelId }
  }

  async openPodExec(request: K8sExecRequest): Promise<BridgeEndpoint> {
    const runtime = await this.ensureRuntime(request.clusterId)
    const channelId = randomUUID()

    const cols = Math.max(20, request.cols)
    const rows = Math.max(5, request.rows)
    const stdin = new PassThrough()
    const stdout = new ResizableSink((chunk) => this.ports.push(channelId, chunk), cols, rows)
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.ports.push(channelId, Buffer.from(chunk))
        callback()
      }
    })

    let socket: { close: () => void } | null = null

    this.ports.create(channelId, {
      onData: (data) => stdin.write(data),
      onResize: (nextCols, nextRows) => stdout.resize(nextCols, nextRows),
      onClose: () => {
        try {
          socket?.close()
        } catch {
          /* ignore */
        }
        stdin.end()
        this.channels.remove(channelId)
      }
    })

    this.channels.add({
      id: channelId,
      kind: 'k8s',
      sessionId: `k8s:${request.clusterId}`,
      close: () => {
        try {
          socket?.close()
        } catch {
          /* ignore */
        }
        this.ports.release(channelId, 'k8s-exec-closed')
      }
    })

    const command =
      request.command && request.command.trim()
        ? ['/bin/sh', '-c', request.command]
        : ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']

    const executor = new Exec(runtime.kc)
    socket = await executor.exec(
      request.namespace,
      request.pod,
      request.container,
      command,
      stdout,
      stderr,
      stdin,
      true,
      () => {
        this.ports.release(channelId, 'exec-exited')
      }
    )

    return { channelId }
  }

  async dispose(): Promise<void> {
    for (const watchId of [...this.watches.keys()]) this.stopWatch(watchId)
    for (const runtime of this.runtimes.values()) runtime.tunnel?.close()
    this.runtimes.clear()
  }

  private stopWatchesOfCluster(clusterId: string): void {
    for (const watchId of [...this.watches.keys()]) {
      if (watchId.startsWith(`k8s:${clusterId}:`)) this.stopWatch(watchId)
    }
  }

  private async ensureRuntime(clusterId: string): Promise<Runtime> {
    const cached = this.runtimes.get(clusterId)
    if (cached) return cached

    const cluster = this.config.getCluster(clusterId)
    if (!cluster) throw new Error('集群配置不存在')

    let content = await this.credentials.get(credentialRef.kubeconfig(clusterId))
    if (!content) {
      content = await this.reloadKubeconfig(cluster)
      await this.credentials.set(credentialRef.kubeconfig(clusterId), content)
    }

    const kc = new KubeConfig()

    if (cluster.source === 'file' && cluster.kubeconfigPath) {
      kc.loadFromFile(cluster.kubeconfigPath)
    } else {
      kc.loadFromString(content)
      if (cluster.kubeconfigPath) {
        const baseDir =
          cluster.source === 'wsl'
            ? path.posix.dirname(cluster.kubeconfigPath)
            : path.dirname(cluster.kubeconfigPath)
        try {
          kc.makePathsAbsolute(baseDir)
        } catch {
          /* 相对路径解析失败时交由连接阶段报错 */
        }
      }
    }
    if (cluster.context) {
      const exists = kc.getContexts().some((context) => context.name === cluster.context)
      if (exists) kc.setCurrentContext(cluster.context)
    }

    const runtime: Runtime = {
      cluster,
      kc,
      objects: KubernetesObjectApi.makeApiClient(kc),
      version: ''
    }

    if (cluster.tunnelSessionId) {
      const current = kc.getCurrentCluster()
      if (!current) throw new Error('kubeconfig 中没有可用的集群')
      const url = new URL(current.server)
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      const tunnel = await this.tunnels.open(cluster.tunnelSessionId, url.hostname, port)
      // Cluster 字段是只读的，只能整体替换
      const index = kc.clusters.findIndex((item) => item.name === current.name)
      if (index < 0) throw new Error('kubeconfig 结构异常：找不到当前集群')
      kc.clusters[index] = {
        ...current,
        server: `https://127.0.0.1:${tunnel.port}`,
        // 保持 SNI 与证书校验使用原始主机名
        tlsServerName: url.hostname
      }
      runtime.tunnel = tunnel
    }

    try {
      const code = await kc.makeApiClient(VersionApi).getCode()
      runtime.version = (code.body as { gitVersion?: string }).gitVersion ?? ''
    } catch (error) {
      runtime.tunnel?.close()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`无法连接集群：${message}`)
    }

    this.runtimes.set(clusterId, runtime)
    return runtime
  }

  private async reloadKubeconfig(cluster: K8sCluster): Promise<string> {
    if (cluster.source === 'wsl') {
      const raw = await this.wslExec(cluster.wslDistro, ['cat', cluster.kubeconfigPath])
      const text = raw.toString('utf8')
      return await this.inlineWslFiles(text, cluster.wslDistro, path.posix.dirname(cluster.kubeconfigPath))
    }
    if (cluster.kubeconfigPath) {
      return await fs.readFile(cluster.kubeconfigPath, 'utf8')
    }
    throw new Error('kubeconfig 已丢失，请重新导入该集群')
  }

  private collectionPath(
    runtime: Runtime,
    query: { apiVersion: string; kind: string; namespace?: string }
  ): string {
    const plural = runtime.resourceTypes?.find(
      (type) => type.kind === query.kind && type.apiVersion === query.apiVersion
    )?.plural
    const resource = plural ?? guessPlural(query.kind)
    const base = query.apiVersion.includes('/')
      ? `/apis/${query.apiVersion}`
      : `/api/${query.apiVersion}`
    const namespace = query.namespace?.trim()
    return namespace ? `${base}/namespaces/${namespace}/${resource}` : `${base}/${resource}`
  }

  private async rawGet<T>(runtime: Runtime, pathname: string): Promise<T> {
    const cluster = runtime.kc.getCurrentCluster()
    if (!cluster) throw new Error('kubeconfig 中没有可用的集群')
    const base = new URL(cluster.server)

    const options: https.RequestOptions = {
      method: 'GET',
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || '443',
      path: `${base.pathname.replace(/\/$/, '')}${pathname}`,
      headers: { accept: 'application/json' },
      timeout: 20000
    }

    await runtime.kc.applyToHTTPSOptions(options)

    return await new Promise<T>((resolve, reject) => {
      const request = https.request(options, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status >= 400) {
            reject(new Error(this.describeStatus(status, body)))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new Error('Kubernetes API 返回了非 JSON 响应'))
          }
        })
      })
      request.on('timeout', () => request.destroy(new Error('请求超时')))
      request.on('error', (error) => reject(new Error(`请求失败：${error.message}`)))
      request.end()
    })
  }

  private describeStatus(status: number, body: string): string {
    if (status === 401) return '认证失败：kubeconfig 凭据可能已过期'
    if (status === 403) return '权限不足：当前凭据没有访问该资源的权限'
    if (status === 404) return '资源不存在，或该 API 版本在集群中不可用'
    try {
      const parsed = JSON.parse(body) as { message?: string }
      return `Kubernetes API ${status}：${parsed.message ?? body.slice(0, 200)}`
    } catch {
      return `Kubernetes API ${status}：${body.slice(0, 200)}`
    }
  }

  private wslExec(distro: string | null, args: string[]): Promise<Buffer> {
    const fullArgs = distro ? ['-d', distro, ...args] : args
    return new Promise((resolve, reject) => {
      execFile(
        'wsl.exe',
        fullArgs,
        { maxBuffer: 20 * 1024 * 1024, encoding: 'buffer', windowsHide: true },
        (error, stdout) => {
          if (error) reject(new Error(`WSL 命令执行失败：${error.message}`))
          else resolve(stdout as unknown as Buffer)
        }
      )
    })
  }

  /** 把 WSL 里的文件型证书 / tokenFile 内联成 data 字段，便于在 Windows 上使用 */
  private async inlineWslFiles(content: string, distro: string, baseDir: string): Promise<string> {
    interface RawKubeconfig {
      clusters?: { name?: string; cluster?: Record<string, unknown> }[]
      users?: { name?: string; user?: Record<string, unknown> }[]
    }

    let parsed: RawKubeconfig | undefined
    try {
      parsed = yaml.load(content) as RawKubeconfig
    } catch {
      return content
    }
    if (!parsed) return content

    const mapping: [Record<string, unknown> | undefined, string, string][] = []
    for (const cluster of parsed.clusters ?? []) {
      mapping.push([cluster.cluster, 'certificate-authority', 'certificate-authority-data'])
    }
    for (const user of parsed.users ?? []) {
      mapping.push([user.user, 'client-certificate', 'client-certificate-data'])
      mapping.push([user.user, 'client-key', 'client-key-data'])
      mapping.push([user.user, 'tokenFile', 'token'])
    }

    let changed = false
    for (const [holder, fileField, dataField] of mapping) {
      if (!holder) continue
      const filePath = holder[fileField]
      if (typeof filePath !== 'string' || !filePath || holder[dataField]) continue
      const absolute = filePath.startsWith('/') ? filePath : path.posix.join(baseDir, filePath)
      try {
        const buffer = await this.wslExec(distro, ['cat', absolute])
        holder[dataField] = buffer.toString('base64').replace(/\n/g, '')
        delete holder[fileField]
        changed = true
      } catch {
        /* 读不到就保持原样，由后续连接报错提示 */
      }
    }

    return changed ? yaml.dump(parsed, { noRefs: true, lineWidth: -1 }) : content
  }
}

function guessPlural(kind: string): string {
  const lower = kind.toLowerCase()
  if (lower.endsWith('s')) return lower
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`
  return `${lower}s`
}
