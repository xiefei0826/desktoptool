import type { BrowserWindow } from 'electron'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { defaultRdpOptions } from '../shared/defaults'
import type { AppServices } from './services'
import { splitStatements } from './db/service'

const HOST = '127.0.0.1'
const SSH_PORT = Number(process.env.SMOKE_SSH_PORT ?? 2222)
const SSH_USER = process.env.SMOKE_SSH_USER ?? 'admin'
const SSH_PASS = process.env.SMOKE_SSH_PASSWORD ?? 'admin'
const INTERNAL_PORT = Number(process.env.SMOKE_INTERNAL_PORT ?? 9099)

function httpGet(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: HOST, port, path: '/', timeout: 5000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => resolve(body))
    })
    request.on('timeout', () => request.destroy(new Error('http timeout')))
    request.on('error', reject)
  })
}

function socksGet(proxyPort: number, destHost: string, destPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, HOST)
    let stage = 'greeting'
    let body = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('socks timeout'))
    }, 8000)

    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('data', (data) => {
      if (stage === 'greeting') {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer)
          reject(new Error('socks auth rejected'))
          return
        }
        const octets = destHost.split('.').map((part) => Number(part))
        socket.write(
          Buffer.from([0x05, 0x01, 0x00, 0x01, ...octets, (destPort >> 8) & 0xff, destPort & 0xff])
        )
        stage = 'connect'
        return
      }

      if (stage === 'connect') {
        if (data[0] !== 0x05 || data[1] !== 0x00) {
          clearTimeout(timer)
          reject(new Error('socks connect rejected'))
          return
        }
        const rest = data.subarray(10).toString('utf8')
        stage = 'body'
        socket.write('GET / HTTP/1.0\r\nHost: mock\r\n\r\n')
        if (rest) body += rest
        return
      }

      body += data.toString('utf8')
      if (body.includes('mock-internal-ok')) {
        clearTimeout(timer)
        socket.destroy()
        resolve(body)
      }
    })
  })
}

/**
 * K8s 端到端自检：导入本机 ~/.kube/config → 连接 → discovery → 命名空间 → Pod 列表 → YAML → watch
 * 结束后自动清理，不会在你的集群里留下任何资源。
 */
export async function runK8sSmoke(
  services: AppServices,
  window: BrowserWindow
): Promise<string[]> {
  const logs: string[] = []
  const kubeconfig = path.join(os.homedir(), '.kube', 'config')

  const cluster = await services.k8s.importFromFile(kubeconfig, '__smoke_k8s__')
  try {
    const info = await services.k8s.connect(cluster.id)
    logs.push(`k8s-connect ok (${info.version || 'unknown'} @ ${info.currentContext})`)

    const types = await services.k8s.listResourceTypes(cluster.id)
    logs.push(`k8s-discovery ok (${types.length} types)`)

    const namespaces = await services.k8s.listNamespaces(cluster.id)
    logs.push(`k8s-namespaces ok (${namespaces.length})`)

    const pods = await services.k8s.listObjects(cluster.id, {
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: ''
    })
    logs.push(`k8s-pods ok (${pods.items.length})`)

    const firstPod = pods.items.find((pod) => pod.status === 'Running') ?? pods.items[0]
    if (firstPod) {
      const objectYaml = await services.k8s.getObjectYaml(cluster.id, {
        apiVersion: 'v1',
        kind: 'Pod',
        namespace: firstPod.namespace,
        name: firstPod.name
      })
      logs.push(`k8s-yaml ok (${objectYaml.length} chars)`)

      const containers = await services.k8s.podContainers(
        cluster.id,
        firstPod.namespace,
        firstPod.name
      )
      logs.push(`k8s-containers ok (${containers.join(',') || 'none'})`)

      const execResult = (await window.webContents.executeJavaScript(`(async () => {
        const containers = await window.api.k8s.podContainers(
          ${JSON.stringify(cluster.id)},
          ${JSON.stringify(firstPod.namespace)},
          ${JSON.stringify(firstPod.name)}
        )
        if (containers.length === 0) return { ok: false, reason: 'no-container' }
        const endpoint = await window.api.k8s.openExec({
          clusterId: ${JSON.stringify(cluster.id)},
          namespace: ${JSON.stringify(firstPod.namespace)},
          pod: ${JSON.stringify(firstPod.name)},
          container: containers[0],
          command: 'echo smoke-exec-ok',
          cols: 100,
          rows: 30
        })
        return await new Promise((resolve) => {
          let buffer = ''
          const finish = (result) => {
            try { window.api.stream.close(endpoint.channelId) } catch (e) { /* ignore */ }
            resolve(result)
          }
          const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 15000)
          window.api.stream.open(endpoint.channelId, {
            onData: (data) => {
              buffer += new TextDecoder().decode(data)
              if (buffer.includes('smoke-exec-ok')) {
                clearTimeout(timer)
                finish({ ok: true })
              }
            },
            onClose: () => {
              clearTimeout(timer)
              finish({ ok: buffer.includes('smoke-exec-ok'), reason: 'closed' })
            }
          }).catch((error) => {
            clearTimeout(timer)
            finish({ ok: false, reason: String(error) })
          })
        })
      })()`)) as { ok: boolean; reason?: string }

      logs.push(`k8s-exec ok (${execResult.ok}${execResult.ok ? '' : ` ${execResult.reason ?? ''}`})`)
    }

    await services.k8s.startWatch(cluster.id, {
      watchId: `smoke:${cluster.id}`,
      apiVersion: 'v1',
      kind: 'Pod',
      namespace: ''
    })
    await new Promise((resolve) => setTimeout(resolve, 2500))
    services.k8s.stopWatch(`smoke:${cluster.id}`)
    logs.push('k8s-watch ok (subscribed)')
  } finally {
    await services.k8s.removeCluster(cluster.id).catch(() => undefined)
  }

  return logs
}

/**
 * 数据库自检：SQL 拆分 / 解析（含错误分支）/ 连接失败提示
 * 不依赖任何真实数据库，纯本地验证。
 */
export async function runDbSmoke(services: AppServices): Promise<string[]> {
  const logs: string[] = []

  const parsed = services.db.parse(
    'mysql',
    "SELECT u.id, u.name FROM users u WHERE u.id = 1;\nUPDATE users SET name = 'x' WHERE id = 1"
  )
  logs.push(
    `db-parse ok (${parsed.statements.length} stmts, types=${parsed.statements
      .map((item) => item.type)
      .join('/')}, tables=${parsed.tables.join(',')}, error=${parsed.error || 'none'})`
  )

  const broken = services.db.parse('mysql', 'SELECT FROM WHERE')
  logs.push(`db-parse-error ok (${Boolean(broken.error)})`)

  const split = splitStatements("SELECT ';' AS a; -- 注释; 里也有分号\nSELECT 2; /* ; */ SELECT 3;")
  logs.push(`db-split ok (${split.length === 3})`)

  const pgBody = splitStatements(
    "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1;"
  )
  logs.push(`db-split-dollar-quote ok (${pgBody.length === 2})`)

  const postgres = services.db.parse('postgres', 'SELECT now() AS ts; CREATE TABLE t (id int)')
  logs.push(`db-parse-postgres ok (${postgres.statements.length === 2 && !postgres.error})`)

  const connection = await services.config.saveDbConnection({
    name: '__smoke_db__',
    kind: 'mysql',
    host: '127.0.0.1',
    port: 3399,
    username: 'root',
    database: ''
  })

  try {
    await services.db.testConnection(connection, 'x')
    logs.push('db-connect-error ok (false)')
  } catch (error) {
    logs.push(
      `db-connect-error ok (${/连接被拒绝|连接超时|认证失败/.test((error as Error).message)})`
    )
  } finally {
    await services.config.deleteDbConnection(connection.id).catch(() => undefined)
  }

  return logs
}

/**
 * K8s 写操作自检：创建 ConfigMap → 再次 apply 更新 → 读取校验 → 删除 → 确认已消失
 * 只在 default 命名空间里用一个固定名字的 ConfigMap 做验证，结束后清理。
 */
export async function runK8sWriteSmoke(services: AppServices): Promise<string[]> {
  const logs: string[] = []
  const kubeconfig = path.join(os.homedir(), '.kube', 'config')
  const cluster = await services.k8s.importFromFile(kubeconfig, '__smoke_k8s_write__')

  const yamlOf = (stage: string): string =>
    [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata:',
      '  name: desktop-tool-smoke',
      '  namespace: default',
      'data:',
      `  stage: "${stage}"`,
      ''
    ].join('\n')

  try {
    await services.k8s.connect(cluster.id)

    const created = await services.k8s.applyObject(cluster.id, yamlOf('1'))
    logs.push(`k8s-apply-create ok (${created})`)

    await services.k8s.applyObject(cluster.id, yamlOf('2'))
    const current = await services.k8s.getObjectYaml(cluster.id, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'default',
      name: 'desktop-tool-smoke'
    })
    const parsed = yaml.load(current) as { data?: { stage?: string } } | null
    logs.push(`k8s-apply-update ok (${parsed?.data?.stage === '2'})`)

    await services.k8s.deleteObject(cluster.id, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'default',
      name: 'desktop-tool-smoke'
    })

    const remaining = await services.k8s.listObjects(cluster.id, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      namespace: 'default'
    })
    logs.push(
      `k8s-delete ok (${!remaining.items.some((item) => item.name === 'desktop-tool-smoke')})`
    )
  } finally {
    await services.k8s.removeCluster(cluster.id).catch(() => undefined)
  }

  return logs
}

/**
 * 端到端自检：
 * SSH 连接 → 渲染进程真实链路（MessagePort 终端流）→ 本地转发 → 动态 SOCKS5
 */
export async function runSshSmoke(services: AppServices, window: BrowserWindow): Promise<string[]> {
  const logs: string[] = []
  const createdForwards: string[] = []

  const session = await services.config.saveSession({
    name: '__smoke__',
    groupId: null,
    protocol: 'ssh',
    host: HOST,
    port: SSH_PORT,
    username: SSH_USER,
    authType: 'password',
    privateKeyPath: '',
    tunnelSessionId: null,
    rdp: defaultRdpOptions(),
    note: 'smoke test'
  })

  try {
    await services.ssh.connect({ sessionId: session.id, password: SSH_PASS })
    logs.push('ssh-connect ok')

    const shellResult = (await window.webContents.executeJavaScript(`(async () => {
      const endpoint = await window.api.ssh.openShell({
        sessionId: ${JSON.stringify(session.id)},
        cols: 100,
        rows: 30
      })
      return await new Promise((resolve, reject) => {
        let buffer = ''
        let sent = false
        const timer = setTimeout(() => reject(new Error('shell timeout')), 8000)
        window.api.stream.open(endpoint.channelId, {
          onData: (data) => {
            buffer += new TextDecoder().decode(data)
            if (!sent && buffer.includes('Mock SSH')) {
              sent = true
              window.api.stream.write(
                endpoint.channelId,
                new TextEncoder().encode('echo smoke-ok\\r\\n')
              )
            }
            if (buffer.includes('smoke-ok')) {
              clearTimeout(timer)
              window.api.stream.close(endpoint.channelId)
              resolve({ ok: true, buffer })
            }
          },
          onClose: () => {
            clearTimeout(timer)
            reject(new Error('channel closed early'))
          }
        }).catch(reject)
      })
    })()`)) as { ok: boolean; buffer: string }

    logs.push(`ssh-shell ok (${shellResult.ok})`)

    const rdClients = await services.rd.detect()
    logs.push(
      `rd-detect ok (${rdClients.map((client) => `${client.id}:${client.available ? 'yes' : 'no'}`).join(',')})`
    )

    const localRule = await services.config.saveForward({
      name: '__smoke_local__',
      sessionId: session.id,
      type: 'local',
      bindHost: HOST,
      bindPort: 18080,
      destHost: HOST,
      destPort: INTERNAL_PORT,
      autoStart: false
    })
    createdForwards.push(localRule.id)
    await services.forward.start(localRule.id)
    const localBody = await httpGet(18080)
    logs.push(`local-forward ok (${localBody.includes('mock-internal-ok')})`)

    const socksRule = await services.config.saveForward({
      name: '__smoke_socks__',
      sessionId: session.id,
      type: 'dynamic',
      bindHost: HOST,
      bindPort: 11080,
      destHost: '',
      destPort: 0,
      autoStart: false
    })
    createdForwards.push(socksRule.id)
    await services.forward.start(socksRule.id)
    const socksBody = await socksGet(11080, HOST, INTERNAL_PORT)
    logs.push(`socks5-forward ok (${socksBody.includes('mock-internal-ok')})`)
  } finally {
    for (const ruleId of createdForwards) {
      await services.forward.stop(ruleId).catch(() => undefined)
      await services.config.deleteForward(ruleId).catch(() => undefined)
    }
    await services.ssh.disconnect(session.id).catch(() => undefined)
    await services.config.deleteSession(session.id).catch(() => undefined)
  }

  return logs
}
