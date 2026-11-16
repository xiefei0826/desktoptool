<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SftpEntry } from '@shared/types'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import { formatBytes, formatTime, modeToRwx } from '../lib/format'
import { joinPath, parentPath, splitPath } from '../lib/path'
import Icon from './Icon.vue'
import InputModal from './InputModal.vue'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()

const cwd = ref('/')
const entries = ref<SftpEntry[]>([])
const selected = ref<SftpEntry | null>(null)
const loading = ref(false)
const errorText = ref('')

const inputModal = ref(false)
const inputTitle = ref('')
const inputLabel = ref('')
const inputValue = ref('')
const inputAction = ref<'mkdir' | 'rename'>('mkdir')

const editorOpen = ref(false)
const editorPath = ref('')
const editorContent = ref('')
const editorLoading = ref(false)

const crumbs = computed(() => splitPath(cwd.value))

async function load(target?: string): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const path = target ?? cwd.value
    const list = await window.api.sftp.list(props.sessionId, path)
    entries.value = list
    selected.value = null
    cwd.value = path
  } catch (error) {
    errorText.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

async function gotoHome(): Promise<void> {
  try {
    const home = await window.api.sftp.home(props.sessionId)
    await load(home)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function openEntry(entry: SftpEntry): void {
  if (entry.type === 'dir') {
    void load(entry.path)
    return
  }
  void openEditor(entry)
}

async function openEditor(entry: SftpEntry): Promise<void> {
  editorOpen.value = true
  editorPath.value = entry.path
  editorContent.value = ''
  editorLoading.value = true
  try {
    editorContent.value = await window.api.sftp.readText(props.sessionId, entry.path)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
    editorOpen.value = false
  } finally {
    editorLoading.value = false
  }
}

async function saveEditor(): Promise<void> {
  try {
    await window.api.sftp.writeText(props.sessionId, editorPath.value, editorContent.value)
    emit('notice', 'success', `已保存 ${editorPath.value}`)
    editorOpen.value = false
    await load()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function upload(): Promise<void> {
  try {
    const result = await window.api.sftp.upload({ sessionId: props.sessionId, remoteDir: cwd.value })
    if (result.uploaded > 0) {
      emit('notice', 'success', `已上传 ${result.uploaded} 个文件`)
      await load()
    }
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function download(): Promise<void> {
  if (!selected.value) {
    emit('notice', 'error', '请先选择一个文件')
    return
  }
  try {
    const result = await window.api.sftp.download({
      sessionId: props.sessionId,
      remotePaths: [selected.value.path]
    })
    if (result.downloaded > 0) emit('notice', 'success', '下载完成')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function askMkdir(): void {
  inputAction.value = 'mkdir'
  inputTitle.value = '新建目录'
  inputLabel.value = `在 ${cwd.value} 下创建`
  inputValue.value = ''
  inputModal.value = true
}

function askRename(): void {
  if (!selected.value) {
    emit('notice', 'error', '请先选择一个条目')
    return
  }
  inputAction.value = 'rename'
  inputTitle.value = '重命名'
  inputLabel.value = selected.value.path
  inputValue.value = selected.value.name
  inputModal.value = true
}

async function handleInput(value: string): Promise<void> {
  const name = value.trim()
  if (!name) return
  try {
    if (inputAction.value === 'mkdir') {
      await window.api.sftp.mkdir(props.sessionId, joinPath(cwd.value, name))
    } else if (selected.value) {
      await window.api.sftp.rename(
        props.sessionId,
        selected.value.path,
        joinPath(cwd.value, name)
      )
    }
    await load()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function removeSelected(): Promise<void> {
  if (!selected.value) return
  const target = selected.value
  if (!window.confirm(`确定删除 ${target.path}？`)) return
  try {
    await window.api.sftp.remove(props.sessionId, target.path, target.type === 'dir')
    emit('notice', 'success', '已删除')
    await load()
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function goUp(): void {
  if (cwd.value === '/') return
  void load(parentPath(cwd.value))
}

onMounted(async () => {
  try {
    const home = await window.api.sftp.home(props.sessionId)
    await load(home)
  } catch (error) {
    errorText.value = errorMessage(error)
    await load('/')
  }
})
</script>

<template>
  <div class="sftp-view">
    <div class="toolbar">
      <button class="icon-btn" title="返回上级" :disabled="cwd === '/'" @click="goUp">
        <Icon name="back" :size="14" />
      </button>
      <button class="icon-btn" title="主目录" @click="gotoHome">
        <Icon name="home" :size="14" />
      </button>
      <button class="icon-btn" title="刷新" @click="load()">
        <Icon name="refresh" :size="14" />
      </button>

      <div class="crumbs">
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span v-if="index > 0" class="sep">/</span>
          <button class="crumb" @click="load(crumb.path)">{{ crumb.name }}</button>
        </template>
      </div>

      <span class="spacer" />
      <button class="icon-btn" @click="askMkdir"><Icon name="folder" :size="14" /> 新建目录</button>
      <button class="icon-btn" @click="upload"><Icon name="upload" :size="14" /> 上传</button>
      <button class="icon-btn" :disabled="!selected" @click="download">
        <Icon name="download" :size="14" /> 下载
      </button>
      <button class="icon-btn" :disabled="!selected" @click="askRename">
        <Icon name="edit" :size="14" />
      </button>
      <button class="icon-btn danger" :disabled="!selected" @click="removeSelected">
        <Icon name="trash" :size="14" />
      </button>
    </div>

    <div v-if="errorText" class="error-bar">{{ errorText }}</div>

    <div class="table-wrap">
      <table class="file-table">
        <thead>
          <tr>
            <th style="width: 46%">名称</th>
            <th style="width: 14%">大小</th>
            <th style="width: 22%">修改时间</th>
            <th style="width: 18%">权限</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.path"
            :class="{ selected: selected?.path === entry.path }"
            @click="selected = entry"
            @dblclick="openEntry(entry)"
          >
            <td class="name-cell">
              <Icon :name="entry.type === 'dir' ? 'folder' : 'file'" :size="13" />
              <span class="name">{{ entry.name }}</span>
            </td>
            <td class="mono">{{ entry.type === 'dir' ? '-' : formatBytes(entry.size) }}</td>
            <td class="mono">{{ formatTime(entry.mtime) }}</td>
            <td class="mono">{{ modeToRwx(entry.mode) }}</td>
          </tr>
          <tr v-if="!loading && entries.length === 0">
            <td colspan="4" class="empty-cell">空目录</td>
          </tr>
        </tbody>
      </table>
      <div v-if="loading" class="loading-mask">加载中…</div>
    </div>

    <div v-if="store.sftpProgress.length" class="progress-bar">
      <div v-for="item in store.sftpProgress" :key="item.id" class="progress-item">
        <Icon :name="item.direction === 'upload' ? 'upload' : 'download'" :size="12" />
        <span class="pname">{{ item.name }}</span>
        <div class="bar">
          <div
            class="bar-inner"
            :style="{ width: `${item.total ? Math.min(100, (item.transferred / item.total) * 100) : 0}%` }"
          />
        </div>
        <span class="pmeta">
          {{ item.error ? '失败' : item.done ? '完成' : formatBytes(item.transferred) }}
        </span>
      </div>
    </div>

    <InputModal
      v-model:show="inputModal"
      :title="inputTitle"
      :label="inputLabel"
      :value="inputValue"
      @confirm="handleInput"
    />

    <div v-if="editorOpen" class="modal-mask" @mousedown.self="editorOpen = false">
      <div class="modal-card wide">
        <div class="modal-head">
          <span class="mono" style="font-size: 12px">{{ editorPath }}</span>
          <button class="icon-btn" @click="editorOpen = false"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body" style="padding: 0">
          <textarea
            v-model="editorContent"
            class="editor"
            spellcheck="false"
            :disabled="editorLoading"
          />
        </div>
        <div class="modal-foot">
          <span v-if="editorLoading" class="hint-text left">加载中…</span>
          <button class="icon-btn" @click="editorOpen = false">取消</button>
          <button class="icon-btn primary" :disabled="editorLoading" @click="saveEditor">
            <Icon name="save" :size="13" /> 保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sftp-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  overflow: hidden;
  margin-left: 4px;
}

.crumb {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.crumb:hover {
  background: var(--panel-2);
  color: var(--text);
}

.sep {
  color: var(--muted);
  font-size: 11px;
}

.error-bar {
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
}

.table-wrap {
  flex: 1;
  overflow: auto;
  position: relative;
  min-height: 0;
}

.file-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.file-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 7px 10px;
  background: var(--panel);
  color: var(--muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}

.file-table td {
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--text-dim);
  white-space: nowrap;
}

.file-table tbody tr {
  cursor: default;
}

.file-table tbody tr:hover {
  background: var(--panel-2);
}

.file-table tbody tr.selected {
  background: var(--accent-soft);
  color: var(--text);
}

.name-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty-cell {
  text-align: center;
  color: var(--muted);
  padding: 30px;
}

.loading-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}

.progress-bar {
  border-top: 1px solid var(--border-soft);
  background: var(--panel);
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 108px;
  overflow: auto;
}

.progress-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-dim);
}

.pname {
  width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--panel-3);
  overflow: hidden;
}

.bar-inner {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s linear;
}

.pmeta {
  width: 70px;
  text-align: right;
  color: var(--muted);
}

.editor {
  width: 100%;
  height: 52vh;
  border: none;
  outline: none;
  resize: none;
  padding: 12px 14px;
  background: var(--bg);
  color: var(--text);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  tab-size: 2;
}
</style>
