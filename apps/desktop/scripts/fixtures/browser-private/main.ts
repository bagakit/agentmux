import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, type Session } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'

const root = process.env.AGENTMUX_PRIVATE_OWNER_ROOT!, output = process.env.AGENTMUX_PRIVATE_OWNER_RECEIPT!
assert.ok(root && output)
app.setPath('userData', join(root, 'user-data')); app.setPath('home', join(root, 'home'))
const receipt: { passed: boolean; stage: string; cases: string[]; failure?: { message: string; stack?: string }; sessions?: unknown } = { passed: false, stage: 'module-loaded', cases: [] }
function stage(value: string) { receipt.stage = value; writeFileSync(output + '.stage.json', JSON.stringify(receipt) + '\n') }
app.on('window-all-closed', () => {})
let manager: BrowserViewManager | undefined, profiles: BrowserProfileManager | undefined, window: BrowserWindow | undefined
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Website owner</title><h1>Website owner</h1>') })
async function run() {
stage('waiting-app-ready')
await app.whenReady()
// This fixture tests Session ownership only. It has no interactive UI, menu/focus oracle or
// App activation claim and cannot take the human's foreground window.
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
try {
  stage('local-server')
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/`
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json'))); await profiles.initialize()
  stage('real-manager')
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'refs.json')), {
    rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('No external application belongs to this website-session fixture') }
  })
  const view = (id: string) => {
    manager!.setBounds(id, { x: 0, y: 0, width: 320, height: 220 })
    const native = manager!.nativeOwner(id); assert.ok(native, 'Actual manager must expose the exact live native owner')
    return native.view
  }
  stage('normal-create'); await manager.create('normal', url, 'workspace')
  const ordinary = view('normal').webContents.session
  stage('private-create'); await manager.create('private', url, 'workspace', undefined, 'private')
  const first = view('private'), firstContents = first.webContents, retired = firstContents.session
  receipt.cases.push('actual-private-session-properties')
  assert.equal(retired.isPersistent(), false, 'actual private Session must be in memory')
  assert.equal(retired.storagePath, null)
  assert.equal(ordinary.isPersistent(), true)
  await manager.create('private-sibling', url, 'workspace', undefined, 'private')
  const sibling = view('private-sibling').webContents.session
  assert.notEqual(retired, sibling); assert.notEqual(retired, ordinary); assert.notEqual(sibling, ordinary)
  receipt.cases.push('actual-normal-and-private-private-session-isolation')
  const put = async (session: Session, value: string) => session.cookies.set({ url, name: 'owner-cookie', value, expirationDate: Math.floor(Date.now() / 1000) + 86400 })
  const get = async (session: Session) => (await session.cookies.get({ url, name: 'owner-cookie' })).map(cookie => cookie.value)
  await put(ordinary, 'normal-kept'); await put(retired, 'private-kept'); await put(sibling, 'private-sibling-kept')
  assert.deepEqual(await get(ordinary), ['normal-kept']); assert.deepEqual(await get(sibling), ['private-sibling-kept'])
  stage('private-release'); await manager.release('private')
  if (!firstContents.isDestroyed()) await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('The exact released native WebContents did not finish closing')), 4000)
    firstContents.once('destroyed', () => { clearTimeout(timer); done() })
  })
  assert.equal(firstContents.isDestroyed(), true)
  await manager.restore('private', { workspaceId: 'workspace', profileId: null, mode: 'private' })
  assert.equal(view('private').webContents.session, retired)
  assert.deepEqual(await get(retired), ['private-kept'])
  receipt.cases.push('actual-private-release-keeps-session-and-cookie')
  stage('private-close'); await manager.close('private')
  assert.deepEqual(await get(retired), [], 'Actual private close must clear the retired Session cookies')
  await manager.create('private', url, 'workspace', undefined, 'private')
  const next = view('private').webContents.session
  assert.notEqual(next, retired, 'closed private Session must never be reused')
  await put(retired, 'late-old-consumer')
  assert.deepEqual(await get(next), [], 'Late retired consumer must not populate the actual new private Session')
  assert.deepEqual(await get(ordinary), ['normal-kept']); assert.deepEqual(await get(sibling), ['private-sibling-kept'])
  receipt.cases.push('actual-private-close-retires-incarnation-and-isolates-late-consumer')
  receipt.sessions = { normal: { persistent: ordinary.isPersistent() }, private: { persistent: next.isPersistent(), storagePath: next.storagePath } }
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error instanceof Error ? error.message : String(error), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) }
} finally {
  stage('cleanup')
  if (manager) for (const target of manager.targets()) { stage('cleanup-owner:' + target.id); try { await manager.close(target.id) } catch (error) { receipt.passed = false; receipt.failure ??= { message: String(error) } } }
  stage('cleanup-manager'); manager?.dispose()
  stage('cleanup-profiles'); await profiles?.dispose()
  stage('cleanup-server'); await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() })
  stage('cleanup-window'); window?.destroy()
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed ? 0 : 1)
}

}
void run().catch(async error => { await writeFile(output, JSON.stringify({passed:false,cases:receipt.cases,failure:{message:String(error)}}));app.exit(1) })
