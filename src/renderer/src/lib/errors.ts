/** 去掉 Electron 给 IPC 异常加的前缀，拿到干净的业务错误信息 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}
