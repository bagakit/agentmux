import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { registerSpaceMountIpc } from '../../../src/main/space-mount-ipc'
import { assertAppDocumentSender } from '../../../src/main/ipc-sender-trust'
import type { SpaceMountMemberEvent } from '../../../src/shared/space-mount'

const [directory, evidence] = process.argv.slice(2) as [string, string]
app.setPath('userData', join(directory, 'user-data')); app.disableHardwareAcceleration()
const events: string[] = [], errors: string[] = [], checks: string[] = [], live = new Set<string>()
const emitters = new Map<string, (event: SpaceMountMemberEvent) => void>()
const watchers = new Map<string, { surfaceId: string; emit(event: SpaceMountMemberEvent): void; dispose(): void }>()
const heldReads = new Map<number, () => void>()
const memberOpenTokens = new Set<string>()
const memberCalls: Array<{ token: string; memberToken: string; method: string }> = []
const cancellations: Array<{ token: string; call: { token: string; memberToken: string; method: string } | null }> = []
let window: BrowserWindow | undefined, dispose = () => {}, serial = 0, watchSerial = 0, readSerial = 0, holdRead = false
let lateSuccess: { armed: boolean; produced(): void; gate: Promise<void> } | undefined
let releaseLateSuccess = () => {}
const result = { id: 'original-member-projection', control: { agentSessionId: 'original-session', run: { runId: 'original-run' } } }
const conversationPage = { agentSessionId: 'original-session', window: { id: 'original-window', view: 'original-view' }, items: [{ id: 'original-conversation-item' }] }
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await check()) { assert.ok(Date.now() < deadline, 'Exact bridge observation did not arrive'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
function publish(readerId: string, marker: string) {
  const watcher = watchers.get(readerId)
  assert.ok(watcher, 'The requested original conversation watcher remains open')
  watcher.emit({ type: 'conversation', readerId, observation: { kind: 'invalidated', marker } as never })
}
async function run() {
  await app.whenReady(); app.dock?.hide()
  const html = join(directory, 'index.html')
  await writeFile(html, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"><title>Private original member bridge</title><script src="./renderer.js"></script>')
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  const preferences = (window.webContents as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  window.webContents.on('preload-error', (_event, _path, error) => errors.push(String(error)))
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  ipcMain.on('ui:themeBootstrap', event => { event.returnValue = { status: 'unavailable', message: 'Isolated bridge proof' } })
  // The original Runtime leaf is controlled. Production Main, token custody,
  // Preload, isolated worlds and the Renderer adapter execute unchanged.
  const runtime = { openMountedSpaceMember: async (_input: unknown, _config: unknown, emit: (event: SpaceMountMemberEvent) => void, signal: AbortSignal) => {
    const id = 'view-' + ++serial; live.add(id); emitters.set(id, emit)
    const close = () => {
      if (!live.delete(id)) return
      events.push('disposed:' + id)
      for (const [readerId, watcher] of watchers) if (watcher.surfaceId === id) watcher.dispose()
    }
    signal.addEventListener('abort', close, { once: true })
    return { initial: { id, hostId: 'original-owner' }, start() {}, dispose: close,
      call: async (method: string, _input: unknown, callSignal: AbortSignal) => {
        events.push('call:' + method + ':' + id)
        if (method === 'read') {
          const request = ++readSerial; events.push('read:' + id + ':' + request)
          if (holdRead) await new Promise<void>(resolve => {
            let settled = false
            const finish = (kind: string) => {
              if (settled) return
              settled = true; heldReads.delete(request); events.push(kind + ':' + id + ':' + request); resolve()
            }
            heldReads.set(request, () => finish('released-read'))
            callSignal.addEventListener('abort', () => finish('cancelled-read'), { once: true })
            if (callSignal.aborted) finish('cancelled-read')
          })
          callSignal.throwIfAborted(); return result
        }
        if (method === 'conversationRead') { callSignal.throwIfAborted(); return conversationPage }
        if (method === 'conversationWatch') {
          callSignal.throwIfAborted()
          const readerId = 'reader-' + ++watchSerial
          const watcher = { surfaceId: id, emit: (event: SpaceMountMemberEvent) => emit(event), dispose: () => {
            if (watchers.delete(readerId)) events.push('watch-disposed:' + readerId)
          } }
          watchers.set(readerId, watcher)
          return { readerId, hostId: 'original-owner', agentSessionId: 'original-session', sourceHostId: 'original-owner', scope: 'original-scope', coverage: 'original-coverage' }
        }
        if (method === 'conversationUnwatch') {
          const readerId = (_input as { readerId: string }).readerId; watchers.get(readerId)?.dispose(); return
        }
        throw new Error('Unexpected original member method: ' + method)
      } }
  } }
  const registration = registerSpaceMountIpc({ runtime: runtime as never, config: () => ({} as never), handle: (channel, handler) => {
    ipcMain.handle(channel, async (event, ...values) => {
      assertAppDocumentSender(event, window!.webContents, { current: { mode: 'prod', filePath: html }, loading: null })
      if (channel === 'spaceMounts:member') memberOpenTokens.add(values[0] as string)
      if (channel === 'spaceMounts:memberCall') memberCalls.push({ token: values[0] as string, memberToken: values[1] as string, method: values[2] as string })
      if (channel === 'spaceMounts:cancel') {
        const token = values[0] as string
        cancellations.push({ token, call: memberCalls.find(call => call.token === token) ?? null })
      }
      const delayed = channel === 'spaceMounts:memberCall' && lateSuccess?.armed ? lateSuccess : undefined
      if (delayed) delayed.armed = false
      const reply = await handler(event, ...values as never)
      if (delayed) {
        assert.deepEqual(reply, { ok: true, value: result }, 'The delayed Main reply is a real successful member result')
        events.push('late-success-produced'); delayed.produced(); await delayed.gate; events.push('late-success-released')
      }
      return reply
    })
  } })
  dispose = registration.dispose
  await window.loadFile(html)
  const read = (code: string) => window!.webContents.executeJavaScript(code)
  await read(`(async()=>{window.port = window.memberBridge.createRendererSpaceMount(window.agentmux.spaceMounts);
    window.target = {hostId:'original-source',target:{reference:{runtimeId:'original-runtime',spaceId:'original-space'},
      regionId:'original-region',runtimeId:'original-execution',agentSessionId:'original-session',expectedRun:{runId:'original-run'}}};
    window.primaryEvents=[]; window.siblingEvents=[];
    window.openAbort=new AbortController(); window.surface=await window.port.member(window.target,event=>window.primaryEvents.push(event),window.openAbort.signal);
    window.sibling=await window.port.member(window.target,event=>window.siblingEvents.push(event)); return true})()`)
  const first = await read(`(async()=>{try{return {ok:true,value:await window.surface.call('read',{},new AbortController().signal)}}catch(error){return{ok:false,message:error.message}}})()`)
  assert.equal(first.ok, true, 'Original member read must cross the real isolated bridge: ' + first.message)
  assert.deepEqual(first.value, result); checks.push('read')

  assert.deepEqual(await read(`window.surface.call('conversationRead',{input:{limit:3,processDetails:'deferred'}},new AbortController().signal)`), conversationPage)
  checks.push('conversation-read')
  const opened = await read(`(async()=>{window.primaryWatch=await window.surface.call('conversationWatch',{view:'original-view'},new AbortController().signal);
    window.siblingWatch=await window.sibling.call('conversationWatch',{view:'original-view'},new AbortController().signal);
    return {primary:window.primaryWatch,sibling:window.siblingWatch}})()`)
  assert.notEqual(opened.primary.readerId, opened.sibling.readerId); assert.equal(watchers.size, 2)
  publish(opened.primary.readerId, 'watch-open'); publish(opened.sibling.readerId, 'watch-open')
  await until(() => read(`window.primaryEvents.some(event=>event.type==='conversation'&&event.observation.marker==='watch-open')`))
  await until(() => read(`window.siblingEvents.some(event=>event.type==='conversation'&&event.observation.marker==='watch-open')`))
  checks.push('conversation-watch')

  const beforePreCancelled = memberCalls.length
  const preCancelled = await read(`(async()=>{const c=new AbortController();c.abort();try{await window.surface.call('read',{},c.signal);return false}catch{return true}})()`)
  assert.equal(preCancelled, true); assert.equal(memberCalls.length, beforePreCancelled, 'Pre-cancelled read must not reach Main or the original Runtime')
  checks.push('pre-cancel')

  holdRead = true
  const callStart = memberCalls.length, readStart = readSerial
  await read(`window.firstCallAbort=new AbortController();window.secondCallAbort=new AbortController();
    window.firstCallState={settled:false};window.secondCallState={settled:false};
    window.firstPending=window.surface.call('read',{},window.firstCallAbort.signal).then(value=>window.firstCallState={settled:true,rejected:false,value},error=>window.firstCallState={settled:true,rejected:true,message:error.message});
    window.secondPending=window.surface.call('read',{},window.secondCallAbort.signal).then(value=>window.secondCallState={settled:true,rejected:false,value},error=>window.secondCallState={settled:true,rejected:true,message:error.message});true`)
  await until(() => readSerial === readStart + 2)
  const concurrent = memberCalls.slice(callStart); assert.equal(concurrent.length, 2); assert.notEqual(concurrent[0]!.token, concurrent[1]!.token)
  await read('window.firstCallAbort.abort();true')
  await until(() => events.some(event => event.startsWith('cancelled-read:view-1:')))
  assert.equal((await read('window.firstPending')).rejected, true)
  assert.equal((await read('window.secondCallState')).settled, false, 'Cancelling one per-call token must not settle its concurrent sibling call')
  await until(() => cancellations.some(value => value.token === concurrent[0]!.token))
  assert.equal(cancellations.some(value => value.token === concurrent[1]!.token), false)
  assert.equal(memberOpenTokens.has(concurrent[0]!.token), false, 'A per-call cancellation must never target the member opening token')
  for (const release of [...heldReads.values()]) release(); holdRead = false
  assert.deepEqual((await read('window.secondPending')).value, result)
  assert.deepEqual(await read('window.surface.call("read",{},new AbortController().signal)'), result)
  assert.deepEqual(await read('window.sibling.call("read",{},new AbortController().signal)'), result)
  assert.deepEqual([...live], ['view-1', 'view-2'], 'Per-call cancellation must preserve both original member views')
  publish(opened.primary.readerId, 'after-call-cancel'); publish(opened.sibling.readerId, 'after-call-cancel')
  await until(() => read(`window.primaryEvents.some(event=>event.type==='conversation'&&event.observation.marker==='after-call-cancel')`))
  await until(() => read(`window.siblingEvents.some(event=>event.type==='conversation'&&event.observation.marker==='after-call-cancel')`))
  checks.push('independent-call-cancel')

  let produced!: () => void
  const producedLateSuccess = new Promise<void>(resolve => { produced = resolve })
  let gate!: () => void
  lateSuccess = { armed: true, produced, gate: new Promise<void>(resolve => { gate = resolve }) }; releaseLateSuccess = gate
  await read(`window.lateAbort=new AbortController();window.lateAdopted=false;
    window.latePending=window.surface.call('read',{},window.lateAbort.signal).then(value=>{window.lateAdopted=true;return{rejected:false,value}},error=>({rejected:true,message:error.message}));true`)
  await producedLateSuccess
  await read('window.lateAbort.abort();true'); releaseLateSuccess()
  const late = await read('window.latePending')
  assert.equal(late.rejected, true, 'Renderer must reject a successful reply delivered after caller cancellation')
  assert.equal(await read('window.lateAdopted'), false, 'The late successful value must never be adopted')
  assert.deepEqual([...live], ['view-1', 'view-2'])
  publish(opened.primary.readerId, 'after-late-success')
  await until(() => read(`window.primaryEvents.some(event=>event.type==='conversation'&&event.observation.marker==='after-late-success')`))
  checks.push('late-success-not-adopted')

  const primaryObservationCount = await read('window.primaryEvents.length')
  await read('window.openAbort.abort();true')
  await until(() => live.size === 1 && watchers.size === 1)
  assert.deepEqual([...live], ['view-2']); assert.equal(watchers.has(opened.sibling.readerId), true)
  emitters.get('view-1')!({ type: 'session', session: { ...result, id: 'late-opening-observation' } as never })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await read('window.primaryEvents.length'), primaryObservationCount, 'A late observation from a disposed opening must not publish')
  assert.deepEqual(await read('window.sibling.call("read",{},new AbortController().signal)'), result)
  publish(opened.sibling.readerId, 'after-opening-dispose')
  await until(() => read(`window.siblingEvents.some(event=>event.type==='conversation'&&event.observation.marker==='after-opening-dispose')`))
  checks.push('opening-dispose-preserves-sibling')

  await read('window.sibling.dispose();true'); await until(() => live.size === 0 && watchers.size === 0)
  assert.equal(new Set(memberCalls.map(call => call.token)).size, memberCalls.length, 'Every member call must have an independent request token')
  assert.equal(memberCalls.some(call => memberOpenTokens.has(call.token)), false, 'Member opening tokens and call tokens must remain distinct')
  assert.deepEqual(errors, []); checks.push('sibling-dispose')
  await writeFile(join(evidence, 'bridge.json'), JSON.stringify({ passed: checks.length, checks, events, errors, memberCalls, cancellations, preferences: {
    contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration
  } }, null, 2))
}
run().then(() => { dispose(); window?.destroy(); app.quit() }).catch(async error => {
  await writeFile(join(evidence, 'bridge-failure.json'), JSON.stringify({ passed: checks.length, checks, events, errors, message: error.message, stack: error.stack }, null, 2))
  console.error(error); dispose(); window?.destroy(); app.exit(1)
})
