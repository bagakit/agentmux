import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { registerSpaceMountIpc } from '../../../src/main/space-mount-ipc'
import { assertAppDocumentSender } from '../../../src/main/ipc-sender-trust'

const [directory, evidence] = process.argv.slice(2) as [string, string]
app.setPath('userData', join(directory, 'user-data')); app.disableHardwareAcceleration()
const events: string[] = [], errors: string[] = [], live = new Set<string>()
let window: BrowserWindow | undefined, dispose = () => {}, serial = 0, hold = false, passed = 0
const result = { id: 'original-member-projection', control: { agentSessionId: 'original-session', run: { runId: 'original-run' } } }
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, 'Exact bridge observation did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function run() {
  await app.whenReady(); app.dock?.hide()
  const html = join(directory, 'index.html')
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>Private original member bridge</title><script src="./renderer.js"></script>')
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(String(error)))
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  ipcMain.on('ui:themeBootstrap', event => { event.returnValue = { status: 'unavailable', message: 'Isolated bridge proof' } })
  // Controlled original Runtime leaf. Production Main, token custody, Preload,
  // isolated worlds and Renderer adapter are loaded unchanged from this tree.
  const runtime = { openMountedSpaceMember: async (_input: unknown, _config: unknown, _emit: unknown, signal: AbortSignal) => {
    const id = 'view-' + ++serial; live.add(id)
    const close = () => { if (live.delete(id)) events.push('disposed:' + id) }
    signal.addEventListener('abort', close, { once: true })
    return { initial: { id, hostId: 'original-owner' }, start() {}, dispose: close,
      call: async (_method: string, _input: unknown, callSignal: AbortSignal) => {
        events.push('read:' + id)
        if (hold) await new Promise<void>(resolve => {
          if (callSignal.aborted) resolve()
          else callSignal.addEventListener('abort', () => { events.push('cancelled:' + id); resolve() }, { once: true })
        })
        callSignal.throwIfAborted(); return result
      } }
  } }
  const registration = registerSpaceMountIpc({ runtime: runtime as never, config: () => ({} as never), handle: (channel, handler) => {
    ipcMain.handle(channel, (event, ...values) => {
      assertAppDocumentSender(event, window!.webContents, { current: { mode: 'prod', filePath: html }, loading: null })
      return handler(event, ...values as never)
    })
  } })
  dispose = registration.dispose
  await window.loadFile(html)
  const read = (code: string) => window!.webContents.executeJavaScript(code)
  await read(`(async()=>{window.port = window.memberBridge.createRendererSpaceMount(window.agentmux.spaceMounts);
    window.target = {hostId:'original-source',target:{reference:{runtimeId:'original-runtime',spaceId:'original-space'},
      regionId:'original-region',runtimeId:'original-execution',agentSessionId:'original-session',expectedRun:{runId:'original-run'}}};
    window.openAbort=new AbortController(); window.surface=await window.port.member(window.target,()=>{},window.openAbort.signal);
    window.sibling=await window.port.member(window.target,()=>{}); return true})()`)
  const first = await read(`(async()=>{try{return {ok:true,value:await window.surface.call('read',{},new AbortController().signal)}}catch(error){return{ok:false,message:error.message}}})()`)
  assert.equal(first.ok, true, 'Original member read must cross the real isolated bridge: ' + first.message)
  assert.deepEqual(first.value, result); passed++
  const before = events.filter(event => event.startsWith('read:')).length
  const preCancelled = await read(`(async()=>{const c=new AbortController();c.abort();try{await window.surface.call('read',{},c.signal);return false}catch{return true}})()`)
  assert.equal(preCancelled, true)
  assert.equal(events.filter(event => event.startsWith('read:')).length, before, 'Pre-cancelled read must not reach the original Runtime'); passed++
  hold = true
  await read(`window.callAbort=new AbortController();window.pendingRead=window.surface.call('read',{},window.callAbort.signal).then(()=>({rejected:false}),error=>({rejected:true,message:error.message}));true`)
  await until(() => events.filter(event => event.startsWith('read:')).length > before)
  await read('window.callAbort.abort();true')
  await until(() => events.includes('cancelled:view-1'))
  assert.equal((await read('window.pendingRead')).rejected, true)
  assert.deepEqual([...live], ['view-1', 'view-2'], 'Cancelling a call must preserve both original member views')
  hold = false
  assert.deepEqual(await read('window.sibling.call("read",{},new AbortController().signal)'), result)
  assert.deepEqual(await read('window.surface.call("read",{},new AbortController().signal)'), result); passed++
  await read('window.openAbort.abort();true')
  await until(() => live.size === 1)
  assert.deepEqual([...live], ['view-2'])
  assert.deepEqual(await read('window.sibling.call("read",{},new AbortController().signal)'), result)
  await read('window.sibling.dispose();true')
  await until(() => live.size === 0); passed++
  await writeFile(join(evidence, 'bridge.json'), JSON.stringify({ passed, events, errors, preferences: {
    contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration
  } }, null, 2))
}
run().then(() => { dispose(); window?.destroy(); app.quit() }).catch(async error => {
  await writeFile(join(evidence, 'bridge-failure.json'), JSON.stringify({ passed, events, errors, message: error.message, stack: error.stack }, null, 2))
  console.error(error); dispose(); window?.destroy(); app.exit(1)
})
