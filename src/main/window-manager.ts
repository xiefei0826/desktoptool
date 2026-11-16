import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

const windows = new Set<BrowserWindow>()

export function createWindow(sessionId?: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    title: 'DesktopTool',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })

  windows.add(window)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => windows.delete(window))

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('[renderer]', message)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const url = new URL(devUrl)
    if (sessionId) url.searchParams.set('session', sessionId)
    void window.loadURL(url.toString())
  } else {
    const file = path.join(__dirname, '../renderer/index.html')
    if (sessionId) void window.loadFile(file, { query: { session: sessionId } })
    else void window.loadFile(file)
  }

  return window
}

export function allWindows(): BrowserWindow[] {
  return [...windows]
}

export function focusFirstWindow(): void {
  const [first] = windows
  if (!first || first.isDestroyed()) return
  if (first.isMinimized()) first.restore()
  first.focus()
}
