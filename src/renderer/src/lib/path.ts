export function joinPath(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`
  return base.endsWith('/') ? `${base}${name}` : `${base}/${name}`
}

export function parentPath(target: string): string {
  const trimmed = target.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

export function splitPath(target: string): { name: string; path: string }[] {
  const parts = target.split('/').filter(Boolean)
  const result: { name: string; path: string }[] = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    result.push({ name: part, path: current })
  }
  return result
}
