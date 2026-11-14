import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { zipSync, strToU8 } from 'fflate'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { registerBrowserProfileEditorIpc } from '../../../src/main/browser-profile-editor-ipc.js'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap.js'
import { onlineInstall } from './online-install.js'
import { onlineUpdate } from './online-update.js'
import { executeBrowserProfileControl } from '../../../src/main/browser-profile-control.js'

const home = process.env.EXTENSIONS_HOME!, out = process.env.EXTENSIONS_OUT!, phase = process.env.EXTENSIONS_PHASE!, base = process.env.EXTENSIONS_BASE!, node = process.env.EXTENSIONS_NODE!
app.setActivationPolicy?.('prohibited'); app.on('window-all-closed', () => {})
const receipt: any = { passed: false, phase, pid: process.pid, cases: [], cli: [], approvals: [] }
let host: BrowserWindow | undefined, profiles: BrowserProfileManager | undefined, browsers: BrowserViewManager | undefined, control: AgentMuxControlServer | undefined
let consent = true, fresh = 0, guiSource = ''
const originalBrowserId = 'extension-original-browser'
const contents = (id = originalBrowserId) => browsers!.nativeOwner(id)!.view.webContents
const token = (id: string) => profiles!.listProfiles().find(profile => profile.id === id)!.revision
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function cli(args: string[], success: boolean | 'observe' = true) {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'profile', 'extension', ...args], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/.test(key))), NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Original extension CLI observation exceeded its private test deadline')) }, 90_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data }); child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr }) }); child.stdin.end()
  })
  const body = JSON.parse(result.stdout || result.stderr); receipt.cli.push({ command: args[0], code: result.code, body })
  if (success !== 'observe') assert.equal(result.code === 0, success, result.stderr + result.stdout)
  return success === true ? body.result : body
}
async function freshPage(profileId: string) {
  const id = `extension-observation-${++fresh}`
  await browsers!.create(id, base, undefined, profileId); browsers!.setBounds(id, { x: 0, y: 0, width: 660, height: 500 })
  let facts: any
  for (let index = 0; index < 300; index++) {
    facts = await contents(id).executeJavaScript('({...document.documentElement.dataset})')
    if (facts.extensionBackground) return facts
    await pause(25)
  }
  throw Error('The actual extension content script and background did not produce their protocol markers: ' + JSON.stringify(facts))
}
const manifest = (version: string, extra: Record<string, unknown> = {}) => ({ manifest_version: 3, name: 'Private Profile helper', version, permissions: ['storage'],
  host_permissions: ['http://127.0.0.1/*'], content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }], background: { service_worker: 'background.js' },
  update_url: 'https://update.invalid/extension.xml', ...extra })
const code = (version: string) => `chrome.storage.local.get({count:0},state=>chrome.storage.local.set({count:state.count+1},()=>{document.documentElement.dataset.extensionVersion=${JSON.stringify(version)};document.documentElement.dataset.extensionCount=String(state.count+1);chrome.runtime.sendMessage({ping:true},reply=>document.documentElement.dataset.extensionBackground=reply?.version??'missing')}))`
const background = (version: string) => `chrome.runtime.onMessage.addListener((message,sender,reply)=>reply({version:${JSON.stringify(version)}}))`
async function source(version: string, options: { zip?: boolean; missingScript?: boolean; key?: string } = {}) {
  const definition = manifest(version, { ...(options.key ? { key: options.key } : {}), ...(version === '2.0.0' ? { permissions: ['storage', 'tabs'] } : {}) })
  const files = { 'manifest.json': JSON.stringify(definition), 'background.js': background(version), ...(!options.missingScript ? { 'content.js': code(version) } : {}) }
  const path = join(home, 'source-' + version + '-' + (++fresh) + (options.zip ? '.zip' : ''))
  if (options.zip) await writeFile(path, zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strToU8(data)]))))
  else { await mkdir(path); for (const [name, data] of Object.entries(files)) await writeFile(join(path, name), data) }
  return path
}
async function prepare(profileId: string, sourcePath: string, operationId: string, extensionId?: string) {
  return (await cli(['prepare', '--profile', profileId, '--expected-revision', token(profileId), '--operation-id', operationId, '--source', sourcePath,
    ...(extensionId ? ['--extension', extensionId] : [])])).review
}
async function apply(profileId: string, review: any, success = true) { return cli(['apply', '--profile', profileId, '--expected-revision', review.expectedRevision, '--review', review.reviewId], success) }
async function main() {
  try {
    host = new BrowserWindow({ show: false, width: 760, height: 640, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, preload: join(out, 'preload.cjs') } })
    const store = new BrowserProfileStore(join(home, 'profiles.json'))
    profiles = new BrowserProfileManager(store); console.error('extensions-proof: profile initialization'); await profiles.initialize(); console.error('extensions-proof: profile ready')
    registerBrowserProfileEditorIpc({ profiles, handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== host!.webContents || event.senderFrame !== host!.webContents.mainFrame) throw Error('Private fixture requires its original trusted Workbench frame')
      console.error('extensions-proof: profile IPC', channel)
      return listener(event, ...args)
    }) })
    ipcMain.on(THEME_BOOTSTRAP_CHANNEL, event => { event.returnValue = { status: 'unavailable', message: 'Private appearance input is unavailable; this fixture proves extension operations.' } })
    ipcMain.handle('ui:chooseFiles', () => [guiSource]) // Private file-selection input only, no approval authority.
    host.webContents.on('preload-error', (_event, _path, error) => console.error('extensions-proof: preload failed', error.message))
    host.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('extensions-proof: renderer error', event.message) })
    if (process.env.EXTENSIONS_CASE?.startsWith('online-')) host.showInactive()
    console.error('extensions-proof: renderer load')
    await host.loadFile(join(out, 'renderer/index.html')); console.error('extensions-proof: renderer ready')
    const retained = phase === 'second' ? JSON.parse(await readFile(join(home, 'retained.json'), 'utf8')) : null
    const profileId = retained?.profileId ?? profiles.defaultProfileId()
    profiles.extensions.setConfirmationHandler(async request => { receipt.approvals.push({ ...request, actualHumanReviewFixture: true, confirmed: consent }); return consent })
    browsers = new BrowserViewManager(host, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} })
    control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: (request, context) => executeBrowserProfileControl(request as never,
      { profiles: profiles!, usage: {} as never, network: {} as never }, context?.actor) }); await control.start()
    if (process.env.EXTENSIONS_CASE?.startsWith('online-')) {
      const scenario = process.env.EXTENSIONS_CASE === 'online-update' ? onlineUpdate : onlineInstall
      await scenario({ home, out, phase, base, profileId, retained, profiles, browsers, host, store, receipt, cli, token, contents, source, setConsent: (value: boolean) => { consent = value } })
      receipt.passed = true
      return
    }
    if (retained) {
      assert.equal(profiles.sessions.observedSession?.(profileId), undefined)
      const cold = await cli(['ls', '--profile', profileId]); assert.equal(cold.extensions[0].application.state, 'unknown')
      assert.equal(profiles.sessions.observedSession?.(profileId), undefined)
      const originalApprovals = receipt.approvals.length
      const pendingUpdate = await cli(['ls', '--profile', profileId, '--operation-id', retained.unknownReview.reviewId])
      assert.equal(pendingUpdate.receipt, null); assert.equal(pendingUpdate.pending[0].sha256, retained.unknownReview.sha256); assert.equal(pendingUpdate.pending[0].version, '5.0.0')
      const blockedUpdate = await apply(profileId, retained.unknownReview, false); assert.equal(blockedUpdate.error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      const blockedRemoval = await cli(['remove', '--profile', profileId, '--expected-revision', retained.unknownRemoveRevision, '--extension', retained.extensionId, '--operation-id', 'actual-unknown-remove'], false)
      assert.equal(blockedRemoval.error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      assert.equal(receipt.approvals.length, originalApprovals); assert.equal(profiles.sessions.observedSession?.(profileId), undefined)
      const pendingProof = { kind: 'second-process-original-pending-intents-no-confirmation-or-native-replay', originalProfileId: profileId, extensionId: retained.extensionId, pendingUpdate: pendingUpdate.pending, updateCode: blockedUpdate.error.code, removalCode: blockedRemoval.error.code, originalNativeSessionNotAcquired: true }
      await browsers.create(originalBrowserId, base, undefined, profileId); browsers.setBounds(originalBrowserId, { x: 0, y: 0, width: 660, height: 500 })
      let facts: any
      for (let index = 0; index < 300; index++) { facts = await contents().executeJavaScript('({...document.documentElement.dataset})'); if (facts.extensionBackground) break; await pause(25) }
      const restored = await cli(['ls', '--profile', profileId, '--operation-id', 'actual-update'])
      assert.equal(restored.extensions[0].id, retained.extensionId); assert.equal(restored.extensions[0].nativeId, retained.nativeId); assert.equal(restored.extensions[0].sha256, retained.sha256)
      assert.equal(restored.extensions[0].application.state, 'loaded'); assert.equal(facts.extensionVersion, '2.0.0'); assert.equal(facts.extensionBackground, '2.0.0'); assert.equal(facts.extensionCount, '3')
      assert.equal((await contents().session.cookies.get({ name: 'profile-signin' }))[0]?.value, 'private-cookie-preserved')
      assert.equal(await contents().executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
      assert.equal(profiles.listProfiles().length, retained.profileCount)
      receipt.cases.push({ kind: 'second-process-approved-original-extension-storage-and-signin', extensionId: retained.extensionId, nativeId: retained.nativeId, facts, sameBrowserId: originalBrowserId, originalProfileId: profileId }); receipt.cases.push(pendingProof)
    } else {
      const independent = await profiles.createProfile('Independent Profile')
      await browsers.create(originalBrowserId, base, undefined, profileId); browsers.setBounds(originalBrowserId, { x: 0, y: 0, width: 660, height: 500 })
      await browsers.create('extension-independent-browser', base, undefined, independent.id); browsers.setBounds('extension-independent-browser', { x: 0, y: 0, width: 660, height: 500 })
      await contents().executeJavaScript('document.querySelector("input").value="original-unsent-form";localStorage.setItem("profile-note","original-note-kept")')
      await contents().session.cookies.set({ url: base, name: 'profile-signin', value: 'private-cookie-preserved', expirationDate: Math.floor(Date.now() / 1000) + 86_400 })
      const review = await prepare(profileId, await source('1.0.0'), 'actual-install')
      assert.equal(profiles.sessions.nativeSession(profileId).extensions.getAllExtensions().length, 0)
      consent = false; assert.equal((await apply(profileId, review)).outcome, 'cancelled'); assert.equal(profiles.sessions.nativeSession(profileId).extensions.getAllExtensions().length, 0)
      consent = true; await apply(profileId, review)
      const first = await cli(['ls', '--profile', profileId, '--operation-id', 'actual-install']), extensionId = first.extensions[0].id, nativeId = first.extensions[0].nativeId
      const facts = await freshPage(profileId); assert.equal(facts.extensionVersion, '1.0.0'); assert.equal(facts.extensionBackground, '1.0.0'); assert.equal(facts.extensionCount, '1')
      assert.equal(await contents('extension-independent-browser').executeJavaScript('document.documentElement.dataset.extensionVersion'), undefined)
      assert.equal((await contents('extension-independent-browser').session.cookies.get({ name: 'profile-signin' })).length, 0)
      receipt.cases.push({ kind: 'actual-cli-human-boundary-content-script-and-mv3-worker', extensionId, nativeId, facts, independentProfileUnaffected: true })
      for (let index = 0; index < 100 && !await host.webContents.executeJavaScript('Boolean(window.extensionsNative)'); index++) await pause(40)
      host.webContents.debugger.attach('1.3')
      const click = async (selector: string) => {
        const point = await host!.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing real extension control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        for (const type of ['mousePressed','mouseReleased']) await host!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type,...point,button:'left',clickCount:1})
      }
      const ready = async (expression: string) => { for (let index=0;index<100;index++) { if(await host!.webContents.executeJavaScript(expression))return; await pause(40) } throw Error('Actual GUI extension consumer did not reach '+expression) }
      await click('.browser-profile-extensions__heading'); await ready('document.querySelectorAll(".browser-profile-extensions__list > li").length === 1')
      guiSource = await source('1.1.0'); consent = false
      await click('.browser-profile-extensions__list > li:first-child .browser-profile-extensions__actions > button:first-child')
      await ready('Boolean(document.querySelector(".browser-profile-extensions__primary"))')
      await click('.browser-profile-extensions__primary'); await ready('document.querySelector(".browser-profile-extensions__notice")?.textContent.includes("Nothing changed")')
      const guiLoaded = await host.webContents.executeJavaScript(`extensionsNative.api.loadProfileExtension(${JSON.stringify(profileId)},${JSON.stringify(extensionId)})`)
      assert.equal(guiLoaded.application.state, 'loaded')
      await click('.browser-profile-extensions__list > li:first-child .browser-profile-extensions__actions > button:last-child')
      for (let index=0;index<100 && !receipt.approvals.some((approval:any)=>approval.kind==='remove'&&!approval.confirmed);index++) await pause(30)
      assert.ok(receipt.approvals.some((approval:any)=>approval.kind==='remove'&&!approval.confirmed)); consent = true
      assert.equal((await cli(['ls','--profile',profileId])).extensions[0].version, '1.0.0')
      host.webContents.debugger.detach()
      receipt.cases.push({ kind: 'actual-production-component-renderer-api-preload-profile-ipc', installedNativeId: nativeId, actualPointerPrepareAndApplyCancelled: true, actualPointerRemovalCancelled: true, approvedLoad: guiLoaded.application, fixtureOnlyFileSelection: true })
      const update = await prepare(profileId, await source('2.0.0', { zip: true }), 'actual-update', extensionId)
      assert.ok(update.addedPermissions.includes('API: tabs')); await apply(profileId, update)
      const updated = await cli(['ls', '--profile', profileId]), second = await freshPage(profileId)
      assert.equal(updated.extensions[0].nativeId, nativeId); assert.equal(updated.extensions[0].id, extensionId); assert.equal(second.extensionVersion, '2.0.0'); assert.equal(second.extensionBackground, '2.0.0'); assert.equal(second.extensionCount, '2')
      const failing = await prepare(profileId, await source('3.0.0', { missingScript: true }), 'actual-failed-update', extensionId), rejected = await apply(profileId, failing, false)
      assert.equal(rejected.error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      const kept = await cli(['ls', '--profile', profileId, '--operation-id', 'actual-failed-update'])
      assert.equal(kept.extensions[0].version, '2.0.0'); assert.equal(kept.extensions[0].application.state, 'loaded'); assert.equal(kept.receipt, null)
      assert.equal(await contents().executeJavaScript('document.querySelector("input").value'), 'original-unsent-form')
      assert.equal(await contents().executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
      receipt.cases.push({ kind: 'actual-zip-update-failure-native-old-ack-and-original-form', extensionId, nativeId, second })
      const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
      const temporary = await prepare(profileId, await source('4.0.0', { key: otherKey }), 'temporary-install'); await apply(profileId, temporary)
      await cli(['remove', '--profile', profileId, '--expected-revision', token(profileId), '--extension', temporary.extensionId, '--operation-id', 'actual-remove'])
      const final = await cli(['ls', '--profile', profileId, '--operation-id', 'actual-remove'])
      assert.equal(final.extensions.length, 1); assert.equal(final.extensions[0].id, extensionId); assert.equal(final.receipt.kind, 'remove')
      receipt.cases.push({ kind: 'exact-removal-keeps-other-extension-and-profile', extensionId: temporary.extensionId, remaining: extensionId })
      const unknownReview = await prepare(profileId, await source('5.0.0'), 'actual-unknown-update', extensionId)
      const save = store.setExtensions.bind(store), nativeSession = profiles.sessions.nativeSession(profileId)
      let updateNativeAcknowledged = false, removalNativeAcknowledged = false
      store.setExtensions = async (...args) => {
        if (args[3].operationId === unknownReview.reviewId) {
          const actual = nativeSession.extensions.getExtension(nativeId)
          assert.equal(actual?.version, '5.0.0'); assert.equal(actual?.id, nativeId); updateNativeAcknowledged = true
          throw Error('Private before-save failure after actual native update acknowledgement')
        }
        if (args[3].operationId === 'actual-unknown-remove') {
          assert.equal(nativeSession.extensions.getExtension(nativeId), null); removalNativeAcknowledged = true
          throw Error('Private before-save failure after actual native removal acknowledgement')
        }
        return save(...args)
      }
      assert.equal((await apply(profileId, unknownReview, false)).error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      assert.equal(updateNativeAcknowledged, true); assert.equal(nativeSession.extensions.getExtension(nativeId)?.version, '2.0.0')
      const unknownRemoveRevision = token(profileId)
      assert.equal((await cli(['remove', '--profile', profileId, '--expected-revision', unknownRemoveRevision, '--extension', extensionId, '--operation-id', 'actual-unknown-remove'], false)).error.code, 'BROWSER_PROFILE_EXTENSION_UNCONFIRMED')
      assert.equal(removalNativeAcknowledged, true); assert.equal(nativeSession.extensions.getExtension(nativeId)?.version, '2.0.0')
      store.setExtensions = save
      const pending = await cli(['ls', '--profile', profileId])
      assert.ok(pending.pending.some((intent: any) => intent.operationId === unknownReview.reviewId && intent.sha256 === unknownReview.sha256 && intent.version === '5.0.0'))
      assert.ok(pending.pending.some((intent: any) => intent.operationId === 'actual-unknown-remove' && intent.nativeId === nativeId))
      receipt.cases.push({ kind: 'actual-native-update-and-removal-before-save-failures-durable-pending', updateNativeAcknowledged, removalNativeAcknowledged, pending: pending.pending, restoredNativeVersion: '2.0.0' })
      await contents().session.cookies.flushStore(); contents().session.flushStorageData()
      const saved = { profileId, extensionId, nativeId, unknownReview, unknownRemoveRevision, sha256: final.extensions[0].sha256, profileCount: profiles.listProfiles().length }
      await writeFile(join(home, 'retained.json'), JSON.stringify(saved)); receipt.retained = saved
    }
    receipt.passed = true
  } catch (error) { receipt.failure = { message: (error as Error).message, stack: (error as Error).stack }; console.error(error) }
  finally {
    await control?.stop(); browsers?.dispose(); await profiles?.dispose(); host?.destroy()
    await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
  }
}
void main()
