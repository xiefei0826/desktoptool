export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  const value = size / 1024 ** index
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export function formatTime(timestamp: number): string {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function modeToRwx(mode: number): string {
  const chars = 'rwxrwxrwx'
  const bits = mode & 0o777
  let result = ''
  for (let i = 0; i < 9; i += 1) {
    result += bits & (1 << (8 - i)) ? chars[i] : '-'
  }
  return result
}

/** Kubernetes 风格的年龄显示：3s / 12m / 5h / 7d / 2y */
export function ageOf(timestamp: string | number | null | undefined): string {
  if (!timestamp) return '-'
  const value = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime()
  const diff = Date.now() - value
  if (Number.isNaN(diff) || diff < 0) return '-'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y`
}

export function relativeTime(timestamp: number | null): string {
  if (!timestamp) return '从未连接'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return formatTime(timestamp)
}
