import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, type WebContents, type WebContentsView } from 'electron'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserOperationJournal, BrowserOperationFileStore, browserOperationAlreadyExistsError } from '../../../src/main/browser-operation-journal'
import { projectBrowserControlResult } from '../../../src/main/browser-completion-control'
import { browserResourceLocations } from '../../../src/main/browser-resource-directory'
import { coldBrowserTargets } from '../../../src/main/browser-cold-descriptor'
import { browserRunResult, unwrapBrowserRunResult } from '../../../src/shared/browser-run-result'
import { senderTrust, assertSenderTrusted } from '../../../src/main/ipc-sender-trust'

const home = process.env.AGENTMUX_CHILD_HOME!, out = process.env.AGENTMUX_CHILD_OUT!, assets = process.env.AGENTMUX_CHILD_ASSETS!
assert.ok(home && out && assets, 'This fixture needs its own explicit private namespace')
const workspaceId = 'child-proof-workspace'
const receipt: any = { schema: 'agentmux.unified-browser-children.native.v1', passed: false, pid: process.pid,
  cases: [], requests: [], calls: [], publicCalls: [], cli: [], events: [], cleanup: [], originalCallbacks: [], constructionFailures: [],
  clipboardWrites: 0, runtimeConnections: 0,
  boundary: 'Actual isolated BVM/native child and its original Chromium request. Real public RPC server/client and freshly compiled CLI consume original Store branches, original preload mappings over actual Electron IPC, and original Main handler registrations. Native programmatic input is not physical OS input. This owner proof does not certify full BrowserPane composition or installed user App.' }
process.on('uncaughtException', error => { (receipt.uncaughtExceptions ??= []).push({ name: error.name, message: error.message }); console.error(error) })
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let rootWindow: BrowserWindow | undefined, manager: BrowserViewManager | undefined, server: Server | undefined, control: AgentMuxControlServer | undefined
let origin = ''
const nativePages = new Map<number, WebContents>(), browserIds = new WeakMap<WebContents, string>(), nativeNavigations = new Map<number, Array<{url:string}>>()
const closePrompts: Array<{ window: BrowserWindow; resolve(value: boolean): void }> = []
async function checkpoint(step: string) {
  receipt.step = step
  await writeFile(join(out, 'native.json'), JSON.stringify(receipt, null, 2) + '\n')
}
async function until<T>(name: string, read: () => Promise<T | false> | T | false, budget = 4000): Promise<T> {
  const end = performance.now() + budget
  while (performance.now() < end) { const value = await read(); if (value) return value; await delay(15) }
  throw new Error('Popup prerequisite was not observed: ' + name)
}
function showPage(id: string): void {
  const targets = manager!.targets(), sourceId = targets.find(target => target.id === id)?.openedFrom?.browserId
  // Preserve the original source host while observing its child.
  for (const target of targets) manager!.setBounds(target.id, target.id === id
    ? { x: sourceId ? 440 : 0, y: 0, width: sourceId ? 440 : 880, height: 620 }
    : target.id === sourceId ? { x: 0, y: 0, width: 440, height: 620 } : null)
}
async function openedAction(action: () => Promise<unknown>, name: string) {
  const before = receipt.originalCallbacks.length
  const failures = receipt.constructionFailures.length
  await action()
  await until(name + ' original native callback', () => {
    assert.equal(receipt.constructionFailures.length, failures, 'Actual native child construction succeeds without the undefined-WebContents exception')
    return receipt.originalCallbacks.length > before
  })
  const callback = receipt.originalCallbacks[before], page = nativePages.get(callback.pageId)!
  assert.ok(page && !page.isDestroyed(), 'The original native child WebContents is retained: ' + name)
  assert.equal(callback.catalogAdded.length, 1, 'Every native child joins the actual Browser target catalog exactly once: ' + name)
  assert.ok(callback.browserId, 'Every native child joins the actual Browser target catalog: ' + name)
  assert.equal(callback.exactGuest, callback.guestId === null ? null : true, 'The actual BVM callback returns Electron exact original child WebContents')
  const target = manager!.targets().find(target => target.id === callback.browserId)
  assert.ok(target, 'Every native child joins the actual Browser target catalog: ' + name)
  assert.equal(target.source, 'embedded'); assert.equal(target.status, 'ready')
  showPage(target.id)
  assert.equal(manager!.nativeOwner(target.id)?.view.webContents, page, 'The Browser identity addresses the exact original native child')
  return { id: target.id, page }
}
async function opened(parent: WebContents, code: string, name: string) {
  showPage(browserIds.get(parent)!)
  return openedAction(() => parent.executeJavaScript(code, true), name)
}
async function nativeLink(parent: WebContents, path: string, name: string, button: 'left' | 'middle' = 'left', modified = true, frame?: Electron.WebFrameMain) {
  const parentId = browserIds.get(parent)!
  assert.ok(parentId, 'The actual native input has an exact Browser identity')
  showPage(parentId)
  const target = origin + path, owner = frame ?? parent.mainFrame
  const beforeURL = parent.getURL(), beforeDraft = await parent.executeJavaScript('document.querySelector("#original-draft")?.value ?? null')
  const callbacksBefore = receipt.originalCallbacks?.length ?? 0, eventsBefore = receipt.nativeWindowOpens?.length ?? 0
  const point = await owner.executeJavaScript(`(()=>{const input=[];window.__nativeInputEvents=input;for(const type of ['mousedown','mouseup','click','auxclick'])document.addEventListener(type,e=>input.push({type,target:e.target.id,button:e.button,meta:e.metaKey,control:e.ctrlKey,x:e.clientX,y:e.clientY}),{once:true,capture:true});const a=document.createElement('a');a.id='native-link';a.href=${JSON.stringify(target)};a.textContent='Open original native child';a.style.cssText='display:block;padding:16px';document.body.append(a);a.scrollIntoView();const r=a.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const framePoint = { ...point }
  if (frame) {
    const offset = await parent.executeJavaScript('(()=>{const r=document.querySelector("#sandbox-frame").getBoundingClientRect();return{x:r.x+2,y:r.y+2}})()')
    point.x += offset.x; point.y += offset.y
  }
  const zoom = parent.getZoomFactor()
  const cssPoint = { ...point }
  point.x = Math.round(point.x * zoom); point.y = Math.round(point.y * zoom)
  rootWindow!.show(); app.focus({ steal: true }); rootWindow!.focus(); parent.focus()
  const modifiers = modified ? [process.platform === 'darwin' ? 'meta' : 'control'] : []
  await delay(50)
  const child = await openedAction(async () => {
    if (frame) {
      const attached = parent.debugger.isAttached()
      if (!attached) parent.debugger.attach('1.3')
      const frameSessions = new Map<string, {sessionId:string; targetId:string}>()
      const attachedTarget = (_event: unknown, method: string, params: any) => {
        if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') frameSessions.set(params.targetInfo.targetId, { sessionId: params.sessionId, targetId: params.targetInfo.targetId })
      }
      parent.debugger.on('message', attachedTarget)
      try {
        const doc = await parent.debugger.sendCommand('DOM.getDocument', { depth: 0 })
        const host = await parent.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#sandbox-frame' })
        const described = await parent.debugger.sendCommand('DOM.describeNode', { nodeId: host.nodeId })
        await parent.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        const frameSession = await until('the exact iframe owner CDP session', async () => {
          for (const target of frameSessions.values()) {
            const owner = await parent.debugger.sendCommand('DOM.getFrameOwner', { frameId: target.targetId }).catch(() => null)
            if (owner?.backendNodeId === described.node.backendNodeId) return target.sessionId
          }
          return false
        })
        ;(receipt.frameInputSessions ??= []).push({ frameSession, ownerBackendNodeId: described.node.backendNodeId, framePoint, targets: [...frameSessions.values()] })
        const cdpModifiers = modified ? process.platform === 'darwin' ? 4 : 2 : 0
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...framePoint }, frameSession)
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...framePoint, button, clickCount: 1, modifiers: cdpModifiers }, frameSession)
        await parent.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...framePoint, button, clickCount: 1, modifiers: cdpModifiers }, frameSession)
      } finally {
        await parent.debugger.sendCommand('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {})
        parent.debugger.off('message', attachedTarget)
        if (!attached) parent.debugger.detach()
      }
    } else {
      parent.sendInputEvent({ type: 'mouseMove', ...point })
      parent.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1, modifiers: [...modifiers, button === 'middle' ? 'middleButtonDown' : 'leftButtonDown'] })
      parent.sendInputEvent({ type: 'mouseUp', ...point, button, clickCount: 1, modifiers })
    }
    await delay(100)
    ;(receipt.nativeInputEvents ??= []).push({ name, point, cssPoint, zoom, inputSource: frame ? 'Chromium Input.dispatchMouseEvent for actual OOPIF' : 'Electron WebContents.sendInputEvent',
      sourceProcessId: parent.mainFrame.processId, frameProcessId: owner.processId,
      hit: await parent.executeJavaScript(`document.elementFromPoint(${cssPoint.x},${cssPoint.y})?.id`), input: await owner.executeJavaScript('window.__nativeInputEvents') })
  }, name)
  // Observe the actual native page for a bounded interval, then assert its URL.
  // A dropped continuation is an owning assertion failure, never a timeout prerequisite.
  const deadline = performance.now() + 2500
  while (performance.now() < deadline && (child.page.isLoading() || child.page.getURL() !== target)) await delay(15)
  const callback = receipt.originalCallbacks.slice(callbacksBefore).find((row: any) => row.pageId === child.page.id)
  const events = receipt.nativeWindowOpens.slice(eventsBefore).filter((row: any) => row.sourceId === parent.id && row.url === target)
  ;(receipt.nativeLinkObservations ??= []).push({ name, target, sourceId: parent.id, childId: child.page.id, button, modifiers, callback, events, actualURL: child.page.getURL(), sourceURL: parent.getURL() })
  await checkpoint('native-link-observed-' + name)
  assert.equal(child.page.getURL(), target, 'Actual native continuation navigates the original guestless child URL: ' + name)
  assert.equal(events.length, 1, 'One original native OpenURLFromTab event belongs to the exact source and target: ' + name)
  assert.equal(events[0].hasNavigate, true, 'The native input supplies its original Chromium continuation: ' + name)
  assert.equal(callback.guestId, null, 'This actual native link exercises the guestless creation branch: ' + name)
  assert.equal(callback.navigations.filter((row: any) => row.url === target).length, 1, 'The original guestless child starts its exact target navigation once: ' + name)
  const input = receipt.nativeInputEvents.find((row: any) => row.name === name).input
  assert.ok(input.some((row: any) => row.target === 'native-link' && row.type === 'mousedown' && row.button === (button === 'middle' ? 1 : 0) &&
    (!modified || (process.platform === 'darwin' ? row.meta : row.control))), 'The original page receives the exact native mouse input: ' + name)
  assert.equal(child.page.session, parent.session, 'Guestless native input retains the original source Session: ' + name)
  assert.equal(parent.getURL(), beforeURL, 'Opening a native child preserves the original source URL: ' + name)
  assert.equal(await parent.executeJavaScript('document.querySelector("#original-draft")?.value ?? null'), beforeDraft, 'Opening a native child preserves the unsent source draft: ' + name)
  const prefs = (child.page as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false)
  assert.equal(await child.page.executeJavaScript('typeof window.agentmux'), 'undefined')
  assert.equal(await child.page.executeJavaScript('typeof window.browserPopup'), 'undefined')
  return child
}
async function settlePage(page: WebContents, path: string) {
  await until('exact original native document ' + path, async () => !page.isDestroyed() && !page.isLoading() && new URL(page.getURL()).pathname === path)
}
const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:32px;font:16px system-ui;background:#f4f7f8;color:#24323b}main{max-width:640px}h1{font-size:28px}input,button{font:inherit;padding:8px}p{line-height:1.6}</style><main><h1>${title}</h1>${body}<button id="proof-action" onclick="globalThis.fixtureClicks++">Increment child counter</button></main><script>globalThis.fixtureClicks=0</script>`

function serve() {
  return createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url!, origin || 'http://localhost'), body = Buffer.concat(chunks).toString()
      receipt.requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie ?? '', referrer: request.headers.referer ?? '', body,
        fetchSite: request.headers['sec-fetch-site'] ?? null, fetchMode: request.headers['sec-fetch-mode'] ?? null, fetchDest: request.headers['sec-fetch-dest'] ?? null })
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/opener') {
        const mode = url.searchParams.get('mode') ?? 'normal'
        response.setHeader('set-cookie', [`fixture=${mode}; Path=/; SameSite=Lax`, `strict_fixture=${mode}; Path=/; SameSite=Strict`])
        response.end(html('Original browser page', '<p>Independent windows retain this original page and session.</p><input id="original-draft" value="Original unsent page draft"><script>window.messages=[];addEventListener("message",e=>messages.push({data:e.data,origin:e.origin}));</script>'))
      } else if (url.pathname === '/slow') {
        response.write(html('Loading page', '<p>Waiting for the server response.</p>'))
        // The original response stays unfinished until native Stop or final server cleanup.
      } else {
        const context = /^\/capture-(normal|narrow|short)-(light|dark)$/u.exec(url.pathname)
        const title = context ? `Popup ${context[1]} ${context[2]}` : url.pathname === '/two' ? 'Second page' : url.pathname === '/javascript-disabled' ? 'JavaScript initially disabled' : 'Child browser page'
        response.end(html(title, '<p>A real native child document. Address and navigation above belong to AgentMux.</p><input value="A page remains interactive"><script>window.fixtureReady=true;' + (url.pathname === '/javascript-disabled' ? 'document.title="Unexpected enabled script"' : '') + '</script>'))
      }
    })
  })
}
async function publicConsumers() {
  const consumed = JSON.parse(await readFile(join(assets, 'consumers.json'), 'utf8'))
  const context: Record<string, any> = {
    handleWithEvent: (channel: string, handler: (...args: any[]) => unknown) => ipcMain.handle(channel, (event, ...args) => {
      receipt.calls.push({ channel, senderId: event.sender.id, frame: event.senderFrame?.url })
      return handler(event, ...args)
    }),
    requireTrustedSender: (channel: any, event: any) => assertSenderTrusted(senderTrust(channel, event.sender, rootWindow!.webContents)),
    workspace: (_config: unknown, id: string) => { assert.equal(id, workspaceId) },
    config: { browser: { agentAutomation: true } }, app, browsers: manager,
    externalBridge: { list: () => [], membershipCoverage: 'complete' },
    spatialState: { read: async () => null }, coldBrowserTargets, browserResourceLocations,
    browserRunResult, browserOperationAlreadyExistsError,
    externalBrowsers: { has: () => false },
    ensureBrowser: (id: string) => manager!.ensure(id, async () => { throw new Error('A real child has no invented cold replacement') })
  }
  new Function(...Object.keys(context), consumed.main)(...Object.values(context))
  const invoke = (name: string, args: unknown[]) => rootWindow!.webContents.executeJavaScript(`globalThis.unifiedBrowserProof.${name}(...${JSON.stringify(args)})`)
  const api = { browser: {
    listTargets: (id?: string) => invoke('listTargets', [id]),
    runScript: async (...args: unknown[]) => unwrapBrowserRunResult(await invoke('runScript', args) as any)
  } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const execute = new AsyncFunction('request', 'api', 'requireActive', 'get', 'browserOperatorForSession', consumed.store)
  control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: async request => {
    receipt.publicCalls.push({ operation: request.operation, browserId: 'browserId' in request ? request.browserId : null })
    return projectBrowserControlResult(await execute(request, api, () => {}, () => ({ sessions: [] }), () => { throw new Error('The private proof does not forge an Agent identity') }))
  } })
  await control.start()
  receipt.consumerSources = consumed.sources
}
async function cli(args: string[], code = ''): Promise<any> {
  return await new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    const child = spawn(process.env.AGENTMUX_CHILD_NODE!, [join(assets, 'cli/agentmux.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The private public CLI exceeded its observation budget')) }, 15000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timeout); const row = { args, code, stdout, stderr }; receipt.cli.push(row); resolve(row) })
    child.stdin.end(code)
  })
}
async function provePublicChild(child: { id: string; page: WebContents }, opener: WebContents) {
  showPage(child.id)
  const expected = manager!.target(child.id)!.openedFrom
  assert.ok(expected, 'A child target carries its original Browser source')
  const sourceSnapshot = manager!.setViewport(child.id, 'responsive')
  assert.deepEqual(sourceSnapshot.source, expected, 'The same Browser snapshot and target retain one source relationship')
  const program = `const s=await snapshot();const n=s.nodes.find(n=>n.role==='button'&&n.name==='Increment child counter');if(!n)throw new Error('Original child action missing');await click(n.ref);return await pageInfo()`
  const direct = await manager!.runScript(child.id, program, undefined, undefined, 'child-owner-program')
  assert.equal(direct.outcome.kind, 'completed', JSON.stringify(direct.outcome))
  assert.equal(direct.runOperation.browserId, child.id)
  assert.equal(await child.page.executeJavaScript('globalThis.fixtureClicks'), 1, 'The same Browser owner executes standard ref actions on the original child')
  assert.equal(await opener.executeJavaScript('globalThis.fixtureClicks'), 0, 'Child actions do not drift to the opener')
  receipt.cases.push({ name: 'actual-child-owner-standard-ref-run', browserId: child.id, report: direct })
  await publicConsumers()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(home, 'control.sock') } })
  try {
    const discovered = await rpc.call('browser.targets', { workspaceId })
    const exact = discovered.targets.find(target => target.id === child.id)
    assert.ok(exact, 'Public RPC discovers the original child Browser target')
    assert.deepEqual(exact.openedFrom, expected, 'Public RPC preserves the original child source relationship')
    const result = await rpc.call('browser.run', { browserId: child.id, operationId: 'child-rpc-program', code: program })
    assert.equal(result.runOperation.browserId, child.id)
    assert.equal(await child.page.executeJavaScript('globalThis.fixtureClicks'), 2, 'Public RPC dispatch reaches the exact original child through actual Store/preload/IPC consumers')
    receipt.cases.push({ name: 'actual-public-rpc-child-discovery-and-run', browserId: child.id, target: exact, result })
  } finally { await rpc.dispose() }
  const discovery = await cli(['browser', 'targets', '--workspace', workspaceId])
  assert.equal(discovery.code, 0, discovery.stderr)
  const targets = JSON.parse(discovery.stdout)
  assert.equal(targets.ok, true)
  const exact = targets.result.targets.find((target: any) => target.id === child.id)
  assert.ok(exact, 'Public CLI discovers the original child Browser target')
  assert.deepEqual(exact.openedFrom, expected, 'Public CLI preserves the original child source relationship')
  const run = await cli(['browser', 'run', '--browser', child.id, '--operation-id', 'child-cli-program'], `await js('document.querySelector("#proof-action").click()');return await pageInfo()`)
  assert.equal(run.code, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.ok, true); assert.equal(result.result.runOperation.browserId, child.id)
  assert.equal(await child.page.executeJavaScript('globalThis.fixtureClicks'), 3, 'Public CLI dispatch mutates the exact original child through actual Store/preload/IPC consumers')
  assert.equal(await opener.executeJavaScript('globalThis.fixtureClicks'), 0, 'Public CLI child actions preserve the opener')
  assert.equal(manager!.nativeOwner(child.id)?.view.webContents, child.page, 'Public execution retains the original child native object')
  assert.ok(receipt.calls.some((row: any) => row.channel === 'browser:listTargets'))
  assert.ok(receipt.calls.some((row: any) => row.channel === 'browser:runScript'))
  receipt.cases.push({ name: 'actual-public-cli-child-discovery-source-and-run', browserId: child.id, target: exact, result })
}

async function run() {
  await app.whenReady()
  app.on('window-all-closed', () => {})
  app.on('web-contents-created', (_event, source) => {
    const navigations: Array<{url:string}> = []; nativeNavigations.set(source.id, navigations)
    source.on('did-start-navigation', event => { if (event.isMainFrame) navigations.push({ url: event.url }) })
    ;(source as any).prependListener('-new-window', (_event: Electron.Event, url: string, frameName: string, disposition: string,
      _features: string, referrer: unknown, postData: unknown, sandboxFlags: number, navigate: unknown) => {
      ;(receipt.nativeWindowOpens ??= []).push({ sourceId: source.id, url, frameName, disposition, referrer,
        hasPostData: Boolean(postData), sandboxFlags, hasNavigate: typeof navigate === 'function' })
    })
    const install = source.setWindowOpenHandler.bind(source)
    source.setWindowOpenHandler = handler => install(details => {
      const decision = handler(details)
      if (decision.action !== 'allow' || !decision.createWindow) return decision
      const create = decision.createWindow
      return { ...decision, createWindow: options => {
        const supplied = (options as typeof options & { webContents?: WebContents }).webContents
        const before = new Set(manager?.targets().map(target => target.id) ?? [])
        let actual: WebContents
        try { actual = create(options) }
        catch (error: any) { receipt.constructionFailures.push({ name: error.name, message: error.message, guestId: supplied?.id ?? null }); throw error }
        const added = manager!.targets().filter(target => !before.has(target.id))
        const target = added.length === 1 ? added[0] : undefined
        if (target) browserIds.set(actual, target.id)
        nativePages.set(actual.id, actual)
        const prefs = options.webPreferences ?? {}
        const projection = { ...options, webContents: supplied ? { id: supplied.id } : null, webPreferences: Object.fromEntries(Object.entries(prefs).map(([key,value])=>[key,value === null || ['string','number','boolean','undefined'].includes(typeof value) ? value : '[native object]'])) }
        const callback = { pageId: actual.id, browserId: target?.id ?? null, catalogAdded: added.map(target => target.id), guestId: supplied?.id ?? null, exactGuest: supplied ? actual === supplied : null,
          sameSession: actual.session === source.session, source: target?.openedFrom, options: projection, optionsSha256: hash(JSON.stringify(projection)), navigations: nativeNavigations.get(actual.id) ?? [] }
        receipt.originalCallbacks.push(callback)
        return actual
      } }
    })
  })
  await checkpoint('before-private-root-window')
  rootWindow = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { preload: join(assets, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await checkpoint('private-root-created')
  await rootWindow.loadURL('data:text/html,<title>Private unified Browser owner proof</title>')
  await checkpoint('private-root-document-loaded')
  const send = rootWindow.webContents.send.bind(rootWindow.webContents)
  rootWindow.webContents.send = (channel, ...args) => { if (channel === 'agentmux:browser-event') receipt.events.push(args[0]); send(channel, ...args) }
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(home, 'operations.sqlite')))
  manager = new BrowserViewManager(rootWindow, { defaultProfileId: () => 'child-normal-profile', resolvePartition: () => 'persist:child-normal-profile' }, new BrowserRefLedgerStore(join(home, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('The private proof never opens external applications') } },
    journal, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { confirmLeave: window => new Promise<boolean>(resolve => closePrompts.push({ window, resolve })) })
  server = serve()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as any).port
  const original = await manager.create('popup-original', origin + '/opener?mode=normal', workspaceId)
  showPage(original.id)
  const opener = manager.nativeOwner(original.id)!.view.webContents
  browserIds.set(opener, original.id)
  await settlePage(opener, '/opener')
  await checkpoint('real-bvm-source-ready')
  const modifiedChild = await nativeLink(opener, '/modifier-native', 'command-control-click')
  const middleChild = await nativeLink(opener, '/middle-native', 'middle-click', 'middle', false)
  for (const [name, page] of [['/modifier-native', modifiedChild.page], ['/middle-native', middleChild.page]] as const) {
    const requests = receipt.requests.filter((row: any) => row.path === name)
    assert.equal(requests.length, 1, 'Original native continuation sends its target request exactly once: ' + name)
    assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].referrer, origin + '/opener?mode=normal')
    assert.equal(requests[0].fetchSite, 'same-origin', 'Original initiating frame identity survives the native continuation')
    assert.equal(requests[0].fetchMode, 'navigate'); assert.equal(requests[0].fetchDest, 'document')
    assert.match(requests[0].cookie, /strict_fixture=normal/u, 'SameSite=Strict uses the original native source context')
    showPage(browserIds.get(page)!)
    assert.equal(await page.executeJavaScript('document.referrer'), origin + '/opener?mode=normal')
  }
  receipt.cases.push({ name: 'native-command-and-middle-original-request-session-security', pages: [modifiedChild.page.id, middleChild.page.id] })

  const noopener = await opened(opener, `(()=>{const a=document.createElement('a');a.href=${JSON.stringify(origin + '/noopener')};a.target='_blank';a.rel='noopener';document.body.append(a);a.click();return true})()`, 'native target blank noopener')
  await settlePage(noopener.page, '/noopener')
  assert.equal(await noopener.page.executeJavaScript('window.opener===null'), true, 'Target blank noopener keeps its original detached opener policy')
  assert.equal(noopener.page.session, opener.session)
  receipt.cases.push({ name: 'native-target-blank-noopener' })

  showPage('popup-original')
  await opener.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const sandboxFrame = await opener.executeJavaScript(`(()=>{const f=document.createElement('iframe');f.id='sandbox-frame';f.sandbox='allow-scripts allow-popups';f.style.cssText='position:fixed;left:20px;top:100px;width:650px;height:350px;z-index:99999;background:white';f.src=${JSON.stringify(origin + '/sandbox-source')};document.body.append(f);return true})()`)
  assert.equal(sandboxFrame, true)
  const sourceFrame = await until('the real sandbox source frame loads', () => opener.mainFrame.frames.find(frame => !frame.isDestroyed() && frame.url.startsWith(origin + '/sandbox-source')) || false)
  await until('the real sandbox frame completes its original document', async () => await sourceFrame.executeJavaScript('document.readyState === "complete"'))
  const sandboxChild = await nativeLink(opener, '/sandbox-native', 'sandbox-command-click', 'left', true, sourceFrame)
  assert.equal(await sandboxChild.page.executeJavaScript('(()=>{try{localStorage.getItem("native-sandbox-proof");return "allowed"}catch(e){return e.name}})()'), 'SecurityError', 'Guestless child preserves its initiating opaque sandbox restrictions')
  assert.ok(receipt.nativeWindowOpens.find((row: any) => row.url === origin + '/sandbox-native').sandboxFlags > 0)
  const sandboxNative = receipt.nativeLinkObservations.find((row: any) => row.name === 'sandbox-command-click')
  assert.equal(sandboxNative.callback.options.webPreferences.openerSandboxFlags, sandboxNative.events[0].sandboxFlags, 'Native constructor retains the exact original sandbox flags')
  await opener.executeJavaScript('document.querySelector("#sandbox-frame").remove();true')
  receipt.cases.push({ name: 'native-sandbox-frame-retains-original-restrictions', pageId: sandboxChild.page.id })

  const nativeNested = await nativeLink(middleChild.page, '/nested-modifier-native', 'nested-command-click')
  let nestedDestroyed = 0, middleDestroyed = 0
  nativeNested.page.on('destroyed', () => nestedDestroyed++)
  middleChild.page.on('destroyed', () => middleDestroyed++)
  middleChild.page.close()
  await until('the exact native source close destroys its original guestless nested page', () => middleChild.page.isDestroyed() && nativeNested.page.isDestroyed())
  assert.equal(nestedDestroyed, 1); assert.equal(middleDestroyed, 1)
  assert.equal(modifiedChild.page.isDestroyed(), false, 'Native nested owner closure preserves the unrelated healthy child')
  receipt.cases.push({ name: 'native-guestless-nested-source-lifecycle-exactly-once', nestedDestroyed, middleDestroyed })

  const child = await opened(opener, `window.originalChild=window.open(${JSON.stringify(origin + '/one')},'original-child','width=800,height=600'); Boolean(originalChild)`, 'normal popup')
  await settlePage(child.page, '/one')
  assert.equal(child.page.session, opener.session, 'Native popup consumes the complete original same-session request')
  assert.equal(await child.page.executeJavaScript('Boolean(window.opener)'), true, 'Original native opener survives local chrome hosting')
  await child.page.executeJavaScript('opener.postMessage("original-child-ready",location.origin)')
  await until('original opener receives real postMessage', async () => await opener.executeJavaScript('messages.some(e=>e.data==="original-child-ready")'))
  assert.match(await child.page.executeJavaScript('document.cookie'), /fixture=normal/u)
  assert.equal(await child.page.executeJavaScript('window.fixtureReady'), true, 'The normal native child executes the fixture inline script')
  const namedBefore = manager.targets().length
  assert.equal(await opener.executeJavaScript('window.open("", "original-child") === originalChild', true), true, 'An existing named native child retains its original renderer identity')
  assert.equal(manager.targets().length, namedBefore, 'Reusing an original named child creates no duplicate shell')
  receipt.cases.push({ name: 'normal-original-opener-session-postmessage', pageId: child.page.id, browserId: child.id })
  await checkpoint('normal-child-confirmed')

  const blank = await opened(opener, `window.blankChild=window.open('about:blank','synchronous-child');blankChild.document.write('<title>Synchronous child</title><h1 id="sync">Original synchronous content</h1>');blankChild.document.close();true`, 'synchronous aboutblank')
  assert.equal(await blank.page.executeJavaScript('document.getElementById("sync")?.textContent'), 'Original synchronous content', 'about:blank synchronous script uses original returned child')
  receipt.cases.push({ name: 'aboutblank-original-synchronous-document', pageId: blank.page.id })
  const noScript = await opened(opener, `window.noScriptChild=window.open(${JSON.stringify(origin + '/javascript-disabled')},'javascript-disabled-child','javascript=no');true`, 'native child with JavaScript disabled')
  await settlePage(noScript.page, '/javascript-disabled')
  assert.equal((noScript.page as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences().javascript, false, 'Guestful native child retains its original javascript=no preference')
  assert.equal(noScript.page.getTitle(), 'JavaScript initially disabled', 'Native page scripts remain disabled by the original child request')
  receipt.cases.push({ name: 'guestful-native-child-javascript-disabled', pageId: noScript.page.id })
  const post = await opened(opener, `(()=>{const f=document.createElement('form');f.method='POST';f.target='_blank';f.action=${JSON.stringify(origin + '/posted')};const i=document.createElement('input');i.name='payload';i.value='original-body';f.append(i);document.body.append(f);f.submit();return true})()`, 'native target blank form')
  await settlePage(post.page, '/posted')
  const posted = receipt.requests.find((row: any) => row.path === '/posted')
  assert.ok(posted, 'The real server observes the original target=_blank request')
  assert.equal(posted.method, 'POST', 'Original window-open options preserve POST rather than replaying GET')
  assert.equal(posted.body, 'payload=original-body'); assert.equal(posted.referrer, origin + '/opener?mode=normal')
  assert.equal(receipt.requests.filter((row: any) => row.path === '/posted').length, 1, 'Native form submission sends the original body exactly once')
  assert.equal(posted.fetchSite, 'same-origin'); assert.match(posted.cookie, /strict_fixture=normal/u)
  receipt.cases.push({ name: 'native-form-post-and-referrer', request: posted })


  showPage(child.id)
  await manager.navigate(child.id, origin + '/two'); await settlePage(child.page, '/two')
  assert.equal(manager.nativeOwner(child.id)?.view.webContents, child.page, 'Formal navigation retains the original child object')
  await manager.back(child.id); await settlePage(child.page, '/one')
  await manager.forward(child.id); await settlePage(child.page, '/two')
  const count = receipt.requests.filter((row: any) => row.path === '/two').length
  await manager.reload(child.id)
  await until('formal reload reaches the original child request', () => receipt.requests.filter((row: any) => row.path === '/two').length > count)
  await settlePage(child.page, '/two')
  assert.equal(receipt.requests.filter((row: any) => row.path === '/two').length, count + 1, 'Formal reload uses the original child once')
  receipt.cases.push({ name: 'same-browser-owner-navigation-history-reload', browserId: child.id })

  let prevented = 0
  post.page.on('will-prevent-unload', () => { prevented++ })
  await post.page.executeJavaScript('window.onbeforeunload=()=>false;true', true)
  await manager.navigate(post.id, origin + '/vetoed-navigation')
  await until('the original child vetoes a navigation without requesting Close', () => prevented > 0)
  assert.equal(closePrompts.length, 0, 'A navigation beforeunload never becomes a child Close confirmation')
  assert.equal(post.page.isDestroyed(), false, 'A navigation veto keeps the original child usable')
  assert.equal(post.page.getURL(), origin + '/posted')
  receipt.cases.push({ name: 'native-navigation-beforeunload-does-not-close-child' })
  const firstClose = Promise.resolve(manager.close(post.id)).then(() => ({ closed: true }), error => ({ closed: false, error: String(error) }))
  await until('original child beforeunload reaches exact close confirmation', () => prevented > 0 && closePrompts.length === 1)
  assert.equal(closePrompts[0].window, rootWindow, 'Stay/Leave belongs to the exact original native host')
  closePrompts[0].resolve(false); assert.equal((await firstClose).closed, false)
  assert.equal(post.page.isDestroyed(), false, 'Explicit Stay retains the original child page')
  const secondClose = Promise.resolve(manager.close(post.id))
  await until('a later explicit child Close retains the original beforeunload', () => closePrompts.length === 2)
  closePrompts[1].resolve(true); await secondClose
  await until('explicit Leave destroys the original child page', () => post.page.isDestroyed())
  receipt.cases.push({ name: 'original-native-child-beforeunload-stay-and-leave', prevented, confirmations: 2 })

  const nested = await opened(child.page, `window.nested=window.open(${JSON.stringify(origin + '/nested')},'nested-child');true`, 'nested child')
  await settlePage(nested.page, '/nested')
  assert.equal(nested.page.session, opener.session)
  assert.equal(await nested.page.executeJavaScript('Boolean(opener)'), true)
  await nested.page.executeJavaScript('window.close()')
  await until('original script-close ends the exact child page', () => nested.page.isDestroyed())
  receipt.cases.push({ name: 'nested-original-policy-and-script-close' })

  showPage(blank.id); manager.setBounds(blank.id, null)
  const accountReplies: Array<string | null | undefined> = []
  const frame = blank.page.mainFrame
  const eventConsumed = blank.page.session.emit('select-webauthn-account', {} as Electron.Event, {
    frame, relyingPartyId: '127.0.0.1', accounts: [{ credentialId: 'fixture-first', name: 'Fixture first', displayName: 'Fixture first' },
      { credentialId: 'fixture-second', name: 'Fixture second', displayName: 'Fixture second' }]
  }, (credential: string | null | undefined) => accountReplies.push(credential))
  assert.equal(eventConsumed, true); assert.equal(accountReplies.length, 0, 'The actual Browser child owner retains its hidden native account request')
  const pendingAccount = manager.setViewport(blank.id, 'responsive')
  assert.ok(pendingAccount.activity?.warning, 'The same Browser snapshot exposes the pending account request')
  await blank.page.loadURL(origin + '/auth-finished')
  assert.deepEqual(accountReplies, [null], 'Original child navigation cancels its own pending account request')
  receipt.cases.push({ name: 'same-browser-native-auth-owner-pending-and-navigation-cancel', browserId: blank.id,
    boundary: 'Synthetic provider event through actual Session/registered owner; no real accounts or OS credentials.' })
  await manager.create('popup-private', origin + '/opener?mode=private', workspaceId, undefined, 'private')
  manager.setBounds('popup-private', { x: 0, y: 0, width: 880, height: 620 })
  const privateOpener = manager.nativeOwner('popup-private')!.view.webContents
  browserIds.set(privateOpener, 'popup-private')
  await settlePage(privateOpener, '/opener')
  const privateChild = await opened(privateOpener, `window.privateChild=window.open(${JSON.stringify(origin + '/private')},'private-child');true`, 'private popup')
  await settlePage(privateChild.page, '/private')
  assert.equal(privateChild.page.session, privateOpener.session)
  assert.notEqual(privateChild.page.session, opener.session)
  assert.match(await privateChild.page.executeJavaScript('document.cookie'), /fixture=private/u)
  const privateModified = await nativeLink(privateOpener, '/private-modifier-native', 'private-command-click')
  assert.notEqual(privateModified.page.session, opener.session)
  assert.match(await privateModified.page.executeJavaScript('document.cookie'), /strict_fixture=private/u)
  const privateRequest = receipt.requests.filter((row: any) => row.path === '/private-modifier-native')
  assert.equal(privateRequest.length, 1); assert.equal(privateRequest[0].fetchSite, 'same-origin')
  assert.doesNotMatch(privateRequest[0].cookie, /(?:^|; )fixture=normal(?:;|$)/u)
  let privateDestroyed = 0
  privateModified.page.on('destroyed', () => privateDestroyed++)
  await manager.close(privateModified.id)
  assert.equal(privateDestroyed, 1, 'Closing one private child ends its exact original page once')
  assert.equal(privateOpener.isDestroyed(), false, 'Closing one private child preserves the original parent native page')
  assert.equal(privateChild.page.isDestroyed(), false, 'Closing one private child preserves its independent sibling')
  assert.match(await privateOpener.executeJavaScript('document.cookie'), /strict_fixture=private/u, 'Closing one private child preserves the shared parent website Session')
  receipt.cases.push({ name: 'native-private-child-close-preserves-parent-session' })
  const privateNested = await opened(privateChild.page, `window.nestedPrivate=window.open(${JSON.stringify(origin + '/private-nested')},'nested-private-child');true`, 'nested private popup')
  await settlePage(privateNested.page, '/private-nested')
  assert.equal(privateNested.page.session, privateOpener.session, 'Nested private child retains the original temporary session')
  await manager.close('popup-private')
  await until('private owner close destroys its actual child', () => privateChild.page.isDestroyed() && privateNested.page.isDestroyed() && privateModified.page.isDestroyed())
  assert.equal(privateDestroyed, 1, 'Closing the original private owner destroys its exact guestless child once')
  assert.equal(opener.isDestroyed(), false, 'Closing a private owner preserves unrelated healthy normal Browser')
  receipt.cases.push({ name: 'private-original-session-and-owner-close', privateDestroyed })


  await checkpoint('before-actual-public-consumers')
  await provePublicChild(child, opener)
  await checkpoint('actual-public-consumers-complete')
  assert.deepEqual(receipt.uncaughtExceptions ?? [], [], 'Original native child inputs do not produce uncaught exceptions')
  const nativeEvents = receipt.events.filter((event: any) => event.type === 'native-opened')
  assert.ok(nativeEvents.length > 0, 'Actual native-opened consumers are nonempty')
  for (const event of nativeEvents) assert.ok(event.browser.source?.browserId && event.browser.source.navigationId, 'The same Browser event retains its exact original source')
  assert.equal(await child.page.executeJavaScript('typeof window.agentmux'), 'undefined')
  assert.equal(await child.page.executeJavaScript('typeof window.unifiedBrowserProof'), 'undefined', 'The website never gains trusted host IPC')
  receipt.passed = true
}
try { await run() }
catch (error: any) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) }
finally {
  const cleanup = async (name: string, action: () => unknown) => { try { await action() } catch (error) { receipt.cleanup.push({ name, error: String(error) }) } }
  await cleanup('public-control', () => control?.stop())
  await cleanup('manager', () => manager?.dispose())
  await cleanup('root', () => { if (rootWindow && !rootWindow.isDestroyed()) rootWindow.destroy() })
  await cleanup('server', async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) } })
  receipt.cleanupComplete = true
  await checkpoint('complete')
  app.exit(receipt.passed && receipt.cleanup.length === 0 ? 0 : 1)
}
