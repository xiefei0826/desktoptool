<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import RFB from '@novnc/novnc'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'
import InputModal from './InputModal.vue'

const props = defineProps<{ sessionId: string }>()

const container = ref<HTMLDivElement | null>(null)
const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
const message = ref('')
const scaleEnabled = ref(true)
const passwordModal = ref(false)
const waitingPassword = ref(true)

let rfb: RFB | null = null
let channelId = ''

const statusText = (): string => {
  if (status.value === 'connected') return '已连接'
  if (status.value === 'connecting') return '连接中'
  return '已断开'
}

const statusClass = (): string => {
  if (status.value === 'connected') return 'ok'
  if (status.value === 'connecting') return 'warn'
  return 'err'
}

async function connect(password?: string): Promise<void> {
  if (!container.value) return
  status.value = 'connecting'
  message.value = ''

  try {
    const endpoint = await window.api.vnc.open(props.sessionId)
    if (!endpoint.url) throw new Error('VNC 通道未就绪')
    channelId = endpoint.channelId

    container.value.innerHTML = ''
    const options: Record<string, unknown> = { shared: true, wsProtocols: ['binary'] }
    if (password) options.credentials = { password }

    rfb = new RFB(container.value, endpoint.url, options)
    rfb.scaleViewport = scaleEnabled.value
    rfb.clipViewport = false
    rfb.background = '#0f1115'

    rfb.addEventListener('connect', () => {
      status.value = 'connected'
      rfb?.focus()
    })

    rfb.addEventListener('disconnect', (event) => {
      status.value = 'disconnected'
      const detail = (event as CustomEvent).detail as { clean?: boolean } | undefined
      message.value = detail?.clean ? '连接已由远端关闭' : '连接异常断开'
    })

    rfb.addEventListener('credentialsrequired', () => {
      waitingPassword.value = true
      passwordModal.value = true
    })

    rfb.addEventListener('securityfailure', (event) => {
      const detail = (event as CustomEvent).detail as { reason?: string } | undefined
      message.value = `安全握手失败：${detail?.reason ?? '未知原因'}`
    })

    rfb.addEventListener('clipboard', (event) => {
      const detail = (event as CustomEvent).detail as { text?: string } | undefined
      if (detail?.text) void window.api.clipboard.write(detail.text)
    })
  } catch (error) {
    status.value = 'disconnected'
    message.value = errorMessage(error)
  }
}

function cleanup(): void {
  if (rfb) {
    try {
      rfb.disconnect()
    } catch {
      /* ignore */
    }
    rfb = null
  }
  if (channelId) {
    void window.api.channel.close(channelId).catch(() => undefined)
    channelId = ''
  }
  if (container.value) container.value.innerHTML = ''
}

async function reconnect(): Promise<void> {
  cleanup()
  await connect()
}

function applyPassword(password: string): void {
  if (!password) return
  waitingPassword.value = false
  if (rfb) rfb.sendCredentials({ password })
}

function sendCtrlAltDel(): void {
  rfb?.sendCtrlAltDel()
}

async function pasteToRemote(): Promise<void> {
  const text = await window.api.clipboard.read()
  if (text) rfb?.clipboardPasteFrom(text)
}

function toggleScale(): void {
  scaleEnabled.value = !scaleEnabled.value
  if (rfb) rfb.scaleViewport = scaleEnabled.value
}

async function toggleFullscreen(): Promise<void> {
  if (!container.value) return
  if (document.fullscreenElement) await document.exitFullscreen()
  else await container.value.requestFullscreen()
}

onMounted(() => {
  void connect()
})

onBeforeUnmount(cleanup)
</script>

<template>
  <div class="vnc-view">
    <div class="toolbar">
      <span class="badge" :class="statusClass()">{{ statusText() }}</span>
      <span v-if="message" class="hint-text error">{{ message }}</span>
      <span class="spacer" />
      <button class="icon-btn" :class="{ primary: scaleEnabled }" @click="toggleScale">
        <Icon name="fullscreen" :size="13" /> 自适应
      </button>
      <button class="icon-btn" @click="sendCtrlAltDel">Ctrl+Alt+Del</button>
      <button class="icon-btn" @click="pasteToRemote">
        <Icon name="copy" :size="13" /> 粘贴
      </button>
      <button class="icon-btn" @click="toggleFullscreen">
        <Icon name="fullscreen" :size="13" /> 全屏
      </button>
      <button class="icon-btn" @click="reconnect">
        <Icon name="refresh" :size="13" /> 重连
      </button>
    </div>

    <div class="screen-wrap">
      <div ref="container" class="screen" />
      <div v-if="status !== 'connected'" class="overlay">
        <div class="overlay-text">
          {{ status === 'connecting' ? '正在建立 VNC 连接…' : message || '连接已断开' }}
        </div>
        <button v-if="status === 'disconnected'" class="icon-btn primary" @click="reconnect">重新连接</button>
      </div>
    </div>

    <InputModal
      v-model:show="passwordModal"
      title="VNC 认证"
      label="远端 VNC 服务需要密码"
      password
      confirm-text="连接"
      hint="密码仅用于本次握手，不会保存"
      @confirm="applyPassword"
    />
  </div>
</template>

<style scoped>
.vnc-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #000;
}

.screen-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

.screen {
  width: 100%;
  height: 100%;
}

.screen :deep(canvas) {
  outline: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(10, 12, 18, 0.75);
  color: var(--text-dim);
  font-size: 12px;
}

.overlay-text {
  max-width: 70%;
  text-align: center;
  line-height: 1.6;
}

.error {
  color: var(--danger);
}
</style>
