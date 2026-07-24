import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { ConfigStore } from './config-store.js'
import { registerIpc } from './ipc.js'
import { RuntimeController } from './runtime-controller.js'
import { DesktopSemanticSessionStore } from './semantic-session-store.js'
import { runDesktopResourceProbe } from './resource-probe.js'

const appIconPath = join(import.meta.dirname, '../../resources/icon.png')
let disposeIpc: (() => void) | null = null

app.setName('AgentMux')
const runtime = new RuntimeController(new DesktopSemanticSessionStore(
  join(app.getPath('userData'), 'agentmux.semantic-sessions.json')
))
const configStore = new ConfigStore()

async function createWindow(): Promise<void> {
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
  disposeIpc?.()
  disposeIpc = await registerIpc({ window, configStore, runtime })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  if (await runDesktopResourceProbe({ window, runtime, configStore })) app.quit()
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  await createWindow()
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

app.on('before-quit', () => {
  disposeIpc?.()
  disposeIpc = null
  void runtime.dispose()
})
