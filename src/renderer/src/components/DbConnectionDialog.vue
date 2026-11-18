<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DbConnection, DbKind } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ show: boolean; connectionId?: string }>(), {
  connectionId: ''
})
const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'saved', connection: DbConnection): void
}>()

const store = useAppStore()

const form = ref<DbConnection>(emptyConnection())
const password = ref('')
const hasStoredPassword = ref(false)
const testing = ref(false)
const saving = ref(false)
const message = ref('')
const messageKind = ref<'info' | 'error'>('info')

const sshSessions = computed(() => store.sessions.filter((session) => session.protocol === 'ssh'))
const isEdit = computed(() => Boolean(props.connectionId))

function emptyConnection(): DbConnection {
  return {
    id: '',
    name: '',
    kind: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    database: '',
    ssl: false,
    tunnelSessionId: null,
    createdAt: 0,
    lastUsedAt: null
  }
}

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    message.value = ''
    password.value = ''
    hasStoredPassword.value = false

    if (props.connectionId) {
      const existing = store.dbConnections.find((item) => item.id === props.connectionId)
      if (existing) {
        form.value = { ...existing }
        hasStoredPassword.value = true
      }
    } else {
      form.value = emptyConnection()
    }
  },
  { immediate: true }
)

function onKindChange(kind: DbKind): void {
  form.value.kind = kind
  form.value.port = kind === 'postgres' ? 5432 : 3306
  if (kind === 'postgres' && form.value.username === 'root') form.value.username = 'postgres'
}

/** Vue 的响应式对象是 Proxy，直接传 IPC 会报 "An object could not be cloned" */
function toPlain(): DbConnection {
  const value = form.value
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    host: value.host,
    port: Number(value.port),
    username: value.username,
    database: value.database,
    ssl: Boolean(value.ssl),
    tunnelSessionId: value.tunnelSessionId ?? null,
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
  }
}

function close(): void {
  emit('update:show', false)
}

async function test(): Promise<void> {
  testing.value = true
  message.value = ''
  try {
    const result = await window.api.db.testConnection(toPlain(), password.value)
    messageKind.value = 'info'
    message.value = `连接成功：${result.serverVersion}（${result.metadata.tables.length} 张表）`
  } catch (error) {
    messageKind.value = 'error'
    message.value = errorMessage(error)
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  message.value = ''
  try {
    const saved = await window.api.db.saveConnection({
      ...toPlain(),
      id: form.value.id || undefined,
      password: password.value || undefined
    })
    await store.reloadDbConnections()
    emit('saved', saved)
    close()
  } catch (error) {
    messageKind.value = 'error'
    message.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="show" class="modal-mask" @mousedown.self="close">
    <div class="modal-card" style="width: 600px">
      <div class="modal-head">
        <span>{{ isEdit ? '编辑数据库连接' : '新建数据库连接' }}</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>

      <div class="modal-body">
        <div class="seg">
          <button :class="{ active: form.kind === 'mysql' }" @click="onKindChange('mysql')">
            MySQL / MariaDB
          </button>
          <button :class="{ active: form.kind === 'postgres' }" @click="onKindChange('postgres')">
            PostgreSQL
          </button>
        </div>

        <div class="dialog-form" style="margin-top: 14px">
          <div class="dialog-row">
            <label>名称</label>
            <input v-model="form.name" class="field" placeholder="例如：本地开发库" />
          </div>

          <div class="dialog-row">
            <label>主机</label>
            <input v-model="form.host" class="field mono" placeholder="127.0.0.1" />
          </div>

          <div class="dialog-row">
            <label>端口</label>
            <input v-model.number="form.port" class="field" type="number" min="1" max="65535" />
          </div>

          <div class="dialog-row">
            <label>用户名</label>
            <input v-model="form.username" class="field" />
          </div>

          <div class="dialog-row">
            <label>密码</label>
            <input
              v-model="password"
              class="field"
              type="password"
              :placeholder="hasStoredPassword ? '已保存，留空表示不修改' : '数据库密码'"
            />
          </div>

          <div class="dialog-row">
            <label>数据库</label>
            <input v-model="form.database" class="field" placeholder="可选，留空则使用默认库" />
          </div>

          <div class="dialog-row">
            <label>访问方式</label>
            <select v-model="form.tunnelSessionId" class="field">
              <option :value="null">直连</option>
              <option v-for="session in sshSessions" :key="session.id" :value="session.id">
                经 SSH 隧道（{{ session.name }}）
              </option>
            </select>
          </div>

          <label class="check-row" style="padding-left: 106px">
            <input v-model="form.ssl" type="checkbox" />
            启用 SSL（自签证书不校验）
          </label>

          <div v-if="message" class="msg" :class="messageKind">{{ message }}</div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="icon-btn" :disabled="testing" @click="test">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <span style="flex: 1" />
        <button class="icon-btn" @click="close">取消</button>
        <button class="icon-btn primary" :disabled="saving" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
}

.seg button {
  flex: 1;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.seg button.active {
  background: var(--accent);
  color: #fff;
}

.msg {
  font-size: 12px;
  color: var(--text-dim);
  padding-left: 106px;
}

.msg.error {
  color: var(--danger);
}
</style>
