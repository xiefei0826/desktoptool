import { app, clipboard, dialog, ipcMain, shell } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  K8sExecRequest,
  K8sListQuery,
  K8sObjectRef,
  K8sPodLogRequest,
  K8sWatchQuery
} from '../shared/types'
import type {
  AppConfig,
  AppSettings,
  ForwardRule,
  GroupConfig,
  SessionInput,
  SftpProgress
} from '../shared/types'
import type {
  LocalTerminalOptions,
  SftpDownloadOptions,
  SftpUploadOptions,
  SshConnectInput,
  SshOpenShellOptions
} from '../shared/api'
import type { AppServices } from './services'
import { createWindow } from './window-manager'

export function registerIpc(services: AppServices): void {
  const { config, credentials } = services

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    ptyAvailable: services.pty.available,
    userDataPath: services.userDataPath
  }))

  ipcMain.handle('app:openUserData', async () => {
    await shell.openPath(services.userDataPath)
  })

  ipcMain.handle('window:new', (_event, sessionId?: string) => {
    createWindow(sessionId)
  })

  ipcMain.handle('app:pickFile', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog({
      title: title ?? '选择文件',
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? '' : result.filePaths[0]
  })

  ipcMain.handle('config:get', () => config.snapshot())

  ipcMain.handle('config:saveSession', async (_event, input: SessionInput) => {
    const saved = await config.saveSession(input)
    services.notifyConfigChanged()
    return saved
  })

  ipcMain.handle('config:deleteSession', async (_event, id: string) => {
    await services.ssh.disconnect(id)
    await credentials.removePrefix(`session:${id}:`)
    await config.deleteSession(id)
    services.notifyConfigChanged()
  })

  ipcMain.handle('config:touchSession', async (_event, id: string) => {
    await config.touchSession(id)
    services.notifyConfigChanged()
  })

  ipcMain.handle('config:saveGroup', async (_event, input: Partial<GroupConfig>) => {
    const group = await config.saveGroup(input)
    services.notifyConfigChanged()
    return group
  })

  ipcMain.handle('config:deleteGroup', async (_event, id: string) => {
    await config.deleteGroup(id)
    services.notifyConfigChanged()
  })

  ipcMain.handle('config:saveSettings', async (_event, patch: Partial<AppSettings>) => {
    const settings = await config.saveSettings(patch)
    services.notifyConfigChanged()
    return settings
  })

  ipcMain.handle('config:saveForward', async (_event, input: Partial<ForwardRule>) => {
    const rule = await config.saveForward(input)
    services.notifyConfigChanged()
    return rule
  })

  ipcMain.handle('config:deleteForward', async (_event, id: string) => {
    await services.forward.stop(id)
    await config.deleteForward(id)
    services.notifyConfigChanged()
  })

  ipcMain.handle('config:exportConfig', async (_event, includeSecrets: boolean) => {
    const result = await dialog.showSaveDialog({
      title: '导出连接配置',
      defaultPath: path.join(app.getPath('documents'), `desktop-tool-config-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, path: '' }

    const payload: Record<string, unknown> = { config: config.snapshot() }
    if (includeSecrets) payload.secrets = await credentials.exportAll()
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: result.filePath }
  })

  ipcMain.handle('config:importConfig', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入连接配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, message: '已取消' }

    try {
      const raw = await fs.readFile(result.filePaths[0], 'utf8')
      const parsed = JSON.parse(raw) as { config?: Partial<AppConfig>; secrets?: Record<string, string> }
      if (!parsed.config) throw new Error('文件格式不正确：缺少 config 字段')
      await config.replaceAll(parsed.config)
      if (parsed.secrets) {
        await credentials.importAll(parsed.secrets, config.settings().allowPlaintextCredential)
      }
      services.notifyConfigChanged()
      return { ok: true, message: '导入完成，请重新连接以刷新状态' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  ipcMain.handle('credential:status', () => credentials.status())

  ipcMain.handle('credential:set', async (_event, ref: string, secret: string, allowPlaintext?: boolean) => {
    await credentials.set(ref, secret, allowPlaintext ?? config.settings().allowPlaintextCredential)
  })

  ipcMain.handle('credential:remove', (_event, ref: string) => credentials.remove(ref))

  ipcMain.handle('credential:has', (_event, ref: string) => credentials.has(ref))

  ipcMain.handle('ssh:connect', async (_event, input: SshConnectInput) => {
    await services.ssh.connect(input)
    await config.touchSession(input.sessionId)
  })

  ipcMain.handle('ssh:disconnect', async (_event, sessionId: string) => {
    await services.forward.stopBySession(sessionId)
    await services.ssh.disconnect(sessionId)
  })

  ipcMain.handle('ssh:openShell', (_event, options: SshOpenShellOptions) => services.ssh.openShell(options))

  ipcMain.handle('ssh:isConnected', (_event, sessionId: string) => services.ssh.isConnected(sessionId))

  ipcMain.handle('pty:create', (_event, options: LocalTerminalOptions) =>
    services.pty.create(options.cols, options.rows, options.shell)
  )

  ipcMain.handle('stream:attach', (event, channelId: string) =>
    services.ports.attach(channelId, event.sender)
  )

  ipcMain.handle('channel:close', (_event, channelId: string) => {
    services.channels.close(channelId)
  })

  ipcMain.handle('sftp:list', (_event, sessionId: string, target: string) =>
    services.sftp.list(sessionId, target)
  )

  ipcMain.handle('sftp:home', (_event, sessionId: string) => services.sftp.home(sessionId))

  ipcMain.handle('sftp:mkdir', (_event, sessionId: string, target: string) =>
    services.sftp.mkdir(sessionId, target)
  )

  ipcMain.handle('sftp:rename', (_event, sessionId: string, from: string, to: string) =>
    services.sftp.rename(sessionId, from, to)
  )

  ipcMain.handle('sftp:remove', (_event, sessionId: string, target: string, isDir: boolean) =>
    services.sftp.remove(sessionId, target, isDir)
  )

  ipcMain.handle('sftp:readText', (_event, sessionId: string, target: string) =>
    services.sftp.readText(sessionId, target)
  )

  ipcMain.handle('sftp:writeText', (_event, sessionId: string, target: string, content: string) =>
    services.sftp.writeText(sessionId, target, content)
  )

  ipcMain.handle('sftp:upload', async (_event, options: SftpUploadOptions) => {
    let localPaths = options.localPaths ?? []
    if (localPaths.length === 0) {
      const result = await dialog.showOpenDialog({
        title: '选择要上传的文件',
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled) return { uploaded: 0, canceld: true }
      localPaths = result.filePaths
    }
    const uploaded = await services.sftp.upload(options.sessionId, options.remoteDir, localPaths)
    return { ...uploaded, canceld: false }
  })

  ipcMain.handle('sftp:download', async (_event, options: SftpDownloadOptions) => {
    let localDir = options.localDir ?? ''
    if (!localDir) {
      const result = await dialog.showOpenDialog({
        title: '选择下载目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return { downloaded: 0 }
      localDir = result.filePaths[0]
    }
    return services.sftp.download(options.sessionId, options.remotePaths, localDir)
  })

  ipcMain.handle('forward:list', () => services.forward.list())

  ipcMain.handle('forward:start', (_event, ruleId: string) => services.forward.start(ruleId))

  ipcMain.handle('forward:stop', (_event, ruleId: string) => services.forward.stop(ruleId))

  ipcMain.handle('rd:detect', () => services.rd.detect())

  ipcMain.handle('rd:launch', (_event, sessionId: string) => services.rd.launch(sessionId))

  ipcMain.handle('k8s:listClusters', () => services.k8s.listClusters())

  ipcMain.handle('k8s:importFromFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 kubeconfig 文件',
      defaultPath: path.join(os.homedir(), '.kube'),
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) throw new Error('已取消导入')
    const cluster = await services.k8s.importFromFile(result.filePaths[0])
    services.notifyConfigChanged()
    return cluster
  })

  ipcMain.handle('k8s:importFromDefault', async () => {
    const file = path.join(os.homedir(), '.kube', 'config')
    if (!existsSync(file)) throw new Error('未找到 ~/.kube/config')
    const cluster = await services.k8s.importFromFile(file, 'kubeconfig')
    services.notifyConfigChanged()
    return cluster
  })

  ipcMain.handle('k8s:importFromText', async (_event, text: string, name: string) => {
    const cluster = await services.k8s.importFromText(text, name)
    services.notifyConfigChanged()
    return cluster
  })

  ipcMain.handle('k8s:importFromWsl', async (_event, distro: string, configPath: string) => {
    const cluster = await services.k8s.importFromWsl(distro, configPath)
    services.notifyConfigChanged()
    return cluster
  })

  ipcMain.handle('k8s:listWslDistros', () => services.k8s.listWslDistros())

  ipcMain.handle('k8s:defaultKubeconfigPath', () => path.join(os.homedir(), '.kube', 'config'))

  ipcMain.handle('k8s:removeCluster', async (_event, id: string) => {
    await services.k8s.removeCluster(id)
    services.notifyConfigChanged()
  })

  ipcMain.handle('k8s:setContext', async (_event, clusterId: string, context: string) =>
    services.k8s.setContext(clusterId, context)
  )

  ipcMain.handle('k8s:setNamespace', (_event, clusterId: string, namespace: string) =>
    services.k8s.setNamespace(clusterId, namespace)
  )

  ipcMain.handle('k8s:setTunnel', async (_event, clusterId: string, sessionId: string | null) => {
    const cluster = await services.k8s.setTunnel(clusterId, sessionId)
    services.notifyConfigChanged()
    return cluster
  })

  ipcMain.handle('k8s:podContainers', (_event, clusterId: string, namespace: string, pod: string) =>
    services.k8s.podContainers(clusterId, namespace, pod)
  )

  ipcMain.handle('k8s:connect', (_event, clusterId: string) => services.k8s.connect(clusterId))

  ipcMain.handle('k8s:listNamespaces', (_event, clusterId: string) =>
    services.k8s.listNamespaces(clusterId)
  )

  ipcMain.handle('k8s:resourceTypes', (_event, clusterId: string) =>
    services.k8s.listResourceTypes(clusterId)
  )

  ipcMain.handle('k8s:listObjects', (_event, clusterId: string, query: K8sListQuery) =>
    services.k8s.listObjects(clusterId, query)
  )

  ipcMain.handle(
    'k8s:getObjectYaml',
    (
      _event,
      clusterId: string,
      query: { apiVersion: string; kind: string; namespace: string; name: string }
    ) => services.k8s.getObjectYaml(clusterId, query)
  )

  ipcMain.handle('k8s:applyObject', (_event, clusterId: string, yamlText: string) =>
    services.k8s.applyObject(clusterId, yamlText)
  )

  ipcMain.handle('k8s:deleteObject', (_event, clusterId: string, query: K8sObjectRef) =>
    services.k8s.deleteObject(clusterId, query)
  )

  ipcMain.handle(
    'k8s:scaleObject',
    (_event, clusterId: string, query: K8sObjectRef & { replicas: number }) =>
      services.k8s.scaleObject(clusterId, query)
  )

  ipcMain.handle('k8s:restartObject', (_event, clusterId: string, query: K8sObjectRef) =>
    services.k8s.restartObject(clusterId, query)
  )

  ipcMain.handle('k8s:startWatch', (_event, clusterId: string, query: K8sWatchQuery) =>
    services.k8s.startWatch(clusterId, query)
  )

  ipcMain.handle('k8s:stopWatch', (_event, watchId: string) => {
    services.k8s.stopWatch(watchId)
  })

  ipcMain.handle('k8s:openLog', (_event, request: K8sPodLogRequest) =>
    services.k8s.openPodLog(request)
  )

  ipcMain.handle('k8s:openExec', (_event, request: K8sExecRequest) =>
    services.k8s.openPodExec(request)
  )

  ipcMain.handle('clipboard:read', () => clipboard.readText())

  ipcMain.handle('clipboard:write', (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('vnc:open', async (_event, sessionId: string) => {
    const session = config.getSession(sessionId)
    if (!session) throw new Error('连接配置不存在')
    if (session.protocol !== 'vnc') throw new Error('该连接不是 VNC 协议')
    return services.vnc.open(session)
  })
}

export type { SftpProgress }
