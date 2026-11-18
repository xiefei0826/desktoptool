<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { SessionInput } from '@shared/types'
import { emptySessionInput } from '@shared/defaults'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{ show: boolean; sessionId?: string; presetGroupId?: string | null }>(),
  { sessionId: '', presetGroupId: null }
)

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'saved'): void
}>()

const store = useAppStore()

const form = reactive<SessionInput>(emptySessionInput())
const password = ref('')
const passphrase = ref('')
const hasStoredPassword = ref(false)
const hasStoredPassphrase = ref(false)
const saving = ref(false)
const error = ref('')

const isEdit = computed(() => Boolean(props.sessionId))

const tunnelOptions = computed(() => [
  { value: '', label: '不使用（直连）' },
  ...store.sessions
    .filter((session) => session.protocol === 'ssh' && session.id !== form.id)
    .map((session) => ({ value: session.id, label: `${session.name}（${session.host}）` }))
])

const groupOptions = computed(() => [
  { value: '', label: '未分组' },
  ...store.groups.map((group) => ({ value: group.id, label: group.name }))
])

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    error.value = ''
    password.value = ''
    passphrase.value = ''
    hasStoredPassword.value = false
    hasStoredPassphrase.value = false

    if (props.sessionId) {
      const session = store.sessions.find((item) => item.id === props.sessionId)
      if (session) {
        const { createdAt: _c, updatedAt: _u, lastUsedAt: _l, ...rest } = session
        Object.assign(form, rest)
        hasStoredPassword.value = await window.api.credential.has(`session:${session.id}:password`)
        hasStoredPassphrase.value = await window.api.credential.has(`session:${session.id}:passphrase`)
      }
    } else {
      Object.assign(form, emptySessionInput(), { groupId: props.presetGroupId ?? null })
    }
  },
  { immediate: true }
)

function onProtocolChange(protocol: 'ssh' | 'rdp' | 'vnc'): void {
  form.protocol = protocol
  form.port = protocol === 'ssh' ? 22 : protocol === 'rdp' ? 3389 : 5900
}

async function pickPrivateKey(): Promise<void> {
  const selected = await window.api.app.pickFile('选择 SSH 私钥文件')
  if (selected) form.privateKeyPath = selected
}

function close(): void {
  emit('update:show', false)
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.host.trim()) {
    error.value = '请填写主机地址'
    return
  }
  if (!form.name.trim()) form.name = form.host.trim()
  if (form.protocol !== 'ssh' && !form.username.trim()) {
    // 远程桌面允许留空用户名（由客户端弹窗输入）
  }

  saving.value = true
  try {
    // JSON 往返一次，避免把 Vue 响应式 Proxy 传进 IPC
    const payload = JSON.parse(
      JSON.stringify({ ...form, groupId: form.groupId || null })
    ) as SessionInput
    const saved = await store.saveSession(payload)
    if (password.value) {
      await window.api.credential.set(`session:${saved.id}:password`, password.value)
    }
    if (passphrase.value) {
      await window.api.credential.set(`session:${saved.id}:passphrase`, passphrase.value)
    }
    emit('saved')
    close()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="show" class="modal-mask" @mousedown.self="close">
    <div class="modal-card" style="width: 600px">
      <div class="modal-head">
        <span>{{ isEdit ? '编辑连接' : '新建连接' }}</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>

      <div class="modal-body">
        <div class="seg">
          <button :class="{ active: form.protocol === 'ssh' }" @click="onProtocolChange('ssh')">
            SSH
          </button>
          <button :class="{ active: form.protocol === 'rdp' }" @click="onProtocolChange('rdp')">
            RDP 远程桌面
          </button>
          <button :class="{ active: form.protocol === 'vnc' }" @click="onProtocolChange('vnc')">
            VNC
          </button>
        </div>

        <div class="dialog-form" style="margin-top: 12px">
          <div class="dialog-row">
            <label>名称</label>
            <input v-model="form.name" class="field" placeholder="例如：生产 Web 服务器" />
          </div>

          <div class="dialog-row">
            <label>主机</label>
            <input v-model="form.host" class="field" placeholder="IP 或域名" />
          </div>

          <div class="dialog-row">
            <label>端口</label>
            <input v-model.number="form.port" class="field" type="number" min="1" max="65535" />
          </div>

          <div class="dialog-row">
            <label>用户名</label>
            <input v-model="form.username" class="field" placeholder="登录用户名" />
          </div>

          <div class="dialog-row">
            <label>分组</label>
            <select v-model="form.groupId" class="field">
              <option v-for="option in groupOptions" :key="option.value" :value="option.value || null">
                {{ option.label }}
              </option>
            </select>
          </div>

          <template v-if="form.protocol === 'ssh'">
            <div class="divider" />

            <div class="dialog-row">
              <label>认证方式</label>
              <select v-model="form.authType" class="field">
                <option value="password">密码 / 交互式</option>
                <option value="privateKey">私钥文件</option>
              </select>
            </div>

            <div v-if="form.authType === 'privateKey'" class="dialog-row wide">
              <label>私钥</label>
              <input v-model="form.privateKeyPath" class="field mono" placeholder="C:\Users\...\id_rsa" />
              <button class="icon-btn" @click="pickPrivateKey">选择</button>
            </div>

            <div v-if="form.authType === 'password'" class="dialog-row">
              <label>密码</label>
              <input
                v-model="password"
                class="field"
                type="password"
                :placeholder="hasStoredPassword ? '已保存，留空表示不修改' : '留空则连接时询问'"
              />
            </div>

            <div v-else class="dialog-row">
              <label>私钥口令</label>
              <input
                v-model="passphrase"
                class="field"
                type="password"
                :placeholder="hasStoredPassphrase ? '已保存，留空表示不修改' : '私钥无口令可留空'"
              />
            </div>
          </template>

          <template v-else-if="form.protocol === 'rdp'">
            <div class="divider" />

            <div class="dialog-row">
              <label>分辨率</label>
              <div style="display: flex; gap: 8px; align-items: center">
                <input v-model.number="form.rdp.width" class="field" type="number" style="width: 96px" />
                <span class="hint-text">×</span>
                <input v-model.number="form.rdp.height" class="field" type="number" style="width: 96px" />
                <label class="check-row">
                  <input v-model="form.rdp.fullscreen" type="checkbox" /> 全屏
                </label>
              </div>
            </div>

            <div class="dialog-row">
              <label>颜色深度</label>
              <select v-model.number="form.rdp.colorDepth" class="field">
                <option :value="16">16 位</option>
                <option :value="24">24 位</option>
                <option :value="32">32 位</option>
              </select>
            </div>

            <div class="dialog-row">
              <label>域</label>
              <input v-model="form.rdp.domain" class="field" placeholder="可选，AD 域" />
            </div>

            <div class="dialog-row">
              <label>选项</label>
              <div class="checks">
                <label class="check-row">
                  <input v-model="form.rdp.clipboard" type="checkbox" /> 剪贴板重定向
                </label>
                <label class="check-row">
                  <input v-model="form.rdp.adminSession" type="checkbox" /> 管理员会话
                </label>
              </div>
            </div>

            <div class="dialog-row">
              <label>密码</label>
              <input
                v-model="password"
                class="field"
                type="password"
                :placeholder="hasStoredPassword ? '已保存，留空表示不修改' : 'Windows 登录密码（可选）'"
              />
            </div>
          </template>

          <template v-else>
            <div class="divider" />
            <div class="hint-text">
              VNC 默认使用应用内嵌的 noVNC 打开；也可以在连接上右键选择用系统客户端打开。
              密码在连接时输入，不在此保存。
            </div>
          </template>

          <div class="divider" />

          <div class="dialog-row">
            <label>SSH 隧道</label>
            <select v-model="form.tunnelSessionId" class="field">
              <option v-for="option in tunnelOptions" :key="option.value" :value="option.value || null">
                {{ option.label }}
              </option>
            </select>
          </div>

          <div class="dialog-row">
            <label>备注</label>
            <textarea v-model="form.note" class="field" placeholder="可选" />
          </div>

          <div v-if="error" class="error-text">{{ error }}</div>
        </div>
      </div>

      <div class="modal-foot">
        <span class="hint-text left">{{ form.protocol === 'ssh' ? 'SSH' : form.protocol.toUpperCase() }} · {{ form.host || '未填写主机' }}:{{ form.port }}</span>
        <button class="icon-btn" @click="close">取消</button>
        <button class="icon-btn primary" :disabled="saving" @click="submit">
          {{ saving ? '保存中…' : '保存' }}
        </button>
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

.checks {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.error-text {
  color: var(--danger);
  font-size: 12px;
}
</style>
