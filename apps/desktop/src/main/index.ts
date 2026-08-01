import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, crashReporter, dialog, Menu, shell } from 'electron'
import { AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { applicationMenuTemplate } from './application-menu.js'
import { isScratchWorkspaceId } from '../shared/contracts.js'
import { desktopAgentSessionStorePath } from './agent-session-store-path.js'
import { CrashLog } from './crash-log.js'
import { crashReporterOptions, registerCrashCapture } from './crash-capture-wiring.js'
import { ConfigStore } from './config-store.js'
import { registerIpc } from './ipc.js'
import { hydrateProcessPathFromLoginShell } from './login-shell-path.js'
import { RuntimeController } from './runtime-controller.js'
import { ScratchTopics } from './scratch-topics.js'
import { runDesktopResourceProbe } from './resource-probe.js'
import { reportStartupFailureAndExit } from './startup-failure-exit.js'
import { runDesktopFileEditingProbe, WorkspaceFileEditingProbeControl } from './file-editing-probe.js'
import { WorkspaceFiles } from './workspace-files.js'
import { registerWindowResizeEvents } from './window-resize-events.js'
import { WindowGeometryStore } from './window-geometry-store.js'
import { clampGeometryToVisibleArea, windowConstructorGeometry } from './window-geometry.js'
import { liveVisibleAreas } from './window-visible-area.js'
import { registerWindowStatePersistence } from './window-state-persistence.js'
import { foregroundActionsForSecondInstance, instanceRoleFromLock } from './single-instance.js'
import { singleFlight } from './single-flight.js'

const appIconPath = join(import.meta.dirname, '../../resources/icon.png')
const packagedUserDataPath = join(app.getPath('appData'), 'dev.agentmux.desktop')

// Development launches and packaged launches must address the same durable user-data root. Electron's
// default path is derived from the app name and differs between a Vite dev process and the signed App;
// without this explicit binding each mode creates a separate config, Workbench localStorage and
// Agent Session store, making a restart look like a clean install.
app.setPath('userData', process.env.AGENTMUX_DESKTOP_USER_DATA ?? packagedUserDataPath)
app.setName('AgentMux')
// 崩溃事后要有痕迹。原生崩溃（含渲染进程）交给 crashReporter 落本地崩溃目录，且恒不上传；主进程
// 层面的四类信号（未捕获异常/拒绝、渲染进程消失、子进程消失）归一成 NDJSON 追加到 userData，体量
// 有硬顶。两者都只落盘、无网络出口。尽可能早挂，才能网住 whenReady 之前就发生的崩溃。
// 致命崩溃（未捕获异常/拒绝）留证后 fail-fast：挂上 process 处理器会抑制 Node 的默认退出，若只记录
// 不退出，主进程会带着半损坏的运行时静默续命。所以致命崩溃走同步落盘（exit 前必须落地）再 app.exit(1)。
crashReporter.start(crashReporterOptions())
const crashLog = new CrashLog()
registerCrashCapture({
  app,
  process,
  sink: (record) => crashLog.append(record),
  persistSync: (record) => crashLog.appendSync(record),
  exit: (code) => app.exit(code)
})

// 双开守卫必须在任何运行时/daemon 引导之前。用户双击图标是必然场景：两个实例会各自构造
// RuntimeController、各自 spawn/adopt daemon，在会话存储和运行时状态目录上互相踩。会话存储内部的
// 跨进程 PID 锁只缩小了爆炸半径，没有阻止双实例本身。这里用 Electron 官方的单实例锁：拿不到锁的
// 第二实例立刻退出，把窗口带到前台交给已在运行的主实例——绝不静默退出让用户以为点了没反应。
if (instanceRoleFromLock(app.requestSingleInstanceLock()).role === 'secondary') {
  // 在构造任何运行时 owner 之前退出。晚一步就已经踩上了会话存储和 daemon。退出码 0：这是预期行为
  // （用户又点了一次图标），不是错误。真正的「把窗口抬到前台」由主实例的 second-instance 处理器完成。
  app.quit()
} else {
  startPrimaryInstance()
}

/**
 * 唯一实例的全部引导。只有拿到单实例锁才会走到这里——第二实例在上面就退出了，连 RuntimeController
 * 都不会构造。运行时 owner、窗口、IPC、崩溃后的清理全在这个闭包里，第二实例一样都碰不到。
 */
function startPrimaryInstance(): void {
  const scratchTopics = new ScratchTopics()
  const runtime = new RuntimeController(
    new AgentMuxFileAgentSessionStore(desktopAgentSessionStorePath()),
    scratchTopics
  )
  const configStore = new ConfigStore()
  const windowGeometryStore = new WindowGeometryStore()
  let disposeIpc: (() => Promise<void>) | null = null
  let ownerDisposal: Promise<void> | null = null
  let allowingQuit = false

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

  /**
   * 启动失败的收尾：告知用户 → 清理 → 退出。序列本身在 `startup-failure-exit.ts` 里，因为在这个
   * 闭包内它对测试不可达，而不可达的代价是实测过的：在这个函数体第一行插一句早退，整条通知路径
   * 变 no-op 而那一族 11 条全绿（记忆 grep-guard-cannot-see-early-return）。
   *
   * 这里刻意**只有一句表达式**、没有任何语句：没有语句可插，那个变异就无处落脚。所有依赖在这
   * 一句里接到真的 electron / ConfigStore 上，由 `startup-failure-exit.test.ts` 的接线层守卫逐个钉住。
   */
  const exitAfterFailure = (error: unknown): Promise<void> =>
    reportStartupFailureAndExit(error, {
      configPath: configStore.filePath,
      showErrorBox: (title, body) => dialog.showErrorBox(title, body),
      disposeOwners,
      writeDiagnostic: (line) => process.stderr.write(`${line}\n`),
      exit: (code) => app.exit(code)
    })

  async function buildWindow(appReadyAtMs: number = Date.now()): Promise<void> {
    const windowCreationStartedAtMs = Date.now()
    // The window reopens where it was last left. Only a first launch (or a corrupt record) falls back
    // to the default size — the fixed 1480×940 literal is no longer the every-launch size. A saved
    // position that no live display still covers (an unplugged monitor, a resolution change) is
    // re-homed into the primary work area so the window can never open where the user cannot reach it.
    const loadedGeometry = await windowGeometryStore.load()
    const persistedGeometry = loadedGeometry
      ? clampGeometryToVisibleArea(loadedGeometry, liveVisibleAreas())
      : null
    const window = new BrowserWindow({
      ...windowConstructorGeometry(persistedGeometry),
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
    // A window persisted while maximized reopens maximized on top of its restored normal bounds, so
    // unmaximize returns to the size the user actually chose rather than the default.
    if (persistedGeometry?.maximized) window.maximize()
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
            localWriteFault: () => fileEditingProbeControl.consumeFault(),
            afterLocalMoveCommit: async () => await fileEditingProbeControl.afterLocalMoveCommit(),
            onReadDirectoryStart: (workspace, path) => {
              fileEditingProbeControl.recordDirectoryRead(workspace.id, path)
            }
          }
        : {}
    )
    registerWindowResizeEvents(window)
    registerWindowStatePersistence(window, windowGeometryStore)
    await disposeIpc?.()
    disposeIpc = await registerIpc({ window, configStore, runtime, scratchTopics, workspaceFiles })
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
    else {
      const probeQuery = process.env.AGENTMUX_DESKTOP_FILE_EDITING_REPORT
        ? { 'agentmux-file-editing-report': '1' }
        : process.env.AGENTMUX_DESKTOP_RESOURCE_REPORT
          ? { 'agentmux-resource-probe': '1' }
          : undefined
      await window.loadFile(join(import.meta.dirname, '../renderer/index.html'),
        probeQuery ? { query: probeQuery } : undefined)
    }
    const rendererLoadedAtMs = Date.now()
    if (process.env.AGENTMUX_DESKTOP_READY_FILE) {
      const readyPath = process.env.AGENTMUX_DESKTOP_READY_FILE
      const temporaryReadyPath = `${readyPath}.tmp-${process.pid}`
      await writeFile(temporaryReadyPath, `${JSON.stringify({
        productName: app.name,
        version: app.getVersion(),
        packaged: app.isPackaged,
        executable: process.execPath
      })}\n`, { mode: 0o600 })
      await rename(temporaryReadyPath, readyPath)
      if (process.env.AGENTMUX_DESKTOP_EXIT_AFTER_READY === '1') {
        app.quit()
        return
      }
    }
    const fileEditingConfig = await configStore.get()
    if (process.env.AGENTMUX_DESKTOP_FILE_EDITING_REPORT) {
      const mountedWorkspaces = fileEditingConfig.workspaces.filter((workspace) => !isScratchWorkspaceId(workspace.id))
      const primaryWorkspace = mountedWorkspaces.find((workspace) => workspace.id === 'workspace-file-editing-e2e')
      const alternateWorkspace = mountedWorkspaces.find((workspace) => workspace.id === 'workspace-file-editing-alternate-e2e')
      if (!primaryWorkspace || !alternateWorkspace) {
        // These two ids must match the ones scripts/file-editing-fixture.mjs writes into the config. They
        // cannot be imported from there — that fixture lives in the scripts build graph, not this bundle —
        // so the coupling is checked here, at startup, by failing loudly and naming where to look.
        throw new Error(
          'Desktop file editing probe requires its primary and alternate mounted workspaces. ' +
            'Their ids must match FILE_EDITING_PRIMARY_WORKSPACE_ID / FILE_EDITING_ALTERNATE_WORKSPACE_ID ' +
            'in apps/desktop/scripts/file-editing-fixture.mjs.'
        )
      }
      if (await runDesktopFileEditingProbe({
        window,
        workspacePath: primaryWorkspace.path,
        alternateWorkspacePath: alternateWorkspace.path,
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

  // 三处建窗触发点（whenReady 首建、second-instance 用户又双击、activate 全关后点 dock）都可能在
  // 「窗口尚未构造出来」的空档里各自判断「当前没窗口」而并发建窗，开出两个窗口。单飞去重：在途只建
  // 一次，后来的调用复用同一次在途，结算后才允许下一次真正建窗。
  const createWindow = singleFlight(buildWindow)

  // 第二实例来敲门时把已有窗口带到用户眼前。最小化的先还原再聚焦，否则聚焦一个最小化窗口用户还是
  // 看不见；窗口全关了（macOS 上 app 还活着）则新开一个。决策在纯函数里，这里只执行动作。
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    const actions = foregroundActionsForSecondInstance({
      exists: existing !== undefined,
      minimized: existing?.isMinimized() ?? false
    })
    for (const action of actions) {
      if (action === 'create') void createWindow()
      else if (action === 'restore') existing?.restore()
      else if (action === 'focus') existing?.focus()
    }
  })

  app.whenReady().then(async () => {
    const appReadyAtMs = Date.now()
    // 换掉默认应用菜单：默认菜单把 Cmd+W 绑到「关闭窗口」，会抢走 Workbench「关闭当前 Region」的
    // 主键位（原生加速键在按键进渲染进程前就被 AppKit 处理，渲染层 preventDefault 拦不住）。这份模板
    // 不含任何绑 Cmd+W 的 role，同时保留 Edit 菜单——终端粘贴走的是原生 Paste role。菜单是应用级、
    // 全窗口共享的，建窗前设一次即可。
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(process.platform === 'darwin')))
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
}
