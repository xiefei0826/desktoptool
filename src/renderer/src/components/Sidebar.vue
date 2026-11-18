<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DbConnection, K8sCluster, SessionConfig } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const emit = defineEmits<{
  (event: 'new-session', groupId?: string | null): void
  (event: 'edit-session', sessionId: string): void
  (event: 'settings'): void
  (event: 'add-cluster'): void
  (event: 'add-db'): void
  (event: 'notice', kind: 'success' | 'error', text: string): void
}>()

const store = useAppStore()

interface Row {
  key: string
  type: 'group' | 'session' | 'section'
  depth: number
  label: string
  groupId?: string
  session?: SessionConfig
  count?: number
}

const keyword = ref('')
const collapsed = ref<Set<string>>(new Set())
const editingGroupId = ref('')
const editingName = ref('')

const menu = ref<{ x: number; y: number; session: SessionConfig } | null>(null)

const rows = computed<Row[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  const matches = (session: SessionConfig): boolean => {
    if (!kw) return true
    return [session.name, session.host, session.username, session.note]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(kw))
  }

  const visibleSessions = store.sessions.filter(matches)
  const byGroup = new Map<string, SessionConfig[]>()
  for (const session of visibleSessions) {
    const key = session.groupId ?? ''
    const list = byGroup.get(key) ?? []
    list.push(session)
    byGroup.set(key, list)
  }

  const result: Row[] = []

  const walk = (parentId: string | null): void => {
    const groups = store.groups
      .filter((group) => (group.parentId ?? null) === parentId)
      .sort((a, b) => a.order - b.order)

    for (const group of groups) {
      const sessions = byGroup.get(group.id) ?? []
      const childCount = store.groups.filter((item) => item.parentId === group.id).length
      if (kw && sessions.length === 0 && childCount === 0) continue
      result.push({
        key: `g:${group.id}`,
        type: 'group',
        depth: 0,
        label: group.name,
        groupId: group.id,
        count: sessions.length
      })
      if (collapsed.value.has(group.id)) continue
      for (const session of sessions) {
        result.push({
          key: `s:${session.id}`,
          type: 'session',
          depth: 1,
          label: session.name,
          session
        })
      }
      walk(group.id)
    }
  }

  walk(null)

  const ungrouped = byGroup.get('') ?? []
  if (ungrouped.length > 0) {
    result.push({ key: 'g:__none', type: 'section', depth: 0, label: '未分组', count: ungrouped.length })
    for (const session of ungrouped) {
      result.push({
        key: `s:${session.id}`,
        type: 'session',
        depth: 1,
        label: session.name,
        session
      })
    }
  }

  return result
})

function toggleGroup(groupId: string): void {
  const next = new Set(collapsed.value)
  if (next.has(groupId)) next.delete(groupId)
  else next.add(groupId)
  collapsed.value = next
}

function statusClass(sessionId: string): string {
  const status = store.sshStatus[sessionId]?.status
  if (status === 'ready') return 'ok'
  if (status === 'error') return 'err'
  if (status === 'connecting') return 'warn'
  return ''
}

async function openSession(session: SessionConfig): Promise<void> {
  try {
    const result = await store.openSession(session.id)
    if (result && !result.ok) emit('notice', 'error', result.message)
    else if (result?.ok) emit('notice', 'success', result.message)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function showMenu(event: MouseEvent, session: SessionConfig): void {
  event.preventDefault()
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 200),
    y: Math.min(event.clientY, window.innerHeight - 260),
    session
  }
}

function closeMenu(): void {
  menu.value = null
}

async function menuAction(action: string): Promise<void> {
  const current = menu.value
  closeMenu()
  if (!current) return
  const session = current.session

  try {
    if (action === 'open') await openSession(session)
    else if (action === 'new-window') await store.openSessionInNewWindow(session.id)
    else if (action === 'edit') emit('edit-session', session.id)
    else if (action === 'sftp') await store.openSftp(session.id)
    else if (action === 'duplicate') {
      await store.duplicateSession(session.id)
      emit('notice', 'success', '已创建副本')
    } else if (action === 'delete') {
      if (!window.confirm(`确定删除连接「${session.name}」？`)) return
      await store.deleteSession(session.id)
      emit('notice', 'success', '已删除')
    } else if (action === 'launch') {
      const result = await store.launchRemoteDesktop(session.id)
      emit('notice', result.ok ? 'success' : 'error', result.message)
    } else if (action === 'disconnect') {
      await store.disconnect(session.id)
      emit('notice', 'success', '已断开连接')
    }
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function addGroup(): Promise<void> {
  const group = await store.saveGroup({ name: '新建分组' })
  editingGroupId.value = group.id
  editingName.value = group.name
  await nextTick()
}

function startRename(row: Row): void {
  if (row.type === 'section' || !row.groupId) return
  editingGroupId.value = row.groupId
  editingName.value = row.label
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.group-rename-input')
    input?.focus()
    input?.select()
  })
}

async function commitRename(): Promise<void> {
  const id = editingGroupId.value
  const name = editingName.value.trim()
  editingGroupId.value = ''
  if (!id || !name) return
  try {
    await store.saveGroup({ id, name })
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function removeGroup(groupId: string, name: string): Promise<void> {
  if (!window.confirm(`删除分组「${name}」？组内连接会移到未分组。`)) return
  try {
    await store.deleteGroup(groupId)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function removeCluster(cluster: K8sCluster): Promise<void> {
  if (!window.confirm(`移除集群「${cluster.name}」？只会删除本地记录，不影响集群本身。`)) return
  try {
    await store.removeCluster(cluster.id)
    emit('notice', 'success', '已移除集群')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function removeDbConnection(connection: DbConnection): Promise<void> {
  if (!window.confirm(`移除数据库连接「${connection.name}」？`)) return
  try {
    await store.removeDbConnection(connection.id)
    emit('notice', 'success', '已移除数据库连接')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function onDocumentClick(): void {
  closeMenu()
}

onMounted(() => document.addEventListener('mousedown', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentClick))

function protocolLabel(session: SessionConfig): string {
  if (session.protocol === 'ssh') return 'SSH'
  if (session.protocol === 'rdp') return 'RDP'
  return 'VNC'
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="logo">DT</span>
      <div class="brand-text">
        <div class="brand-title">DesktopTool</div>
        <div class="brand-sub">SSH · RDP · VNC</div>
      </div>
    </div>

    <div class="search-box">
      <Icon name="search" :size="13" />
      <input v-model="keyword" placeholder="搜索名称 / 主机 / 用户" />
      <button v-if="keyword" class="search-clear" @click="keyword = ''">
        <Icon name="close" :size="11" />
      </button>
    </div>

    <div class="actions">
      <button class="icon-btn primary grow" @click="emit('new-session', null)">
        <Icon name="plus" :size="14" /> 新建连接
      </button>
      <button class="icon-btn" title="本机终端" @click="store.openLocalTerminal()">
        <Icon name="terminal" :size="15" />
      </button>
    </div>

    <div class="tree">
      <div class="tree-head">
        <span>连接</span>
        <button class="icon-btn" title="新建分组" @click="addGroup"><Icon name="folder" :size="14" /></button>
      </div>

      <div
        v-for="row in rows"
        :key="row.key"
        class="row"
        :class="{ group: row.type === 'group', section: row.type === 'section', session: row.type === 'session' }"
        :style="{ paddingLeft: `${8 + row.depth * 12}px` }"
        @click="row.type === 'group' && row.groupId && toggleGroup(row.groupId)"
        @dblclick="row.type === 'group' && startRename(row)"
        @contextmenu="row.session && showMenu($event, row.session)"
      >
        <template v-if="row.type === 'group'">
          <Icon :name="collapsed.has(row.groupId!) ? 'chevronRight' : 'chevronDown'" :size="12" />
          <input
            v-if="editingGroupId === row.groupId"
            v-model="editingName"
            class="group-rename-input"
            @click.stop
            @blur="commitRename"
            @keyup.enter="commitRename"
            @keyup.esc="editingGroupId = ''"
          />
          <span v-else class="label">{{ row.label }}</span>
          <span class="count">{{ row.count }}</span>
          <button
            class="row-action"
            title="删除分组"
            @click.stop="removeGroup(row.groupId!, row.label)"
          >
            <Icon name="trash" :size="11" />
          </button>
        </template>

        <template v-else-if="row.type === 'section'">
          <Icon name="folder" :size="12" />
          <span class="label">{{ row.label }}</span>
          <span class="count">{{ row.count }}</span>
        </template>

        <template v-else>
          <span class="dot" :class="statusClass(row.session!.id)" />
          <Icon
            :name="row.session!.protocol === 'ssh' ? 'server' : 'monitor'"
            :size="13"
            class="row-icon"
          />
          <span class="label">{{ row.label }}</span>
          <span class="protocol">{{ protocolLabel(row.session!) }}</span>
          <button class="row-action" title="更多" @click.stop="showMenu($event, row.session!)">···</button>
        </template>
      </div>

      <div v-if="rows.length === 0" class="empty-hint">
        {{ keyword ? '没有匹配的连接' : '还没有连接，点击上方「新建连接」开始' }}
      </div>
    </div>

    <div class="k8s-block">
      <div class="tree-head">
        <span>K8s 集群</span>
        <button class="icon-btn" title="添加集群" @click="emit('add-cluster')">
          <Icon name="plus" :size="13" />
        </button>
      </div>
      <div
        v-for="cluster in store.clusters"
        :key="cluster.id"
        class="k8s-row"
        @click="store.openK8sTab(cluster.id)"
      >
        <Icon name="globe" :size="12" />
        <span class="label">{{ cluster.name }}</span>
        <button class="row-action" title="移除" @click.stop="removeCluster(cluster)">
          <Icon name="trash" :size="11" />
        </button>
      </div>
      <div v-if="store.clusters.length === 0" class="k8s-empty">尚未添加集群</div>
    </div>

    <div class="k8s-block">
      <div class="tree-head">
        <span>数据库</span>
        <button class="icon-btn" title="添加数据库连接" @click="emit('add-db')">
          <Icon name="plus" :size="13" />
        </button>
      </div>
      <div
        v-for="connection in store.dbConnections"
        :key="connection.id"
        class="k8s-row"
        @click="store.openDbTab(connection.id)"
      >
        <Icon name="database" :size="12" />
        <span class="label">{{ connection.name }}</span>
        <button class="row-action" title="移除" @click.stop="removeDbConnection(connection)">
          <Icon name="trash" :size="11" />
        </button>
      </div>
      <div v-if="store.dbConnections.length === 0" class="k8s-empty">尚未添加数据库</div>
    </div>

    <div class="foot">
      <button class="foot-btn" @click="store.openForwards()">
        <Icon name="link" :size="14" />
        <span>端口转发</span>
        <span v-if="store.runningForwardCount" class="badge ok">{{ store.runningForwardCount }}</span>
      </button>
      <button class="foot-btn" @click="emit('settings')">
        <Icon name="gear" :size="14" />
        <span>设置</span>
      </button>
    </div>

    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @mousedown.stop
    >
      <button @click="menuAction('open')">
        <Icon name="play" :size="13" /> 打开（新标签）
      </button>
      <button @click="menuAction('new-window')">
        <Icon name="external" :size="13" /> 在新窗口打开
      </button>
      <button v-if="menu.session.protocol === 'ssh'" @click="menuAction('sftp')">
        <Icon name="folder" :size="13" /> SFTP 文件管理
      </button>
      <button v-if="menu.session.protocol !== 'ssh'" @click="menuAction('launch')">
        <Icon name="external" :size="13" /> 用系统客户端打开
      </button>
      <button v-if="menu.session.protocol === 'ssh'" @click="menuAction('disconnect')">
        <Icon name="stop" :size="13" /> 断开连接
      </button>
      <div class="divider" />
      <button @click="menuAction('edit')">
        <Icon name="edit" :size="13" /> 编辑
      </button>
      <button @click="menuAction('duplicate')">
        <Icon name="copy" :size="13" /> 创建副本
      </button>
      <button class="danger" @click="menuAction('delete')">
        <Icon name="trash" :size="13" /> 删除
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 264px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--border);
  min-height: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px 10px;
}

.logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #2563eb, #06b6d4);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.brand-title {
  font-size: 13px;
  font-weight: 600;
}

.brand-sub {
  font-size: 10px;
  color: var(--muted);
  letter-spacing: 0.6px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 10px 8px;
  padding: 0 8px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--muted);
}

.search-box input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.search-clear {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  padding: 2px;
}

.actions {
  display: flex;
  gap: 6px;
  padding: 0 10px 10px;
}

.grow {
  flex: 1;
}

.tree {
  flex: 1;
  overflow: auto;
  padding: 0 6px;
  min-height: 0;
}

.tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 4px 4px;
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-right: 6px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.row.group {
  color: var(--muted);
  font-size: 11.5px;
  margin-top: 2px;
}

.row.section {
  color: var(--muted);
  font-size: 11.5px;
  cursor: default;
}

.row .label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row .count {
  color: var(--muted);
  font-size: 10.5px;
}

.row .protocol {
  font-size: 9.5px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 14px;
}

.row-icon {
  color: var(--muted);
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--panel-3);
  flex-shrink: 0;
}

.dot.ok {
  background: var(--success);
}

.dot.err {
  background: var(--danger);
}

.dot.warn {
  background: var(--warning);
}

.row-action {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0 2px;
  display: none;
  font-size: 12px;
  line-height: 1;
}

.row:hover .row-action {
  display: inline-flex;
}

.row-action:hover {
  color: var(--danger);
}

.group-rename-input {
  flex: 1;
  min-width: 0;
  height: 20px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--panel-2);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.k8s-block {
  border-top: 1px solid var(--border-soft);
  padding: 4px 6px 6px;
  max-height: 200px;
  overflow: auto;
}

.k8s-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.k8s-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.k8s-row .label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.k8s-row:hover .row-action {
  display: inline-flex;
}

.k8s-empty {
  padding: 2px 8px 6px;
  font-size: 11px;
  color: var(--muted);
}

.foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 8px 10px;
  border-top: 1px solid var(--border-soft);
}

.foot-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.foot-btn:hover {
  background: var(--panel-2);
  color: var(--text);
}

.foot-btn span:nth-child(2) {
  flex: 1;
}
</style>
