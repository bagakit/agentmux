import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { performanceFixture } from '../../../packages/core/test/helpers/renderer-performance.js'
import type { MetricsWindow, RendererV8ProfileTarget } from '../../../packages/core/src/metrics.js'
import { RendererMemoryInspector } from '../src/main/renderer-memory.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import type { ProcessResourceSampler, ResourceSample } from '../src/main/process-resource-sampler.js'

type Label = 'root' | 'foreign'
type Packet = { kind: string; nonce?: string; worker?: string; ticks?: number; bytes?: number; first?: number; last?: number; message?: string }
const directory = process.env.RENDERER_WORKER_MEMORY_NATIVE_DIRECTORY!
const windows = new Map<Label, BrowserWindow>()
const latest = new Map<string, Packet>()
const pending = new Map<string, { resolve(value: Packet): void; reject(error: Error): void }>()
const commands: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [], ipc: Record<string, unknown>[] = []
const heartbeats: Record<string, unknown>[] = []
let omittedHeartbeats = 0
let server: AgentMuxControlServer | undefined
let metrics: ReturnType<typeof createResourceMetricsPort> | undefined
let sequence = 0
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const save = (name: string, value: unknown) => writeFileSync(join(directory, name + '.json'), JSON.stringify(value, null, 2))
function flush() { save('native-command-trace', commands); save('native-events', events); save('native-ipc', ipc); save('native-heartbeats', { samples: heartbeats, omitted: omittedHeartbeats }) }
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() >= deadline) throw new Error('Private fixture stage timed out: ' + label); await pause(20) }
}
function request(label: Label, kind: string, data: Record<string, unknown> = {}): Promise<Packet> {
  const nonce = 'private-' + (++sequence), key = label + ':' + nonce
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('Private page IPC timed out: ' + kind)) }, 5000)
    pending.set(key, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    windows.get(label)!.webContents.send('renderer-worker-memory-fixture-command', { kind, nonce, ...data })
  })
}
function target(label: Label): RendererV8ProfileTarget | null {
  const window = windows.get(label)
  if (!window || window.isDestroyed()) return null
  const pid = window.webContents.getOSProcessId(), metric = app.getAppMetrics().find(item => item.pid === pid)
  return metric ? { windowId: window.id, webContentsId: window.webContents.id, generation: 1, pid, creationTime: metric.creationTime } : null
}
function currentWindow(): MetricsWindow | null {
  const value = target('root')
  return value ? { windowId: value.windowId, webContentsId: value.webContentsId, generation: value.generation } : null
}
function trace(label: Label, window: BrowserWindow): void {
  const client = window.webContents.debugger, send = client.sendCommand.bind(client)
  client.sendCommand = async (method, params, sessionId) => {
    const row: Record<string, unknown> = { owner: label, method, params: params ?? {}, sessionId: sessionId ?? null, requestedAt: Date.now(), status: 'requested' }
    commands.push(row); flush()
    try { const value = await send(method, params, sessionId); Object.assign(row, { status: 'completed', completedAt: Date.now(), result: value }); flush(); return value }
    catch (error) { Object.assign(row, { status: 'failed', completedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }); flush(); throw error }
  }
  client.on('message', (_event, method, params, sessionId) => {
    if (method.startsWith('Target.')) { events.push({ owner: label, method, params, sessionId: sessionId ?? null, at: Date.now() }); flush() }
  })
  client.on('detach', (_event, reason) => { events.push({ owner: label, event: 'debugger-detached', reason, at: Date.now() }); flush() })
  window.webContents.on('preload-error', (_event, _path, error) => { events.push({ owner: label, event: 'preload-error', message: error.message }); flush() })
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { events.push({ owner: label, event: 'did-fail-load', code, description, isMainFrame }); flush() })
  window.webContents.on('render-process-gone', (_event, details) => { events.push({ owner: label, event: 'render-process-gone', details }); flush() })
  window.webContents.on('console-message', event => { events.push({ owner: label, event: 'console-message', message: event.message }); flush() })
}

// Self-created, credential-free pages only. The nested Worker is a different native
// attachment shape, created after the first query has released its debugger.
const childSource = `let ticks=0;const storage=new Uint8Array(4*1024*1024);storage.fill(53);
setInterval(()=>postMessage({kind:'heartbeat',worker:'nested',ticks:++ticks,bytes:storage.byteLength,first:storage[0],last:storage[storage.length-1]}),25);
postMessage({kind:'nested-ready',worker:'nested',bytes:storage.byteLength,first:storage[0],last:storage[storage.length-1]});`
const workerSource = `let storage=null,ticks=0,child=null;
setInterval(()=>postMessage({kind:'heartbeat',worker:'direct',ticks:++ticks,bytes:storage?.byteLength??0,first:storage?.[0]??null,last:storage?.[storage.length-1]??null}),25);
onmessage=event=>{const c=event.data;if(c.kind==='allocate'){storage=new Uint8Array(c.bytes);storage.fill(c.value);postMessage({kind:'allocated',nonce:c.nonce,bytes:storage.byteLength,first:storage[0],last:storage[storage.length-1]});}
if(c.kind==='nested'){child=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(childSource)}],{type:'text/javascript'})),{name:'private-nested-worker'});child.onmessage=e=>{const p=e.data;if(p.kind==='nested-ready')p.nonce=c.nonce;postMessage(p)};child.onerror=e=>postMessage({kind:'worker-error',nonce:c.nonce,message:e.message});}};
postMessage({kind:'worker-ready',worker:'direct'});`
const page = '<!doctype html><meta charset="utf-8"><title>Private Worker memory product fixture</title><p>Original private page remains alive</p><script>' +
  'const source=' + JSON.stringify(workerSource) + ';let worker=null,startNonce=null;' +
  'workerMemoryFixture.onCommand(c=>{if(c.kind==="start"){startNonce=c.nonce;worker=new Worker(URL.createObjectURL(new Blob([source],{type:"text/javascript"})),{name:"private-direct-worker"});' +
  'worker.onmessage=e=>{const p=e.data;if(p.kind==="worker-ready")p.nonce=startNonce;workerMemoryFixture.report(p)};worker.onerror=e=>workerMemoryFixture.report({kind:"worker-error",nonce:startNonce,message:e.message});}' +
  'else worker.postMessage(c)});workerMemoryFixture.report({kind:"page-ready"});</script>'

function sample(): ResourceSample {
  const now = Date.now(), identity = target('root')!, window = currentWindow()!
  return { observedAt: now, runs: [], runTotals: null, app: null, runtime: null, runtimeUnavailable: 'Private fixture does not inspect Runtime or Agent processes', mainOwners: null,
    unavailable: 'Private fixture does not inspect host process tables', processObservedAt: null, appObservedAt: null, runtimeObservedAt: null,
    mainObservedAt: null, mainUnavailable: 'Private fixture does not inspect Main owner inventories',
    diagnostics: { observedAt: null, data: null, unavailable: 'Private fixture does not inspect host diagnostics' },
    renderer: { observedAt: now, unavailable: null, unavailableWindow: null, data: { window, process: { pid: identity.pid, creationTime: identity.creationTime },
      memory: { sampledAt: now, scope: 'renderer-v8-isolate', heap: null, unavailable: 'Use the native public counter operation' },
      counts: { monacoEditors: null, monacoModels: null, documents: 1, runtimeSubscriptions: 0, terminalViews: 0, terminalAddons: 0, terminalListeners: 0 },
      performance: performanceFixture() } } }
}
async function health(label: string): Promise<void> {
  const before = new Map([...latest].filter(([key]) => key.includes(':heartbeat:')).map(([key, value]) => [key, value.ticks!]))
  await until(() => [...before].every(([key, ticks]) => latest.get(key)!.ticks! > ticks), 'heartbeat progress after ' + label)
  save(label, { at: Date.now(), windows: Object.fromEntries([...windows].map(([owner, window]) => [owner, {
    target: target(owner), debuggerAttached: window.webContents.debugger.isAttached(), destroyed: window.isDestroyed(), visible: window.isVisible(), focused: window.isFocused(),
    heartbeats: [...latest].filter(([key]) => key.startsWith(owner + ':heartbeat:')).map(([key, value]) => ({ key, ...value, beforeTicks: before.get(key), progressed: value.ticks! > before.get(key)! }))
  }])) }); flush()
}
async function foreignCounter(): Promise<void> {
  const client = windows.get('foreign')!.webContents.debugger
  client.attach('1.3')
  try {
    await client.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    let relation: Record<string, unknown> | undefined
    await until(() => { relation = events.find(row => row.owner === 'foreign' && row.method === 'Target.attachedToTarget'); return relation !== undefined }, 'foreign dedicated Worker relation')
    const params = relation!.params as { sessionId: string; targetInfo: { targetId: string }; waitingForDebugger: boolean }
    const isolate = await client.sendCommand('Runtime.getIsolateId', {}, params.sessionId)
    const usage = await client.sendCommand('Runtime.getHeapUsage', {}, params.sessionId)
    save('foreign-counter', { source: target('foreign'), ...params, isolateId: isolate.id, usage })
  } finally { client.detach() }
}
async function run(): Promise<void> {
  app.setName('RendererWorkerMemoryNativeFixture')
  for (const [key, name] of Object.entries({ home: 'home', appData: 'app-data', userData: 'user-data', sessionData: 'session-data' })) {
    const path = join(directory, name); mkdirSync(path, { recursive: true }); app.setPath(key as 'home' | 'appData' | 'userData' | 'sessionData', path)
  }
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update'); app.commandLine.appendSwitch('disable-sync')
  await app.whenReady(); app.dock?.hide()
  ipcMain.on('renderer-worker-memory-fixture-report', (event, packet: Packet) => {
    const owner = [...windows].find(([, window]) => window.webContents === event.sender)?.[0]
    if (!owner) return
    latest.set(owner + ':' + packet.kind + ':' + (packet.worker ?? 'page'), packet)
    if (packet.kind === 'heartbeat') {
      if (heartbeats.length < 1024) heartbeats.push({ owner, ...packet, at: Date.now(), debuggerAttached: event.sender.debugger.isAttached() })
      else omittedHeartbeats++
      return
    }
    ipc.push({ owner, ...packet, at: Date.now() }); flush()
    if (packet.nonce) {
      const key = owner + ':' + packet.nonce, waiter = pending.get(key)
      if (waiter) { pending.delete(key); if (packet.kind === 'worker-error') waiter.reject(new Error(packet.message)); else waiter.resolve(packet) }
    }
  })
  for (const owner of ['root', 'foreign'] as const) {
    const window = new BrowserWindow({ show: false, focusable: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, partition: 'renderer-worker-memory-private-' + owner, preload: process.env.RENDERER_WORKER_MEMORY_NATIVE_PRELOAD! } })
    windows.set(owner, window); trace(owner, window)
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
    await until(() => latest.has(owner + ':page-ready:page'), 'sandbox preload and page bootstrap')
    await request(owner, 'start')
  }
  await request('foreign', 'allocate', { bytes: 8 * 1024 * 1024, value: 91 })
  await until(() => ['root', 'foreign'].every(owner => (latest.get(owner + ':heartbeat:direct')?.ticks ?? 0) > 0), 'initial Worker heartbeats')
  await foreignCounter()
  const memory = new RendererMemoryInspector(windows.get('root')!.webContents, () => target('root'))
  // Only the externally observed sample leaf is controlled. Public projection,
  // codec, server, CLI and native memory owner are the actual product consumers.
  const sampler = { subscribe(callback: (value: ResourceSample) => void) { callback(sample()); return () => {} } } as ProcessResourceSampler
  metrics = createResourceMetricsPort({ sampler, currentWindow, memory })
  server = new AgentMuxControlServer({ coreClients: () => [], metrics }, process.env.RENDERER_WORKER_MEMORY_NATIVE_SOCKET!)
  await server.start()
  save('native-ready', { target: target('root'), foreignTarget: target('foreign'), electron: process.versions.electron, chromium: process.versions.chrome,
    windows: { sandbox: true, contextIsolation: true, nodeIntegration: false, show: false, focusable: false }, noActualApp: true })
  console.log('ready')
  const input = createInterface({ input: process.stdin })
  let work = Promise.resolve()
  input.on('line', line => {
    work = work.then(async () => {
      if (line === 'allocate') {
        save('root-allocation', { at: Date.now(), reply: await request('root', 'allocate', { bytes: 32 * 1024 * 1024, value: 37 }) })
        await until(() => latest.get('root:heartbeat:direct')?.bytes === 32 * 1024 * 1024, 'pre-existing Worker retained backing')
        await health('before-first-query'); console.log('allocated')
      } else if (line === 'nested') {
        save('nested-allocation', { at: Date.now(), reply: await request('root', 'nested') })
        await until(() => (latest.get('root:heartbeat:nested')?.ticks ?? 0) > 0, 'new nested Worker heartbeat')
        await health('before-second-query'); console.log('nested')
      } else if (line.startsWith('health:')) {
        const label = line.slice(7); await health(label); console.log(line)
      } else if (line === 'quit') {
        await health('native-final'); await server!.stop(); metrics!.dispose(); input.close()
        for (const window of windows.values()) window.destroy()
        app.quit()
      }
    }).catch(fail)
  })
}
async function fail(error: unknown): Promise<void> {
  save('native-failure', { error: error instanceof Error ? error.message : String(error) }); flush(); console.error(error)
  try { await server?.stop() } finally { metrics?.dispose(); for (const window of windows.values()) if (!window.isDestroyed()) window.destroy(); app.exit(1) }
}
void run().catch(fail)
