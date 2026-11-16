<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import Icon from './Icon.vue'

const store = useAppStore()
const password = ref('')
const remember = ref(true)
const inputRef = ref<HTMLInputElement | null>(null)

watch(
  () => store.authPrompt,
  async (prompt) => {
    if (!prompt) return
    password.value = ''
    remember.value = true
    await nextTick()
    inputRef.value?.focus()
  },
  { immediate: true }
)

function submit(): void {
  if (!password.value) return
  store.submitAuthPrompt({ password: password.value, remember: remember.value })
}

function cancel(): void {
  store.submitAuthPrompt(null)
}
</script>

<template>
  <div v-if="store.authPrompt" class="modal-mask" @mousedown.self="cancel">
    <div class="modal-card" style="width: 440px">
      <div class="modal-head">
        <span>需要登录凭据</span>
        <button class="icon-btn" @click="cancel"><Icon name="close" :size="14" /></button>
      </div>
      <div class="modal-body">
        <div class="hint-text" style="margin-bottom: 10px">{{ store.authPrompt.hint }}</div>
        <input
          ref="inputRef"
          v-model="password"
          class="field"
          type="password"
          placeholder="密码 / 私钥口令"
          @keyup.enter="submit"
          @keyup.esc="cancel"
        />
        <label class="check-row" style="margin-top: 10px">
          <input v-model="remember" type="checkbox" />
          记住密码（存入系统密钥环）
        </label>
        <div v-if="store.credentialStatus.degraded" class="warn-text">
          系统密钥环不可用，勾选后将以明文保存，可在设置中关闭。
        </div>
      </div>
      <div class="modal-foot">
        <button class="icon-btn" @click="cancel">取消</button>
        <button class="icon-btn primary" :disabled="!password" @click="submit">连接</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.warn-text {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--warning);
  line-height: 1.5;
}
</style>
