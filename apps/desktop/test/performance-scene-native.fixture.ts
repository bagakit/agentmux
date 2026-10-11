// One isolated App owner. Only resource presentation DTOs are controlled; every profiler command is real Electron CDP.
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
const directory = process.env.PERFORMANCE_SCENE_NATIVE_DIRECTORY!,
  privateRoot = process.env.PERFORMANCE_SCENE_PRIVATE_ROOT!,
  home = join(privateRoot, 'home')
assert.equal(process.env.HOME, home)
assert.equal(homedir(), home)
writeFileSync(
  join(directory, 'worker-home.json'),
  JSON.stringify({ pid: process.pid, home: process.env.HOME, nodeHome: homedir(), beforeProductionImports: true })
)
async function run() {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const { AgentMuxControlServer } = await import('../../../packages/core/src/public-rpc-server.js')
  const { RendererV8Profiler } = await import('../src/main/renderer-v8-profile.js')
  const { RendererAllocationSampler } = await import('../src/main/renderer-allocations.js')
  const { RendererMemoryInspector } = await import('../src/main/renderer-memory.js')
  const { RendererTimelineTracer } = await import('../src/main/renderer-trace.js')
  const { PerformanceSceneOwner } = await import('../src/main/performance-scene.js')
  const { createResourceMetricsPort } = await import('../src/main/resource-usage-control.js')
  const { registerPerformanceCaptureIpc } = await import('../src/main/performance-capture-ipc.js')
  const { deepMetricsSnapshot } = await import('../../../packages/core/test/helpers/toolkit-metrics.js')
  app.setPath('userData', join(privateRoot, 'user-data'))
  app.setPath('sessionData', join(privateRoot, 'session-data'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  await app.whenReady()
  app.dock?.hide()
  let generation = 1,
    focusedEver = false,
    foreign = false
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    show: false,
    focusable: false,
    webPreferences: {
      preload: process.env.PERFORMANCE_SCENE_PRELOAD_FILE!,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  window.on('focus', () => {
    focusedEver = true
  })
  if (process.env.PERFORMANCE_SCENE_RENDERER_FILE) await window.loadFile(process.env.PERFORMANCE_SCENE_RENDERER_FILE)
  else
    await window.loadURL(
      'data:text/html,<title>Original private scene</title><textarea id="original">Original private draft</textarea><script>globalThis.retainedSceneAllocations=[];globalThis.growth=setInterval(function sceneAllocationPositiveControl(){const a=Array.from({length:300},(_,i)=>({i,values:Array(100).fill(i)}));retainedSceneAllocations.push(a);if(retainedSceneAllocations.length>100)retainedSceneAllocations.shift()},25)</script>'
    )
  if (process.env.PERFORMANCE_SCENE_VISIBLE === '1') window.showInactive()
  const target = () => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return null
    const pid = window.webContents.getOSProcessId(),
      m = app.getAppMetrics().find((v) => v.pid === pid)
    return m && m.creationTime > 0
      ? { windowId: window.id, webContentsId: window.webContents.id, generation, pid, creationTime: m.creationTime }
      : null
  }
  const windowTarget = () => {
    const t = target()
    return t ? { windowId: t.windowId, webContentsId: t.webContentsId, generation: t.generation } : null
  }
  const initial = target()
  assert.ok(initial)
  const client = window.webContents.debugger,
    commands: Array<{ method: string; params: unknown; at: number }> = [],
    send = client.sendCommand.bind(client)
  client.sendCommand = (method, params, sessionId) => {
    commands.push({ method, params: params ?? null, at: Date.now() })
    return send(method, params, sessionId)
  }
  const profiler = new RendererV8Profiler(window.webContents, target),
    allocations = new RendererAllocationSampler(window.webContents, target),
    memory = new RendererMemoryInspector(window.webContents, target),
    tracer = new RendererTimelineTracer(window.webContents, target)
  const scene = new PerformanceSceneOwner(join(privateRoot, 'state', 'performance-scene.json'))
  const loaded = JSON.parse(readFileSync(process.env.PERFORMANCE_SCENE_LOADED_IDENTITY!, 'utf8'))
  // Explicitly controlled resource DTOs with the actual private native identity. No user Runtime or content is read.
  const sampler = {
    subscribe(receive: (value: unknown) => void) {
      const t = target()!,
        observation = structuredClone(deepMetricsSnapshot().observation),
        at = Date.now()
      assert.ok(observation)
      observation.window = windowTarget()
      observation.scope.mainPid = process.pid
      const renderer = observation.renderer.data!
      renderer.window = windowTarget()!
      renderer.process = { pid: t.pid, creationTime: t.creationTime }
      renderer.memory.sampledAt = at
      renderer.performance.observedAt = at
      renderer.performance.terminals = []
      renderer.performance.tabSwitches = []
      observation.app.data = {
        processCount: 1,
        cpuPercent: null,
        rssKib: 0,
        groups: [{ role: 'renderer', processCount: 1, cpuPercent: null, rssKib: 0 }],
        processes: [
          {
            pid: t.pid,
            creationTime: t.creationTime,
            type: 'Tab',
            role: 'renderer',
            cpuPercent: null,
            intervalMs: null,
            rssKib: 0
          }
        ],
        omittedProcesses: 0,
        logicalCpuCount: 1,
        unavailable: null
      }
      receive({
        runs: [],
        runTotals: {
          coverage: { trackedRuns: 0, observedRoots: 0, missingRoots: 0 },
          processCount: 0,
          cpuPercent: 0,
          rssKib: 0
        },
        app: observation.app.data,
        runtime: [],
        runtimeUnavailable: null,
        mainOwners: {
          sessionAttachmentOwners: 0,
          sessionAttachmentLeases: 0,
          fileWatchers: 0,
          browserViews: 0,
          releasedBrowserViews: 0
        },
        mainUnavailable: null,
        unavailable: null,
        processObservedAt: at,
        appObservedAt: at,
        runtimeObservedAt: at,
        mainObservedAt: at,
        diagnostics: { data: null, observedAt: null, unavailable: 'Private fixture has no user Runtime' },
        renderer: { data: renderer, observedAt: at, unavailable: null, unavailableWindow: null }
      })
      return () => {}
    }
  }
  const metrics = createResourceMetricsPort({
    sampler: sampler as never,
    currentWindow: windowTarget,
    profiler,
    allocations,
    memory,
    tracer,
    scene: { owner: scene, currentTarget: target, loaded: () => ({ mainPid: process.pid, ...loaded }) }
  })
  const channels: string[] = [],
    ipcCalls: Array<{
      channel: string
      input: unknown
      at: number
      finished: boolean
      finishedAt?: number
      status?: string
      captureId?: string
    }> = []
  registerPerformanceCaptureIpc(metrics, (channel, handler) => {
    channels.push(channel)
    ipcMain.handle(channel, (event, input) => {
      assert.equal(event.sender, window.webContents)
      assert.equal(event.senderFrame, window.webContents.mainFrame)
      const call = { channel, input, at: Date.now(), finished: false } as (typeof ipcCalls)[number]
      ipcCalls.push(call)
      return Promise.resolve(handler(event, input)).then(
        (result) => {
          call.finished = true
          call.finishedAt = Date.now()
          const status =
            (result as { status?: string; scene?: { status: string } }).status ??
            (result as { scene?: { status: string } }).scene?.status
          if (status) call.status = status
          const captureId = (result as { scene?: { captureId?: string } }).scene?.captureId
          if (captureId) call.captureId = captureId
          return result
        },
        (error) => {
          call.finished = true
          call.finishedAt = Date.now()
          call.status = 'failed'
          throw error
        }
      )
    })
  })
  const server = new AgentMuxControlServer(
    { coreClients: () => [], metrics },
    process.env.PERFORMANCE_SCENE_NATIVE_SOCKET!
  )
  await server.start()
  writeFileSync(
    join(directory, 'native-ready.json'),
    JSON.stringify({
      target: initial,
      mainPid: process.pid,
      home: process.env.HOME,
      nodeHome: homedir(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      loaded,
      rendererFile: process.env.PERFORMANCE_SCENE_RENDERER_FILE ?? null,
      controlledResources: true
    })
  )
  console.log('ready')

  const input = createInterface({ input: process.stdin })
  input.on('line', async (line) => {
    try {
      if (line === 'foreign') {
        client.attach()
        foreign = true
        console.log('foreign-ready')
      } else if (line === 'release-foreign') {
        client.detach()
        foreign = false
        console.log('foreign-released')
      } else if (line === 'generation') {
        generation++
        console.log('generation-changed')
      } else if (line === 'facts') {
        writeFileSync(
          join(directory, 'native-facts.json'),
          JSON.stringify({
            target: target(),
            attached: client.isAttached(),
            commands,
            focusedEver,
            visible: window.isVisible(),
            focusable: window.isFocusable()
          })
        )
        console.log('facts')
      } else if (line === 'quit') {
        assert.equal(process.env.HOME, home)
        assert.equal(homedir(), home)
        assert.equal(focusedEver, false)
        writeFileSync(
          join(directory, 'native-final.json'),
          JSON.stringify({
            target: target(),
            attached: client.isAttached(),
            foreign,
            commands,
            focusedEver,
            visible: window.isVisible(),
            focusable: window.isFocusable(),
            home: process.env.HOME,
            nodeHome: homedir(),
            mainPid: process.pid,
            title: window.getTitle()
          })
        )
        input.close()
        await server.stop()
        scene.dispose()
        metrics.dispose()
        for (const channel of channels) ipcMain.removeHandler(channel)
        window.destroy()
        app.quit()
      }
    } catch (error) {
      console.error(error)
      app.exit(1)
    }
  })

  if (process.env.PERFORMANCE_SCENE_UI_DRIVER) {
    const driver = await import(pathToFileURL(process.env.PERFORMANCE_SCENE_UI_DRIVER).href)
    const result = await driver.runPerformanceSceneUiProof({
      window,
      initialTarget: initial,
      directory,
      metrics,
      ipcCalls
    })
    writeFileSync(join(directory, 'ui-receipt.json'), JSON.stringify(result, null, 2))
    console.log('ui-complete')
  }
}
void run().catch((error) => {
  writeFileSync(
    join(directory, 'fatal.json'),
    JSON.stringify({ name: error.name, message: error.message, stack: error.stack })
  )
  console.error(error)
  process.exit(1)
})
