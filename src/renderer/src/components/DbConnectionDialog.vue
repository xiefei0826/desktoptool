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

interface DbProfile {
  port: number
  username: string
  database: string
  authSource: string
  databaseLabel: string
  databaseHint: string
  usernameHint: string
}

/** 不同数据库的默认端口 / 用户名 / 默认库各不相同 */
const PROFILES: Record<DbKind, DbProfile> = {
  mysql: {
    port: 3306,
    username: 'root',
    database: '',
    authSource: 'admin',
    databaseLabel: '数据库',
    databaseHint: '可选，留空则列出全部库',
    usernameHint: 'root'
  },
  postgres: {
    port: 5432,
    username: 'postgres',
    database: 'postgres',
    authSource: 'admin',
    databaseLabel: '数据库',
    databaseHint: '默认 postgres',
    usernameHint: 'postgres'
  },
  redis: {
    port: 6379,
    username: '',
    database: '',
    authSource: 'admin',
    databaseLabel: '数据库',
    databaseHint: 'Redis 没有库名，用库序号',
    usernameHint: '通常为空（旧版 Redis 只有密码）'
  },
  mongo: {
    port: 27017,
    username: '',
    database: 'admin',
    authSource: 'admin',
    databaseLabel: '默认数据库',
    databaseHint: '默认 admin',
    usernameHint: '未开启认证时留空'
  }
}

function emptyConnection(): DbConnection {
  const profile = PROFILES.mysql
  return {
    id: '',
    name: '',
    kind: 'mysql',
    host: '127.0.0.1',
    port: profile.port,
    username: profile.username,
    database: profile.database,
    ssl: false,
    dbIndex: 0,
    authSource: profile.authSource,
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

/** 切换类型时只替换「仍是上一种默认值」的字段，不覆盖用户手填的内容 */
function onKindChange(kind: DbKind): void {
  if (kind === form.value.kind) return
  const previous = PROFILES[form.value.kind]
  const next = PROFILES[kind]

  if (!form.value.port || form.value.port === previous.port) form.value.port = next.port
  if (!form.value.username || form.value.username === previous.username) {
    form.value.username = next.username
  }
  if (!form.value.database || form.value.database === previous.database) {
    form.value.database = next.database
  }
  if (!form.value.authSource) form.value.authSource = next.authSource
  if (form.value.dbIndex === undefined) form.value.dbIndex = 0

  form.value.kind = kind
}

const profile = computed(() => PROFILES[form.value.kind])

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
    dbIndex: Number(value.dbIndex ?? 0),
    authSource: value.authSource || 'admin',
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
    if ('serverVersion' in result) {
      message.value = `连接成功：${result.serverVersion}（${result.metadata.tables.length} 张表）`
    } else if ('keyCount' in result) {
      message.value = `连接成功：Redis ${result.version}（db${result.currentDb}，${result.keyCount} 个键）`
    } else {
      message.value = `连接成功：MongoDB ${result.version}（${result.databases.length} 个库）`
    }
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
            MySQL
          </button>
          <button :class="{ active: form.kind === 'postgres' }" @click="onKindChange('postgres')">
            PostgreSQL
          </button>
          <button :class="{ active: form.kind === 'redis' }" @click="onKindChange('redis')">
            Redis
          </button>
          <button :class="{ active: form.kind === 'mongo' }" @click="onKindChange('mongo')">
            MongoDB
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
            <input v-model="form.username" class="field" :placeholder="profile.usernameHint" />
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

          <div v-if="form.kind === 'redis'" class="dialog-row">
            <label>库序号</label>
            <input v-model.number="form.dbIndex" class="field" type="number" min="0" max="15" />
          </div>

          <template v-else-if="form.kind === 'mongo'">
            <div class="dialog-row">
              <label>{{ profile.databaseLabel }}</label>
              <input v-model="form.database" class="field" :placeholder="profile.databaseHint" />
            </div>
            <div class="dialog-row">
              <label>认证库</label>
              <input v-model="form.authSource" class="field" placeholder="admin" />
            </div>
          </template>

          <div v-else class="dialog-row">
            <label>{{ profile.databaseLabel }}</label>
            <input v-model="form.database" class="field" :placeholder="profile.databaseHint" />
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
