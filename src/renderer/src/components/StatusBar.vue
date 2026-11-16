<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'

const store = useAppStore()

const platformText = computed(() => {
  const platform = store.info?.platform ?? ''
  const map: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
  return map[platform] ?? platform
})

const ptyText = computed(() => {
  if (!store.info) return ''
  return store.info.ptyAvailable ? 'PTY 就绪' : 'PTY 不可用（本机终端降级为管道模式）'
})

const credentialText = computed(() => {
  const status = store.credentialStatus
  if (!status.backend) return ''
  return `${status.available ? '凭据加密' : '凭据未加密'} · ${status.backend}`
})
</script>

<template>
  <div class="status-bar">
    <span>
      <span class="dot" :class="store.connectedCount ? 'ok' : ''" />
      SSH 已连接 {{ store.connectedCount }}
    </span>
    <span>转发运行中 {{ store.runningForwardCount }}</span>
    <span class="spacer" style="flex: 1" />
    <span v-if="ptyText">{{ ptyText }}</span>
    <span v-if="credentialText">{{ credentialText }}</span>
    <span>{{ platformText }} · Electron {{ store.info?.electron ?? '-' }}</span>
  </div>
</template>
