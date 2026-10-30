import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { app, BrowserWindow, ipcMain } from 'electron'
import { mintObjectId } from '@agentmux/core/object-id'
import { WorkbenchDocumentSources } from '../../../src/main/workbench-document-sources'
import { assertAppDocumentSender } from '../../../src/main/ipc-sender-trust'
import { registerThemeBootstrap } from '../../../src/main/theme-bootstrap'
import { windowSecurityWebPreferences } from '../../../src/main/window-security'
import { topFrameOrigin } from '../../../src/main/top-frame-navigation'
import { capsuleDocumentIpc } from '../../../src/main/capsule-document-ipc'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { nameChangeRequests, desktopNameContext } from '../../../src/main/name-change-audit'
import { sessionInputOperationResult } from '../../../src/shared/session-input-result'

declare const __REGISTRARS__: string
declare const __LOADER__: string
declare const __CAPSULE_REGISTRATION__: string
declare const __WORKBENCH_CALL__: string
const [directory, report, scope = 'all'] = process.argv.slice(2) as [string, string, string?]
for (const name of ['home', 'appData', 'userData', 'sessionData']) {
  const path = join(directory, name); await mkdir(path, { recursive: true }); app.setPath(name as 'home', path)
}
app.setActivationPolicy('accessory')
app.on('window-all-closed', () => {}) // This private proof owns its exact final exit after cleanup.
const receipt: any = { passed: false, inputs: [], calls: [], phases: [], userRuntimeOperations: 0 }
let window: BrowserWindow | undefined, foreign: BrowserWindow | undefined, browsers: BrowserViewManager | undefined
let server: ReturnType<typeof createServer> | undefined, disposeCapsuleDocument: (() => void) | undefined
const channels: string[] = []
const waitFor = async (read: () => boolean, label: string) => {
  const deadline = Date.now() + 5000
  while (!read()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 10)) }
}
app.whenReady().then(async () => {
try {
  console.log('ipc-native: ready')
  window = new BrowserWindow({ show: false, webPreferences: {
    ...windowSecurityWebPreferences(join(import.meta.dirname, '../preload/index.cjs')), backgroundThrottling: false
  } })
  registerThemeBootstrap(ipcMain, window, () => ({ terminalTheme: 'graphite' }), () => true)
  const contents = window.webContents, appDocuments = new WorkbenchDocumentSources()
  contents.on('did-navigate', (_event, url) => appDocuments.committed(url))
  const args = { window, appDocumentSources: () => appDocuments.read() }
  const registrations = new Function('ipcMain', 'channels', 'assertAppDocumentSender', 'args', 'contents',
    'nameChangeRequests', 'desktopNameContext', 'mintObjectId', __REGISTRARS__)(ipcMain, channels,
    assertAppDocumentSender, args, contents, nameChangeRequests, desktopNameContext, mintObjectId)
  const { handle, handleWithEvent } = registrations
  handle('config:get', () => {
    receipt.calls.push({ url: contents.mainFrame.url, sources: appDocuments.read() })
    return { original: 'private-config' }
  })
  const loader = new Function('window', 'appDocuments', 'mintObjectId', 'topFrameOrigin', 'setTimeout', 'clearTimeout',
    `let appOrigin; let updateReady = null; const probeQuery = undefined;
    const load = ${__LOADER__}; return { load, ready(token) { if(updateReady?.token === token) updateReady.resolve() } }`)(
    window, appDocuments, mintObjectId, topFrameOrigin,
    (callback: () => void, ms: number) => setTimeout(callback, ms === 20000 ? 80 : ms), clearTimeout)
  handleWithEvent('ui:rendererUpdateReady', (_event: unknown, token: string) => loader.ready(token))
  receipt.portal = []
  const callUserRpc = async (method: string, input: unknown) => {
    receipt.portal.push({ method, input, rootUrl: contents.mainFrame.url })
    return { windows: [], recordedOperation: { state: 'confirmed' } }
  }
  handleWithEvent('ui:workbenchWindowsCall', new Function('callUserRpc', 'return ' + __WORKBENCH_CALL__)(callUserRpc))
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: undefined! } } }))
  receipt.documentInvocations = []
  handleWithEvent('ui:recordStartupFailure', (event: any, input: any) => {
    receipt.documentInvocations.push({ declaredInitiator: input.error.message, receivedFrameUrl: event.senderFrame.url, sources: appDocuments.read() })
    return true
  })
  const a = join(directory, 'renderer-a.html'), b = join(directory, 'renderer-b.html')
  await writeFile(a, `<!doctype html><title>A</title><script>
    globalThis.privateProofDocument='A';
    const record=phase=>window.agentmux.ui.recordStartupFailure({attemptId:'private-document-observation',event:'renderer-import-error',error:{name:'Observation',message:'A:'+phase}}).catch(()=>{});
    setInterval(()=>window.agentmux.config.get().catch(()=>{}),10);
    addEventListener('beforeunload',()=>{record('beforeunload');queueMicrotask(()=>record('queued-before-unload'))});
    </script>`)
  await writeFile(b, '<!doctype html><title>B</title><script>globalThis.privateProofDocument="B"</script>')
  const load = (file: string) => loader.load(file).then(() => null, (error: Error) => error.message)
  // These pages intentionally never send ready. The original Native navigation remains
  // independently authoritative when the expedited test-only readiness budget expires.
  console.log('ipc-native: load A')
  await load(a)
  console.log('ipc-native: A navigation settled')
  assert.equal((await contents.executeJavaScript('window.agentmux.config.get()')).original, 'private-config')
  if (scope !== 'capsule') {
  const servingA = contents.mainFrame
  let releaseRequest: ((value: object) => void) | undefined
  contents.session.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    if (new URL(details.url).pathname === b) releaseRequest = callback
    else callback({})
  })
  console.log('ipc-native: hold B')
  const before = receipt.calls.length, attempt = load(b)
  await waitFor(() => Boolean(releaseRequest), 'B original navigation held before commit')
  await attempt // Ready failed, but the Native load is still pending.
  assert.equal(appDocuments.read().loading?.mode, 'prod', 'Readiness cannot revoke an in-flight original source')
  await waitFor(() => receipt.calls.slice(before).some((call: any) => new URL(call.url).pathname === a), 'A remains callable before B commits')
  releaseRequest!({}); releaseRequest = undefined
  await waitFor(() => { const current = appDocuments.read().current; return current?.mode === 'prod' && current.filePath === b },
    'Late B commit confirms the originally authorized source')
  assert.equal((await contents.executeJavaScript('window.agentmux.config.get()')).original, 'private-config')
  assert.equal(await contents.executeJavaScript('globalThis.privateProofDocument'), 'B', 'The original A execution context was replaced by document B')
  await waitFor(() => receipt.documentInvocations.some((call: any) => call.declaredInitiator === 'A:beforeunload'),
    'The actual A document initiated its original queued IPC before destruction')
  receipt.nativeFrameReuse = { sameReference: servingA === contents.mainFrame, observedCurrentUrl: contents.mainFrame.url,
    boundary: 'WebFrameMain is a mutable native frame reference, not a document generation snapshot. Precommit-authorized in-flight operations are retained; domain owners retain their own target/generation checks.' }

  contents.session.webRequest.onBeforeRequest(null)
  console.log('ipc-native: load A')
  await load(a)
  console.log('ipc-native: A navigation settled')
  assert.equal((await contents.executeJavaScript('window.agentmux.config.get()')).original, 'private-config')
  console.log('ipc-native: loader scenarios passed')
  receipt.phases.push('old-document-before-commit', 'ready-failure-before-native-settlement', 'late-authorized-commit', 'rollback')
  }
  if (scope !== 'loader') {
  if (scope === 'all') {
  foreign = new BrowserWindow({ show: false, webPreferences: windowSecurityWebPreferences(join(import.meta.dirname, '../preload/index.cjs')) })
  await foreign.loadFile(a)
  const denied = await foreign.webContents.executeJavaScript('window.agentmux.config.get().then(()=>false,()=>true)')
  assert.equal(denied, true, 'Another native App-preload contents has no root authority')
  foreign.destroy()
  receipt.phases.push('foreign-contents-denied')
  await contents.executeJavaScript(await readFile(join(import.meta.dirname, '../renderer/portal.js'), 'utf8'))
  assert.equal(await contents.executeJavaScript('window.installOriginalPortal()'), true)
  await waitFor(() => receipt.portal.length === 1, 'Original Workbench toolbar event crosses its root preload from the native child portal')
  assert.equal(receipt.portal[0].method, 'app.window.return')
  assert.equal(receipt.portal[0].input.windowId, 'private-workbench-window')
  assert.equal(receipt.portal[0].input.documentGeneration, 'original-child-document')
  assert.equal(new URL(receipt.portal[0].rootUrl).pathname, a)
  receipt.phases.push('original-workbench-toolbar-portal')
  }
  server = createServer((_request, response) => {
    response.setHeader('x-agentmux-capsule-instance', instanceId)
    response.end('<!doctype html><title>Original Capsule</title>')
  })
  const instanceId = mintObjectId()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const record = { capsuleId: mintObjectId(), port, mode: 'injected', theme: 'follow', target: { hostId: 'local', agentSessionId: 'private-agent' } }
  const inspection: any = { record, endpoint: { status: 'available', instanceId, url: `http://127.0.0.1:${port}/` } }
  browsers = new BrowserViewManager(window, { defaultProfileId: () => 'private', resolvePartition: () => 'persist:private' } as never,
    new BrowserRefLedgerStore(join(directory, 'refs')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal() {} })
  const capsuleDocuments = capsuleDocumentIpc({ browsers, capsules: { call: async (method: string) => {
    if (method === 'capsule.inspect') return inspection
    if (method === 'capsule.interaction.inspect') return { interaction: { interactionId: 'original-interaction', draft: 'Original draft' } }
    throw new Error('Unexpected private Capsule call: ' + method)
  } } as never, theme: () => ({ mode: 'dark', tokens: { '--surface-0': '#101010' } }) })
  disposeCapsuleDocument = new Function('capsuleDocuments', 'ipcMain', 'handleWithEvent', 'sessionInputOperationResult',
    __CAPSULE_REGISTRATION__ + '; return disposeCapsuleDocument')(capsuleDocuments, ipcMain, handleWithEvent, sessionInputOperationResult)
  await browsers.create('private-capsule', inspection.endpoint.url, 'private-workspace', undefined, 'normal', 'responsive', { capsule: inspection })
  await waitFor(() => Boolean(browsers!.capsuleDocumentContents('private-capsule')), 'Original BVM admits its exact Native Capsule response')
  const page = browsers.capsuleDocumentContents('private-capsule')!
  const sdk = await page.executeJavaScript(`Promise.all([window.capsule.capabilities(),window.capsule.read('original-interaction')]).then(value=>({ok:true,value}),error=>({ok:false,error:error.message}))`)
  assert.equal(sdk.ok, true, 'Accurate original Capsule SDK remains callable under its independent registration')
  assert.equal(sdk.value[0].humanReply, false); assert.equal(sdk.value[1].draft, 'Original draft')
  assert.equal(await page.executeJavaScript('typeof window.agentmux'), 'undefined')
  receipt.phases.push('original-bvm-capsule-sdk')
  }
  receipt.passed = true
} catch (error) { receipt.error = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack }; process.exitCode = 1 }
finally {
  const errors: string[] = []
  for (const dispose of [() => disposeCapsuleDocument?.(), () => browsers?.dispose(),
    () => { if (foreign && !foreign.isDestroyed()) foreign.destroy() },
    () => { if (window && !window.isDestroyed()) window.destroy() },
    () => { for (const channel of channels) ipcMain.removeHandler(channel) },
    () => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())]) {
    try { await dispose() } catch (error) { errors.push(String(error)) }
  }
  receipt.cleanup = errors; if (errors.length) { receipt.passed = false; process.exitCode = 1 }
  await writeFile(report, JSON.stringify(receipt, null, 2) + '\n')
  app.exit(Number(process.exitCode ?? 0))
}

}).catch(error => { process.stderr.write(String(error)); app.exit(1) })
