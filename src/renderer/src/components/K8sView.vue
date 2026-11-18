<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  K8sCategory,
  K8sClusterInfo,
  K8sObjectRef,
  K8sObjectSummary,
  K8sResourceType
} from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import { registerK8sWatch } from '../lib/k8s-watch'
import { ageOf } from '../lib/format'
import Icon from './Icon.vue'

const props = defineProps<{ clusterId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()

const CATEGORY_LABELS: Record<K8sCategory, string> = {
  workload: '工作负载',
  network: '网络',
  storage: '存储',
  config: '配置',
  cluster: '集群',
  custom: '自定义资源'
}
const CATEGORY_ORDER: K8sCategory[] = ['workload', 'network', 'storage', 'config', 'cluster', 'custom']

const info = ref<K8sClusterInfo | null>(null)
const loading = ref(true)
const errorText = ref('')
const contexts = ref<string[]>([])
const currentContext = ref('')
const namespaces = ref<string[]>([])
const namespace = ref('')
const resourceTypes = ref<K8sResourceType[]>([])
const typeFilter = ref('')
const activeType = ref<K8sResourceType | null>(null)
const items = ref<K8sObjectSummary[]>([])
const nameFilter = ref('')
const listing = ref(false)
const listError = ref('')
const selected = ref<K8sObjectSummary | null>(null)
const yamlText = ref('')
const yamlLoading = ref(false)
const picker = ref<{ pod: K8sObjectSummary; containers: string[]; mode: 'log' | 'exec' } | null>(null)

const expandedCategories = ref<Set<K8sCategory>>(loadExpandedCategories())
const editing = ref(false)
const editText = ref('')
const saving = ref(false)
const scaleModal = ref(false)
const scaleValue = ref('1')

let watchId = ''
let unregisterWatch: (() => void) | null = null

const groupedTypes = computed(() =>
  CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    types: resourceTypes.value.filter(
      (type) =>
        type.category === category &&
        (!typeFilter.value ||
          type.kind.toLowerCase().includes(typeFilter.value.toLowerCase()) ||
          type.plural.toLowerCase().includes(typeFilter.value.toLowerCase()))
    )
  })).filter((group) => group.types.length > 0)
)

const visibleItems = computed(() => {
  const keyword = nameFilter.value.trim().toLowerCase()
  if (!keyword) return items.value
  return items.value.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) || item.namespace.toLowerCase().includes(keyword)
  )
})

const clusterName = computed(
  () => store.clusters.find((cluster) => cluster.id === props.clusterId)?.name ?? 'Kubernetes'
)

const scalable = computed(() =>
  ['Deployment', 'StatefulSet', 'ReplicaSet'].includes(selected.value?.kind ?? '')
)
const restartable = computed(() =>
  ['Deployment', 'StatefulSet', 'DaemonSet'].includes(selected.value?.kind ?? '')
)

function loadExpandedCategories(): Set<K8sCategory> {
  try {
    const raw = localStorage.getItem('dt.k8s.expanded')
    if (raw) return new Set(JSON.parse(raw) as K8sCategory[])
  } catch {
    /* ignore */
  }
  return new Set()
}

function persistExpanded(): void {
  try {
    localStorage.setItem('dt.k8s.expanded', JSON.stringify([...expandedCategories.value]))
  } catch {
    /* ignore */
  }
}

function toggleCategory(category: K8sCategory): void {
  const next = new Set(expandedCategories.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  expandedCategories.value = next
  persistExpanded()
}

function isExpanded(category: K8sCategory): boolean {
  return typeFilter.value.trim() !== '' || expandedCategories.value.has(category)
}

function objectRef(): K8sObjectRef | null {
  const row = selected.value
  if (!row) return null
  return {
    apiVersion: row.apiVersion || activeType.value?.apiVersion || 'v1',
    kind: row.kind || activeType.value?.kind || '',
    namespace: row.namespace,
    name: row.name
  }
}

function startEdit(): void {
  editing.value = true
  editText.value = yamlText.value
}

function cancelEdit(): void {
  editing.value = false
  editText.value = ''
}

async function saveEdit(): Promise<void> {
  saving.value = true
  try {
    const message = await window.api.k8s.applyObject(props.clusterId, editText.value)
    editing.value = false
    emit('notice', 'success', message)
    await refreshList()
    const current = selected.value
    if (current) await selectObject(current)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function deleteSelected(): Promise<void> {
  const ref = objectRef()
  if (!ref) return
  if (!window.confirm(`确定删除 ${ref.kind} ${ref.name}？此操作不可撤销。`)) return
  try {
    await window.api.k8s.deleteObject(props.clusterId, ref)
    emit('notice', 'success', `已删除 ${ref.name}`)
    closeDetail()
    await refreshList()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function askScale(): void {
  const statusText = selected.value?.status ?? ''
  const replicas = statusText.includes('/') ? statusText.split('/')[1] : '1'
  scaleValue.value = String(Number(replicas) || 1)
  scaleModal.value = true
}

async function confirmScale(): Promise<void> {
  const ref = objectRef()
  const replicas = Number(scaleValue.value)
  if (!ref) return
  if (!Number.isFinite(replicas) || replicas < 0) {
    emit('notice', 'error', '请输入合法的副本数')
    return
  }
  scaleModal.value = false
  try {
    await window.api.k8s.scaleObject(props.clusterId, { ...ref, replicas })
    emit('notice', 'success', `已将 ${ref.name} 扩缩到 ${replicas} 个副本`)
    await refreshList()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function restartSelected(): Promise<void> {
  const ref = objectRef()
  if (!ref) return
  if (!window.confirm(`对 ${ref.kind} ${ref.name} 触发滚动重启？`)) return
  try {
    await window.api.k8s.restartObject(props.clusterId, ref)
    emit('notice', 'success', '已触发滚动重启')
    await refreshList()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function init(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    info.value = await window.api.k8s.connect(props.clusterId)
    contexts.value = info.value.contexts
    currentContext.value = info.value.currentContext
    const cluster = store.clusters.find((item) => item.id === props.clusterId)
    namespace.value = cluster?.namespace ?? ''
    namespaces.value = await window.api.k8s.listNamespaces(props.clusterId)
    resourceTypes.value = await window.api.k8s.resourceTypes(props.clusterId)
    const pods = resourceTypes.value.find((type) => type.kind === 'Pod' && type.apiVersion === 'v1')
    if (pods) await selectType(pods)
  } catch (error) {
    errorText.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function selectType(type: K8sResourceType): Promise<void> {
  if (activeType.value?.apiVersion === type.apiVersion && activeType.value?.kind === type.kind) return
  activeType.value = type
  selected.value = null
  yamlText.value = ''
  items.value = []
  await refreshList()
  await startWatch()
}

async function refreshList(): Promise<void> {
  const type = activeType.value
  if (!type) return
  listing.value = true
  listError.value = ''
  try {
    const result = await window.api.k8s.listObjects(props.clusterId, {
      apiVersion: type.apiVersion,
      kind: type.kind,
      namespace: type.namespaced ? namespace.value : ''
    })
    items.value = result.items
    if (result.truncated) listError.value = '结果超过 500 条，已截断，可用名称搜索缩小范围'
  } catch (error) {
    listError.value = errorMessage(error)
  } finally {
    listing.value = false
  }
}

async function startWatch(): Promise<void> {
  await stopWatch()
  const type = activeType.value
  if (!type) return

  watchId = `k8s:${props.clusterId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
  unregisterWatch = registerK8sWatch(watchId, (event) => {
    if (event.type === 'ERROR') {
      void refreshList()
      return
    }
    if (!event.object) return
    const index = items.value.findIndex((item) => item.uid === event.object?.uid)
    if (event.type === 'DELETED') {
      if (index >= 0) items.value.splice(index, 1)
      if (selected.value?.uid === event.object.uid) closeDetail()
      return
    }
    if (index >= 0) items.value.splice(index, 1, event.object)
    else items.value.unshift(event.object)
    if (selected.value?.uid === event.object.uid) selected.value = event.object
  })

  try {
    await window.api.k8s.startWatch(props.clusterId, {
      watchId,
      apiVersion: type.apiVersion,
      kind: type.kind,
      namespace: type.namespaced ? namespace.value : ''
    })
  } catch (error) {
    listError.value = `实时刷新不可用：${errorMessage(error)}`
  }
}

async function stopWatch(): Promise<void> {
  unregisterWatch?.()
  unregisterWatch = null
  if (!watchId) return
  const id = watchId
  watchId = ''
  try {
    await window.api.k8s.stopWatch(id)
  } catch {
    /* ignore */
  }
}

async function changeContext(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value
  if (!next || next === currentContext.value) return
  try {
    await window.api.k8s.setContext(props.clusterId, next)
    await store.reloadClusters()
    await init()
    emit('notice', 'success', `已切换到 context：${next}`)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function changeNamespace(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value
  namespace.value = next
  try {
    await window.api.k8s.setNamespace(props.clusterId, next)
  } catch {
    /* 忽略：仅影响下次默认值 */
  }
  await refreshList()
  await startWatch()
}

async function selectObject(row: K8sObjectSummary): Promise<void> {
  selected.value = row
  editing.value = false
  editText.value = ''
  yamlText.value = ''
  yamlLoading.value = true
  try {
    yamlText.value = await window.api.k8s.getObjectYaml(props.clusterId, {
      apiVersion: row.apiVersion || activeType.value?.apiVersion || 'v1',
      kind: row.kind || activeType.value?.kind || '',
      namespace: row.namespace,
      name: row.name
    })
  } catch (error) {
    yamlText.value = `# 加载失败：${errorMessage(error)}`
  } finally {
    yamlLoading.value = false
  }
}

function closeDetail(): void {
  selected.value = null
  yamlText.value = ''
  editing.value = false
  editText.value = ''
}

async function copyName(row: K8sObjectSummary): Promise<void> {
  await window.api.clipboard.write(row.name)
  emit('notice', 'success', `已复制 ${row.name}`)
}

async function copyYaml(): Promise<void> {
  if (!yamlText.value) return
  await window.api.clipboard.write(yamlText.value)
  emit('notice', 'success', '已复制 YAML')
}

async function refreshAll(): Promise<void> {
  await refreshList()
  await startWatch()
}

async function chooseContainer(container: string): Promise<void> {
  const current = picker.value
  if (!current) return
  await runPodAction(current.pod, container, current.mode)
}

async function podAction(row: K8sObjectSummary, mode: 'log' | 'exec'): Promise<void> {
  try {
    const containers = await window.api.k8s.podContainers(props.clusterId, row.namespace, row.name)
    if (containers.length === 0) {
      emit('notice', 'error', '未获取到容器列表')
      return
    }
    if (containers.length === 1) {
      await runPodAction(row, containers[0], mode)
      return
    }
    picker.value = { pod: row, containers, mode }
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function runPodAction(
  row: K8sObjectSummary,
  container: string,
  mode: 'log' | 'exec'
): Promise<void> {
  picker.value = null
  try {
    if (mode === 'log') {
      await store.openK8sLog({
        clusterId: props.clusterId,
        namespace: row.namespace,
        pod: row.name,
        container
      })
    } else {
      await store.openK8sExec({
        clusterId: props.clusterId,
        namespace: row.namespace,
        pod: row.name,
        container
      })
    }
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function shortNames(type: K8sResourceType): string {
  return type.shortNames.slice(0, 2).join(',')
}

onMounted(init)

onBeforeUnmount(() => {
  void stopWatch()
})
</script>

<template>
  <div class="k8s-view">
    <div class="toolbar">
      <span class="badge" :class="info ? 'ok' : 'warn'">
        {{ info ? info.version || '已连接' : '未连接' }}
      </span>
      <Icon name="globe" :size="14" />
      <span class="cluster-name">{{ clusterName }}</span>

      <select class="field mini" :value="currentContext" @change="changeContext">
        <option v-for="context in contexts" :key="context" :value="context">{{ context }}</option>
      </select>

      <select class="field mini" :value="namespace" @change="changeNamespace">
        <option value="">全部命名空间</option>
        <option v-for="item in namespaces" :key="item" :value="item">{{ item }}</option>
      </select>

      <button class="icon-btn" title="刷新" @click="refreshAll">
        <Icon name="refresh" :size="14" />
      </button>

      <span class="spacer" />
      <input v-model="nameFilter" class="field filter" placeholder="过滤名称" />
      <span class="badge warn">可编辑</span>
    </div>

    <div v-if="errorText" class="error-bar">
      {{ errorText }}
      <button class="icon-btn" @click="init">重试</button>
    </div>

    <div class="body">
      <aside class="types">
        <input v-model="typeFilter" class="field type-search" placeholder="搜索资源类型" />
        <div class="type-list">
          <div v-for="group in groupedTypes" :key="group.category" class="type-group">
            <button class="type-title" @click="toggleCategory(group.category)">
              <Icon
                :name="isExpanded(group.category) ? 'chevronDown' : 'chevronRight'"
                :size="11"
              />
              <span class="type-title-label">{{ group.label }}</span>
              <span class="type-count">{{ group.types.length }}</span>
            </button>
            <template v-if="isExpanded(group.category)">
              <button
                v-for="type in group.types"
                :key="`${type.apiVersion}/${type.kind}`"
                class="type-item"
                :class="{ active: activeType?.kind === type.kind && activeType?.apiVersion === type.apiVersion }"
                @click="selectType(type)"
              >
                <span class="type-kind">{{ type.kind }}</span>
                <span class="type-meta">{{ type.apiVersion }}<template v-if="shortNames(type)"> · {{ shortNames(type) }}</template></span>
              </button>
            </template>
          </div>
          <div v-if="groupedTypes.length === 0" class="empty-hint" style="padding: 20px 8px">
            没有匹配的资源类型
          </div>
        </div>
      </aside>

      <section class="objects">
        <div class="object-head">
          <span class="object-title">
            {{ activeType?.kind ?? '选择资源类型' }}
            <span class="muted" v-if="activeType">· {{ activeType.apiVersion }}</span>
          </span>
          <span class="muted">{{ visibleItems.length }} 个</span>
          <span v-if="listing" class="muted">刷新中…</span>
        </div>

        <div v-if="listError" class="list-error">{{ listError }}</div>

        <div class="table-wrap">
          <table class="object-table">
            <thead>
              <tr>
                <th style="width: 34%">名称</th>
                <th style="width: 16%">命名空间</th>
                <th style="width: 16%">状态</th>
                <th style="width: 14%">就绪 / 重启</th>
                <th style="width: 10%">年龄</th>
                <th style="width: 10%"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in visibleItems"
                :key="row.uid || `${row.namespace}/${row.name}`"
                :class="{ selected: selected?.uid === row.uid }"
                @click="selectObject(row)"
              >
                <td class="name-cell">
                  <span class="obj-name">{{ row.name }}</span>
                </td>
                <td class="muted">{{ row.namespace || '-' }}</td>
                <td>
                  <span class="state" :class="row.status">{{ row.status }}</span>
                </td>
                <td class="muted">
                  {{ row.ready || '-' }}<template v-if="row.restarts"> · {{ row.restarts }} 重启</template>
                </td>
                <td class="muted">{{ ageOf(row.createdAt) }}</td>
                <td class="row-actions" @click.stop>
                  <button
                    v-if="row.kind === 'Pod'"
                    class="icon-btn tiny"
                    title="日志"
                    @click="podAction(row, 'log')"
                  >
                    <Icon name="file" :size="12" />
                  </button>
                  <button
                    v-if="row.kind === 'Pod'"
                    class="icon-btn tiny"
                    title="Exec"
                    @click="podAction(row, 'exec')"
                  >
                    <Icon name="terminal" :size="12" />
                  </button>
                  <button class="icon-btn tiny" title="复制名称" @click="copyName(row)">
                    <Icon name="copy" :size="12" />
                  </button>
                </td>
              </tr>
              <tr v-if="!listing && visibleItems.length === 0">
                <td colspan="6" class="empty-cell">
                  {{ loading ? '加载中…' : '没有对象' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <aside v-if="selected" class="detail">
        <div class="detail-head">
          <span class="detail-title">{{ selected.name }}</span>
          <template v-if="!editing">
            <button class="icon-btn tiny" title="编辑 YAML" @click="startEdit">
              <Icon name="edit" :size="12" />
            </button>
            <button v-if="scalable" class="icon-btn tiny" title="扩容 / 缩容" @click="askScale">
              <Icon name="plus" :size="12" />
            </button>
            <button v-if="restartable" class="icon-btn tiny" title="滚动重启" @click="restartSelected">
              <Icon name="refresh" :size="12" />
            </button>
            <button class="icon-btn tiny" title="复制 YAML" @click="copyYaml">
              <Icon name="copy" :size="12" />
            </button>
            <button class="icon-btn tiny danger" title="删除" @click="deleteSelected">
              <Icon name="trash" :size="12" />
            </button>
            <button class="icon-btn tiny" title="关闭" @click="closeDetail">
              <Icon name="close" :size="12" />
            </button>
          </template>
        </div>

        <div v-if="editing" class="edit-wrap">
          <textarea v-model="editText" class="edit-area" spellcheck="false" />
          <div class="edit-foot">
            <span class="hint-text">保存会以服务端 apply 方式提交</span>
            <button class="icon-btn" :disabled="saving" @click="cancelEdit">取消</button>
            <button class="icon-btn primary" :disabled="saving" @click="saveEdit">
              {{ saving ? '提交中…' : '应用' }}
            </button>
          </div>
        </div>
        <pre v-else class="yaml">{{ yamlLoading ? '加载中…' : yamlText }}</pre>
      </aside>
    </div>

    <div v-if="scaleModal" class="modal-mask" @mousedown.self="scaleModal = false">
      <div class="modal-card" style="width: 380px">
        <div class="modal-head">
          <span>扩容 / 缩容 · {{ selected?.name }}</span>
          <button class="icon-btn" @click="scaleModal = false"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="hint-text" style="margin-bottom: 8px">设置期望的副本数（0 表示缩到零）</div>
          <input v-model="scaleValue" class="field" type="number" min="0" />
        </div>
        <div class="modal-foot">
          <button class="icon-btn" @click="scaleModal = false">取消</button>
          <button class="icon-btn primary" @click="confirmScale">确定</button>
        </div>
      </div>
    </div>

    <div v-if="picker" class="modal-mask" @mousedown.self="picker = null">
      <div class="modal-card" style="width: 420px">
        <div class="modal-head">
          <span>{{ picker.mode === 'log' ? '查看日志' : '连接容器' }} · {{ picker.pod.name }}</span>
          <button class="icon-btn" @click="picker = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="hint-text" style="margin-bottom: 8px">该 Pod 有多个容器，请选择：</div>
          <button
            v-for="container in picker.containers"
            :key="container"
            class="container-option"
            @click="chooseContainer(container)"
          >
            <Icon name="file" :size="13" /> {{ container }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.k8s-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.cluster-name {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.field.mini {
  width: auto;
  min-width: 130px;
  max-width: 200px;
  height: 26px;
}

.field.filter {
  width: 180px;
  height: 26px;
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.types {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}

.type-search {
  height: 26px;
  margin: 8px;
  width: calc(100% - 16px);
}

.type-list {
  flex: 1;
  overflow: auto;
  padding: 0 6px 10px;
}

.type-title {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 7px 6px 4px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  letter-spacing: 0.4px;
  cursor: pointer;
  text-align: left;
}

.type-title:hover {
  color: var(--text);
}

.type-title-label {
  flex: 1;
}

.type-count {
  font-size: 9.5px;
  opacity: 0.75;
}

.type-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.type-item:hover {
  background: var(--panel-2);
  color: var(--text);
}

.type-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.type-kind {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-meta {
  font-size: 9.5px;
  color: var(--muted);
  flex-shrink: 0;
}

.objects {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.object-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
  font-size: 12px;
}

.object-title {
  color: var(--text);
  font-weight: 600;
}

.muted {
  color: var(--muted);
}

.list-error {
  padding: 6px 12px;
  font-size: 11.5px;
  color: var(--warning);
  background: rgba(245, 158, 11, 0.1);
}

.table-wrap {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.object-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.object-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 6px 10px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  border-bottom: 1px solid var(--border);
}

.object-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.object-table tbody tr {
  cursor: pointer;
}

.object-table tbody tr:hover {
  background: var(--panel-2);
}

.object-table tbody tr.selected {
  background: var(--accent-soft);
}

.obj-name {
  color: var(--text);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
}

.state {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
}

.state.Running,
.state.Active,
.state.Ready,
.state.Available,
.state.Bound {
  color: var(--success);
  border-color: rgba(34, 197, 94, 0.35);
}

.state.Failed,
.state.CrashLoopBackOff,
.state.NotReady,
.state.Error,
.state.Pending {
  color: var(--danger);
  border-color: rgba(239, 68, 68, 0.35);
}

.row-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
}

.object-table tbody tr:hover .row-actions {
  opacity: 1;
}

.icon-btn.tiny {
  height: 20px;
  min-width: 20px;
  padding: 0 3px;
}

.empty-cell {
  text-align: center;
  color: var(--muted);
  padding: 30px;
}

.detail {
  width: 420px;
  flex-shrink: 0;
  border-left: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
}

.detail-title {
  flex: 1;
  font-size: 12px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.edit-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.edit-area {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  padding: 10px 12px;
  background: var(--bg);
  color: var(--text);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  tab-size: 2;
}

.edit-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-soft);
}

.edit-foot .hint-text {
  flex: 1;
  font-size: 11px;
}

.yaml {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre;
}

.container-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  margin-bottom: 4px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.container-option:hover {
  border-color: var(--accent);
  color: var(--text);
}
</style>
