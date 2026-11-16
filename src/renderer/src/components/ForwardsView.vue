<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ForwardRule } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'
import ForwardDialog from './ForwardDialog.vue'

const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()
const store = useAppStore()

const dialogShow = ref(false)
const editingId = ref<string | null>(null)

interface Row {
  rule: ForwardRule
  status: string
  message: string
  connections: number
}

const rows = computed<Row[]>(() =>
  store.config.forwards.map((rule) => {
    const state = store.forwards.find((item) => item.ruleId === rule.id)
    return {
      rule,
      status: state?.status ?? 'stopped',
      message: state?.message ?? '',
      connections: state?.connections ?? 0
    }
  })
)

function sessionName(sessionId: string): string {
  return store.sessions.find((session) => session.id === sessionId)?.name ?? '（会话已删除）'
}

function typeLabel(type: ForwardRule['type']): string {
  if (type === 'local') return '本地 -L'
  if (type === 'remote') return '远程 -R'
  return 'SOCKS5 -D'
}

function endpoint(host: string, port: number): string {
  if (!host && !port) return '-'
  return `${host}:${port}`
}

async function toggle(row: Row): Promise<void> {
  try {
    if (row.status === 'running') {
      await store.stopForward(row.rule.id)
      emit('notice', 'success', `已停止 ${row.rule.name}`)
    } else {
      await store.startForward(row.rule.id)
      emit('notice', 'success', `已启动 ${row.rule.name}`)
    }
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function createRule(): void {
  editingId.value = null
  dialogShow.value = true
}

function editRule(rule: ForwardRule): void {
  editingId.value = rule.id
  dialogShow.value = true
}

async function removeRule(rule: ForwardRule): Promise<void> {
  if (!window.confirm(`删除转发规则「${rule.name}」？`)) return
  try {
    await store.deleteForward(rule.id)
    emit('notice', 'success', '已删除')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}
</script>

<template>
  <div class="forwards-view">
    <div class="toolbar">
      <span class="badge">{{ rows.length }} 条规则</span>
      <span class="badge ok" v-if="store.runningForwardCount">{{ store.runningForwardCount }} 个运行中</span>
      <span class="spacer" />
      <button class="icon-btn primary" @click="createRule"><Icon name="plus" :size="14" /> 新建转发</button>
      <button class="icon-btn" @click="store.refreshForwards()"><Icon name="refresh" :size="14" /></button>
    </div>

    <div class="table-wrap">
      <table class="forward-table">
        <thead>
          <tr>
            <th style="width: 20%">名称</th>
            <th style="width: 12%">类型</th>
            <th style="width: 18%">监听</th>
            <th style="width: 18%">目标</th>
            <th style="width: 10%">状态</th>
            <th style="width: 22%">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.rule.id">
            <td>
              <div class="name">{{ row.rule.name }}</div>
              <div class="sub">{{ sessionName(row.rule.sessionId) }}</div>
            </td>
            <td>{{ typeLabel(row.rule.type) }}</td>
            <td class="mono">{{ endpoint(row.rule.bindHost, row.rule.bindPort) }}</td>
            <td class="mono">
              {{ row.rule.type === 'dynamic' ? '动态代理' : endpoint(row.rule.destHost, row.rule.destPort) }}
            </td>
            <td>
              <span
                class="badge"
                :class="row.status === 'running' ? 'ok' : row.status === 'error' ? 'err' : ''"
              >
                {{ row.status === 'running' ? '运行中' : row.status === 'error' ? '异常' : row.status === 'starting' ? '启动中' : '已停止' }}
              </span>
              <div v-if="row.message" class="sub error">{{ row.message }}</div>
            </td>
            <td class="actions">
              <button class="icon-btn" @click="toggle(row)">
                <Icon :name="row.status === 'running' ? 'stop' : 'play'" :size="13" />
                {{ row.status === 'running' ? '停止' : '启动' }}
              </button>
              <button class="icon-btn" @click="editRule(row.rule)"><Icon name="edit" :size="13" /></button>
              <button class="icon-btn danger" @click="removeRule(row.rule)">
                <Icon name="trash" :size="13" />
              </button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="6" class="empty-cell">
              还没有转发规则。新建后即可把内网端口映射到本机，或在本机开 SOCKS5 代理。
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ForwardDialog v-model:show="dialogShow" :rule-id="editingId" @saved="store.refreshForwards()" />
  </div>
</template>

<style scoped>
.forwards-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.table-wrap {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.forward-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.forward-table th {
  position: sticky;
  top: 0;
  text-align: left;
  padding: 8px 10px;
  background: var(--panel);
  color: var(--muted);
  font-weight: 500;
  font-size: 11px;
  border-bottom: 1px solid var(--border);
}

.forward-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--text-dim);
  vertical-align: top;
}

.forward-table tbody tr:hover {
  background: var(--panel-2);
}

.name {
  color: var(--text);
  font-size: 12.5px;
}

.sub {
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}

.sub.error {
  color: var(--danger);
  max-width: 220px;
  white-space: normal;
  line-height: 1.4;
}

.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.empty-cell {
  text-align: center;
  color: var(--muted);
  padding: 40px 20px;
  line-height: 1.7;
}
</style>
