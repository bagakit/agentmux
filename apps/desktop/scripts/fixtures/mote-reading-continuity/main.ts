import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import assert from 'node:assert/strict'
import { createReadingOwner } from './node-owner'
import { connectAgentMuxRpc } from '../../../../../packages/core/src/public-rpc-client'
import { registerConversationReadIpc } from '../../../src/main/conversation-read-ipc'
import { assertAppDocumentSender } from '../../../src/main/ipc-sender-trust'
import { WorkbenchDocumentSources } from '../../../src/main/workbench-document-sources'
import { readingDraft, readingSessionId } from './source'

const [html, privateRoot, evidence] = process.argv.slice(2) as [string, string, string]
app.setPath('userData', join(privateRoot, 'userData')); app.setPath('sessionData', join(privateRoot, 'sessionData'))
const result: any = { schema: 'agentmux.mote-reading-physical.v1', passed: false, userAppOrRunTouched: false,
  physicalGeometryStubbed: false, globalOsInput: false, cases: [], ipc: [], errors: [], versions: process.versions }
let win: BrowserWindow | undefined, owner: Awaited<ReturnType<typeof createReadingOwner>> | undefined
let transport: ReturnType<typeof registerConversationReadIpc> | undefined
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  try {
    await mkdir(evidence, { recursive: true }); owner = await createReadingOwner(privateRoot)
    win = new BrowserWindow({ width: 1100, height: 800, useContentSize: true, show: false,
      webPreferences: { preload: join(dirname(html), 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    const sources = new WorkbenchDocumentSources()
    const trusted = (event: any) => assertAppDocumentSender(event, win!.webContents, sources.read())
    transport = registerConversationReadIpc({ handle(channel, listener) {
      ipcMain.handle(channel, (event, ...values) => { trusted(event); result.ipc.push({ channel, args: values }); return listener(event, ...values as any) })
    }, connect: () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner!.server.path } }) })
    ipcMain.handle('private-reading:seed', event => { trusted(event); return owner!.seed })
    win.webContents.on('console-message', event => { result.errors.push({ level: event.level, message: event.message }) })
    win.webContents.on('preload-error', (_event, path, error) => { result.errors.push({ preload: path, message: error.message, stack: error.stack }) })
    win.webContents.on('did-fail-load', (_event, code, description, url) => { result.errors.push({ code, description, url }) })
    const read = (code: string) => win!.webContents.executeJavaScript(code)
    const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const until = async (code: string, label: string) => {
      for (let n = 0; n < 250; n++) { if (await read(code)) return; await delay(20) }
      throw Error('Private Mote condition not reached: ' + label)
    }
    const facts = () => read('readingProof.snapshot()')
    const readableTail = (ui: any) => ui.physical.readingTail.top - ui.physical.frame.bottom
    const checkOwner = async () => {
      const native = await owner!.facts(), ui = await facts()
      assert.deepEqual(native.controls, []); assert.deepEqual(ui.writes, [])
      assert.equal(native.store, native.originalStore); assert.equal(native.native, native.expectedNative)
      assert.equal(ui.drafts[readingSessionId], readingDraft); assert.deepEqual(ui.control.run, owner!.seed.run)
      const otherVisibleSurfaces = await read('[...document.querySelectorAll(".agent-surface")].filter(n=>!document.getElementById("pmo-teams-topic-floating-panel").contains(n)&&n.checkVisibility()&&!n.closest("[hidden],[inert],[aria-hidden=true]")).length')
      assert.equal(otherVisibleSurfaces, 0); return { native, ui, otherVisibleSurfaces }
    }
    const open = async () => {
      await read('readingProof.open()')
      await until('readingProof.snapshot().panelOpen && readingProof.snapshot().nativeIds.length >= 60 && readingProof.snapshot().physical?.clientHeight > 0', 'Original Mote actual readable viewport')
      await settle()
    }
    const capture = async (name: string) => {
      await settle(); const current = await checkOwner()
      await writeFile(join(evidence, name + '.png'), (await win!.webContents.capturePage()).toPNG())
      return current
    }
    const hideAppend = async () => {
      await read('readingProof.hide()'); await until('!readingProof.snapshot().panelOpen', 'Original Mote hidden')
      await settle(); await delay(80)
      const count = (await owner!.facts()).calls.length
      await owner!.append(); await delay(180)
      assert.equal((await owner!.facts()).calls.length, count, 'No private source reads while every original presentation is hidden')
      await open(); await until('readingProof.snapshot().nativeIds.at(-1) === "reading-original-159"', 'The same source appended records are accepted')
      await settle()
    }
    const load = async () => {
      const complete = sources.begin({ mode: 'prod', filePath: html })
      await win!.loadFile(html, { query: process.env.AGENTMUX_READING_PLACEMENT_TRACE ? { placementTrace: '1' } : {} }); sources.committed(win!.webContents.mainFrame.url); complete()
      // Private Chromium is measurable without activating or focusing any application.
      win!.showInactive()
      await until('window.readingProof?.ready === true', 'Complete synthetic App ready')
      result.executed = await read('globalThis.__moteReadingExecuted')
      await open()
    }
    await load()
    const beforeFollow = await capture('follow-before')
    assert.ok(beforeFollow.ui.physical.scrollHeight > beforeFollow.ui.physical.clientHeight, 'Natural Chromium overflow is required')
    assert.ok(Math.abs(readableTail(beforeFollow.ui)) <= 2, 'Initial original latest tail is physically visible')
    await hideAppend()
    const afterFollow = await capture('follow-after')
    assert.equal(afterFollow.ui.consumers.find((value: any) => value.gates.enabled)?.consumerId, beforeFollow.ui.consumers.find((value: any) => value.gates.enabled)?.consumerId, 'The same original reading owner resumes')
    assert.ok(Math.abs(readableTail(afterFollow.ui)) <= 2, 'Following latest must survive hide/append/show')
    assert.ok(afterFollow.ui.physical.latest.bottom <= afterFollow.ui.physical.frame.bottom + 2, 'Latest source record is in the physical viewport')
    result.cases.push({ kind: 'following', passed: true, before: beforeFollow, after: afterFollow })
    // A second private source inventory runs the same scenario; no user Session is used.
    await transport.dispose(); transport = undefined
    await owner.close(); owner = undefined
    // Native source and Store stay intact for evidence. Another fresh isolated directory
    // holds the independent upward case so it also starts with the same original 60.
    const upwardRoot = join(privateRoot, 'upward'); await mkdir(upwardRoot)
    owner = await createReadingOwner(upwardRoot)
    transport = registerConversationReadIpc({ handle(channel, listener) {
      ipcMain.removeHandler(channel); ipcMain.handle(channel, (event, ...values) => { trusted(event); result.ipc.push({ channel, args: values }); return listener(event, ...values as any) })
    }, connect: () => connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner!.server.path } }) })
    await load()
    const tail = await facts(), frame = tail.physical.frame
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2), deltaY: 340, deltaX: 0, canScroll: true })
    await until(`readingProof.snapshot().physical.scrollTop < ${JSON.stringify(tail.physical.scrollTop - 100)}`, 'Private Chromium human upward wheel')
    await settle(); await read('readingProof.rememberAnchor()'); await settle()
    const beforeUpward = await capture('upward-before')
    assert.ok(beforeUpward.ui.physical.tailDistance > 100); assert.ok(beforeUpward.ui.anchor?.id)
    await hideAppend()
    const afterUpward = await capture('upward-after')
    result.cases.push({ kind: 'upward', passed: false, before: beforeUpward, after: afterUpward })
    assert.equal(afterUpward.ui.anchor.id, beforeUpward.ui.anchor.id)
    assert.ok(Math.abs(afterUpward.ui.anchor.offset - beforeUpward.ui.anchor.offset) <= 2, 'The original visible record offset must survive hidden same-source append')
    assert.equal(afterUpward.ui.anchor.text, beforeUpward.ui.anchor.originalText, 'The original selected text stays selected')
    assert.equal(afterUpward.ui.anchor.expanded, true, 'Original expansion remains open')
    assert.ok(afterUpward.ui.physical.tailDistance > 100, 'New records must not pull an upward reader to latest')
    await read('readingProof.clearSelection()'); await settle(); await read('readingProof.jump()'); await settle()
    const returned = await capture('upward-explicit-latest')
    assert.ok(Math.abs(readableTail(returned.ui)) <= 2, 'Explicit current action uses the original follow owner')
    result.cases.at(-1).returned = returned; result.cases.at(-1).passed = true
    result.passed = true
  } catch (error) {
    result.failure = { message: String((error as Error).message), stack: (error as Error).stack }
    if (win) {
      result.dom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => null)
      result.last = await win.webContents.executeJavaScript('window.readingProof?.snapshot()').catch(() => null)
      result.startup = await win.webContents.executeJavaScript('({port:typeof window.privateReadingPort,errors:window.__readingStartupErrors})').catch(() => null)
      result.placement = await win.webContents.executeJavaScript('window.readingProof?.placement()').catch(() => null)
      await writeFile(join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {})
    }
  } finally {
    try { result.finalOwner = await owner?.facts() } catch {}
    await transport?.dispose(); await owner?.close()
    await writeFile(join(evidence, 'physical-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.quit()
  }
})
