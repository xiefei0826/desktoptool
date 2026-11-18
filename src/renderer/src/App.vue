<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useAppStore } from './stores/app'
import { errorMessage } from './lib/errors'
import Sidebar from './components/Sidebar.vue'
import TabBar from './components/TabBar.vue'
import TerminalView from './components/TerminalView.vue'
import SftpView from './components/SftpView.vue'
import VncView from './components/VncView.vue'
import ForwardsView from './components/ForwardsView.vue'
import K8sView from './components/K8sView.vue'
import DbTabView from './components/DbTabView.vue'
import WelcomeView from './components/WelcomeView.vue'
import StatusBar from './components/StatusBar.vue'
import SessionDialog from './components/SessionDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ClusterDialog from './components/ClusterDialog.vue'
import DbConnectionDialog from './components/DbConnectionDialog.vue'
import CredentialPrompt from './components/CredentialPrompt.vue'
import type { DbConnection, K8sCluster } from '@shared/types'

interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

const store = useAppStore()

const ready = ref(false)
const fatal = ref('')
const sessionDialog = ref(false)
const editingSessionId = ref('')
const presetGroupId = ref<string | null>(null)
const settingsDialog = ref(false)
const clusterDialog = ref(false)
const dbDialog = ref(false)
const toasts = ref<Toast[]>([])

let toastSeq = 0

function notify(kind: Toast['kind'], text: string): void {
  if (!text) return
  const id = (toastSeq += 1)
  toasts.value = [...toasts.value, { id, kind, text }]
  setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id)
  }, 4200)
}

onMounted(async () => {
  try {
    await store.bootstrap()
    document.documentElement.dataset.theme = store.settings.theme
    ready.value = true

    // 由「在新窗口打开」带过来的会话参数
    const requested = new URLSearchParams(window.location.search).get('session')
    if (requested) {
      window.history.replaceState({}, '', window.location.pathname)
      try {
        const result = await store.openSession(requested)
        if (result && !result.ok) notify('error', result.message)
      } catch (error) {
        notify('error', errorMessage(error))
      }
    }
  } catch (error) {
    fatal.value = errorMessage(error)
  }
})

watch(
  () => store.settings.theme,
  (theme) => {
    document.documentElement.dataset.theme = theme
  }
)

function openNewSession(groupId?: string | null): void {
  editingSessionId.value = ''
  presetGroupId.value = groupId ?? null
  sessionDialog.value = true
}

function openEditSession(sessionId: string): void {
  editingSessionId.value = sessionId
  presetGroupId.value = null
  sessionDialog.value = true
}

function selectTab(id: string): void {
  store.activeTabId = id
}

function onClusterImported(cluster: K8sCluster): void {
  notify('success', `已导入集群 ${cluster.name}`)
  store.openK8sTab(cluster.id)
}

function onDbSaved(connection: DbConnection): void {
  notify('success', `已保存数据库连接 ${connection.name}`)
  store.openDbTab(connection.id)
}
</script>

<template>
  <div class="app-shell">
    <div v-if="!ready" class="boot">
      <div v-if="fatal" class="boot-error">
        <div class="boot-title">启动失败</div>
        <div class="hint-text">{{ fatal }}</div>
      </div>
      <div v-else class="hint-text">正在加载…</div>
    </div>

    <div v-else class="app-body">
      <Sidebar
        @new-session="openNewSession"
        @edit-session="openEditSession"
        @settings="settingsDialog = true"
        @add-cluster="clusterDialog = true"
        @add-db="dbDialog = true"
        @notice="notify"
      />

      <section class="main-area">
        <TabBar :tabs="store.tabs" :active-id="store.activeTabId" @select="selectTab" @close="store.closeTab" />

        <div class="tab-content">
          <WelcomeView
            v-if="store.tabs.length === 0"
            @new-session="openNewSession"
            @settings="settingsDialog = true"
            @notice="notify"
          />
          <template v-else>
            <div
              v-for="tab in store.tabs"
              v-show="tab.id === store.activeTabId"
              :key="tab.id"
              class="tab-pane"
            >
              <TerminalView
                v-if="tab.kind === 'terminal'"
                :session-id="tab.sessionId"
                :local="tab.local"
                :title="tab.title"
                :channel-id="tab.channelId"
                :read-only="tab.readOnly"
              />
              <SftpView
                v-else-if="tab.kind === 'sftp'"
                :session-id="tab.sessionId ?? ''"
                @notice="notify"
              />
              <VncView v-else-if="tab.kind === 'vnc'" :session-id="tab.sessionId ?? ''" />
              <K8sView
                v-else-if="tab.kind === 'k8s'"
                :key="`${tab.id}:${tab.clusterId}`"
                :cluster-id="tab.clusterId ?? ''"
                @notice="notify"
              />
              <DbTabView
                v-else-if="tab.kind === 'db'"
                :key="`${tab.id}:${tab.dbConnectionId}`"
                :connection-id="tab.dbConnectionId ?? ''"
                @notice="notify"
              />
              <ForwardsView v-else @notice="notify" />
            </div>
          </template>
        </div>

        <StatusBar />
      </section>
    </div>

    <SessionDialog
      v-model:show="sessionDialog"
      :session-id="editingSessionId"
      :preset-group-id="presetGroupId"
      @saved="notify('success', '连接已保存')"
    />
    <SettingsDialog v-model:show="settingsDialog" @notice="notify" />
    <ClusterDialog v-model:show="clusterDialog" @imported="onClusterImported" />
    <DbConnectionDialog v-model:show="dbDialog" @saved="onDbSaved" />
    <CredentialPrompt />

    <div class="toast-stack">
      <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind">
        {{ toast.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.boot {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.boot-error {
  text-align: center;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.boot-title {
  font-size: 16px;
  color: var(--danger);
}

.toast-stack {
  position: fixed;
  right: 16px;
  bottom: 40px;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  min-width: 200px;
  max-width: 420px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  animation: toast-in 0.16s ease-out;
}

.toast.success {
  border-color: rgba(34, 197, 94, 0.4);
  color: #8ff0b0;
}

.toast.error {
  border-color: rgba(239, 68, 68, 0.4);
  color: #ff9b9b;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
