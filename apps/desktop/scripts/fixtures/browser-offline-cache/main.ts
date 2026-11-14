import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, type Session } from 'electron'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { executeBrowserProfileControl, isBrowserProfileControlRequest } from '../../../src/main/browser-profile-control.js'
import { AgentMuxControlServer } from '../../../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../../../packages/core/test/helpers/private-rpc-core.js'
import type { BrowserProfileStorageClearInput } from '@agentmux/core/control'

const home = process.env.AGENTMUX_OFFLINE_HOME!, output = process.env.AGENTMUX_OFFLINE_OUTPUT!, phase = process.env.AGENTMUX_OFFLINE_PHASE!
const report: any = { passed: false, phase, versions: process.versions, stages: [] }
const stage = (name: string) => { report.stages.push(name); writeFileSync(output, JSON.stringify(report, null, 2)); console.log('Offline cache native: ' + name) }
app.on('window-all-closed', () => {})
app.setActivationPolicy?.('prohibited')
const windows = new Set<BrowserWindow>()
let profiles: BrowserProfileManager | undefined, rpc: AgentMuxControlServer | undefined, core: Awaited<ReturnType<typeof privateRpcCorePort>> | undefined
let http: ReturnType<typeof createServer> | undefined
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
async function page(target: Session, url: string) {
  const win = new BrowserWindow({ show: false, webPreferences: { session: target, sandbox: true, contextIsolation: true } }); windows.add(win)
  await win.loadURL(url); return win
}
const seed = `(async()=>{ const cache=await caches.open('offline-fixture');await cache.put('/offline-fixture',new Response('owned fixture '.repeat(32768)));localStorage.setItem('preserved','local-fixture');await new Promise((resolve,reject)=>{const r=indexedDB.open('preserved',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('data','readwrite');tx.objectStore('data').put('idb-fixture','key');tx.oncomplete=()=>{db.close();resolve(null)}}});await navigator.serviceWorker.register('/sw.js');return true})()`
const retained = `(async()=>{const value=await new Promise((resolve,reject)=>{const r=indexedDB.open('preserved',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('data')){db.close();resolve(null);return}const q=db.transaction('data').objectStore('data').get('key');q.onsuccess=()=>{db.close();resolve(q.result??null)}}});return {caches:await caches.keys(),local:localStorage.getItem('preserved'),idb:value,workers:(await navigator.serviceWorker.getRegistrations()).length}})()`
function keep(value: any) { assert.equal(value.local, 'local-fixture', 'localStorage kept'); assert.equal(value.idb, 'idb-fixture', 'IndexedDB kept'); assert.ok(value.workers > 0, 'Service Worker registration kept') }
async function cli(action: 'inspect' | 'clear', input: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, child = spawn(process.execPath, [process.env.AGENTMUX_OFFLINE_CLI!, 'browser', 'profile', 'storage', action, '--input', '-'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
    child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, stderr + stdout); const parsed = JSON.parse(stdout); assert.equal(parsed.ok, true); resolve(parsed.result) } catch (error) { reject(error) } })
    child.stdin.end(JSON.stringify(input))
  })
}
try {
  await app.whenReady()
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json'))); await profiles.initialize()
  core = await privateRpcCorePort(join(home, 'sessions.json'), join(home, 'messages.ndjson'))
  rpc = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: core.clients,
    execute: async request => { assert.ok(isBrowserProfileControlRequest(request)); return executeBrowserProfileControl(request, { profiles } as never, undefined) } })
  await rpc.start()
  let confirmations = 0
  profiles.storage.setConfirmationHandler(async input => { confirmations++; assert.ok(input.sites.length); return true })
  if (phase === 'restart') {
    stage('reading original operation after actual process restart')
    const saved = JSON.parse(await readFile(join(home, 'restart-input.json'), 'utf8'))
    const inspected = await cli('inspect', { profileId: saved.profileId, operationId: saved.operationId })
    assert.equal(inspected.receipt.status, 'unknown'); assert.equal(inspected.pending.length, 1)
    assert.equal((await cli('clear', saved)).receipt.status, 'unknown')
    assert.equal(confirmations, 0, 'unknown original operation was not confirmed or dispatched again')
    assert.ok(inspected.snapshot.usage.logicalBytes > 0, 'new cache data retained across restart')
    report.restartOriginalOperation = true
  } else {
    stage('seeding isolated native Profiles and two origins')
    http = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url === '/sw.js') { response.setHeader('Content-Type', 'application/javascript'); response.end('self.addEventListener("fetch",()=>{});'); return }
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Private cache fixture</title><input value="original draft">')
    })
    await new Promise<void>(done => http!.listen(0, '0.0.0.0', done))
    const port = (http.address() as any).port, originA = `http://127.0.0.1:${port}`, originB = `http://localhost:${port}`
    const first = profiles.listProfiles()[0]!, second = await profiles.createProfile('Other fixture Profile', 'create-other', { kind: 'device', id: 'isolated-owner', verified: true })
    const native1 = profiles.sessions.nativeSession(first.id), native2 = profiles.sessions.nativeSession(second.id)
    const a = await page(native1, originA), b = await page(native1, originB), other = await page(native2, originA)
    for (const win of [a, b, other]) await win.webContents.executeJavaScript(seed)
    assert.equal(await a.webContents.executeJavaScript(`'storageBuckets' in navigator`), true, 'native Storage Buckets support')
    await a.webContents.executeJavaScript(`(async()=>{const bucket=await navigator.storageBuckets.open('named-fixture');const cache=await bucket.caches.open('named');await cache.put('/named',new Response('named fixture '.repeat(2048)));return true})()`)
    await native1.cookies.set({ url: originA, name: 'preserved', value: 'cookie-fixture' })
    await b.webContents.executeJavaScript(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.src=${JSON.stringify(originA + '/embedded')};frame.onload=()=>resolve(true);document.body.appendChild(frame)})`)
    const embedded = b.webContents.mainFrame.frames[0]!
    await embedded.executeJavaScript(seed)
    b.webContents.debugger.attach('1.3')
    const { targetInfos } = await b.webContents.debugger.sendCommand('Target.getTargets')
    const child = targetInfos.filter((target: any) => target.type === 'iframe' && target.url === originA + '/embedded')
    assert.equal(child.length, 1, 'exact private cross-origin iframe target')
    const { sessionId } = await b.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: child[0].targetId, flatten: true })
    const frameTree = await b.webContents.debugger.sendCommand('Page.getFrameTree', {}, sessionId)
    const { storageKey: partitioned } = await b.webContents.debugger.sendCommand('Storage.getStorageKeyForFrame', { frameId: frameTree.frameTree.frame.id })
    await b.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId })
    b.webContents.debugger.detach()
    assert.ok(partitioned.includes('^'), 'third-party key has its original partition suffix')
    report.partitionedKeyObserved = true
    for (const win of [...windows]) { win.destroy(); windows.delete(win) }
    native1.flushStorageData(); native2.flushStorageData()
    stage('observing both cold directory layouts through public CLI')
    let snapshot: any; const deadline = Date.now() + 20_000
    do { snapshot = (await cli('inspect', { profileId: first.id })).snapshot; if (snapshot.sites.flatMap((s: any) => s.storageKeys).includes(partitioned) && snapshot.sites.length === 2) break; await sleep(100) } while (Date.now() < deadline)
    assert.equal(snapshot.sites.length, 2, JSON.stringify(snapshot))
    assert.ok(snapshot.sites.flatMap((s: any) => s.storageKeys).includes(partitioned), 'cold third-party original key is discovered')
    assert.equal(snapshot.usage.complete, true, JSON.stringify(snapshot.issues))
    const selected: BrowserProfileStorageClearInput = { profileId: first.id, expectedRevision: first.revision, operationId: 'clear-cold-partition', sites: [{ origin: originA, storageKeys: [partitioned] }] }
    stage('clearing one exact cold third-party key')
    assert.equal((await cli('clear', selected)).receipt.status, 'completed')
    assert.equal(confirmations, 1)
    const kept = await page(native1, originA), top = await page(native1, originB), keptOther = await page(native2, originA)
    const firstValue = await kept.webContents.executeJavaScript(retained); keep(firstValue)
    assert.deepEqual(firstValue.caches, ['offline-fixture'], 'unselected first-party CacheStorage kept')
    await top.webContents.executeJavaScript(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.src=${JSON.stringify(originA + '/embedded')};frame.onload=()=>resolve(true);document.body.appendChild(frame)})`)
    const thirdValue = await top.webContents.mainFrame.frames[0]!.executeJavaScript(retained); keep(thirdValue)
    assert.deepEqual(thirdValue.caches, [], 'selected third-party CacheStorage cleared')
    keep(await keptOther.webContents.executeJavaScript(retained))
    assert.deepEqual(await keptOther.webContents.executeJavaScript('caches.keys()'), ['offline-fixture'], 'other Profile CacheStorage kept')
    assert.equal((await native1.cookies.get({ url: originA })).find(cookie => cookie.name === 'preserved')?.value, 'cookie-fixture')
    stage('one confirmation clears all frozen identified sites in one Profile')
    const all = (await cli('inspect', { profileId: first.id })).snapshot
    const allInput = { profileId: first.id, expectedRevision: first.revision, operationId: 'clear-all-identified-sites', sites: all.sites.map(({ origin, storageKeys }: any) => ({ origin, storageKeys })) }
    const allResult = (await cli('clear', allInput)).receipt
    assert.equal(confirmations, 2, 'multi-site action confirms only once')
    assert.equal(allResult.status, 'completed'); assert.equal(allResult.sites.length, 2)
    for (const win of [kept, top]) { const value = await win.webContents.executeJavaScript(retained); keep(value); assert.deepEqual(value.caches, []) }
    assert.deepEqual(await kept.webContents.executeJavaScript(`(async()=>{const b=await navigator.storageBuckets.open('named-fixture');return b.caches.keys()})()`), [], 'named bucket CacheStorage cleared')
    assert.deepEqual(await keptOther.webContents.executeJavaScript('caches.keys()'), ['offline-fixture'], 'all-sites action stays inside original Profile')
    assert.equal((await native1.cookies.get({ url: originA })).find(cookie => cookie.name === 'preserved')?.value, 'cookie-fixture', 'login Cookie kept')
    assert.equal(await kept.webContents.executeJavaScript('document.querySelector("input").value'), 'original draft', 'active original page and draft kept')
    await kept.webContents.executeJavaScript(`(async()=>{const c=await caches.open('new-write');await c.put('/new',new Response('active rewrite '.repeat(16384)));return true})()`)
    for (const win of [...windows]) { win.destroy(); windows.delete(win) }
    native1.flushStorageData()
    let renewed: any; const renewedDeadline = Date.now() + 15_000
    do { renewed = (await profiles.storage.inspect(first.id)).snapshot; if (renewed.sites.some(s => s.origin === originA && s.usage.logicalBytes > 100_000)) break; await sleep(100) } while (Date.now() < renewedDeadline)
    assert.ok(renewed.sites.some(s => s.origin === originA && s.usage.logicalBytes > 100_000), 'website writes can rebuild cache after acknowledged clear')
    const pendingInput = { profileId: first.id, expectedRevision: first.revision, operationId: 'original-unconfirmed-op', sites: renewed.sites.filter((s: any) => s.origin === originA).map(({ origin, storageKeys }: any) => ({ origin, storageKeys })) }
    await new BrowserProfileStore(join(home, 'profiles.json')).changeStorageReceipt(first.id, { ...pendingInput, status: 'pending', requestedAt: Date.now(), finishedAt: null, before: renewed, after: null, issues: [], results: pendingInput.sites.flatMap((s: any) => s.storageKeys).map(storageKey => ({ storageKey, status: 'unknown' })) }, true)
    await writeFile(join(home, 'restart-input.json'), JSON.stringify(pendingInput))
    report.before = snapshot; report.after = allResult.after; report.confirmations = confirmations
  }
  report.passed = true; stage('native assertions passed')
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); console.error(error) }
finally {
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  await rpc?.stop(); await core?.dispose(); await profiles?.dispose()
  await new Promise<void>(done => http ? http.close(() => done()) : done())
  await writeFile(output, JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1)
}
