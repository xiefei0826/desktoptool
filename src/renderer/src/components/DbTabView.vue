<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import DbView from './DbView.vue'
import RedisView from './RedisView.vue'
import MongoView from './MongoView.vue'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()
const kind = computed(
  () => store.dbConnections.find((item) => item.id === props.connectionId)?.kind ?? 'mysql'
)

function forwardNotice(level: 'success' | 'error', text: string): void {
  emit('notice', level, text)
}
</script>

<template>
  <RedisView
    v-if="kind === 'redis'"
    :connection-id="connectionId"
    @notice="forwardNotice"
  />
  <MongoView
    v-else-if="kind === 'mongo'"
    :connection-id="connectionId"
    @notice="forwardNotice"
  />
  <DbView v-else :connection-id="connectionId" @notice="forwardNotice" />
</template>
