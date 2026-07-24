import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { ConfigStore } from './config-store.js'
import { registerIpc } from './ipc.js'
import { RuntimeController } from './runtime-controller.js'
import { runDesktopResourceProbe } from './resource-probe.js'

const appIconPath = join(import.meta.dirname, '../../resources/icon.png')
const packagedUserDataPath = join(app.getPath('appData'), 'dev.agentmux.desktop')
let disposeIpc: (() => Promise<void>) | null = null
let quitting = false

if (process.env.AGENTMUX_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.AGENTMUX_DESKTOP_USER_DATA)
} else if (app.isPackaged) {
  app.setPath('userData', packagedUserDataPath)
}
app.setName('AgentMux')
const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore())
const configStore = new ConfigStore()

async function createWindow(appReadyAtMs: number = Date.now()): Promise<void> {
  const windowCreationStartedAtMs = Date.now()
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 660,
    icon: appIconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0d0f',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  await disposeIpc?.()
  disposeIpc = await registerIpc({ window, configStore, runtime })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  const rendererLoadedAtMs = Date.now()
  if (process.env.AGENTMUX_DESKTOP_READY_FILE) {
    await writeFile(process.env.AGENTMUX_DESKTOP_READY_FILE, `${JSON.stringify({
      productName: app.name,
      version: app.getVersion(),
      packaged: app.isPackaged
    })}\n`, { mode: 0o600 })
    if (process.env.AGENTMUX_DESKTOP_EXIT_AFTER_READY === '1') {
      app.quit()
      return
    }
  }
  if (await runDesktopResourceProbe({
    window,
    runtime,
    configStore,
    startup: {
      spawnedAtMs: Number(process.env.AGENTMUX_DESKTOP_SPAWNED_AT_MS),
      appReadyAtMs,
      windowCreationStartedAtMs,
      rendererLoadedAtMs
    }
  })) app.quit()
}

app.whenReady().then(async () => {
  const appReadyAtMs = Date.now()
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  await createWindow(appReadyAtMs)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  app.exit(1)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void (async () => {
    await disposeIpc?.()
    disposeIpc = null
    await runtime.dispose()
    app.quit()
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    app.exit(1)
  })
})
