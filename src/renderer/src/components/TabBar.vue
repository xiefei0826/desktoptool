<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore, type Tab } from '../stores/app'
import Icon from './Icon.vue'

const props = defineProps<{ tabs: Tab[]; activeId: string }>()
const emit = defineEmits<{ (event: 'select', id: string): void; (event: 'close', id: string): void }>()

const store = useAppStore()

/** 同一连接多开时，标题自动编号：web-01、(2)、(3)… */
const labels = computed<Record<string, string>>(() => {
  const counts = new Map<string, number>()
  const result: Record<string, string> = {}
  for (const tab of props.tabs) {
    const next = (counts.get(tab.groupKey) ?? 0) + 1
    counts.set(tab.groupKey, next)
    result[tab.id] = next === 1 ? tab.title : `${tab.title} (${next})`
  }
  return result
})

function iconOf(tab: Tab): string {
  if (tab.kind === 'terminal') return tab.local ? 'terminal' : 'server'
  if (tab.kind === 'sftp') return 'folder'
  if (tab.kind === 'vnc') return 'monitor'
  if (tab.kind === 'k8s') return 'globe'
  return 'link'
}

function close(id: string): void {
  const tab = store.tabs.find((item) => item.id === id)
  if (tab && store.settings.confirmOnClose && (tab.kind === 'terminal' || tab.kind === 'vnc')) {
    const ok = window.confirm(`确定关闭「${tab.title}」？会话将被断开。`)
    if (!ok) return
  }
  emit('close', id)
}
</script>

<template>
  <div v-if="tabs.length" class="tab-bar">
    <div
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === activeId }"
      @mousedown.left="emit('select', tab.id)"
      @mousedown.middle.prevent="close(tab.id)"
    >
      <Icon :name="iconOf(tab)" :size="13" />
      <span class="tab-title" :title="labels[tab.id]">{{ labels[tab.id] }}</span>
      <button class="tab-close" title="关闭" @mousedown.stop @click.stop="close(tab.id)">
        <Icon name="close" :size="11" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  gap: 1px;
  height: 34px;
  padding: 0 6px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  overflow-y: hidden;
  flex-shrink: 0;
}

.tab-bar::-webkit-scrollbar {
  height: 3px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 120px;
  max-width: 220px;
  padding: 0 6px 0 10px;
  margin-top: 4px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.tab:hover {
  background: var(--panel-2);
  color: var(--text-dim);
}

.tab.active {
  background: var(--bg);
  border-color: var(--border);
  color: var(--text);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  cursor: pointer;
}

.tab-close:hover {
  background: var(--panel-3);
  opacity: 1;
}
</style>
