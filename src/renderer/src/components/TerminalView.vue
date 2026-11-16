<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { IDisposable } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { useAppStore } from '../stores/app'
import { darkTerminalTheme, lightTerminalTheme } from '../lib/terminal-theme'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{
  sessionId?: string
  local?: boolean
  title: string
  /** 主进程已建好的通道（K8s 日志 / Exec），有值时不再自行创建 */
  channelId?: string
  readOnly?: boolean
}>()

const store = useAppStore()

const host = ref<HTMLDivElement | null>(null)
const searchVisible = ref(false)
const searchText = ref('')
const status = ref<'connecting' | 'ready' | 'closed'>('connecting')
const driver = ref('')
const errorText = ref('')

let term: Terminal | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let channelId = ''
let dataDisposable: IDisposable | null = null
let resizeDisposable: IDisposable | null = null
let resizeObserver: ResizeObserver | null = null

const isDark = computed(() => store.settings.theme === 'dark')

const statusText = computed(() => {
  if (status.value === 'ready') return props.local ? `本机 · ${driver.value}` : '已连接'
  if (status.value === 'connecting') return '连接中'
  return '已断开'
})

const statusClass = computed(() => {
  if (status.value === 'ready') return 'ok'
  if (status.value === 'connecting') return 'warn'
  return 'err'
})

function createTerminal(): void {
  if (!host.value) return

  term = new Terminal({
    fontSize: store.settings.fontSize,
    fontFamily: store.settings.fontFamily,
    cursorBlink: store.settings.cursorBlink,
    theme: isDark.value ? darkTerminalTheme : lightTerminalTheme,
    allowProposedApi: true,
    scrollback: 8000,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    // K8s 日志是流式输出，禁止键盘输入
    disableStdin: Boolean(props.readOnly)
  })

  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  searchAddon = new SearchAddon()
  term.loadAddon(searchAddon)

  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  try {
    term.unicode.activeVersion = '11'
  } catch {
    /* ignore */
  }

  term.open(host.value)
  try {
    term.loadAddon(new WebglAddon())
  } catch {
    /* WebGL 不可用时回退 canvas 渲染 */
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
      void copySelection()
      return false
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
      void pasteClipboard()
      return false
    }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyF') {
      searchVisible.value = true
      return false
    }
    return true
  })
}

function bindInput(): void {
  dataDisposable?.dispose()
  dataDisposable =
    term?.onData((data) => {
      if (!channelId) return
      window.api.stream.write(channelId, new TextEncoder().encode(data))
    }) ?? null

  resizeDisposable?.dispose()
  resizeDisposable =
    term?.onResize(({ cols, rows }) => {
      if (!channelId) return
      window.api.stream.resize(channelId, cols, rows)
    }) ?? null
}

async function connect(): Promise<void> {
  if (!host.value) return
  status.value = 'connecting'
  errorText.value = ''

  if (!term) createTerminal()
  if (!term) return

  await nextTick()
  try {
    fitAddon?.fit()
  } catch {
    /* ignore */
  }

  const cols = term.cols || 80
  const rows = term.rows || 24

  try {
    const endpoint = props.channelId
      ? { channelId: props.channelId }
      : props.local
        ? await window.api.pty.create({ cols, rows })
        : await window.api.ssh.openShell({ sessionId: props.sessionId ?? '', cols, rows })

    channelId = endpoint.channelId
    if ('driver' in endpoint) driver.value = String(endpoint.driver)

    bindInput()

    await window.api.stream.open(channelId, {
      onData: (data) => term?.write(data),
      onClose: (reason) => {
        if (status.value !== 'closed') {
          term?.writeln(`\r\n\x1b[90m[连接已关闭${reason ? `：${reason}` : ''}]\x1b[0m`)
        }
        status.value = 'closed'
        channelId = ''
      }
    })

    status.value = 'ready'
    term.focus()
  } catch (error) {
    status.value = 'closed'
    errorText.value = errorMessage(error)
    term.writeln(`\x1b[31m${errorText.value}\x1b[0m`)
    term.writeln('\x1b[90m可点击右上角「重连」重试\x1b[0m')
  }
}

function cleanup(): void {
  dataDisposable?.dispose()
  dataDisposable = null
  resizeDisposable?.dispose()
  resizeDisposable = null
  resizeObserver?.disconnect()
  resizeObserver = null

  if (channelId) {
    window.api.stream.close(channelId)
    channelId = ''
  }

  term?.dispose()
  term = null
  fitAddon = null
  searchAddon = null
  if (host.value) host.value.innerHTML = ''
}

async function restart(): Promise<void> {
  cleanup()
  status.value = 'connecting'
  await nextTick()
  await connect()
}

async function copySelection(): Promise<void> {
  const selected = term?.getSelection() ?? ''
  if (!selected) return
  await window.api.clipboard.write(selected)
}

async function pasteClipboard(): Promise<void> {
  const text = await window.api.clipboard.read()
  if (text && channelId) window.api.stream.write(channelId, new TextEncoder().encode(text))
}

async function openAnother(): Promise<void> {
  try {
    if (props.local) store.openLocalTerminal()
    else if (props.sessionId) await store.openNewTerminal(props.sessionId)
  } catch (error) {
    errorText.value = errorMessage(error)
  }
}

function findNext(): void {
  if (searchText.value) searchAddon?.findNext(searchText.value)
}

function findPrevious(): void {
  if (searchText.value) searchAddon?.findPrevious(searchText.value)
}

onMounted(async () => {
  createTerminal()
  await nextTick()
  if (host.value) {
    resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon?.fit()
      } catch {
        /* ignore */
      }
    })
    resizeObserver.observe(host.value)
  }
  await connect()
})

onBeforeUnmount(cleanup)

watch(
  () => store.settings.fontSize,
  (size) => {
    if (!term) return
    term.options.fontSize = size
    try {
      fitAddon?.fit()
    } catch {
      /* ignore */
    }
  }
)

watch(
  () => store.settings.cursorBlink,
  (blink) => {
    if (term) term.options.cursorBlink = blink
  }
)

watch(isDark, (dark) => {
  if (term) term.options.theme = dark ? darkTerminalTheme : lightTerminalTheme
})

defineExpose({ restart })
</script>

<template>
  <div class="terminal-view">
    <div class="toolbar">
      <span class="badge" :class="statusClass">{{ statusText }}</span>
      <span class="title">{{ title }}</span>
      <span v-if="errorText" class="hint-text error">{{ errorText }}</span>
      <span class="spacer" />
      <button class="icon-btn" title="再开一个相同连接的终端" @click="openAnother">
        <Icon name="plus" :size="14" />
      </button>
      <button class="icon-btn" title="搜索 (Ctrl+Shift+F)" @click="searchVisible = !searchVisible">
        <Icon name="search" :size="14" />
      </button>
      <button class="icon-btn" title="清屏" @click="term?.clear()">
        <Icon name="trash" :size="14" />
      </button>
      <button class="icon-btn" title="重连" @click="restart">
        <Icon name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="searchVisible" class="search-bar">
      <input
        v-model="searchText"
        class="field"
        placeholder="在终端中搜索"
        @keyup.enter="findNext"
        @keyup.esc="searchVisible = false"
      />
      <button class="icon-btn" @click="findPrevious">上一个</button>
      <button class="icon-btn" @click="findNext">下一个</button>
      <button class="icon-btn" @click="searchVisible = false"><Icon name="close" :size="13" /></button>
    </div>

    <div ref="host" class="terminal-host" />
  </div>
</template>

<style scoped>
.terminal-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.title {
  font-size: 12px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}

.error {
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border-soft);
}

.search-bar .field {
  max-width: 280px;
}

.terminal-host {
  flex: 1;
  min-height: 0;
  padding: 6px 2px 2px 8px;
  overflow: hidden;
}

.terminal-host :deep(.xterm) {
  height: 100%;
}

.terminal-host :deep(.xterm-viewport) {
  background: transparent !important;
}
</style>
