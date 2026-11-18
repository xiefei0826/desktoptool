<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { MongoCollectionInfo, MongoConnectResult, MongoFindResult } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import Icon from './Icon.vue'

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()
const connection = computed(() => store.dbConnections.find((item) => item.id === props.connectionId))

const info = ref<MongoConnectResult | null>(null)
const errorText = ref('')
const loading = ref(true)
const database = ref('')
const collections = ref<MongoCollectionInfo[]>([])
const collection = ref('')
const filterText = ref('{\n  \n}')
const sortText = ref('')
const limit = ref(50)
const result = ref<MongoFindResult | null>(null)
const queryError = ref('')
const running = ref(false)

const prettyDocs = computed(() =>
  result.value ? JSON.stringify(result.value.documents, null, 2) : ''
)

async function connect(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    info.value = await window.api.mongo.connect(props.connectionId)
    const preferred =
      (connection.value?.database &&
        info.value.databases.find((item) => item.name === connection.value?.database)?.name) ||
      info.value.databases[0]?.name ||
      ''
    database.value = preferred
    await loadCollections()
  } catch (error) {
    errorText.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function loadCollections(): Promise<void> {
  if (!database.value) return
  collections.value = await window.api.mongo.collections(props.connectionId, database.value)
  if (collections.value.length > 0) {
    if (!collections.value.some((item) => item.name === collection.value)) {
      collection.value = collections.value[0].name
    }
    await runQuery()
  } else {
    collection.value = ''
    result.value = null
  }
}

async function changeDatabase(event: Event): Promise<void> {
  database.value = (event.target as HTMLSelectElement).value
  collection.value = ''
  result.value = null
  try {
    await loadCollections()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function selectCollection(name: string): Promise<void> {
  collection.value = name
  await runQuery()
}

async function runQuery(): Promise<void> {
  if (!database.value || !collection.value) return
  running.value = true
  queryError.value = ''
  try {
    result.value = await window.api.mongo.find({
      connectionId: props.connectionId,
      database: database.value,
      collection: collection.value,
      filter: filterText.value.trim() === '{}' ? '' : filterText.value,
      sort: sortText.value,
      limit: Number(limit.value) || 50,
      skip: 0
    })
  } catch (error) {
    queryError.value = errorMessage(error)
    result.value = null
  } finally {
    running.value = false
  }
}

function resetFilter(): void {
  filterText.value = '{\n  \n}'
  sortText.value = ''
  void runQuery()
}

onMounted(() => {
  void connect()
})

onBeforeUnmount(() => {
  void window.api.mongo.disconnect(props.connectionId).catch(() => undefined)
})
</script>

<template>
  <div class="mongo-view">
    <div class="toolbar">
      <span class="badge" :class="errorText ? 'err' : info ? 'ok' : 'warn'">
        {{ errorText ? '连接失败' : info ? `MongoDB ${info.version}` : '连接中' }}
      </span>
      <Icon name="database" :size="14" />
      <span class="conn-name">{{ connection?.name ?? 'MongoDB' }}</span>
      <select v-if="info" class="field mini" :value="database" @change="changeDatabase">
        <option v-for="item in info.databases" :key="item.name" :value="item.name">
          {{ item.name }}
        </option>
      </select>
      <button class="icon-btn" title="刷新集合" @click="loadCollections">
        <Icon name="refresh" :size="13" />
      </button>
      <span class="spacer" />
      <span v-if="result" class="muted">
        匹配 {{ result.matched }} 条 · {{ result.durationMs }}ms
      </span>
    </div>

    <div v-if="errorText" class="error-bar">
      {{ errorText }}
      <button class="icon-btn" @click="connect">重试</button>
    </div>

    <div class="body">
      <aside class="collections">
        <div class="side-head">
          <span>集合</span>
          <span class="muted">{{ collections.length }}</span>
        </div>
        <div class="collection-list">
          <button
            v-for="item in collections"
            :key="item.name"
            class="collection-row"
            :class="{ active: item.name === collection }"
            @click="selectCollection(item.name)"
          >
            <span class="collection-name">{{ item.name }}</span>
            <span class="muted">{{ item.count }}</span>
          </button>
          <div v-if="!loading && collections.length === 0" class="empty-hint">没有集合</div>
        </div>
      </aside>

      <section class="right">
        <div class="query-bar">
          <div class="query-field">
            <label>filter</label>
            <textarea v-model="filterText" class="field code small" spellcheck="false" />
          </div>
          <div class="query-field narrow">
            <label>sort</label>
            <input v-model="sortText" class="field mono" placeholder='{"_id":-1}' />
          </div>
          <div class="query-field tiny">
            <label>limit</label>
            <input v-model.number="limit" class="field" type="number" min="1" max="500" />
          </div>
          <div class="query-actions">
            <button class="icon-btn primary" :disabled="running || !collection" @click="runQuery">
              <Icon name="play" :size="13" /> 执行
            </button>
            <button class="icon-btn" @click="resetFilter">重置</button>
          </div>
        </div>

        <div v-if="queryError" class="query-error">{{ queryError }}</div>

        <pre class="docs">{{ running ? '查询中…' : prettyDocs || '选择集合后执行查询' }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mongo-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.conn-name {
  font-size: 12px;
  color: var(--text);
}

.muted {
  color: var(--muted);
  font-size: 11.5px;
}

.field.mini {
  width: auto;
  min-width: 120px;
  height: 26px;
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger);
  font-size: 12px;
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.collections {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}

.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border-soft);
}

.collection-list {
  flex: 1;
  overflow: auto;
  padding: 4px 6px;
}

.collection-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.collection-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.collection-row.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.collection-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
}

.right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.query-bar {
  display: flex;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-soft);
  align-items: flex-start;
}

.query-field {
  flex: 1;
  min-width: 0;
}

.query-field.narrow {
  flex: 0 0 180px;
}

.query-field.tiny {
  flex: 0 0 90px;
}

.query-field label {
  display: block;
  font-size: 10.5px;
  color: var(--muted);
  margin-bottom: 3px;
}

.code.small {
  height: 62px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
}

.query-actions {
  display: flex;
  gap: 6px;
  padding-top: 16px;
}

.query-error {
  padding: 6px 12px;
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid var(--border-soft);
}

.docs {
  flex: 1;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre;
}
</style>
