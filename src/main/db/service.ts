import mysql from 'mysql2/promise'
import { Client as PgClient } from 'pg'
import { Parser } from 'node-sql-parser'
import type {
  DbColumn,
  DbConnectResult,
  DbConnection,
  DbForeignKey,
  DbIndex,
  DbKind,
  DbMetadata,
  DbParseResult,
  DbQueryRequest,
  DbQueryResponse,
  DbResultSet,
  DbStatementInfo,
  DbTable
} from '../../shared/types'
import { SYSTEM_DATABASES } from '../../shared/defaults'
import { credentialRef, type CredentialStore } from '../store/credential-store'
import type { ConfigStore } from '../store/config-store'
import type { LocalTunnel, TunnelService } from '../ssh/tunnel'

const DEFAULT_MAX_ROWS = 1000
const QUERY_TIMEOUT_MS = 120_000

interface QueryOutcome {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  affectedRows: number
  command: string
  truncated: boolean
}

interface Session {
  readonly kind: DbKind
  query(sql: string, maxRows: number): Promise<QueryOutcome>
  metadata(): Promise<DbMetadata>
  databases(): Promise<string[]>
  version(): Promise<string>
  destroy(): void
}

const MYSQL_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING'
}

const PG_TYPE_NAMES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb'
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) {
    const hex = value.toString('hex')
    return value.length > 32 ? `0x${hex.slice(0, 64)}…(${value.length} bytes)` : `0x${hex}`
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

function commandOf(sql: string): string {
  const match = /^\s*([a-zA-Z]+)/.exec(sql)
  return match ? match[1].toUpperCase() : 'QUERY'
}

/** 按分号拆分语句，跳过字符串、注释与 PostgreSQL 的 $$ 块 */
export function splitStatements(sql: string): string[] {
  const result: string[] = []
  let current = ''
  let index = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  let dollarTag = ''

  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if (inLineComment) {
      current += char
      if (char === '\n') inLineComment = false
      index += 1
      continue
    }

    if (inBlockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += '/'
        index += 2
        inBlockComment = false
        continue
      }
      index += 1
      continue
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag
        index += dollarTag.length
        dollarTag = ''
        continue
      }
      current += char
      index += 1
      continue
    }

    if (inSingle) {
      current += char
      if (char === '\\' && next !== undefined) {
        current += next
        index += 2
        continue
      }
      if (char === "'" && next === "'") {
        current += "'"
        index += 2
        continue
      }
      if (char === "'") inSingle = false
      index += 1
      continue
    }

    if (inDouble) {
      current += char
      if (char === '"' && next === '"') {
        current += '"'
        index += 2
        continue
      }
      if (char === '"') inDouble = false
      index += 1
      continue
    }

    if (inBacktick) {
      current += char
      if (char === '`' && next === '`') {
        current += '`'
        index += 2
        continue
      }
      if (char === '`') inBacktick = false
      index += 1
      continue
    }

    if (char === '-' && next === '-') {
      inLineComment = true
      current += '--'
      index += 2
      continue
    }

    if (char === '#') {
      inLineComment = true
      current += char
      index += 1
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      current += '/*'
      index += 2
      continue
    }

    if (char === "'") {
      inSingle = true
      current += char
      index += 1
      continue
    }

    if (char === '"') {
      inDouble = true
      current += char
      index += 1
      continue
    }

    if (char === '`') {
      inBacktick = true
      current += char
      index += 1
      continue
    }

    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))
      if (match) {
        dollarTag = match[0]
        current += dollarTag
        index += dollarTag.length
        continue
      }
    }

    if (char === ';') {
      const trimmed = current.trim()
      if (trimmed) result.push(trimmed)
      current = ''
      index += 1
      continue
    }

    current += char
    index += 1
  }

  const tail = current.trim()
  if (tail) result.push(tail)
  return result
}

class MySqlSession implements Session {
  readonly kind: DbKind = 'mysql'

  constructor(
    private readonly connection: mysql.Connection,
    private readonly database: string
  ) {}

  async query(sql: string, maxRows: number): Promise<QueryOutcome> {
    const [rows, fields] = await this.connection.query({
      sql,
      rowsAsArray: true,
      timeout: QUERY_TIMEOUT_MS
    })

    if (Array.isArray(rows)) {
      const list = rows as unknown as unknown[][]
      const columns = (fields ?? []).map((field) => ({
        name: field.name,
        type: field.type === undefined ? '' : (MYSQL_TYPE_NAMES[field.type] ?? String(field.type))
      }))
      return {
        columns,
        rows: list.slice(0, maxRows).map((row) => row.map(normalizeCell)),
        affectedRows: 0,
        command: commandOf(sql),
        truncated: list.length > maxRows
      }
    }

    const header = rows as unknown as { affectedRows?: number; info?: string }
    return {
      columns: [],
      rows: [],
      affectedRows: header.affectedRows ?? 0,
      command: commandOf(sql),
      truncated: false
    }
  }

  async metadata(): Promise<DbMetadata> {
    // 未指定库时列出全部库（业务库在前、系统库在后），否则会出现「0 张表」
    const scoped = Boolean(this.database)

    const tableSql = scoped
      ? `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`
      : `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, TABLE_TYPE AS tableType
         FROM information_schema.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME`

    const columnSql = scoped
      ? `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey,
                COLUMN_DEFAULT AS columnDefault
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`
      : `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_KEY AS columnKey,
                COLUMN_DEFAULT AS columnDefault
         FROM information_schema.COLUMNS
         ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`

    const indexSql = scoped
      ? `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
                NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
      : `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, INDEX_NAME AS indexName,
                NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName
         FROM information_schema.STATISTICS
         ORDER BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`

    const foreignKeySql = scoped
      ? `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
                COLUMN_NAME AS columnName, REFERENCED_TABLE_SCHEMA AS refSchema,
                REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`
      : `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, CONSTRAINT_NAME AS constraintName,
                COLUMN_NAME AS columnName, REFERENCED_TABLE_SCHEMA AS refSchema,
                REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY TABLE_SCHEMA, TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`

    const params = scoped ? [this.database] : []
    const [tableRows] = await this.connection.query(tableSql, params)
    const [columnRows] = await this.connection.query(columnSql, params)
    const [indexRows] = await this.connection.query(indexSql, params)
    const [foreignKeyRows] = await this.connection.query(foreignKeySql, params)

    const tables = [...(tableRows as unknown as Record<string, unknown>[])].sort((left, right) => {
      const a = String(left.schemaName ?? '')
      const b = String(right.schemaName ?? '')
      const systemA = SYSTEM_DATABASES.includes(a) ? 1 : 0
      const systemB = SYSTEM_DATABASES.includes(b) ? 1 : 0
      if (systemA !== systemB) return systemA - systemB
      return a.localeCompare(b) || String(left.tableName ?? '').localeCompare(String(right.tableName ?? ''))
    })

    return buildMetadata(
      this.database,
      'database',
      tables,
      columnRows as unknown as Record<string, unknown>[],
      indexRows as unknown as Record<string, unknown>[],
      foreignKeyRows as unknown as Record<string, unknown>[]
    )
  }

  async databases(): Promise<string[]> {
    // SHOW DATABASES 默认返回对象数组（{ Database: 'xxl_job' }），必须按列名取
    const [rows] = await this.connection.query({ sql: 'SHOW DATABASES', rowsAsArray: true })
    return (rows as unknown as unknown[][])
      .map((row) => String(row[0] ?? ''))
      .filter((name) => name && name !== 'undefined')
  }

  async version(): Promise<string> {
    const [rows] = await this.connection.query('SELECT VERSION() AS version')
    const list = rows as unknown as { version?: string }[]
    return list[0]?.version ? `MySQL ${list[0].version}` : 'MySQL'
  }

  destroy(): void {
    try {
      this.connection.destroy()
    } catch {
      /* ignore */
    }
  }
}

class PgSession implements Session {
  readonly kind: DbKind = 'postgres'

  constructor(
    private readonly client: PgClient,
    private readonly database: string
  ) {}

  async query(sql: string, maxRows: number): Promise<QueryOutcome> {
    const result = await this.client.query({ text: sql, rowMode: 'array' })
    const fields = result.fields ?? []
    if (fields.length > 0) {
      const rows = (result.rows ?? []) as unknown[][]
      return {
        columns: fields.map((field) => ({
          name: field.name,
          type: PG_TYPE_NAMES[field.dataTypeID] ?? String(field.dataTypeID)
        })),
        rows: rows.slice(0, maxRows).map((row) => row.map(normalizeCell)),
        affectedRows: 0,
        command: result.command ?? commandOf(sql),
        truncated: rows.length > maxRows
      }
    }
    return {
      columns: [],
      rows: [],
      affectedRows: result.rowCount ?? 0,
      command: result.command ?? commandOf(sql),
      truncated: false
    }
  }

  async metadata(): Promise<DbMetadata> {
    const tables = await this.client.query<Record<string, unknown>>(
      `SELECT table_schema AS "schemaName", table_name AS "tableName", table_type AS "tableType"
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name`
    )
    const columns = await this.client.query<Record<string, unknown>>(
      `SELECT table_schema AS "schemaName", table_name AS "tableName", column_name AS "columnName",
              data_type AS "columnType", is_nullable AS "nullable", column_default AS "columnDefault"
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`
    )
    const primaryKeys = await this.client.query<Record<string, unknown>>(
      `SELECT tc.table_schema AS "schemaName", tc.table_name AS "tableName", kcu.column_name AS "columnName"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'`
    )

    const indexes = await this.client.query<Record<string, unknown>>(
      `SELECT schemaname AS "schemaName", tablename AS "tableName", indexname AS "indexName",
              indexdef AS "definition"
       FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`
    )
    const foreignKeys = await this.client.query<Record<string, unknown>>(
      `SELECT tc.table_schema AS "schemaName", tc.table_name AS "tableName",
              tc.constraint_name AS "constraintName", kcu.column_name AS "columnName",
              ccu.table_schema AS "refSchema", ccu.table_name AS "refTable", ccu.column_name AS "refColumn"
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'`
    )

    const pkSet = new Set(
      primaryKeys.rows.map(
        (row) => `${String(row.schemaName)}.${String(row.tableName)}.${String(row.columnName)}`
      )
    )

    return buildMetadata(
      this.database,
      'schema',
      tables.rows,
      columns.rows.map((row) => ({
        ...row,
        columnKey: pkSet.has(
          `${String(row.schemaName)}.${String(row.tableName)}.${String(row.columnName)}`
        )
          ? 'PRI'
          : ''
      })),
      indexes.rows,
      foreignKeys.rows
    )
  }

  async databases(): Promise<string[]> {
    const result = await this.client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1'
    )
    return result.rows.map((row) => row.datname)
  }

  async version(): Promise<string> {
    const result = await this.client.query<{ version: string }>('SELECT version() AS version')
    return result.rows[0]?.version ? `PostgreSQL ${result.rows[0].version.split(' ')[0]}` : 'PostgreSQL'
  }

  destroy(): void {
    void this.client.end().catch(() => undefined)
  }
}

function buildMetadata(
  database: string,
  groupLabel: 'database' | 'schema',
  tableRows: Record<string, unknown>[],
  columnRows: Record<string, unknown>[],
  indexRows: Record<string, unknown>[] = [],
  foreignKeyRows: Record<string, unknown>[] = []
): DbMetadata {
  const map = new Map<string, DbTable>()

  for (const row of tableRows) {
    const schema = String(row.schemaName ?? '')
    const name = String(row.tableName ?? '')
    const tableType = String(row.tableType ?? '')
    const key = `${schema}.${name}`
    map.set(key, {
      schema,
      name,
      type: /VIEW/i.test(tableType) ? 'view' : 'table',
      columns: [],
      indexes: [],
      foreignKeys: []
    })
  }

  for (const row of columnRows) {
    const schema = String(row.schemaName ?? '')
    const name = String(row.tableName ?? '')
    const table = map.get(`${schema}.${name}`)
    if (!table) continue
    const column: DbColumn = {
      name: String(row.columnName ?? ''),
      type: String(row.columnType ?? ''),
      nullable: String(row.nullable ?? '').toUpperCase() !== 'NO',
      primaryKey: String(row.columnKey ?? '').toUpperCase() === 'PRI',
      defaultValue: row.columnDefault === null || row.columnDefault === undefined
        ? ''
        : String(row.columnDefault)
    }
    table.columns.push(column)
  }

  const indexMap = new Map<string, DbIndex>()
  for (const row of indexRows) {
    const schema = String(row.schemaName ?? '')
    const tableName = String(row.tableName ?? '')
    const name = String(row.indexName ?? '')
    const table = map.get(`${schema}.${tableName}`)
    if (!table || !name) continue

    const key = `${schema}.${tableName}.${name}`
    let index = indexMap.get(key)
    if (!index) {
      const definition = String(row.definition ?? '')
      const parsed = definition ? parseIndexDefinition(definition) : null
      index = {
        name,
        columns: [],
        unique: parsed ? parsed.unique : Number(row.nonUnique ?? 1) === 0,
        primary: name.toUpperCase() === 'PRIMARY',
        definition
      }
      indexMap.set(key, index)
      table.indexes.push(index)
    }

    const columnName = row.columnName ? String(row.columnName) : ''
    if (columnName) index.columns.push(columnName)
    else if (index.columns.length === 0 && index.definition) {
      const parsed = parseIndexDefinition(index.definition)
      if (parsed) index.columns = parsed.columns
    }
  }

  const foreignKeyMap = new Map<string, DbForeignKey>()
  for (const row of foreignKeyRows) {
    const schema = String(row.schemaName ?? '')
    const tableName = String(row.tableName ?? '')
    const name = String(row.constraintName ?? '')
    const table = map.get(`${schema}.${tableName}`)
    if (!table || !name) continue

    const key = `${schema}.${tableName}.${name}`
    let foreignKey = foreignKeyMap.get(key)
    if (!foreignKey) {
      foreignKey = {
        name,
        columns: [],
        refSchema: String(row.refSchema ?? ''),
        refTable: String(row.refTable ?? ''),
        refColumns: []
      }
      foreignKeyMap.set(key, foreignKey)
      table.foreignKeys.push(foreignKey)
    }

    const columnName = String(row.columnName ?? '')
    const refColumn = String(row.refColumn ?? '')
    if (columnName) foreignKey.columns.push(columnName)
    if (refColumn) foreignKey.refColumns.push(refColumn)
  }

  return {
    database,
    groupLabel,
    tables: [...map.values()],
    fetchedAt: Date.now()
  }
}

/** PostgreSQL 的 pg_indexes 只给整条 CREATE INDEX 语句，这里解析出列名与唯一性 */
function parseIndexDefinition(definition: string): { unique: boolean; columns: string[] } | null {
  const match = /CREATE\s+(UNIQUE\s+)?INDEX\s+.*?\((.+)\)\s*$/i.exec(definition)
  if (!match) return null
  const columns = match[2]
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/\s+(ASC|DESC)\b/i, '')
        .replace(/\s+NULLS\s+(FIRST|LAST)/i, '')
        .replace(/"/g, '')
    )
    .filter(Boolean)
  return { unique: Boolean(match[1]), columns }
}

export class DbService {
  private readonly sessions = new Map<string, { session: Session; tunnel?: LocalTunnel }>()
  private readonly databaseOverrides = new Map<string, string>()
  private readonly transactions = new Map<string, boolean>()
  private readonly parser = new Parser()

  constructor(
    private readonly config: ConfigStore,
    private readonly credentials: CredentialStore,
    private readonly tunnels: TunnelService
  ) {}

  listConnections(): DbConnection[] {
    return this.config.getDbConnections()
  }

  async connect(connectionId: string): Promise<DbConnectResult> {
    const session = await this.ensureSession(connectionId)
    await this.config.touchDbConnection(connectionId)
    const [version, metadata] = await Promise.all([session.version(), session.metadata()])
    return {
      serverVersion: version,
      database: metadata.database,
      metadata,
      inTransaction: this.transactions.get(connectionId) ?? false
    }
  }

  async testConnection(connection: DbConnection, password: string): Promise<DbConnectResult> {
    const session = await this.openSession(connection, password)
    try {
      const [version, metadata] = await Promise.all([session.version(), session.metadata()])
      return {
        serverVersion: version,
        database: metadata.database,
        metadata,
        inTransaction: false
      }
    } finally {
      session.destroy()
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    this.transactions.delete(connectionId)
    const entry = this.sessions.get(connectionId)
    if (!entry) return
    this.sessions.delete(connectionId)
    entry.session.destroy()
    entry.tunnel?.close()
  }

  async listDatabases(connectionId: string): Promise<string[]> {
    const session = await this.ensureSession(connectionId)
    return await session.databases()
  }

  /** 切换当前库：关闭旧连接后带新库名重连（PostgreSQL 必须重连） */
  async switchDatabase(connectionId: string, database: string): Promise<DbMetadata> {
    await this.disconnect(connectionId)
    this.databaseOverrides.set(connectionId, database)
    const session = await this.ensureSession(connectionId)
    return await session.metadata()
  }

  async transaction(connectionId: string, action: 'begin' | 'commit' | 'rollback'): Promise<boolean> {
    const session = await this.ensureSession(connectionId)
    const sql =
      action === 'begin'
        ? session.kind === 'mysql'
          ? 'START TRANSACTION'
          : 'BEGIN'
        : action === 'commit'
          ? 'COMMIT'
          : 'ROLLBACK'

    await session.query(sql, 1)
    const active = action === 'begin'
    this.transactions.set(connectionId, active)
    return active
  }

  async cancel(connectionId: string): Promise<void> {
    await this.disconnect(connectionId)
  }

  async metadata(connectionId: string): Promise<DbMetadata> {
    const session = await this.ensureSession(connectionId)
    return await session.metadata()
  }

  async query(request: DbQueryRequest): Promise<DbQueryResponse> {
    const session = await this.ensureSession(request.connectionId)
    const statements = splitStatements(request.sql)
    if (statements.length === 0) {
      return { results: [], error: '', errorStatement: -1 }
    }

    const maxRows = request.maxRows && request.maxRows > 0 ? request.maxRows : DEFAULT_MAX_ROWS
    const results: DbResultSet[] = []

    for (let index = 0; index < statements.length; index += 1) {
      const started = Date.now()
      try {
        const outcome = await session.query(statements[index], maxRows)
        results.push({
          command: outcome.command,
          columns: outcome.columns,
          rows: outcome.rows,
          rowCount: outcome.rows.length,
          affectedRows: outcome.affectedRows,
          durationMs: Date.now() - started,
          truncated: outcome.truncated,
          notice: outcome.truncated ? `结果已截断，仅显示前 ${maxRows} 行` : ''
        })
      } catch (error) {
        return {
          results,
          error: `第 ${index + 1} 条语句执行失败：${friendlyDbError(error)}`,
          errorStatement: index
        }
      }
    }

    return { results, error: '', errorStatement: -1 }
  }

  /** 纯解析：语句拆分 + 类型 + 涉及的表/字段，不连数据库 */
  parse(kind: DbKind, sql: string): DbParseResult {
    const statements = splitStatements(sql)
    const infos: DbStatementInfo[] = []
    const allTables = new Set<string>()
    const options = { database: kind === 'mysql' ? 'mysql' : 'postgresql' } as never

    for (let index = 0; index < statements.length; index += 1) {
      const text = statements[index]
      try {
        const ast = this.parser.astify(text, options) as unknown
        const node = (Array.isArray(ast) ? ast[0] : ast) as { type?: string } | undefined
        const tables = (this.parser.tableList(text, options) as string[])
          .map((entry) => entry.split('::')[2] ?? '')
          .filter(Boolean)
        const columns = (this.parser.columnList(text, options) as string[])
          .map((entry) => entry.split('::')[2] ?? '')
          .filter(Boolean)

        tables.forEach((table) => allTables.add(table))
        infos.push({
          type: (node?.type ?? 'unknown').toUpperCase(),
          text,
          tables: [...new Set(tables)],
          columns: [...new Set(columns)]
        })
      } catch (error) {
        return {
          statements: infos,
          tables: [...allTables],
          error: `第 ${index + 1} 条语句解析失败：${(error as Error).message}`
        }
      }
    }

    return { statements: infos, tables: [...allTables], error: '' }
  }

  async dispose(): Promise<void> {
    for (const connectionId of [...this.sessions.keys()]) {
      await this.disconnect(connectionId)
    }
  }

  private async ensureSession(connectionId: string): Promise<Session> {
    const existing = this.sessions.get(connectionId)
    if (existing) return existing.session

    const connection = this.config.getDbConnection(connectionId)
    if (!connection) throw new Error('数据库连接配置不存在')

    const password = (await this.credentials.get(credentialRef.dbPassword(connectionId))) ?? ''
    if (!password && connection.username) {
      throw new Error(`连接「${connection.name}」未保存密码，请编辑连接补充密码`)
    }

    const session = await this.openSession(connection, password)
    this.sessions.set(connectionId, { session })
    return session
  }

  private async openSession(connection: DbConnection, password: string): Promise<Session> {
    let host = connection.host
    let port = connection.port
    let tunnel: LocalTunnel | undefined

    if (connection.tunnelSessionId) {
      tunnel = await this.tunnels.open(connection.tunnelSessionId, connection.host, connection.port)
      host = tunnel.host
      port = tunnel.port
    }

    const database = this.databaseOverrides.get(connection.id) ?? connection.database

    try {
      if (connection.kind === 'mysql') {
        const client = await mysql.createConnection({
          host,
          port,
          user: connection.username,
          password,
          database: database || undefined,
          ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
          connectTimeout: 10_000,
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
          multipleStatements: false
        })
        return new MySqlSession(client, database)
      }

      const client = new PgClient({
        host,
        port,
        user: connection.username,
        password,
        database: database || undefined,
        ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 10_000,
        statement_timeout: QUERY_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS
      })
      await client.connect()
      return new PgSession(client, database)
    } catch (error) {
      tunnel?.close()
      throw new Error(friendlyDbError(error))
    }
  }
}

function friendlyDbError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string }).code ?? ''

  if (code === 'ECONNREFUSED') return '连接被拒绝：目标主机端口未监听'
  if (code === 'ENOTFOUND') return '无法解析主机名'
  if (code === 'ETIMEDOUT' || /timeout/i.test(raw)) return '连接超时'
  if (code === 'ER_ACCESS_DENIED_ERROR' || /password authentication failed/i.test(raw)) {
    return '认证失败：用户名或密码不正确'
  }
  if (code === 'ER_BAD_DB_ERROR' || code === '3D000') return '数据库不存在'
  if (code === '28P01') return '认证失败：用户名或密码不正确'
  if (code === '42P01') return '表不存在'
  if (code === '42601' || code === 'ER_PARSE_ERROR' || /syntax error/i.test(raw)) {
    return `SQL 语法错误：${raw}`
  }
  return raw
}
