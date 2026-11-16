<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import { relativeTime } from '../lib/format'
import Icon from './Icon.vue'

const emit = defineEmits<{
  (event: 'new-session', groupId?: string | null): void
  (event: 'settings'): void
  (event: 'notice', kind: 'success' | 'error', text: string): void
}>()

const store = useAppStore()

const availableClients = computed(() => store.rdClients.filter((client) => client.available))

async function openRecent(sessionId: string): Promise<void> {
  try {
    const result = await store.openSession(sessionId)
    if (result && !result.ok) emit('notice', 'error', result.message)
    else if (result?.ok) emit('notice', 'success', result.message)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function protocolTag(protocol: string): string {
  if (protocol === 'rdp') return 'RDP'
  if (protocol === 'vnc') return 'VNC'
  return 'SSH'
}
</script>

<template>
  <div class="welcome">
    <div class="hero">
      <div class="hero-badge">跨平台 · Windows / Linux / macOS</div>
      <h1>一站式远程运维工作台</h1>
      <p>SSH 终端、SFTP 文件管理、端口转发与远程桌面，全部收在一个窗口里。</p>
      <div class="hero-actions">
        <button class="icon-btn primary" @click="emit('new-session', null)">
          <Icon name="plus" :size="14" /> 新建连接
        </button>
        <button class="icon-btn" @click="store.openLocalTerminal()">
          <Icon name="terminal" :size="14" /> 本机终端
        </button>
        <button class="icon-btn" @click="store.openForwards()">
          <Icon name="link" :size="14" /> 端口转发
        </button>
        <button class="icon-btn" @click="emit('settings')">
          <Icon name="gear" :size="14" /> 设置
        </button>
      </div>
    </div>

    <div class="grid">
      <section class="card">
        <header>
          <Icon name="server" :size="14" />
          <span>最近连接</span>
        </header>
        <div v-if="store.recentSessions.length === 0" class="empty-hint">还没有连接记录</div>
        <button
          v-for="session in store.recentSessions"
          :key="session.id"
          class="recent-row"
          @click="openRecent(session.id)"
        >
          <span class="tag">{{ protocolTag(session.protocol) }}</span>
          <span class="recent-name">{{ session.name }}</span>
          <span class="recent-host mono">{{ session.host }}</span>
          <span class="recent-time">{{ relativeTime(session.lastUsedAt) }}</span>
        </button>
      </section>

      <section class="card">
        <header>
          <Icon name="monitor" :size="14" />
          <span>可用远程桌面客户端</span>
        </header>
        <div v-if="availableClients.length === 0" class="empty-hint">未检测到可用客户端</div>
        <div v-for="client in availableClients" :key="`${client.kind}-${client.id}`" class="client-row">
          <span class="tag">{{ client.kind.toUpperCase() }}</span>
          <span class="recent-name">{{ client.label }}</span>
          <span class="client-detail mono">{{ client.detail }}</span>
        </div>
        <div class="card-foot hint-text">
          远程桌面优先调用系统客户端；VNC 同时提供应用内嵌视图。
        </div>
      </section>

      <section class="card wide-card">
        <header>
          <Icon name="check" :size="14" />
          <span>运行环境</span>
        </header>
        <div class="env-grid">
          <span>本机终端</span>
          <span class="mono">{{ store.info?.ptyAvailable ? 'PTY 就绪' : '管道模式（未编译 node-pty）' }}</span>
          <span>凭据存储</span>
          <span class="mono">{{ store.credentialStatus.backend }} · {{ store.credentialStatus.available ? '已加密' : '未加密' }}</span>
          <span>平台</span>
          <span class="mono">{{ store.info?.platform }} / {{ store.info?.arch }} · Electron {{ store.info?.electron }}</span>
        </div>
        <div class="card-foot hint-text">
          提示：在左侧连接上右键，可直接打开 SFTP、用系统客户端打开 RDP/VNC，或断开连接。
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  height: 100%;
  overflow: auto;
  padding: 32px 36px 40px;
}

.hero-badge {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 12px;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 24px;
  letter-spacing: -0.2px;
}

.hero p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.hero-actions {
  display: flex;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
  margin-top: 28px;
}

.card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 14px;
  min-height: 180px;
}

.wide-card {
  grid-column: 1 / -1;
  min-height: 0;
}

.card header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
  font-weight: 600;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 8px;
}

.recent-row,
.client-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.recent-row:hover {
  background: var(--panel-2);
}

.recent-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.recent-host,
.client-detail {
  color: var(--muted);
  font-size: 11px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-time {
  color: var(--muted);
  font-size: 11px;
}

.tag {
  font-size: 9.5px;
  padding: 0 4px;
  line-height: 15px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--muted);
  flex-shrink: 0;
}

.card-foot {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-soft);
}

.env-grid {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--text-dim);
}

.env-grid span:nth-child(odd) {
  color: var(--muted);
}
</style>
