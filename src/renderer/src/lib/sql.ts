export interface SqlStatementRange {
  text: string
  from: number
  to: number
}

/** 与主进程一致的语句拆分，但保留字符偏移，用于「执行光标所在语句」 */
export function splitSqlStatements(sql: string): SqlStatementRange[] {
  const result: SqlStatementRange[] = []
  let index = 0
  let statementStart = -1
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  let dollarTag = ''

  const push = (end: number): void => {
    if (statementStart < 0) return
    const text = sql.slice(statementStart, end)
    if (hasContent(text)) result.push({ text, from: statementStart, to: end })
    statementStart = -1
  }

  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if (inLineComment) {
      if (char === '\n') inLineComment = false
      index += 1
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        index += 2
        inBlockComment = false
        continue
      }
      index += 1
      continue
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length
        dollarTag = ''
        continue
      }
      index += 1
      continue
    }

    if (inSingle) {
      if (char === '\\' && next !== undefined) {
        index += 2
        continue
      }
      if (char === "'" && next === "'") {
        index += 2
        continue
      }
      if (char === "'") inSingle = false
      index += 1
      continue
    }

    if (inDouble) {
      if (char === '"' && next === '"') {
        index += 2
        continue
      }
      if (char === '"') inDouble = false
      index += 1
      continue
    }

    if (inBacktick) {
      if (char === '`' && next === '`') {
        index += 2
        continue
      }
      if (char === '`') inBacktick = false
      index += 1
      continue
    }

    if (char === '-' && next === '-') {
      if (statementStart < 0) statementStart = index
      inLineComment = true
      index += 2
      continue
    }

    if (char === '#') {
      if (statementStart < 0) statementStart = index
      inLineComment = true
      index += 1
      continue
    }

    if (char === '/' && next === '*') {
      if (statementStart < 0) statementStart = index
      inBlockComment = true
      index += 2
      continue
    }

    if (char === "'") {
      if (statementStart < 0) statementStart = index
      inSingle = true
      index += 1
      continue
    }

    if (char === '"') {
      if (statementStart < 0) statementStart = index
      inDouble = true
      index += 1
      continue
    }

    if (char === '`') {
      if (statementStart < 0) statementStart = index
      inBacktick = true
      index += 1
      continue
    }

    if (char === '$') {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index))
      if (match) {
        if (statementStart < 0) statementStart = index
        dollarTag = match[0]
        index += dollarTag.length
        continue
      }
    }

    if (char === ';') {
      push(index)
      index += 1
      continue
    }

    if (statementStart < 0 && !/\s/.test(char)) statementStart = index
    index += 1
  }

  push(sql.length)
  return result
}

function hasContent(text: string): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/#[^\n]*/g, '')
    .trim()
  return stripped.length > 0
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replace(/'/g, "''")}'`
}
