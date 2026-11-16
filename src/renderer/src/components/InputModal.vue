<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = withDefaults(
  defineProps<{
    show: boolean
    title: string
    label?: string
    value?: string
    placeholder?: string
    password?: boolean
    confirmText?: string
    hint?: string
  }>(),
  { label: '', value: '', placeholder: '', password: false, confirmText: '确定', hint: '' }
)

const emit = defineEmits<{
  (event: 'update:show', value: boolean): void
  (event: 'confirm', value: string): void
}>()

const text = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.show,
  async (visible) => {
    if (!visible) return
    text.value = props.value
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  },
  { immediate: true }
)

function close(): void {
  emit('update:show', false)
}

function submit(): void {
  emit('confirm', text.value)
  close()
}
</script>

<template>
  <div v-if="show" class="modal-mask" @mousedown.self="close">
    <div class="modal-card" style="width: 420px">
      <div class="modal-head">
        <span>{{ title }}</span>
        <button class="icon-btn" @click="close"><Icon name="close" :size="14" /></button>
      </div>
      <div class="modal-body">
        <div v-if="label" class="hint-text" style="margin-bottom: 8px">{{ label }}</div>
        <input
          ref="inputRef"
          v-model="text"
          class="field"
          :type="password ? 'password' : 'text'"
          :placeholder="placeholder"
          @keyup.enter="submit"
          @keyup.esc="close"
        />
        <div v-if="hint" class="hint-text" style="margin-top: 8px">{{ hint }}</div>
      </div>
      <div class="modal-foot">
        <button class="icon-btn" @click="close">取消</button>
        <button class="icon-btn primary" @click="submit">{{ confirmText }}</button>
      </div>
    </div>
  </div>
</template>
