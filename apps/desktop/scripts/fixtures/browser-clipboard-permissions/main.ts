import { app, BrowserWindow, session, type Session } from 'electron'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'

const root = process.env.CLIPBOARD_PROBE_ROOT!, interactive = process.env.CLIPBOARD_PROBE_INTERACTIVE === '1'
app.setPath('userData', join(root, 'user-data')); app.setPath('sessionData', join(root, 'session-data'))
app.on('window-all-closed', () => {})
const receipt: any = { schema: 'agentmux.browser-clipboard-electron.v1', passed: false, pid: process.pid, versions: process.versions,
  writes: [], permissionCalls: [], cleanup: {}, boundary: 'Actual BrowserViewManager and Chromium page Clipboard APIs to general OS pasteboard; fixture website and input delivery are explicit. No Agent or user page is operated; no OS hit-test qualification.',
  clipboardProtection: 'All NSPasteboardItems/types preserved in helper memory. Conditional restore skips observed external updates; NSPasteboard has no atomic CAS.' }
const helper = spawn(process.env.CLIPBOARD_PROBE_HELPER!, [], { stdio: ['pipe', 'pipe', 'pipe'] })
let sequence = 0
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
const lines = createInterface({ input: helper.stdout })
lines.on('line', line => { const response = JSON.parse(line), request = pending.get(response.id); pending.delete(response.id); response.ok ? request?.resolve(response.result) : request?.reject(new Error(response.error)) })
helper.stderr.on('data', bytes => process.stderr.write(bytes))
const lease = (command: string, extra = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); helper.stdin.write(JSON.stringify({ id, command, ...extra }) + '\n') })
const helperExited = new Promise<void>(resolve => helper.once('exit', (code, signal) => { receipt.cleanup.helper = { pid: helper.pid, code, signal }; resolve() }))
let manager: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined, window: BrowserWindow | undefined
let failure: unknown, completed = 0, finishing = false
const marker = (index: number) => `AgentMux-clipboard-private-${process.pid}-${index}`
const html = (child: boolean) => `<!doctype html><meta charset="utf-8"><title>AgentMux Clipboard Permission Probe ${process.pid}</title><style>body{font:18px system-ui;padding:22px;background:#f5f5f5}button{font:18px system-ui;padding:16px;margin:8px}iframe{display:block;width:540px;height:210px;border:1px solid #999}</style><h2>${child ? 'Iframe ClipboardItem' : 'Main page writeText'}</h2><button id="copy">Copy ${child ? 'iframe item' : 'main text'}</button><output id="status"></output>${child ? '' : '<iframe src="/child"></iframe>'}<script>document.querySelector('button').onclick=async event=>{const facts={index:${child ? 1 : 0},trusted:event.isTrusted,activation:navigator.userActivation.isActive,focused:document.hasFocus(),url:location.href};try{const permit=await fetch('/permit',{method:'POST'});if(!permit.ok)throw new Error('Original clipboard changed; write cancelled');facts.activationAtWrite=navigator.userActivation.isActive;${child ? `await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([${JSON.stringify(marker(1))}],{type:'text/plain'})})])` : `await navigator.clipboard.writeText(${JSON.stringify(marker(0))})`};facts.outcome='resolved'}catch(error){facts.outcome='rejected';facts.error=String(error)}document.querySelector('output').textContent=facts.outcome;await fetch('/completed',{method:'POST',body:JSON.stringify(facts)})}</script>`
const server = createServer((request, response) => {
  if (request.url === '/permit') {
    void lease('prepare').then(result => { receipt.lastPermit = result; response.end('allowed') }, error => { failure = error; response.writeHead(409); response.end('changed') })
    return
  }
  if (request.url === '/completed') {
    let body = ''; request.on('data', bytes => { body += bytes }); request.on('end', () => {
      void (async () => {
        const facts = JSON.parse(body); assert.equal(facts.index, completed); assert.equal(facts.outcome, 'resolved', facts.error)
        const system = await lease('confirm', { marker: marker(completed) }); receipt.writes.push({ ...facts, system, input: interactive ? 'Root CUA OS input to exact private window' : 'Electron WebContents.sendInputEvent to exact private BrowserView' }); completed++
        if (completed < 2) await lease('prepare')
        await writeFile(join(root, 'progress.json'), JSON.stringify({ completed, writes: receipt.writes }, null, 2))
      })().then(() => response.end('ok'), error => { failure = error; response.writeHead(500); response.end('failed') })
    }); return
  }
  response.setHeader('Content-Type', 'text/html'); response.end(html(request.url === '/child'))
})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function run() {
await app.whenReady()
if (process.platform === 'darwin') app.setActivationPolicy(interactive ? 'regular' : 'accessory')
try {
  receipt.clipboardBefore = await lease('snapshot', { probePid: process.pid })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as any).port}`
  const prototype = Object.getPrototypeOf(session.defaultSession), check = prototype.setPermissionCheckHandler, request = prototype.setPermissionRequestHandler
  prototype.setPermissionCheckHandler = function (handler: any) { return check.call(this, handler && ((contents: any, permission: any, requestingOrigin: any, details: any) => { const allowed = handler(contents, permission, requestingOrigin, details); receipt.permissionCalls.push({ type: 'check', id: contents?.id, permission, requestingOrigin, details, allowed }); return allowed })) }
  prototype.setPermissionRequestHandler = function (handler: any) { return request.call(this, handler && ((contents: any, permission: any, callback: any, details: any) => handler(contents, permission, (allowed: any) => { receipt.permissionCalls.push({ type: 'request', id: contents.id, permission, details, allowed }); callback(allowed) }, details))) }
  window = new BrowserWindow({ show: false, title: `AgentMux Clipboard Permission Probe ${process.pid}`, width: 700, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json'))); await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('No external launch belongs to this clipboard fixture') } })
  const original = await manager.create('clipboard-original-browser', origin, 'clipboard-original-workspace')
  manager.setBounds(original.id, { x: 0, y: 0, width: 700, height: 610 })
  const native = manager.nativeOwner(original.id); assert.ok(native)
  const wc = native.view.webContents; receipt.original = { browser: original, webContentsId: wc.id, nativeBounds: native.view.getBounds(), profileId: original.profileId }
  const query = `navigator.permissions.query({name:'clipboard-write'}).then(result=>({state:result.state,url:location.href,origin:origin,secure:isSecureContext}))`
  receipt.sourceQueries = [{ kind: 'main', ...await wc.executeJavaScript(query) }]
  for (const kind of ['blank', 'srcdoc']) {
    await wc.executeJavaScript(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.id='inherited-${kind}';frame.onload=()=>resolve(true);${kind === 'srcdoc' ? `frame.srcdoc='<p>Inherited source</p>'` : `frame.src='about:blank'`};document.body.append(frame)})`)
    const frame = wc.mainFrame.frames.find(frame => frame.url === (kind === 'blank' ? 'about:blank' : 'about:srcdoc'))
    assert.ok(frame)
    receipt.sourceQueries.push({ kind, ...await frame.executeJavaScript(query) })
    await wc.executeJavaScript(`document.getElementById('inherited-${kind}').remove()`)
  }
  const file = join(root, 'file-query.html'); await writeFile(file, '<!doctype html><title>Private file permission query</title>')
  await manager.create('clipboard-file-query', new URL('file://' + file).href, 'clipboard-original-workspace')
  manager.setBounds('clipboard-file-query', { x: 0, y: 0, width: 700, height: 610 })
  const fileContents = manager.nativeOwner('clipboard-file-query')?.view.webContents
  assert.ok(fileContents); receipt.sourceQueries.push({ kind: 'file', ...await fileContents.executeJavaScript(query) })
  await manager.close('clipboard-file-query')
  if (!fileContents.isDestroyed()) await new Promise<void>(resolve => fileContents.once('destroyed', resolve))
  assert.ok(receipt.sourceQueries.every((query: any) => query.state === 'granted'), 'File and inherited origins keep Chromium clipboard write qualification')
  window.setTitle(`AgentMux Clipboard Permission Probe ${process.pid}`)
  window.show(); window.focus(); wc.focus()
  await lease('prepare')
  await writeFile(join(root, 'ready.json'), JSON.stringify({ pid: process.pid, title: window.getTitle(), executable: process.execPath, root, bounds: window.getBounds(), nativeBounds: native.view.getBounds(), mainButton: await wc.executeJavaScript(`JSON.stringify(document.querySelector('button').getBoundingClientRect())`), childButton: await wc.executeJavaScript(`JSON.stringify(document.querySelector('iframe').getBoundingClientRect())`), input: interactive ? 'waiting for Root actual private-window clicks' : 'SDK exact-view input' }, null, 2))
  if (!interactive) {
    for (const index of [0, 1]) {
      const point = await wc.executeJavaScript(index === 0 ? `(()=>{const r=document.querySelector('button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()` : `(()=>{const f=document.querySelector('iframe'),r=f.getBoundingClientRect(),b=f.contentDocument.querySelector('button').getBoundingClientRect();return{x:r.x+f.clientLeft+b.x+b.width/2,y:r.y+f.clientTop+b.y+b.height/2}})()`)
      wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      const until = Date.now() + 5000
      while (completed <= index && !failure && Date.now() < until) await delay(25)
      assert.equal(completed, index + 1, String(failure ?? 'Page completion absent'))
    }
    finishing = true
  }
  const deadline = Date.now() + 10 * 60_000
  while (!finishing && !failure && Date.now() < deadline) {
    const command = await readFile(join(root, 'control.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    if (command && JSON.parse(command).action === 'finish') finishing = true
    else await delay(150)
  }
  if (failure) throw failure
  assert.equal(completed, 2, 'Both actual webpage writes must be consumed')
  const reads = await wc.executeJavaScript(`Promise.all(['readText','read'].map(async name=>{try{await navigator.clipboard[name]();return{name,state:'allowed'}}catch(error){return{name,state:'denied',error:String(error)}}}))`)
  assert.ok(reads.every((value: any) => value.state === 'denied')); receipt.reads = reads
  assert.ok(receipt.permissionCalls.some((value: any) => value.permission === 'clipboard-sanitized-write' && value.allowed))
  assert.equal(manager.nativeOwner(original.id)?.view.webContents, wc); receipt.originalRetained = true
  receipt.passed = true
} catch (error) { receipt.failure = String((error as Error).stack ?? error) }
finally {
  try { receipt.clipboardAfter = await lease('restore'); assert.equal(receipt.clipboardAfter.restored, true) } catch (error) { receipt.passed = false; receipt.cleanup.clipboardFailure = String(error) }
  receipt.cleanup.focus = await lease('restore-focus')
  if (manager) for (const target of manager.targets()) {
    const contents = manager.nativeOwner(target.browserId)?.view.webContents
    await manager.close(target.browserId)
    if (contents && !contents.isDestroyed()) await new Promise<void>(resolve => contents.once('destroyed', resolve))
  }
  manager?.dispose(); await profiles?.dispose()
  if (window && !window.isDestroyed()) window.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  helper.stdin.end(); await helperExited; lines.close()
  receipt.cleanup.windowsDestroyed = !window || window.isDestroyed()
  receipt.cleanup.serverClosed = !server.listening
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
}
}
void run().catch(error => { process.stderr.write(String(error.stack ?? error)); app.exit(1) })
