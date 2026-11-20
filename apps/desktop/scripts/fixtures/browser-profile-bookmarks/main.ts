import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { createBrowserProfileBookmarkOpener } from '../../../src/main/browser-profile-bookmark-open.js'
import { createBrowserAutomationGate } from '../../../src/main/browser-automation-gate.js'
import { registerBrowserProfileEditorIpc } from '../../../src/main/browser-profile-editor-ipc.js'
import { THEME_BOOTSTRAP_CHANNEL } from '../../../src/shared/theme-bootstrap.js'
import { executeBrowserProfileControl } from '../../../src/main/browser-profile-control.js'
import { emitWebloc } from '../../../src/shared/bookmark-file.js'

const home = process.env.BOOKMARKS_HOME!, out = process.env.BOOKMARKS_OUT!, phase = process.env.BOOKMARKS_PHASE!, base = process.env.BOOKMARKS_BASE!, node = process.env.BOOKMARKS_NODE!
app.setActivationPolicy?.('prohibited'); app.on('window-all-closed', () => {})
const receipt: any = { passed: false, phase, pid: process.pid, cases: [], cli: [], guiCalls: [] }
let host: BrowserWindow | undefined, profiles: BrowserProfileManager | undefined, browsers: BrowserViewManager | undefined, control: AgentMuxControlServer | undefined
let guiSource = '', failAfterNavigation = false
const originalBrowserId = 'bookmark-original-browser', otherBrowserId = 'bookmark-independent-browser'
const contents = (id = originalBrowserId) => browsers!.nativeOwner(id)!.view.webContents
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function cli(method: string, input: object, success = true) {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'profile', 'bookmark', method, '--input', '-'], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !/^(AGENTMUX_|CTXMUX_)/.test(key))), NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Original bookmark CLI exceeded its bounded observation deadline')) }, 90_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data }); child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr }) }); child.stdin.end(JSON.stringify(input))
  })
  const body = JSON.parse(result.stdout || result.stderr)
  receipt.cli.push({ method, code: result.code, ...(body.result?.receipt ? { receipt: body.result.receipt } : {}), ...(body.error ? { errorCode: body.error.code } : {}) })
  assert.equal(result.code === 0, success, result.stderr + result.stdout)
  return success ? body.result : body
}
async function ready(expression: string) { for (let i = 0; i < 200; i++) { if (await host!.webContents.executeJavaScript(expression)) return; await pause(30) } throw Error('Actual GUI bookmark consumer did not reach its expected state: '+expression) }
async function click(selector: string) {
  if (!host!.webContents.debugger.isAttached()) host!.webContents.debugger.attach('1.3')
  const point = await host!.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing actual bookmark control');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await host!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
async function button(text: string) {
  const selector = await host!.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing actual named bookmark control');e.dataset.nativeClick='original';return'[data-native-click="original"]'})()`)
  await click(selector); await host!.webContents.executeJavaScript('document.querySelector("[data-native-click]")?.removeAttribute("data-native-click")')
}
async function type(selector: string, text: string) { await click(selector); await host!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }); await host!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 }); await host!.webContents.debugger.sendCommand('Input.insertText', { text }) }
async function main() {
  const metadata = join(home, 'profiles.json'), pendingBackup = join(home, 'pending-original.json')
  try {
    host = new BrowserWindow({ show: false, width: 760, height: 780, webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false, preload: join(out, 'preload.cjs') } })
    host.webContents.on('console-message', (_event, _level, message) => console.error('bookmarks-renderer:', message))
    profiles = new BrowserProfileManager(new BrowserProfileStore(metadata)); await profiles.initialize()
    const retained = phase === 'second' ? JSON.parse(await readFile(join(home, 'retained.json'), 'utf8')) : null
    const profileId = retained?.profileId ?? profiles.defaultProfileId()
    browsers = new BrowserViewManager(host, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} }, new BrowserOperationJournal(new BrowserOperationFileStore(join(home, 'browser-operations.json'))))
    const gate = createBrowserAutomationGate({ automation: () => true, profileOf: async id => browsers!.recoveryPreviewScope(id)?.profileId ?? null, agentAccess: id => profiles!.listProfiles().find(p => p.id === id)?.agentAccess !== false })
    const originalOpen = createBrowserProfileBookmarkOpener({ browsers, scope: async id => browsers!.recoveryPreviewScope(id), prepare: async id => { assert.ok(browsers!.recoveryPreviewScope(id)) }, authorize: gate })
    const openBookmark = async (request: Parameters<typeof originalOpen>[0], url: string) => {
      await originalOpen(request, url)
      if (failAfterNavigation) { for (let i=0;i<100 && contents().getURL()!==url;i++) await pause(20) }
      if (failAfterNavigation) { failAfterNavigation = false; await rename(metadata, pendingBackup); await mkdir(metadata) }
    }
    registerBrowserProfileEditorIpc({ profiles, openBookmark, handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== host!.webContents || event.senderFrame !== host!.webContents.mainFrame) throw Error('This fixture requires its original trusted Workbench frame')
      if (channel.includes('Bookmark')) receipt.guiCalls.push({ channel })
      return listener(event, ...args)
    }) })
    ipcMain.on(THEME_BOOTSTRAP_CHANNEL, event => { event.returnValue = { status: 'unavailable', message: 'Private appearance input unavailable; this fixture proves original bookmark operations.' } })
    ipcMain.handle('ui:chooseFiles', () => [guiSource]); ipcMain.handle('ui:chooseDirectory', () => home)
    ipcMain.handle('browser:listTargets', () => ({ targets: browsers!.targets(), coverage: 'complete', observedAt: Date.now() }))
    control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: (request, context) => executeBrowserProfileControl(request as never, { profiles: profiles!, usage: {} as never, network: {} as never, openBookmark }, context?.actor) }); await control.start()
    await host.loadFile(join(out, 'renderer/index.html')); await ready('Boolean(window.bookmarksNative)'); await host.webContents.executeJavaScript(`bookmarksNative.setProfile(${JSON.stringify(profiles.listProfiles().find(p=>p.id===profileId))})`)
    const list = (folderId: string | null = null, operationId?: string) => cli('ls', { profileId, folderId, ...(operationId ? { operationId } : {}) })
    if (retained) {
      assert.equal(profiles.sessions.observedSession?.(profileId), undefined); assert.equal(profiles.listProfiles().length, retained.profileCount)
      const cold = await list(null, 'native-lost-receipt'); assert.equal(cold.receipt.status, 'pending'); assert.equal(cold.pending.length, 1)
      const inside = await list(retained.folderId); assert.equal(inside.bookmarks[0].id, retained.bookmarkId); assert.equal(inside.bookmarks[0].url, retained.target)
      await cli('open', { profileId, bookmarkId: retained.bookmarkId, browserId: originalBrowserId, expectedRevision: cold.revision, operationId: 'native-lost-receipt' }, false)
      assert.equal(profiles.sessions.observedSession?.(profileId), undefined)
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'second-process-original-identities-and-pending-no-native-replay', originalProfileId: profileId, bookmarkId: retained.bookmarkId, folderId: retained.folderId, pendingOperation: cold.receipt.operationId, originalNativeSessionNotAcquired: true })
      await browsers.create(originalBrowserId, base+'/restart', undefined, profileId); browsers.setBounds(originalBrowserId, { x: 0, y: 0, width: 660, height: 500 })
      assert.equal((await contents().session.cookies.get({ name: 'profile-signin' }))[0]?.value, 'fixture-signin-kept')
      assert.equal(await contents().executeJavaScript('localStorage.getItem("profile-note")'), 'original-note-kept')
      await cli('open', { profileId, bookmarkId: retained.bookmarkId, browserId: originalBrowserId, expectedRevision: cold.revision, operationId: 'second-explicit-open' })
      for (let i=0;i<100 && contents().getURL()!==retained.target;i++) await pause(20)
      assert.equal(contents().getURL(),retained.target)
      await ready('Boolean(window.bookmarksNative)'); await click('.profile-bookmarks__heading'); await ready('document.querySelectorAll(".profile-bookmarks__receipt").length > 0')
      assert.ok((await host.webContents.executeJavaScript('document.querySelector(".profile-bookmarks").textContent')).includes('native-lost-receipt'))
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'second-process-native-signin-and-GUI-pending-discovery', originalBrowserId, originalProfileId: profileId, guiOriginalPendingVisible: true, addressExact: true })
    } else {
      const independent = await profiles.createProfile('Independent Profile')
      await browsers.create(originalBrowserId, base+'/original', undefined, profileId); browsers.setBounds(originalBrowserId, { x: 0, y: 0, width: 660, height: 500 })
      await browsers.create(otherBrowserId, base+'/independent', undefined, independent.id); browsers.setBounds(otherBrowserId, { x: 0, y: 0, width: 660, height: 500 })
      await contents().executeJavaScript('localStorage.setItem("profile-note","original-note-kept")'); await contents(otherBrowserId).executeJavaScript('document.querySelector("input").value="independent-unsent-form"')
      await contents().session.cookies.set({ url: base, name: 'profile-signin', value: 'fixture-signin-kept', expirationDate: Math.floor(Date.now()/1000)+86400 })
      const folder = await cli('edit', { profileId, expectedRevision: 'empty', operationId: 'native-folder', change: { kind: 'create-folder', parentId: null, label: 'Retained folder' } }), folderId = folder.receipt.entryId
      const target = base+'/target?term=exact+value&mode=one#panel', saved = await cli('edit', { profileId, expectedRevision: folder.revision, operationId: 'native-save', change: { kind: 'save', folderId, title: 'Retained address', url: target } }), bookmarkId = saved.receipt.entryId
      const opened = await cli('open', { profileId, bookmarkId, browserId: originalBrowserId, expectedRevision: saved.revision, operationId: 'native-open' }); assert.equal(opened.receipt.status, 'completed')
      for (let i=0;i<100 && contents().getURL()!==target;i++) await pause(20); assert.equal(contents().getURL(),target)
      const wrong = await cli('open', { profileId, bookmarkId, browserId: otherBrowserId, expectedRevision: saved.revision, operationId: 'native-wrong-profile' }); assert.equal(wrong.receipt.status,'failed'); assert.equal(contents(otherBrowserId).getURL(),base+'/independent')
      assert.equal(await contents(otherBrowserId).executeJavaScript('document.querySelector("input").value'),'independent-unsent-form')
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'actual-public-CLI-native-exact-profile-and-full-address', originalProfileId: profileId, bookmarkId, folderId, sameBrowserId: originalBrowserId, wrongProfileUntouched: true })
      let calls = 0, allowed = true
      const guarded = createBrowserProfileBookmarkOpener({ browsers, scope: async id => browsers!.recoveryPreviewScope(id), prepare: async () => {}, authorize: async (id, caller) => { if (++calls === 3) allowed = false; if (!allowed) throw Error('Fixture original authority changed'); await gate(id,caller) } })
      await assert.rejects(guarded({ profileId, browserId: originalBrowserId, operationId: 'native-dispatch-guard', caller: { agentSessionId: 'original-native-agent' } }, base+'/must-not-dispatch'))
      assert.equal(calls,3); assert.equal(contents().getURL(),target)
      const keptOwner = await cli('open', { profileId, bookmarkId, browserId: originalBrowserId, expectedRevision: (await list()).revision, operationId: 'native-human-before-handoff' }); assert.equal(keptOwner.receipt.status, 'failed'); assert.equal(contents().getURL(), target); browsers.takeControl(originalBrowserId)
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'actual-original-runScript-dispatch-authority-recheck', originalProfileId: profileId, originalBrowserId, checks: calls, originalPageKept: true })
      const workspace = join(home,'Workspace.webloc'); await writeFile(workspace,emitWebloc(base+'/workspace?exact=yes#fragment'))
      const sourceBytes = await readFile(workspace), imported = await cli('import', { profileId, folderId: null, expectedRevision: (await list()).revision, operationId: 'native-webloc', sourcePath: workspace }); assert.equal(imported.receipt.createdIds.length,1); assert.deepEqual(await readFile(workspace),sourceBytes)
      const output = join(home,'scoped-export.html'); await cli('export',{profileId,folderId,expectedRevision:imported.revision,operationId:'native-export',destinationPath:output}); const html=await readFile(output,'utf8'); assert.ok(html.includes('term=exact+value&amp;mode=one#panel'))
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'original-Workspace-reader-and-scoped-standard-export', sourceBytesPreserved: true, originalFolderId: folderId })
      await ready('Boolean(window.bookmarksNative)'); host.webContents.debugger.attach('1.3')
      await click('.profile-bookmarks__heading'); await ready(`Boolean(document.querySelector('[aria-label="Bookmark Browser"]'))`)
      await button('New bookmark'); await ready(`Boolean(document.querySelector('[aria-label="Bookmark edit"]'))`)
      await type('form[aria-label="Bookmark edit"] input','GUI original bookmark'); await type('[aria-label="Bookmark address"]',base+'/gui?term=kept#route'); await button('Save')
      await ready(`!document.querySelector('[aria-label="Bookmark edit"]')`); assert.ok((await list()).bookmarks.some((b:any)=>b.title==='GUI original bookmark' && b.url===base+'/gui?term=kept#route'))
      await host.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[aria-label="Bookmark Browser"]');e.value=${JSON.stringify(originalBrowserId)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      const entry = await host.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('[data-bookmark-entry]')].find(e=>e.textContent.includes('GUI original bookmark'));e.dataset.nativeEntry='true';return'[data-native-entry="true"]'})()`); await click(entry)
      await ready('document.querySelector(".profile-bookmarks").textContent.includes("Open request sent")')
      for(let i=0;i<100 && contents().getURL()!==base+'/gui?term=kept#route';i++)await pause(20);assert.equal(contents().getURL(),base+'/gui?term=kept#route')
      guiSource=join(home,'gui-import.html');await writeFile(guiSource,'<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="'+base+'/gui-import?one=two#route">GUI imported</A></DL><p>');await button('Import…');await ready('document.querySelector(".profile-bookmarks").textContent.includes("GUI imported")')
      await button('Export…');await button('Choose destination folder…');await ready('document.querySelector(".profile-bookmarks").textContent.includes("Destination selected")');await button('Export new file');await ready(`!document.querySelector('[aria-label="Bookmark edit"]')`);assert.ok((await readFile(join(home,'bookmarks.html'),'utf8')).includes('GUI imported'))
      host.webContents.debugger.detach(); for (const method of ['listProfileBookmarks', 'editProfileBookmark', 'openProfileBookmark', 'importProfileBookmarks', 'exportProfileBookmarks']) assert.ok(receipt.guiCalls.some((c:any)=>c.channel==='browser:'+method), 'Actual GUI consumes '+method)
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'actual-production-Renderer-preload-IPC-owner-native-GUI', fiveBusinessMethods: true, originalAddressExact: true, actualPointerInput: true })
      const revision=(await list()).revision, beforeUrl=contents().getURL()
      await chmod(home,0o500);await cli('open',{profileId,bookmarkId,browserId:originalBrowserId,expectedRevision:revision,operationId:'native-before-save'},false);await chmod(home,0o700);assert.equal(contents().getURL(),beforeUrl)
      failAfterNavigation=true;await cli('open',{profileId,bookmarkId,browserId:originalBrowserId,expectedRevision:revision,operationId:'native-lost-receipt'},false);assert.equal(contents().getURL(),target)
      await rm(metadata,{recursive:true});await rename(pendingBackup,metadata)
      const pending=await list(null,'native-lost-receipt');assert.equal(pending.receipt.status,'pending')
      const retained={profileId,folderId,bookmarkId,target,profileCount:profiles.listProfiles().length};await writeFile(join(home,'retained.json'),JSON.stringify(retained));receipt.retained=retained
      console.error('bookmarks-proof: confirmed case '+(receipt.cases.length+1)); receipt.cases.push({ kind: 'real-before-save-IO-failure-and-native-effect-before-receipt-save-failure', beforeSaveNoNavigation: true, afterNativeOriginalIntentRetained: true, operationId:'native-lost-receipt' })
      await contents().session.flushStorageData()
    }
    receipt.passed=true
  } catch(error) { receipt.failure={message:(error as Error).message,stack:(error as Error).stack};try { receipt.renderer = await host?.webContents.executeJavaScript('window.bookmarksNative?.read()') } catch {} console.error(error) }
  finally { await chmod(home,0o700).catch(()=>{});await control?.stop();browsers?.dispose();await profiles?.dispose();host?.destroy();await writeFile(join(out,phase+'.json'),JSON.stringify(receipt,null,2));app.exit(receipt.passed?0:1) }
}
void main()
