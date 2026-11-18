<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RedisCommandResult, RedisConnectResult, RedisKeyInfo, RedisValueResult } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()
const connection = computed(() => store.dbConnections.find((item) => item.id === props.connectionId))

const info = ref<RedisConnectResult | null>(null)
const errorText = ref('')
const loading = ref(true)
const pattern = ref('*')
const cursor = ref('0')
const keys = ref<RedisKeyInfo[]>([])
const scanning = ref(false)
const selectedKey = ref('')
const value = ref<RedisValueResult | null>(null)
const valueLoading = ref(false)
const mode = ref<'value' | 'command'>('value')
const commandText = ref('PING')
const commandResult = ref<RedisCommandResult | null>(null)
const commandError = ref('')
const running = ref(false)

const dialog = ref<{
  title: string
  label: string
  value: string
  multiline: boolean
  onConfirm: (input: string) => void
} | null>(null)
const dialogValue = ref('')

const dbOptions = computed(() =>
  Array.from({ length: Math.max(1, info.value?.databases ?? 16) }, (_item, index) => index)
)

const prettyValue = computed(() => {
  if (!value.value) return ''
  return typeof value.value.value === 'string'
    ? value.value.value
    : JSON.stringify(value.value.value, null, 2)
})

function formatTtl(ttl: number): string {
  if (ttl === -1) return '永久'
  if (ttl === -2) return '已过期'
  return `${ttl}s`
}

async function connect(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    info.value = await window.api.redis.connect(props.connectionId)
    await scan(true)
  } catch (error) {
    errorText.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function scan(reset: boolean): Promise<void> {
  scanning.value = true
  try {
    const result = await window.api.redis.scan(
      props.connectionId,
      reset ? '0' : cursor.value,
      pattern.value || '*',
      200
    )
    keys.value = reset ? result.keys : [...keys.value, ...result.keys]
    cursor.value = result.cursor
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  } finally {
    scanning.value = false
  }
}

async function selectKey(key: string): Promise<void> {
  selectedKey.value = key
  mode.value = 'value'
  await loadValue()
}

async function loadValue(): Promise<void> {
  if (!selectedKey.value) return
  valueLoading.value = true
  try {
    value.value = await window.api.redis.value(props.connectionId, selectedKey.value)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  } finally {
    valueLoading.value = false
  }
}

async function switchDb(event: Event): Promise<void> {
  const index = Number((event.target as HTMLSelectElement).value)
  try {
    info.value = await window.api.redis.switchDb(props.connectionId, index)
    selectedKey.value = ''
    value.value = null
    await scan(true)
    emit('notice', 'success', `已切换到 db${index}`)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function removeKey(): Promise<void> {
  if (!selectedKey.value) return
  if (!window.confirm(`删除键 ${selectedKey.value}？`)) return
  try {
    await window.api.redis.remove(props.connectionId, [selectedKey.value])
    const removed = selectedKey.value
    selectedKey.value = ''
    value.value = null
    keys.value = keys.value.filter((item) => item.key !== removed)
    emit('notice', 'success', '已删除')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function askTtl(): void {
  if (!value.value) return
  dialogValue.value = String(value.value.ttl > 0 ? value.value.ttl : 60)
  dialog.value = {
    title: `设置 TTL · ${value.value.key}`,
    label: '秒（0 或负数表示永久）',
    value: dialogValue.value,
    multiline: false,
    onConfirm: (input) => {
      void applyTtl(Number(input))
    }
  }
}

async function applyTtl(ttl: number): Promise<void> {
  if (!selectedKey.value || !Number.isFinite(ttl)) return
  try {
    await window.api.redis.setTtl(props.connectionId, selectedKey.value, ttl)
    await loadValue()
    emit('notice', 'success', 'TTL 已更新')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function askEditString(): void {
  if (!value.value || value.value.type !== 'string') return
  dialogValue.value = String(value.value.value ?? '')
  dialog.value = {
    title: `编辑字符串 · ${value.value.key}`,
    label: '值',
    value: dialogValue.value,
    multiline: true,
    onConfirm: (input) => {
      void saveString(input)
    }
  }
}

async function saveString(text: string): Promise<void> {
  if (!selectedKey.value) return
  try {
    await window.api.redis.setString(props.connectionId, selectedKey.value, text)
    await loadValue()
    emit('notice', 'success', '已保存')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function runCommand(): Promise<void> {
  if (!commandText.value.trim()) return
  running.value = true
  commandError.value = ''
  commandResult.value = null
  try {
    commandResult.value = await window.api.redis.command(props.connectionId, commandText.value)
    await scan(true)
  } catch (error) {
    commandError.value = errorMessage(error)
  } finally {
    running.value = false
  }
}

function confirmDialog(): void {
  const current = dialog.value
  if (!current) return
  const input = dialogValue.value
  dialog.value = null
  current.onConfirm(input)
}

onMounted(() => {
  void connect()
})

onBeforeUnmount(() => {
  void window.api.redis.disconnect(props.connectionId).catch(() => undefined)
})
</script>

<template>
  <div class="redis-view">
    <div class="toolbar">
      <span class="badge" :class="errorText ? 'err' : info ? 'ok' : 'warn'">
        {{ errorText ? '连接失败' : info ? `Redis ${info.version}` : '连接中' }}
      </span>
      <Icon name="database" :size="14" />
      <span class="conn-name">{{ connection?.name ?? 'Redis' }}</span>
      <select v-if="info" class="field mini" :value="info.currentDb" @change="switchDb">
        <option v-for="index in dbOptions" :key="index" :value="index">db{{ index }}</option>
      </select>
      <span v-if="info" class="muted">{{ info.keyCount }} keys</span>

      <span class="spacer" />
      <input v-model="pattern" class="field filter" placeholder="匹配模式，如 user:*" @keyup.enter="scan(true)" />
      <button class="icon-btn" :disabled="scanning" @click="scan(true)">
        <Icon name="refresh" :size="13" /> 扫描
      </button>
    </div>

    <div v-if="errorText" class="error-bar">
      {{ errorText }}
      <button class="icon-btn" @click="connect">重试</button>
    </div>

    <div class="body">
      <aside class="keys">
        <div class="keys-head">
          <span>键</span>
          <span class="muted">{{ keys.length }}</span>
        </div>
        <div class="key-list">
          <button
            v-for="item in keys"
            :key="item.key"
            class="key-row"
            :class="{ active: item.key === selectedKey }"
            :title="`${item.key}（${item.type}）`"
            @click="selectKey(item.key)"
          >
            <span class="key-name">{{ item.key }}</span>
            <span class="key-type">{{ item.type }}</span>
          </button>
          <div v-if="!loading && keys.length === 0" class="empty-hint">没有匹配的键</div>
        </div>
        <div class="keys-foot">
          <button class="icon-btn" :disabled="scanning || cursor === '0'" @click="scan(false)">
            加载更多
          </button>
        </div>
      </aside>

      <section class="right">
        <div class="mode-tabs">
          <button :class="{ active: mode === 'value' }" @click="mode = 'value'">值</button>
          <button :class="{ active: mode === 'command' }" @click="mode = 'command'">命令台</button>
        </div>

        <template v-if="mode === 'value'">
          <div class="value-head">
            <span class="value-key">{{ selectedKey || '未选择键' }}</span>
            <template v-if="value">
              <span class="badge">{{ value.type }}</span>
              <span class="muted">TTL {{ formatTtl(value.ttl) }}</span>
              <span class="muted">size {{ value.size }}</span>
            </template>
            <span class="spacer" />
            <button class="icon-btn" :disabled="!selectedKey" @click="loadValue">刷新</button>
            <button
              v-if="value?.type === 'string'"
              class="icon-btn"
              :disabled="!selectedKey"
              @click="askEditString"
            >
              编辑
            </button>
            <button class="icon-btn" :disabled="!selectedKey" @click="askTtl">TTL</button>
            <button class="icon-btn danger" :disabled="!selectedKey" @click="removeKey">删除</button>
          </div>
          <pre class="value-body">{{ valueLoading ? '加载中…' : prettyValue || '（空）' }}</pre>
        </template>

        <template v-else>
          <div class="command-bar">
            <input
              v-model="commandText"
              class="field mono"
              placeholder="支持任意命令，如 GET user:1 / HGETALL user:1 / KEYS *"
              @keyup.enter="runCommand"
            />
            <button class="icon-btn primary" :disabled="running" @click="runCommand">执行</button>
          </div>
          <div v-if="commandError" class="command-error">{{ commandError }}</div>
          <pre class="value-body">{{ commandResult ? JSON.stringify(commandResult.value, null, 2) : '执行结果会显示在这里' }}</pre>
        </template>
      </section>
    </div>

    <div v-if="dialog" class="modal-mask" @mousedown.self="dialog = null">
      <div class="modal-card" style="width: 520px">
        <div class="modal-head">
          <span>{{ dialog.title }}</span>
          <button class="icon-btn" @click="dialog = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="dialog-form">
            <div class="dialog-row">
              <label>{{ dialog.label }}</label>
              <textarea v-if="dialog.multiline" v-model="dialogValue" class="field code" spellcheck="false" />
              <input v-else v-model="dialogValue" class="field mono" @keyup.enter="confirmDialog" />
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="icon-btn" @click="dialog = null">取消</button>
          <button class="icon-btn primary" @click="confirmDialog">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.redis-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.conn-name {
  font-size: 12px;
  color: var(--text);
}

.muted {
  color: var(--muted);
  font-size: 11.5px;
}

.field.mini {
  width: auto;
  min-width: 84px;
  height: 26px;
}

.field.filter {
  width: 200px;
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
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.keys {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}

.keys-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border-soft);
}

.key-list {
  flex: 1;
  overflow: auto;
  padding: 4px 6px;
}

.key-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.key-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.key-row.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.key-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
}

.key-type {
  font-size: 9.5px;
  color: var(--muted);
}

.keys-foot {
  padding: 6px 8px;
  border-top: 1px solid var(--border-soft);
}

.right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.mode-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
}

.mode-tabs button {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 5px;
  cursor: pointer;
}

.mode-tabs button.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.value-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.value-key {
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  color: var(--text);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value-body {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}

.command-bar {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
}

.command-bar .field {
  flex: 1;
}

.command-error {
  padding: 6px 12px;
  color: var(--danger);
  font-size: 12px;
}

.code {
  height: 160px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
}

.icon-btn.danger {
  color: var(--danger);
}
</style>
