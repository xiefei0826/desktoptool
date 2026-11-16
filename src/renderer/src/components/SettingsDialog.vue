<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AppSettings } from '@shared/types'
import { defaultSettings } from '@shared/defaults'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'notice', kind: 'success' | 'error', text: string): void
}>()

const store = useAppStore()
const form = reactive<AppSettings>(defaultSettings())
const includeSecrets = ref(false)
const saving = ref(false)

watch(
  () => props.show,
  (visible) => {
    if (visible) Object.assign(form, store.settings)
  },
  { immediate: true }
)

function close(): void {
  emit('update:show', false)
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await store.saveSettings({ ...form })
    emit('notice', 'success', '设置已保存')
    close()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  } finally {
    saving.value = false
  }
}

async function exportConfig(): Promise<void> {
  try {
    const path = await store.exportConfig(includeSecrets.value)
    if (path) emit('notice', 'success', `已导出到 ${path}`)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function importConfig(): Promise<void> {
  try {
    const message = await store.importConfig()
    emit('notice', 'success', message)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function openUserData(): Promise<void> {
  await window.api.app.openUserData()
}
</script>

<template>
  <div v-if="show" class="modal-mask" @mousedown.self="close">
    <div class="modal-card" style="width: 620px">
      <div class="modal-head">
        <span>设置</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>

      <div class="modal-body">
        <section class="section">
          <h4>外观</h4>
          <div class="dialog-form">
            <div class="dialog-row">
              <label>主题</label>
              <select v-model="form.theme" class="field">
                <option value="dark">深色</option>
                <option value="light">浅色</option>
              </select>
            </div>
            <div class="dialog-row">
              <label>终端字号</label>
              <input v-model.number="form.fontSize" class="field" type="number" min="10" max="28" />
            </div>
            <div class="dialog-row">
              <label>终端字体</label>
              <input v-model="form.fontFamily" class="field mono" />
            </div>
            <div class="dialog-row">
              <label>行为</label>
              <div class="checks">
                <label class="check-row">
                  <input v-model="form.cursorBlink" type="checkbox" /> 光标闪烁
                </label>
                <label class="check-row">
                  <input v-model="form.confirmOnClose" type="checkbox" /> 关闭终端标签时确认
                </label>
              </div>
            </div>
          </div>
        </section>

        <section class="section">
          <h4>凭据安全</h4>
          <div class="dialog-form">
            <div class="dialog-row">
              <label>加密后端</label>
              <div>
                <span class="badge" :class="store.credentialStatus.available ? 'ok' : 'warn'">
                  {{ store.credentialStatus.available ? '系统密钥环可用' : '系统密钥环不可用' }}
                </span>
                <span class="hint-text" style="margin-left: 8px">{{ store.credentialStatus.backend }}</span>
              </div>
            </div>
            <div class="dialog-row">
              <label>降级策略</label>
              <label class="check-row">
                <input v-model="form.allowPlaintextCredential" type="checkbox" />
                密钥环不可用时仍以明文保存密码
              </label>
            </div>
            <div class="hint-text" style="padding-left: 106px">
              Linux 上若没有 libsecret / KWallet，Electron 只能降级为明文存储，建议保持关闭。
            </div>
          </div>
        </section>

        <section class="section">
          <h4>配置</h4>
          <div class="dialog-form">
            <div class="dialog-row">
              <label>数据目录</label>
              <div style="display: flex; gap: 8px; align-items: center">
                <span class="hint-text mono ellipsis">{{ store.info?.userDataPath }}</span>
                <button class="icon-btn" @click="openUserData"><Icon name="external" :size="13" /></button>
              </div>
            </div>
            <div class="dialog-row">
              <label>导出</label>
              <div style="display: flex; gap: 10px; align-items: center">
                <button class="icon-btn" @click="exportConfig"><Icon name="download" :size="13" /> 导出配置</button>
                <label class="check-row">
                  <input v-model="includeSecrets" type="checkbox" /> 包含密码（明文）
                </label>
              </div>
            </div>
            <div class="dialog-row">
              <label>导入</label>
              <button class="icon-btn" style="justify-self: start" @click="importConfig">
                <Icon name="upload" :size="13" /> 从 JSON 导入
              </button>
            </div>
          </div>
        </section>

        <section class="section">
          <h4>环境</h4>
          <div class="kv">
            <span>版本</span><span class="mono">{{ store.info?.version }}</span>
            <span>平台</span><span class="mono">{{ store.info?.platform }} / {{ store.info?.arch }}</span>
            <span>Electron</span><span class="mono">{{ store.info?.electron }}</span>
            <span>本机终端</span>
            <span class="mono">{{ store.info?.ptyAvailable ? 'node-pty (PTY)' : '管道模式（未启用 PTY）' }}</span>
            <span>远程桌面客户端</span>
            <span class="mono">
              {{ store.rdClients.filter((client) => client.available).map((client) => client.label).join('、') || '未检测到' }}
            </span>
          </div>
        </section>
      </div>

      <div class="modal-foot">
        <button class="icon-btn" @click="close">取消</button>
        <button class="icon-btn primary" :disabled="saving" @click="save">保存设置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.section {
  margin-bottom: 18px;
}

.section h4 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-soft);
}

.checks {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.kv {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
}

.kv span:nth-child(odd) {
  color: var(--muted);
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 330px;
}
</style>
