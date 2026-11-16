<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { ForwardRule } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ show: boolean; ruleId?: string | null }>(), { ruleId: null })
const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'saved'): void
}>()

const store = useAppStore()

const form = reactive<Partial<ForwardRule>>({
  name: '',
  sessionId: '',
  type: 'local',
  bindHost: '127.0.0.1',
  bindPort: 8080,
  destHost: '127.0.0.1',
  destPort: 80,
  autoStart: false
})

const saving = ref(false)
const error = ref('')

const sshSessions = computed(() => store.sessions.filter((session) => session.protocol === 'ssh'))

const typeHint = computed(() => {
  if (form.type === 'local') return '本地转发：本机端口 → 远端地址，类似 ssh -L'
  if (form.type === 'remote') return '远程转发：远端端口 → 本机地址，类似 ssh -R'
  return '动态转发：在本机开一个 SOCKS5 代理，类似 ssh -D'
})

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    error.value = ''
    if (props.ruleId) {
      const rule = store.config.forwards.find((item) => item.id === props.ruleId)
      if (rule) Object.assign(form, rule)
    } else {
      Object.assign(form, {
        id: undefined,
        name: '',
        sessionId: sshSessions.value[0]?.id ?? '',
        type: 'local',
        bindHost: '127.0.0.1',
        bindPort: 8080,
        destHost: '127.0.0.1',
        destPort: 80,
        autoStart: false
      })
    }
  },
  { immediate: true }
)

function close(): void {
  emit('update:show', false)
}

async function submit(): Promise<void> {
  error.value = ''
  if (!form.sessionId) {
    error.value = '请选择要使用的 SSH 会话'
    return
  }
  if (!form.name?.trim()) form.name = `${form.bindHost}:${form.bindPort}`
  if (form.type === 'dynamic') {
    form.destHost = ''
    form.destPort = 0
  }

  saving.value = true
  try {
    await store.saveForward({ ...form })
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
    <div class="modal-card" style="width: 540px">
      <div class="modal-head">
        <span>{{ ruleId ? '编辑转发规则' : '新建转发规则' }}</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>

      <div class="modal-body">
        <div class="dialog-form">
          <div class="dialog-row">
            <label>名称</label>
            <input v-model="form.name" class="field" placeholder="例如：内网 MySQL" />
          </div>

          <div class="dialog-row">
            <label>SSH 会话</label>
            <select v-model="form.sessionId" class="field">
              <option value="" disabled>请选择</option>
              <option v-for="session in sshSessions" :key="session.id" :value="session.id">
                {{ session.name }}（{{ session.host }}）
              </option>
            </select>
          </div>

          <div class="dialog-row">
            <label>类型</label>
            <select v-model="form.type" class="field">
              <option value="local">本地转发 (-L)</option>
              <option value="remote">远程转发 (-R)</option>
              <option value="dynamic">动态 SOCKS5 (-D)</option>
            </select>
          </div>

          <div class="hint-text" style="padding-left: 106px">{{ typeHint }}</div>

          <div class="dialog-row">
            <label>绑定地址</label>
            <input v-model="form.bindHost" class="field mono" placeholder="127.0.0.1" />
          </div>

          <div class="dialog-row">
            <label>绑定端口</label>
            <input v-model.number="form.bindPort" class="field" type="number" min="1" max="65535" />
          </div>

          <template v-if="form.type !== 'dynamic'">
            <div class="dialog-row">
              <label>目标地址</label>
              <input v-model="form.destHost" class="field mono" placeholder="127.0.0.1" />
            </div>
            <div class="dialog-row">
              <label>目标端口</label>
              <input v-model.number="form.destPort" class="field" type="number" min="1" max="65535" />
            </div>
          </template>

          <label class="check-row" style="padding-left: 106px">
            <input v-model="form.autoStart" type="checkbox" />
            应用启动后自动开启
          </label>

          <div v-if="error" class="error-text">{{ error }}</div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="icon-btn" @click="close">取消</button>
        <button class="icon-btn primary" :disabled="saving" @click="submit">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.error-text {
  color: var(--danger);
  font-size: 12px;
  padding-left: 106px;
}
</style>
