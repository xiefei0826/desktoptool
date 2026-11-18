import { app, BrowserWindow, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { AppServices } from './services'
import { registerIpc } from './ipc'
import { runK8sSmoke, runK8sWriteSmoke, runSshSmoke } from './smoke'
import { allWindows, createWindow, focusFirstWindow } from './window-manager'

let services: AppServices | null = null
let quitting = false

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}

/** 无人值守启动自检：验证窗口、主布局与致命错误占位是否正常，然后退出 */
function runWindowSmokeTest(window: BrowserWindow): void {
  window.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const result = await window.webContents.executeJavaScript(`(async () => {
          const fatal = document.querySelector('.boot-error')
          const info = await window.api.app.info()
          return {
            shell: Boolean(document.querySelector('.app-shell')),
            sidebar: Boolean(document.querySelector('.sidebar')),
            brand: document.querySelector('.brand-title')?.textContent ?? '',
            fatal: fatal ? fatal.textContent : '',
            pty: info.ptyAvailable,
            url: location.href
          }
        })()`)
        console.log('[smoke]', JSON.stringify(result))
      } catch (error) {
        console.error('[smoke] failed:', error)
      }
      app.exit(0)
    }, 2500)
  })
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(buildMenu())

  services = new AppServices((channel, payload) => {
    for (const window of allWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  })

  await services.init()
  registerIpc(services)

  const mainWindow = createWindow()

  if (process.argv.includes('--smoke-test')) {
    runWindowSmokeTest(mainWindow)
  }

  if (process.argv.includes('--smoke-k8s-write')) {
    const activeServices = services
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const logs = await runK8sWriteSmoke(activeServices)
        console.log('[smoke-k8s-write] PASS', JSON.stringify(logs))
      } catch (error) {
        console.error('[smoke-k8s-write] FAIL', error)
      }
      app.exit(0)
    })
  }

  if (process.argv.includes('--smoke-k8s')) {
    const activeServices = services
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const logs = await runK8sSmoke(activeServices, mainWindow)
        console.log('[smoke-k8s] PASS', JSON.stringify(logs))
      } catch (error) {
        console.error('[smoke-k8s] FAIL', error)
      }
      app.exit(0)
    })
  }

  if (process.argv.includes('--smoke-ssh')) {
    const activeServices = services
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const logs = await runSshSmoke(activeServices, mainWindow)
        console.log('[smoke-ssh] PASS', JSON.stringify(logs))
      } catch (error) {
        console.error('[smoke-ssh] FAIL', error)
      }
      app.exit(0)
    })
  }

  app.on('activate', () => {
    if (allWindows().length === 0) createWindow()
  })

  setTimeout(() => {
    services?.forward.startAutoRules().catch(() => {
      /* 自动启动失败不影响主流程 */
    })
  }, 1500)
}

const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => focusFirstWindow())

  app.whenReady().then(bootstrap).catch((error: Error) => {
    console.error('[bootstrap] failed:', error)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !services) return
    event.preventDefault()
    quitting = true
    services
      .dispose()
      .catch(() => {
        /* ignore */
      })
      .finally(() => app.quit())
  })
}
