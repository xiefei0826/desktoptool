<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { format } from 'sql-formatter'
import type {
  DbColumn,
  DbMetadata,
  DbParseResult,
  DbResultSet,
  DbTable
} from '@shared/types'
import { SYSTEM_DATABASES } from '@shared/defaults'
import { useAppStore } from '../stores/app'
import { errorMessage } from '../lib/errors'
import { splitSqlStatements, sqlLiteral } from '../lib/sql'
import Icon from './Icon.vue'
import SqlEditor from './SqlEditor.vue'

interface CellEditorState {
  table: DbTable | null
  column: string
  value: string
  sql: string
  hasPrimaryKey: boolean
  row: unknown[]
}

const props = defineProps<{ connectionId: string }>()
const emit = defineEmits<{ (event: 'notice', kind: 'success' | 'error', text: string): void }>()

const store = useAppStore()

const connection = computed(() =>
  store.dbConnections.find((item) => item.id === props.connectionId)
)
const dialect = computed<'mysql' | 'postgres'>(() =>
  connection.value?.kind === 'postgres' ? 'postgres' : 'mysql'
)

const version = ref('')
const database = ref('')
const metadata = ref<DbMetadata | null>(null)
const loading = ref(true)
const errorText = ref('')
const editorRef = ref<InstanceType<typeof SqlEditor> | null>(null)
const running = ref(false)

interface QueryPage {
  id: string
  title: string
  sql: string
  results: DbResultSet[]
  activeIndex: number
  message: string
  messageKind: 'info' | 'error'
  parseResult: DbParseResult | null
  lastSql: string
}

let pageSeq = 0

function createPage(title?: string, sqlText = ''): QueryPage {
  pageSeq += 1
  return {
    id: `query-${Date.now()}-${pageSeq}`,
    title: title || `查询 ${pageSeq}`,
    sql: sqlText,
    results: [],
    activeIndex: 0,
    message: '',
    messageKind: 'info',
    parseResult: null,
    lastSql: ''
  }
}

const pages = ref<QueryPage[]>([createPage('查询 1')])
const activePageId = ref(pages.value[0].id)

const activePage = computed<QueryPage>(
  () => pages.value.find((page) => page.id === activePageId.value) ?? pages.value[0]
)

/* 每个查询页各自保存 SQL / 结果 / 消息，切页不丢状态 */
const sql = computed({
  get: () => activePage.value.sql,
  set: (value: string) => {
    activePage.value.sql = value
  }
})

const results = computed({
  get: () => activePage.value.results,
  set: (value: DbResultSet[]) => {
    activePage.value.results = value
  }
})

const activeIndex = computed({
  get: () => activePage.value.activeIndex,
  set: (value: number) => {
    activePage.value.activeIndex = value
  }
})

const message = computed({
  get: () => activePage.value.message,
  set: (value: string) => {
    activePage.value.message = value
  }
})

const messageKind = computed({
  get: () => activePage.value.messageKind,
  set: (value: 'info' | 'error') => {
    activePage.value.messageKind = value
  }
})

const parseResult = computed({
  get: () => activePage.value.parseResult,
  set: (value: DbParseResult | null) => {
    activePage.value.parseResult = value
  }
})
const expandedSchemas = ref<Set<string>>(new Set())
const expandedTables = ref<Set<string>>(new Set())
const expandedGroups = ref<Set<string>>(new Set())
const menu = ref<{
  x: number
  y: number
  kind: 'table' | 'column' | 'schema'
  table?: DbTable
  column?: DbColumn
  schema?: string
} | null>(null)
const prompt = ref<{
  title: string
  label: string
  value: string
  onConfirm: (value: string) => void
} | null>(null)
const promptValue = ref('')
const inTransaction = ref(false)
const databases = ref<string[]>([])
const cellEditor = ref<CellEditorState | null>(null)

const editorPane = ref<HTMLDivElement | null>(null)
const rightPane = ref<HTMLDivElement | null>(null)
const editorHeight = ref(300)
let dragging = false

const schemaForCompletion = computed(() => {
  const namespace: Record<string, Record<string, string[]>> = {}
  for (const table of metadata.value?.tables ?? []) {
    const group = table.schema || 'default'
    namespace[group] ??= {}
    namespace[group][table.name] = table.columns.map((column) => column.name)
  }
  return namespace
})

const groupedTables = computed(() => {
  const groups = new Map<string, DbTable[]>()
  for (const table of metadata.value?.tables ?? []) {
    const key = table.schema || 'default'
    const list = groups.get(key) ?? []
    list.push(table)
    groups.set(key, list)
  }
  return [...groups.entries()].map(([schema, tables]) => ({ schema, tables }))
})

const activeResult = computed(() => results.value[activeIndex.value] ?? null)

/** 未指定当前库、或存在多个库/schema 时必须带前缀，否则同名表无法区分 */
const multiSchema = computed(() => groupedTables.value.length > 1)

const needsSchemaPrefix = computed(
  () => metadata.value?.groupLabel === 'schema' || !database.value || multiSchema.value
)

function tableRef(table: DbTable): string {
  return needsSchemaPrefix.value && table.schema ? `${table.schema}.${table.name}` : table.name
}

function defaultSql(): string {
  const first =
    metadata.value?.tables.find((table) => table.type === 'table') ?? metadata.value?.tables[0]
  if (!first) return '-- 输入 SQL，Ctrl+Enter 执行\n'
  return `SELECT *\nFROM ${tableRef(first)}\nLIMIT 100;\n`
}

async function connect(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const info = await window.api.db.connect(props.connectionId)
    version.value = info.serverVersion
    database.value = info.database
    metadata.value = info.metadata
    inTransaction.value = info.inTransaction
    syncExpandedSchemas()
    if (!sql.value.trim()) sql.value = defaultSql()
    void loadDatabases()
  } catch (error) {
    errorText.value = errorMessage(error)
  } finally {
    loading.value = false
  }
}

/** 业务库默认展开，系统库保持折叠 */
function syncExpandedSchemas(): void {
  const business = groupedTables.value
    .map((group) => group.schema)
    .filter((schema) => !SYSTEM_DATABASES.includes(schema))
  expandedSchemas.value = new Set(business)
}

function isSystemSchema(schema: string): boolean {
  return SYSTEM_DATABASES.includes(schema)
}

async function refreshMetadata(): Promise<void> {
  try {
    metadata.value = await window.api.db.metadata(props.connectionId)
    syncExpandedSchemas()
    emit('notice', 'success', '元数据已刷新')
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

function toggleSchema(schema: string): void {
  const next = new Set(expandedSchemas.value)
  if (next.has(schema)) next.delete(schema)
  else next.add(schema)
  expandedSchemas.value = next
}

function tableKey(table: DbTable): string {
  return `${table.schema}.${table.name}`
}

function isTableExpanded(table: DbTable): boolean {
  return expandedTables.value.has(tableKey(table))
}

function toggleTable(table: DbTable): void {
  const key = tableKey(table)
  const next = new Set(expandedTables.value)
  if (next.has(key)) next.delete(key)
  else {
    next.add(key)
    // 首次展开时默认把「列」打开，符合 DataGrip 的直觉
    const groups = new Set(expandedGroups.value)
    groups.add(`${key}:columns`)
    expandedGroups.value = groups
  }
  expandedTables.value = next
}

function isGroupOpen(table: DbTable, group: 'columns' | 'keys' | 'indexes'): boolean {
  return expandedGroups.value.has(`${tableKey(table)}:${group}`)
}

function toggleGroup(table: DbTable, group: 'columns' | 'keys' | 'indexes'): void {
  const key = `${tableKey(table)}:${group}`
  const next = new Set(expandedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedGroups.value = next
}

function primaryKeyColumns(table: DbTable): string[] {
  return table.columns.filter((column) => column.primaryKey).map((column) => column.name)
}

function keyCount(table: DbTable): number {
  return primaryKeyColumns(table).length + table.foreignKeys.length
}

function quoteIdent(name: string): string {
  return dialect.value === 'mysql' ? `\`${name}\`` : `"${name}"`
}

function menuPosition(event: MouseEvent): { x: number; y: number } {
  return {
    x: Math.min(event.clientX, window.innerWidth - 230),
    y: Math.min(event.clientY, window.innerHeight - 330)
  }
}

function openTableMenu(event: MouseEvent, table: DbTable): void {
  menu.value = { ...menuPosition(event), kind: 'table', table }
}

function openColumnMenu(event: MouseEvent, column: DbColumn): void {
  menu.value = { ...menuPosition(event), kind: 'column', column }
}

function openSchemaMenu(event: MouseEvent, schema: string): void {
  menu.value = { ...menuPosition(event), kind: 'schema', schema }
}

function closeMenu(): void {
  menu.value = null
}

async function copyText(text: string, notice: string): Promise<void> {
  await window.api.clipboard.write(text)
  emit('notice', 'success', notice)
}

function createQuery(table: DbTable): void {
  closeMenu()
  generateSelect(table)
}

function createTableTemplate(table: DbTable): void {
  closeMenu()
  const lines = table.columns.map((column) => {
    const parts = [`  ${quoteIdent(column.name)}`, column.type]
    if (!column.nullable) parts.push('NOT NULL')
    if (column.defaultValue) parts.push(`DEFAULT ${column.defaultValue}`)
    return parts.join(' ')
  })
  const primaryKeys = primaryKeyColumns(table)
  if (primaryKeys.length > 0) {
    lines.push(`  PRIMARY KEY (${primaryKeys.map(quoteIdent).join(', ')})`)
  }
  addPage(`CREATE TABLE ${tableRef(table)} (\n${lines.join(',\n')}\n);\n`, `CREATE ${table.name}`)
}

function askRename(table: DbTable): void {
  closeMenu()
  promptValue.value = table.name
  prompt.value = {
    title: `重命名 ${table.type === 'view' ? '视图' : '表'} ${table.name}`,
    label: '新名称',
    value: table.name,
    onConfirm: (value) => {
      void renameTable(table, value)
    }
  }
}

async function renameTable(table: DbTable, nextName: string): Promise<void> {
  const name = nextName.trim()
  if (!name || name === table.name) return
  const target = tableRef(table)
  const statement =
    dialect.value === 'mysql'
      ? `RENAME TABLE ${target} TO ${quoteIdent(name)};`
      : `ALTER TABLE ${target} RENAME TO ${quoteIdent(name)};`
  await executeDdl(statement)
}

async function truncateTable(table: DbTable): Promise<void> {
  closeMenu()
  if (!window.confirm(`清空 ${tableRef(table)} 中的所有数据？此操作不可撤销。`)) return
  await executeDdl(`TRUNCATE TABLE ${tableRef(table)};`)
}

async function dropTable(table: DbTable): Promise<void> {
  closeMenu()
  const kind = table.type === 'view' ? '视图' : '表'
  if (!window.confirm(`确定删除${kind} ${tableRef(table)}？此操作不可撤销。`)) return
  await executeDdl(`DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} ${tableRef(table)};`)
}

async function executeDdl(statement: string): Promise<void> {
  await runSql(statement)
  if (messageKind.value === 'error') {
    emit('notice', 'error', message.value)
    return
  }
  await refreshMetadata()
  emit('notice', 'success', '已执行')
}

function setCurrentSchema(schema: string): void {
  closeMenu()
  if (dialect.value !== 'mysql') {
    emit('notice', 'error', 'PostgreSQL 需要切换数据库连接，不能直接切 schema')
    return
  }
  void window.api.db
    .switchDatabase(props.connectionId, schema)
    .then((next) => {
      metadata.value = next
      database.value = next.database
      syncExpandedSchemas()
      emit('notice', 'success', `已切换到 ${schema}`)
    })
    .catch((error: unknown) => emit('notice', 'error', errorMessage(error)))
}

function confirmPrompt(): void {
  const current = prompt.value
  if (!current) return
  const value = promptValue.value
  prompt.value = null
  current.onConfirm(value)
}

/* 菜单动作：从 menu 状态里取上下文，避免在模板里做类型收窄 */
function menuCreateQuery(): void {
  const table = menu.value?.table
  if (table) createQuery(table)
}

function menuCopyName(): void {
  const table = menu.value?.table
  if (table) void copyText(tableRef(table), '已复制名称')
}

function menuCreateTemplate(): void {
  const table = menu.value?.table
  if (table) createTableTemplate(table)
}

function menuRename(): void {
  const table = menu.value?.table
  if (table) askRename(table)
}

function menuTruncate(): void {
  const table = menu.value?.table
  if (table) void truncateTable(table)
}

function menuDrop(): void {
  const table = menu.value?.table
  if (table) void dropTable(table)
}

function menuInsertColumn(): void {
  const column = menu.value?.column
  closeMenu()
  if (column) insertColumn(column.name)
}

function menuCopyColumn(): void {
  const column = menu.value?.column
  if (column) void copyText(column.name, '已复制列名')
}

function menuNewQueryInSchema(): void {
  const schema = menu.value?.schema
  closeMenu()
  if (!schema) return
  addPage(`-- ${schema}\n`, schema)
}

function menuCopySchema(): void {
  const schema = menu.value?.schema
  if (schema) void copyText(schema, '已复制库名')
}

function menuSetSchema(): void {
  const schema = menu.value?.schema
  if (schema) setCurrentSchema(schema)
}

function menuRefresh(): void {
  closeMenu()
  void refreshMetadata()
}

function insertTable(table: DbTable): void {
  editorRef.value?.insertText(tableRef(table))
}

function generateSelect(table: DbTable): void {
  addPage(`SELECT *\nFROM ${tableRef(table)}\nLIMIT 100;\n`, table.name)
}

function insertColumn(column: string): void {
  editorRef.value?.insertText(column)
}

async function runSql(text: string): Promise<void> {
  // 固定在发起查询的那个页上写结果，避免切页后写错地方
  const page = activePage.value

  if (!text.trim()) {
    page.message = '没有可执行的 SQL'
    page.messageKind = 'info'
    return
  }

  running.value = true
  page.message = ''
  page.messageKind = 'info'
  page.parseResult = null
  page.lastSql = text

  try {
    const response = await window.api.db.query({
      connectionId: props.connectionId,
      sql: text,
      maxRows: 1000
    })
    page.results = response.results
    page.activeIndex = 0

    if (response.error) {
      page.message = response.error
      page.messageKind = 'error'
      return
    }

    const summary = response.results.map((item) =>
      item.columns.length
        ? `${item.command} · ${item.rowCount} 行 · ${item.durationMs}ms${item.truncated ? ' · 已截断' : ''}`
        : `${item.command} · 影响 ${item.affectedRows} 行 · ${item.durationMs}ms`
    )
    page.message = summary.join('    |    ') || '执行完成'
  } catch (error) {
    page.message = errorMessage(error)
    page.messageKind = 'error'
  } finally {
    running.value = false
  }
}

function addPage(sqlText = '', title?: string): QueryPage {
  const page = createPage(title, sqlText)
  pages.value.push(page)
  activePageId.value = page.id
  void nextTick(() => editorRef.value?.focus())
  return page
}

function activatePage(id: string): void {
  if (activePageId.value === id) return
  activePageId.value = id
  void nextTick(() => editorRef.value?.focus())
}

function closePage(id: string): void {
  if (pages.value.length <= 1) {
    const page = pages.value[0]
    page.sql = ''
    page.results = []
    page.activeIndex = 0
    page.message = ''
    page.parseResult = null
    return
  }

  const index = pages.value.findIndex((page) => page.id === id)
  if (index < 0) return
  pages.value.splice(index, 1)
  if (activePageId.value === id) {
    activePageId.value = pages.value[Math.min(index, pages.value.length - 1)].id
  }
}

/** 取当前要执行的 SQL：优先选区，否则光标所在语句 */
function currentStatement(): { text: string; from: number; to: number } | null {
  const editor = editorRef.value
  if (!editor) return null

  const selection = editor.getSelection()
  if (selection) return { text: selection, from: -1, to: -1 }

  const ranges = splitSqlStatements(editor.getValue())
  if (ranges.length === 0) return null
  const cursor = editor.getCursor()
  const hit = ranges.find((range) => cursor >= range.from && cursor <= range.to)
  return hit ?? ranges[ranges.length - 1]
}

function executeCurrent(): void {
  const statement = currentStatement()
  if (!statement) {
    message.value = '当前没有可执行的语句'
    messageKind.value = 'info'
    return
  }
  if (statement.from >= 0) editorRef.value?.setSelection(statement.from, statement.to)
  void runSql(statement.text)
}

function executeAll(): void {
  void runSql(editorRef.value?.getValue() ?? '')
}

function explain(): void {
  const statement = currentStatement()
  if (!statement) return
  const stripped = statement.text.replace(/^\s*((--[^\n]*\n)|(\/\*[\s\S]*?\*\/))*/g, '').trim()
  if (!/^(select|with)\b/i.test(stripped)) {
    message.value = '只有 SELECT / WITH 语句可以查看执行计划'
    messageKind.value = 'error'
    return
  }
  void runSql(`EXPLAIN ${statement.text}`)
}

async function loadDatabases(): Promise<void> {
  try {
    databases.value = await window.api.db.listDatabases(props.connectionId)
  } catch {
    databases.value = []
  }
}

async function changeDatabase(event: Event): Promise<void> {
  const next = (event.target as HTMLSelectElement).value
  if (!next || next === database.value) return
  try {
    metadata.value = await window.api.db.switchDatabase(props.connectionId, next)
    database.value = metadata.value.database
    inTransaction.value = false
    syncExpandedSchemas()
    emit('notice', 'success', `已切换到 ${next || '全部数据库'}`)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function transaction(action: 'begin' | 'commit' | 'rollback'): Promise<void> {
  try {
    inTransaction.value = await window.api.db.transaction(props.connectionId, action)
    message.value =
      action === 'begin'
        ? '已开始事务，记得提交或回滚'
        : action === 'commit'
          ? '事务已提交'
          : '事务已回滚'
    messageKind.value = 'info'
  } catch (error) {
    message.value = errorMessage(error)
    messageKind.value = 'error'
  }
}

function inferTable(columnNames: string[]): DbTable | null {
  const tables = metadata.value?.tables ?? []
  const matches = tables.filter((table) =>
    columnNames.every((name) => table.columns.some((column) => column.name === name))
  )
  return matches.length === 1 ? matches[0] : null
}

function tableLabel(table: DbTable): string {
  return needsSchemaPrefix.value && table.schema ? `${table.schema}.${table.name}` : table.name
}

function buildUpdate(table: DbTable, column: string, newValue: string, row: unknown[]): string {
  const result = activeResult.value
  if (!result) return ''
  const names = result.columns.map((item) => item.name)
  const primaryKeys = table.columns.filter((item) => item.primaryKey)
  if (primaryKeys.length === 0) return ''

  const conditions: string[] = []
  for (const key of primaryKeys) {
    const index = names.indexOf(key.name)
    if (index < 0) return ''
    const value = row[index]
    conditions.push(value === null ? `${key.name} IS NULL` : `${key.name} = ${sqlLiteral(value)}`)
  }

  return `UPDATE ${tableLabel(table)}\nSET ${column} = ${sqlLiteral(newValue)}\nWHERE ${conditions.join(' AND ')};`
}

function openCellEditor(rowIndex: number, cellIndex: number): void {
  const result = activeResult.value
  if (!result) return
  const row = result.rows[rowIndex]
  if (!row) return

  const column = result.columns[cellIndex]?.name ?? ''
  const value = row[cellIndex]
  const table = inferTable(result.columns.map((item) => item.name))
  const hasPrimaryKey = Boolean(table?.columns.some((item) => item.primaryKey))
  const text = value === null || value === undefined ? '' : String(value)

  cellEditor.value = {
    table,
    column,
    value: text,
    sql: table && hasPrimaryKey ? buildUpdate(table, column, text, row) : '',
    hasPrimaryKey,
    row
  }
}

function regenerateCellSql(): void {
  const editor = cellEditor.value
  if (!editor?.table) return
  editor.sql = buildUpdate(editor.table, editor.column, editor.value, editor.row)
}

async function executeCellSql(): Promise<void> {
  const editor = cellEditor.value
  if (!editor?.sql.trim()) return
  if (!window.confirm(`即将执行：\n\n${editor.sql}\n\n确认执行？`)) return
  cellEditor.value = null
  await runSql(editor.sql)
}

function insertCellSql(): void {
  const editor = cellEditor.value
  if (!editor?.sql.trim()) return
  sql.value = `${sql.value.trimEnd()}\n\n${editor.sql}\n`
  cellEditor.value = null
  editorRef.value?.focus()
}

async function copyCellValue(): Promise<void> {
  const editor = cellEditor.value
  if (!editor) return
  await window.api.clipboard.write(editor.value)
  emit('notice', 'success', '已复制')
}

function formatSql(): void {
  const editor = editorRef.value
  if (!editor) return
  const selection = editor.getSelection()
  const source = selection || editor.getValue()
  if (!source.trim()) return

  try {
    const formatted = format(source, {
      language: dialect.value === 'mysql' ? 'mysql' : 'postgresql',
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1
    })
    if (selection) editor.replaceSelection(formatted)
    else sql.value = formatted
  } catch (error) {
    emit('notice', 'error', `格式化失败：${errorMessage(error)}`)
  }
}

async function parseSql(): Promise<void> {
  const text = editorRef.value?.getSelection() || editorRef.value?.getValue() || ''
  if (!text.trim()) return
  try {
    parseResult.value = await window.api.db.parse(dialect.value, text)
  } catch (error) {
    emit('notice', 'error', errorMessage(error))
  }
}

async function stop(): Promise<void> {
  await window.api.db.cancel(props.connectionId)
  running.value = false
  message.value = '已终止当前连接，下次执行会重新建立连接'
  messageKind.value = 'info'
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function startDrag(event: MouseEvent): void {
  dragging = true
  event.preventDefault()
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', stopDrag)
}

function onDrag(event: MouseEvent): void {
  if (!dragging) return
  const pane = rightPane.value
  if (!pane) return
  const top = pane.getBoundingClientRect().top
  const next = event.clientY - top - 34
  editorHeight.value = Math.max(120, Math.min(pane.clientHeight - 160, next))
}

function stopDrag(): void {
  dragging = false
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', stopDrag)
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
  void connect()
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  stopDrag()
  void window.api.db.disconnect(props.connectionId).catch(() => undefined)
})
</script>

<template>
  <div class="db-view">
    <div class="toolbar">
      <span class="badge" :class="errorText ? 'err' : version ? 'ok' : 'warn'">
        {{ errorText ? '连接失败' : version || '连接中' }}
      </span>
      <Icon name="database" :size="14" />
      <span class="conn-name">{{ connection?.name ?? '数据库' }}</span>
      <select
        v-if="databases.length"
        class="field mini"
        :value="database"
        title="切换当前数据库"
        @change="changeDatabase"
      >
        <option value="">全部数据库</option>
        <option v-for="item in databases" :key="item" :value="item">{{ item }}</option>
      </select>
      <button class="icon-btn" title="刷新元数据" @click="refreshMetadata">
        <Icon name="refresh" :size="14" />
      </button>

      <span class="spacer" />
      <span v-if="inTransaction" class="badge warn">事务中</span>
      <button class="icon-btn" :disabled="loading" title="开始事务" @click="transaction('begin')">
        事务
      </button>
      <button
        class="icon-btn"
        :disabled="!inTransaction"
        title="提交事务"
        @click="transaction('commit')"
      >
        提交
      </button>
      <button
        class="icon-btn"
        :disabled="!inTransaction"
        title="回滚事务"
        @click="transaction('rollback')"
      >
        回滚
      </button>

      <button class="icon-btn primary" :disabled="loading" @click="executeCurrent">
        <Icon name="play" :size="13" /> 执行 <span class="kbd">Ctrl+↵</span>
      </button>
      <button class="icon-btn" :disabled="loading" title="执行编辑器内全部语句" @click="executeAll">
        全部
      </button>
      <button class="icon-btn" :disabled="loading" title="EXPLAIN 当前语句" @click="explain">
        计划
      </button>
      <button class="icon-btn" :disabled="loading" @click="formatSql">
        <Icon name="edit" :size="13" /> 格式化
      </button>
      <button class="icon-btn" :disabled="loading" @click="parseSql">
        <Icon name="check" :size="13" /> 解析
      </button>
      <button class="icon-btn danger" :disabled="!running" @click="stop">
        <Icon name="stop" :size="13" /> 停止
      </button>
    </div>

    <div v-if="errorText" class="error-bar">
      {{ errorText }}
      <button class="icon-btn" @click="connect">重试</button>
    </div>

    <div class="body">
      <aside class="schema">
        <div class="schema-head">
          <span>结构</span>
          <span class="muted">{{ metadata?.tables.length ?? 0 }} 张表</span>
        </div>
        <div class="schema-list">
          <div v-for="group in groupedTables" :key="group.schema" class="schema-group">
            <button
              class="schema-title"
              @click="toggleSchema(group.schema)"
              @contextmenu.prevent="openSchemaMenu($event, group.schema)"
            >
              <Icon
                :name="expandedSchemas.has(group.schema) ? 'chevronDown' : 'chevronRight'"
                :size="11"
              />
              <span class="schema-name" :class="{ system: isSystemSchema(group.schema) }">
                {{ group.schema }}
              </span>
              <span class="muted">{{ group.tables.length }}</span>
            </button>

            <template v-if="expandedSchemas.has(group.schema)">
              <template v-for="table in group.tables" :key="`${table.schema}.${table.name}`">
                <button
                  class="table-row"
                  :title="`${tableRef(table)}（双击生成 SELECT，右键更多操作）`"
                  @click="insertTable(table)"
                  @dblclick="generateSelect(table)"
                  @contextmenu.prevent="openTableMenu($event, table)"
                >
                  <Icon :name="table.type === 'view' ? 'globe' : 'database'" :size="11" />
                  <span class="table-name">{{ table.name }}</span>
                  <span
                    class="column-toggle"
                    title="展开表信息"
                    @click.stop="toggleTable(table)"
                    @dblclick.stop
                  >
                    <Icon
                      :name="isTableExpanded(table) ? 'chevronDown' : 'chevronRight'"
                      :size="10"
                    />
                  </span>
                </button>

                <template v-if="isTableExpanded(table)">
                  <button class="group-row" @click.stop="toggleGroup(table, 'columns')">
                    <Icon :name="isGroupOpen(table, 'columns') ? 'chevronDown' : 'chevronRight'" :size="10" />
                    <span class="group-label">列</span>
                    <span class="muted">{{ table.columns.length }}</span>
                  </button>
                  <template v-if="isGroupOpen(table, 'columns')">
                    <button
                      v-for="column in table.columns"
                      :key="column.name"
                      class="column-row"
                      :title="`${column.type}${column.nullable ? '' : ' NOT NULL'}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ''}`"
                      @click="insertColumn(column.name)"
                      @contextmenu.prevent="openColumnMenu($event, column)"
                    >
                      <span class="column-name" :class="{ pk: column.primaryKey }">
                        <span v-if="column.primaryKey" class="pk-dot">●</span>{{ column.name }}
                      </span>
                      <span class="column-type">{{ column.type }}</span>
                    </button>
                  </template>

                  <button class="group-row" @click.stop="toggleGroup(table, 'keys')">
                    <Icon :name="isGroupOpen(table, 'keys') ? 'chevronDown' : 'chevronRight'" :size="10" />
                    <span class="group-label">键</span>
                    <span class="muted">{{ keyCount(table) }}</span>
                  </button>
                  <template v-if="isGroupOpen(table, 'keys')">
                    <div v-if="keyCount(table) === 0" class="column-row muted">无</div>
                    <div
                      v-for="column in primaryKeyColumns(table)"
                      :key="`pk-${column}`"
                      class="key-row"
                    >
                      <span class="key-tag">PK</span>
                      <span class="key-text">{{ column }}</span>
                    </div>
                    <div v-for="fk in table.foreignKeys" :key="fk.name" class="key-row" :title="fk.name">
                      <span class="key-tag fk">FK</span>
                      <span class="key-text">
                        {{ fk.columns.join(', ') }} → {{ fk.refTable }}({{ fk.refColumns.join(', ') }})
                      </span>
                    </div>
                  </template>

                  <button class="group-row" @click.stop="toggleGroup(table, 'indexes')">
                    <Icon :name="isGroupOpen(table, 'indexes') ? 'chevronDown' : 'chevronRight'" :size="10" />
                    <span class="group-label">索引</span>
                    <span class="muted">{{ table.indexes.length }}</span>
                  </button>
                  <template v-if="isGroupOpen(table, 'indexes')">
                    <div v-if="table.indexes.length === 0" class="column-row muted">无</div>
                    <div v-for="index in table.indexes" :key="index.name" class="index-row">
                      <span class="index-name">
                        <span v-if="index.primary" class="key-tag">PK</span>
                        <span v-else-if="index.unique" class="key-tag uniq">UQ</span>
                        {{ index.name }}
                      </span>
                      <span class="column-type">{{ index.columns.join(', ') }}</span>
                    </div>
                  </template>
                </template>
              </template>
            </template>
          </div>
          <div v-if="!loading && groupedTables.length === 0" class="empty-hint">
            没有可显示的表
          </div>
        </div>
      </aside>

      <div ref="rightPane" class="right">
        <div class="console-tabs">
          <button
            v-for="page in pages"
            :key="page.id"
            class="console-tab"
            :class="{ active: page.id === activePageId }"
            :title="page.title"
            @click="activatePage(page.id)"
          >
            <span class="console-title">{{ page.title }}</span>
            <span class="console-close" title="关闭" @click.stop="closePage(page.id)">×</span>
          </button>
          <button class="console-add" title="新建查询页" @click="addPage()">＋</button>
        </div>

        <div ref="editorPane" class="editor-pane" :style="{ height: `${editorHeight}px` }">
          <SqlEditor
            ref="editorRef"
            v-model="sql"
            :dialect="dialect"
            :schema="schemaForCompletion"
            @execute="executeCurrent"
            @format="formatSql"
          />
        </div>

        <div class="splitter" @mousedown="startDrag" />

        <div class="result-pane">
          <div v-if="message" class="message" :class="messageKind">{{ message }}</div>

          <div v-if="parseResult" class="parse-panel">
            <div class="parse-head">
              <span>解析结果</span>
              <button class="icon-btn tiny" @click="parseResult = null">
                <Icon name="close" :size="11" />
              </button>
            </div>
            <div v-if="parseResult.error" class="parse-error">{{ parseResult.error }}</div>
            <div v-else class="parse-body">
              <div v-for="(statement, index) in parseResult.statements" :key="index" class="parse-item">
                <span class="badge">{{ statement.type }}</span>
                <span class="muted">{{ statement.tables.join(', ') || '无表引用' }}</span>
              </div>
              <div v-if="parseResult.tables.length" class="hint-text" style="margin-top: 6px">
                共涉及 {{ parseResult.tables.length }} 张表：{{ parseResult.tables.join('、') }}
              </div>
            </div>
          </div>

          <div v-if="results.length > 1" class="result-tabs">
            <button
              v-for="(item, index) in results"
              :key="index"
              class="result-tab"
              :class="{ active: index === activeIndex }"
              @click="activeIndex = index"
            >
              结果 {{ index + 1 }} · {{ item.command }}
            </button>
          </div>

          <div class="grid-wrap">
            <table v-if="activeResult && activeResult.columns.length" class="grid">
              <thead>
                <tr>
                  <th class="row-no">#</th>
                  <th v-for="column in activeResult.columns" :key="column.name">
                    <div class="col-name">{{ column.name }}</div>
                    <div class="col-type">{{ column.type }}</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in activeResult.rows" :key="rowIndex">
                  <td class="row-no">{{ rowIndex + 1 }}</td>
                  <td
                    v-for="(cell, cellIndex) in row"
                    :key="cellIndex"
                    :class="{ null: cell === null }"
                    :title="`${formatCell(cell)}（双击编辑）`"
                    @dblclick="openCellEditor(rowIndex, cellIndex)"
                  >
                    {{ formatCell(cell) }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else-if="!loading" class="empty-hint">
              {{ running ? '执行中…' : '执行 SQL 后在这里查看结果（双击单元格可编辑）' }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      @click.stop
    >
      <template v-if="menu.kind === 'table'">
        <button @click="menuCreateQuery">新建查询（SELECT）</button>
        <button @click="menuCreateTemplate">生成 CREATE 模板</button>
        <div class="ctx-sep" />
        <button @click="menuCopyName">复制限定名</button>
        <div class="ctx-sep" />
        <button @click="menuRename">重命名…</button>
        <button @click="menuTruncate">清空表…</button>
        <button class="danger" @click="menuDrop">
          {{ menu.table?.type === 'view' ? '删除视图…' : '删除表…' }}
        </button>
        <div class="ctx-sep" />
        <button @click="menuRefresh">刷新</button>
      </template>

      <template v-else-if="menu.kind === 'column'">
        <button @click="menuInsertColumn">插入列名</button>
        <button @click="menuCopyColumn">复制列名</button>
      </template>

      <template v-else>
        <button @click="menuNewQueryInSchema">新建查询</button>
        <button @click="menuCopySchema">复制库名</button>
        <button v-if="dialect === 'mysql'" @click="menuSetSchema">设为当前数据库</button>
        <div class="ctx-sep" />
        <button @click="menuRefresh">刷新</button>
      </template>
    </div>

    <div v-if="prompt" class="modal-mask" @mousedown.self="prompt = null">
      <div class="modal-card" style="width: 420px">
        <div class="modal-head">
          <span>{{ prompt.title }}</span>
          <button class="icon-btn" @click="prompt = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="dialog-form">
            <div class="dialog-row">
              <label>{{ prompt.label }}</label>
              <input
                v-model="promptValue"
                class="field mono"
                @keyup.enter="confirmPrompt"
              />
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="icon-btn" @click="prompt = null">取消</button>
          <button class="icon-btn primary" @click="confirmPrompt">确定</button>
        </div>
      </div>
    </div>

    <div v-if="cellEditor" class="modal-mask" @mousedown.self="cellEditor = null">
      <div class="modal-card" style="width: 580px">
        <div class="modal-head">
          <span>编辑单元格 · {{ cellEditor.column }}</span>
          <button class="icon-btn" @click="cellEditor = null"><Icon name="close" :size="14" /></button>
        </div>
        <div class="modal-body">
          <div class="dialog-form">
            <div class="dialog-row">
              <label>新值</label>
              <input
                v-model="cellEditor.value"
                class="field mono"
                placeholder="留空表示 NULL / 空字符串"
                @keyup.enter="regenerateCellSql"
              />
            </div>

            <div class="hint-text">
              <template v-if="cellEditor.table">
                目标表：{{ tableLabel(cellEditor.table) }}
                <template v-if="!cellEditor.hasPrimaryKey">
                  （该表没有主键，无法生成安全的 UPDATE）
                </template>
                <template v-else>（按主键生成 UPDATE）</template>
              </template>
              <template v-else>无法从结果推断唯一目标表，只能复制原值</template>
            </div>

            <textarea
              v-if="cellEditor.table && cellEditor.hasPrimaryKey"
              v-model="cellEditor.sql"
              class="field code"
              spellcheck="false"
            />
            <div class="btn-row" v-if="cellEditor.table && cellEditor.hasPrimaryKey">
              <button class="icon-btn" @click="regenerateCellSql">按新值重新生成</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="icon-btn" @click="copyCellValue">复制原值</button>
          <span style="flex: 1" />
          <button class="icon-btn" @click="cellEditor = null">取消</button>
          <button
            class="icon-btn"
            :disabled="!cellEditor.sql.trim()"
            @click="insertCellSql"
          >
            插入编辑器
          </button>
          <button
            class="icon-btn primary"
            :disabled="!cellEditor.sql.trim()"
            @click="executeCellSql"
          >
            执行
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-view {
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

.kbd {
  font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0 3px;
}

.field.mini {
  width: auto;
  min-width: 120px;
  max-width: 190px;
  height: 26px;
}

.code {
  height: 110px;
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
}

.btn-row {
  display: flex;
  gap: 8px;
  padding-left: 106px;
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger);
  font-size: 12px;
  border-bottom: 1px solid rgba(239, 68, 68, 0.25);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.schema {
  width: 218px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
  min-height: 0;
}

.schema-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border-soft);
}

.schema-list {
  flex: 1;
  overflow: auto;
  padding: 4px 6px 10px;
}

.schema-title {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 10.5px;
  cursor: pointer;
  text-align: left;
}

.schema-title:hover {
  color: var(--text);
}

.schema-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schema-name.system {
  color: var(--muted);
  opacity: 0.75;
}

.table-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 24px;
  padding: 0 6px 0 14px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.table-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.table-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-toggle {
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  padding: 0;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  height: 22px;
  padding: 0 6px 0 24px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}

.group-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.group-label {
  flex: 1;
}

.key-row,
.index-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 6px 0 42px;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
}

.index-name {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.key-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.key-tag {
  font-size: 9px;
  line-height: 13px;
  padding: 0 3px;
  border-radius: 3px;
  border: 1px solid var(--warning);
  color: var(--warning);
  flex-shrink: 0;
}

.key-tag.fk {
  border-color: var(--accent);
  color: var(--accent);
}

.key-tag.uniq {
  border-color: var(--success);
  color: var(--success);
}

.pk-dot {
  color: var(--warning);
  font-size: 8px;
  margin-right: 3px;
}

.column-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 22px;
  padding: 0 6px 0 42px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}

.column-row:hover {
  background: var(--panel-2);
  color: var(--text);
}

.column-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-name.pk {
  color: var(--warning);
}

.column-type {
  font-size: 9.5px;
  color: var(--muted);
  flex-shrink: 0;
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.console-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  overflow-x: auto;
  flex-shrink: 0;
}

.console-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}

.console-tab:hover {
  background: var(--panel-2);
  color: var(--text);
}

.console-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.console-title {
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.console-close {
  font-size: 13px;
  line-height: 1;
  opacity: 0.6;
}

.console-close:hover {
  opacity: 1;
  color: var(--danger);
}

.console-add {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}

.console-add:hover {
  background: var(--panel-2);
  color: var(--text);
}

.editor-pane {
  display: flex;
  flex-direction: column;
  min-height: 120px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.splitter {
  height: 5px;
  cursor: row-resize;
  background: var(--border-soft);
  flex-shrink: 0;
}

.splitter:hover {
  background: var(--accent-soft);
}

.result-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.message {
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
}

.message.error {
  color: var(--danger);
  background: rgba(239, 68, 68, 0.1);
}

.parse-panel {
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
  padding: 8px 10px;
  max-height: 160px;
  overflow: auto;
}

.parse-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text);
  margin-bottom: 6px;
}

.parse-error {
  font-size: 11.5px;
  color: var(--danger);
}

.parse-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.parse-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.result-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
  overflow-x: auto;
}

.result-tab {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}

.result-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.grid-wrap {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.grid {
  border-collapse: collapse;
  font-size: 11.5px;
  width: max-content;
  min-width: 100%;
}

.grid th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 5px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border-soft);
  font-weight: 500;
  white-space: nowrap;
}

.col-name {
  color: var(--text);
  font-size: 11.5px;
}

.col-type {
  color: var(--muted);
  font-size: 9.5px;
  font-weight: 400;
}

.grid td {
  padding: 3px 10px;
  border-bottom: 1px solid var(--border-soft);
  border-right: 1px solid var(--border-soft);
  color: var(--text-dim);
  white-space: nowrap;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: 'JetBrains Mono', Consolas, monospace;
}

.grid td.null {
  color: var(--muted);
  font-style: italic;
}

.row-no {
  color: var(--muted);
  text-align: right;
  background: var(--panel);
  font-size: 10.5px;
}

.icon-btn.tiny {
  height: 20px;
  min-width: 20px;
  padding: 0 3px;
}

.ctx-menu {
  position: fixed;
  z-index: 900;
  min-width: 176px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.ctx-menu button {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ctx-menu button:hover {
  background: var(--accent-soft);
  color: var(--text);
}

.ctx-menu button.danger {
  color: var(--danger);
}

.ctx-menu button.danger:hover {
  background: rgba(239, 68, 68, 0.15);
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-soft);
}
</style>
