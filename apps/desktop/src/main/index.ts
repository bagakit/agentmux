import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { ConfigStore } from './config-store.js'
import { registerIpc } from './ipc.js'
import { hydrateProcessPathFromLoginShell } from './login-shell-path.js'
import { RuntimeController } from './runtime-controller.js'
import { runDesktopResourceProbe } from './resource-probe.js'
import { runDesktopFileEditingProbe, WorkspaceFileEditingProbeControl } from './file-editing-probe.js'
import { WorkspaceFiles } from './workspace-files.js'

const appIconPath = join(import.meta.dirname, '../../resources/icon.png')
const packagedUserDataPath = join(app.getPath('appData'), 'dev.agentmux.desktop')
let disposeIpc: (() => Promise<void>) | null = null
let ownerDisposal: Promise<void> | null = null
let allowingQuit = false

if (process.env.AGENTMUX_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.AGENTMUX_DESKTOP_USER_DATA)
} else if (app.isPackaged) {
  app.setPath('userData', packagedUserDataPath)
}
app.setName('AgentMux')
const runtime = new RuntimeController(new AgentMuxFileAgentSessionStore())
const configStore = new ConfigStore()

function disposeOwners(): Promise<void> {
  if (!ownerDisposal) {
    ownerDisposal = (async () => {
      const disposeRegisteredIpc = disposeIpc
      disposeIpc = null
      const failures: unknown[] = []
      try {
        await disposeRegisteredIpc?.()
      } catch (error) {
        failures.push(error)
      }
      try {
        await runtime.dispose()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Desktop owner disposal failed')
    })()
  }
  return ownerDisposal
}

async function exitAfterFailure(error: unknown): Promise<void> {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  try {
    await disposeOwners()
  } catch (cleanupError) {
    process.stderr.write(`${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`)
  }
  app.exit(1)
}

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
  const fileEditingProbeControl = new WorkspaceFileEditingProbeControl()
  const workspaceFiles = new WorkspaceFiles(
    (id) => runtime.executionHost(id),
    process.env.AGENTMUX_DESKTOP_FILE_EDITING_REPORT
      ? {
          beforeWrite: async (input) => await fileEditingProbeControl.beforeWrite(input),
          localWriteFault: () => fileEditingProbeControl.consumeFault()
        }
      : {}
  )
  await disposeIpc?.()
  disposeIpc = await registerIpc({ window, configStore, runtime, workspaceFiles })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  const rendererLoadedAtMs = Date.now()
  if (process.env.AGENTMUX_DESKTOP_READY_FILE) {
    await writeFile(process.env.AGENTMUX_DESKTOP_READY_FILE, `${JSON.stringify({
      productName: app.name,
      version: app.getVersion(),
      packaged: app.isPackaged,
      executable: process.execPath
    })}\n`, { mode: 0o600 })
    if (process.env.AGENTMUX_DESKTOP_EXIT_AFTER_READY === '1') {
      app.quit()
      return
    }
  }
  const fileEditingConfig = await configStore.get()
  if (process.env.AGENTMUX_DESKTOP_FILE_EDITING_REPORT) {
    if (fileEditingConfig.workspaces.length !== 1) {
      throw new Error('Desktop file editing probe requires exactly one workspace.')
    }
    if (await runDesktopFileEditingProbe({
      window,
      workspacePath: fileEditingConfig.workspaces[0]!.path,
      control: fileEditingProbeControl
    })) {
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
  const pathHydration = await hydrateProcessPathFromLoginShell()
  if (!pathHydration.ok && pathHydration.reason !== 'unsupported-platform') {
    process.stderr.write(`Unable to load login shell PATH: ${pathHydration.reason}\n`)
  }
  if (process.platform === 'darwin') app.dock?.setIcon(appIconPath)
  await createWindow(appReadyAtMs)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
}).catch((error) => {
  void exitAfterFailure(error)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (allowingQuit) return
  event.preventDefault()
  void disposeOwners().then(() => {
    allowingQuit = true
    app.quit()
  }, async (error) => await exitAfterFailure(error))
})
