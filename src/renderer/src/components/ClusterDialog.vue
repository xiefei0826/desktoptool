<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { K8sCluster } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'imported', cluster: K8sCluster): void
}>()

const store = useAppStore()

const mode = ref<'file' | 'paste' | 'wsl'>('file')
const pasted = ref('')
const name = ref('')
const tunnelSessionId = ref('')
const wslDistros = ref<string[]>([])
const wslDistro = ref('')
const wslPath = ref('~/.kube/config')
const defaultPath = ref('')
const busy = ref(false)
const error = ref('')

const sshSessions = computed(() => store.sessions.filter((session) => session.protocol === 'ssh'))

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    error.value = ''
    pasted.value = ''
    name.value = ''
    tunnelSessionId.value = ''
    try {
      defaultPath.value = await window.api.k8s.defaultKubeconfigPath()
      wslDistros.value = await window.api.k8s.listWslDistros()
      if (!wslDistro.value && wslDistros.value.length > 0) wslDistro.value = wslDistros.value[0]
    } catch {
      /* WSL 不可用不影响其他入口 */
    }
  },
  { immediate: true }
)

function close(): void {
  emit('update:show', false)
}

async function finish(cluster: K8sCluster): Promise<void> {
  if (tunnelSessionId.value) {
    try {
      await window.api.k8s.setTunnel(cluster.id, tunnelSessionId.value)
    } catch (err) {
      error.value = `集群已导入，但隧道设置失败：${errorMessage(err)}`
    }
  }
  await store.reloadClusters()
  emit('imported', cluster)
  close()
}

async function run(action: () => Promise<K8sCluster>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const cluster = await action()
    await finish(cluster)
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function importFromFile(): Promise<void> {
  return run(() => window.api.k8s.importFromFile())
}

function importFromDefault(): Promise<void> {
  return run(() => window.api.k8s.importFromDefault())
}

function importFromText(): Promise<void> {
  if (!pasted.value.trim()) {
    error.value = '请先粘贴 kubeconfig 内容'
    return Promise.resolve()
  }
  return run(() => window.api.k8s.importFromText(pasted.value, name.value || '粘贴的集群'))
}

function importFromWsl(): Promise<void> {
  if (!wslDistro.value) {
    error.value = '没有检测到 WSL 发行版'
    return Promise.resolve()
  }
  return run(() => window.api.k8s.importFromWsl(wslDistro.value, wslPath.value))
}
</script>

<template>
  <div v-if="show" class="modal-mask" @mousedown.self="close">
    <div class="modal-card" style="width: 620px">
      <div class="modal-head">
        <span>添加 Kubernetes 集群</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>

      <div class="modal-body">
        <div class="seg">
          <button :class="{ active: mode === 'file' }" @click="mode = 'file'">本地文件</button>
          <button :class="{ active: mode === 'paste' }" @click="mode = 'paste'">粘贴 kubeconfig</button>
          <button :class="{ active: mode === 'wsl' }" @click="mode = 'wsl'">从 WSL 导入</button>
        </div>

        <div class="dialog-form" style="margin-top: 14px">
          <template v-if="mode === 'file'">
            <div class="hint-text">
              支持选择任意 kubeconfig 文件；也可以一键使用默认路径：
              <span class="mono">{{ defaultPath || '~/.kube/config' }}</span>
            </div>
            <div class="btn-row">
              <button class="icon-btn primary" :disabled="busy" @click="importFromFile">
                <Icon name="folder" :size="13" /> 选择文件
              </button>
              <button class="icon-btn" :disabled="busy" @click="importFromDefault">
                <Icon name="server" :size="13" /> 使用默认 ~/.kube/config
              </button>
            </div>
          </template>

          <template v-else-if="mode === 'paste'">
            <div class="dialog-row">
              <label>集群名称</label>
              <input v-model="name" class="field" placeholder="例如：生产集群" />
            </div>
            <textarea
              v-model="pasted"
              class="field code"
              placeholder="把 kubeconfig 的 YAML 内容粘贴到这里"
              spellcheck="false"
            />
            <div class="hint-text">
              kubeconfig 会先用系统密钥环加密保存；若其中引用的是文件路径而非 base64 数据，
              相对路径会以配置文件所在目录为准。
            </div>
            <button class="icon-btn primary" :disabled="busy" @click="importFromText">
              <Icon name="upload" :size="13" /> 导入
            </button>
          </template>

          <template v-else>
            <div class="dialog-row">
              <label>WSL 发行版</label>
              <select v-model="wslDistro" class="field">
                <option v-if="wslDistros.length === 0" value="">未检测到发行版</option>
                <option v-for="distro in wslDistros" :key="distro" :value="distro">{{ distro }}</option>
              </select>
            </div>
            <div class="dialog-row">
              <label>配置文件</label>
              <input v-model="wslPath" class="field mono" placeholder="~/.kube/config" />
            </div>
            <div class="hint-text">
              会通过 <code>wsl.exe</code> 读取该文件，并把其中的文件型证书内联成 base64，
              这样 Windows 侧也能正常使用。
            </div>
            <button class="icon-btn primary" :disabled="busy" @click="importFromWsl">
              <Icon name="download" :size="13" /> 从 WSL 读取并导入
            </button>
          </template>

          <div class="divider" />

          <div class="dialog-row">
            <label>访问方式</label>
            <select v-model="tunnelSessionId" class="field">
              <option value="">直连 API Server</option>
              <option v-for="session in sshSessions" :key="session.id" :value="session.id">
                经 SSH 隧道（{{ session.name }}）
              </option>
            </select>
          </div>
          <div class="hint-text" style="padding-left: 106px">
            集群 API 只在内网可达时，选一条已保存的 SSH 会话做跳板。
          </div>

          <div v-if="error" class="error-text">{{ error }}</div>
          <div v-if="busy" class="hint-text">正在连接并校验集群…</div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="icon-btn" @click="close">取消</button>
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

.btn-row {
  display: flex;
  gap: 8px;
}

.code {
  height: 180px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
}

.error-text {
  color: var(--danger);
  font-size: 12px;
}

code {
  background: var(--panel-2);
  padding: 0 4px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', Consolas, monospace;
}
</style>
