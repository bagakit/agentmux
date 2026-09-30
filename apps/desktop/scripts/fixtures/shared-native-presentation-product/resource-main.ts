import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'
import { topFrameOrigin, topFrameNavigationGuard } from '../../../src/main/top-frame-navigation'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const [html, privateRoot, preload, evidence, sourcePage] = process.argv.slice(2) as [string,string,string,string,string]
app.setPath('userData', join(privateRoot, 'user-data'))
app.setPath('sessionData', join(privateRoot, 'session-data'))
const receipt: any = { passed: false, pid: process.pid, phases: [], ipc: [], captures: [], mediaEvents: [], frames: [], chromeRefresh: [],
  boundary: 'Production registerIpc/preload/BVM in an exact private Window; host preparation/empty Agent services isolated. Private two-video caller proves resources only, not BrowserPane/multi-surface delivery, Native first press, OS input, IME, clipboard or Run continuity.',
  userAppRunRuntimeControls: 0, physicalInputQualified: false, T004Qualified: false }
let window: BrowserWindow, controller: RuntimeController, dispose: (() => Promise<void>) | undefined
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width: 1060, height: 460, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    const guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
    window.webContents.on('will-navigate', guard); window.webContents.on('will-redirect', guard)
    const requester = window.webContents, session = requester.session
    const install = session.setDisplayMediaRequestHandler.bind(session)
    session.setDisplayMediaRequestHandler = (handler, options) => install(handler ? (request, callback) => {
      const facts: any = { requesterId: requester.id, exactFrame: request.frame === requester.mainFrame,
        requesterDocument: request.frame?.url, securityOrigin: request.securityOrigin, userGesture: request.userGesture,
        video: request.videoRequested, audio: request.audioRequested }
      receipt.captures.push(facts)
      handler(request, streams => { facts.allowed = !!streams?.video; callback(streams) })
    } : null, options)
    const send = requester.send.bind(requester)
    requester.send = (channel, ...args) => {
      if (channel === 'agentmux:browser-presentation-event') receipt.mediaEvents.push(args[0])
      send(channel, ...args)
    }
    const register = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, listener) => register(channel, (event, ...args) => {
      if (channel.startsWith('browser:')) receipt.ipc.push({ channel, exactSender: event.sender === requester,
        exactFrame: event.senderFrame === requester.mainFrame, args })
      return listener(event, ...args)
    })
    const refresh = NativeOverlaySurfaces.prototype.refresh
    NativeOverlaySurfaces.prototype.refresh = function () {
      const fact = { channel: receipt.ipc.at(-1)?.channel, stage: receipt.stage, outcome: 'pending' }
      receipt.chromeRefresh.push(fact)
      return refresh.call(this).then(result => { fact.outcome = 'completed'; return result }, error => {
        fact.outcome = 'rejected'; throw error
      })
    }
    controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
    controller.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    const config = { ...structuredClone(DEFAULT_CONFIG), hosts: [], workspaces: [] }
    dispose = await registerIpc({ window, runtime: controller, configStore: { get: async () => config } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: {} as never,
      workspaceFiles: { dispose: async () => {} } as never })
    await window.loadFile(html); window.show(); window.focus()
    const read = (expression: string) => requester.executeJavaScript(expression)
    const until = async (name: string, condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 12000
      do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 35)) } while (Date.now() < deadline)
      throw new Error('Resource condition did not settle: ' + name)
    }
    receipt.requester = { id: requester.id, sessionSame: session === requester.session,
      frameRoutingId: requester.mainFrame.routingId, frameProcessId: requester.mainFrame.processId,
      url: requester.getURL(), focusedWindow: window.isFocused(), focusedDocument: await read('document.hasFocus()') }
    receipt.stage = 'register-original-page-and-measured-stages'
    const originalChildren = new Set(window.contentView.children)
    const started = await read(`resourceProof.start(${JSON.stringify(pathToFileURL(sourcePage).href)})`)
    // create returns the original resource before its asynchronous initial navigation commits.
    // Identify the unique newly attached owner; then observe that owner's actual document.
    const createdChildren = window.contentView.children.filter(view => !originalChildren.has(view))
    receipt.originalChildren = { before: originalChildren.size, after: window.contentView.children.length,
      added: createdChildren.map(view => ({ id: (view as WebContentsView).webContents?.id,
        url: (view as WebContentsView).webContents?.getURL(), bounds: view.getBounds() })) }
    assert.equal(createdChildren.length, 1, 'Exactly one original production Browser view was created')
    const native = createdChildren[0] as WebContentsView | undefined
    assert.ok(native, 'The actual original production Browser view exists')
    const source = native.webContents, originalId = source.id, originalSession = source.session
    receipt.original = { sourceId: source.id, requesterId: requester.id,
      sourceSessionSeparate: source.session !== session, bounds: native.getBounds(), sourceUrl: source.getURL() }
    assert.ok(native.getBounds().width > 0 && native.getBounds().height > 0, 'Original Native authority has measured positive bounds')
    await until('original source document loaded', async () => !source.isLoading() && source.getURL() === pathToFileURL(sourcePage).href)
    // Media preparation focuses this private requester only; no physical Native input qualification.
    requester.focus()
    receipt.capturePreparation = { nativeBounds: native.getBounds(), focusedDocument: await read('document.hasFocus()') }
    receipt.stage = 'initial-capture-and-play'
    const initial = await read('resourceProof.acquireInitial()')
    const facts = () => read('resourceProof.facts()')
    const color = (green: boolean) => until('two actual new video pixels', async () => {
      const observed = await facts()
      return observed.videos.length === 2 && observed.videos.every((video: any) =>
        video.frames > 0 && video.time > 0 && video.pixel && (green ? video.pixel[1] > 150 && video.pixel[0] < 70 : video.pixel[0] > 200 && video.pixel[1] < 70))
    })
    await color(false)
    receipt.phases.push({ phase: 'same-source-two-video', started, initial, facts: await facts(), sourceId: source.id,
      sameSourceSession: source.session === originalSession, viewVisible: native.getVisible(), bounds: native.getBounds() })
    receipt.stage = 'local-hide-source-reload'
    await read('resourceProof.hide(0)')
    assert.equal(native.getVisible(), false)
    await read('resourceProof.reloadSource()')
    await color(true)
    assert.equal(source.id, originalId); assert.equal(source.session, originalSession)
    assert.equal(receipt.captures.length, 1, 'Source normal reload keeps the authorized original stream')
    receipt.phases.push({ phase: 'local-hide-source-reload-continuous', facts: await facts(), sourceId: source.id,
      sourceAlive: !source.isDestroyed(), sourceUrl: source.getURL(), nativeHidden: !native.getVisible() })
    receipt.stage = 'last-visible-ended'
    await read('resourceProof.hide(1)')
    await until('actual last-visible track ended', async () => {
      const tracks = (await facts()).tracks
      return tracks.length > 0 && tracks.every((track: any) => track.readyState === 'ended')
    })
    const stopped = await facts(); assert.ok(stopped.tracks.length > 0)
    assert.equal(source.isDestroyed(), false)
    await read('resourceProof.remove(0)')
    receipt.phases.push({ phase: 'last-visible-actual-stopped-source-kept', facts: stopped, sourceId: source.id })
    requester.focus()
    receipt.stage = 'reacquire-and-requester-reload'
    const second = await read('resourceProof.reacquire()')
    await color(true)
    assert.equal(receipt.captures.length, 2)
    const oldLease = started.leases[1].leaseId
    await window.loadFile(html)
    await until('new requester document ready', () => read('Boolean(window.resourceProof)'))
    const stale = await read(`resourceProof.staleUpdate(${JSON.stringify(oldLease)})`)
    assert.equal(stale.rejected, true)
    assert.ok(receipt.mediaEvents.some((event: any) => event.captureId === second.captureId && event.reason === 'requester-ended'))
    assert.equal(source.isDestroyed(), false); assert.equal(source.id, originalId)
    receipt.phases.push({ phase: 'requester-reload-old-lease-rejected', stale, sourceId: source.id,
      actualOldTrackAfterDocumentDestruction: 'unobservable; not signed ended', mediaEvents: receipt.mediaEvents })
    const picture = (await requester.capturePage()).toPNG()
    await fs.writeFile(join(evidence, 'resource-requester-after-reload.png'), picture)
    receipt.frames.push({ file: 'resource-requester-after-reload.png', source: 'requester-WebContents-not-OS-composite' })
    assert.equal(receipt.captures.filter((request: any) => request.allowed).length, 2)
    assert.ok(receipt.ipc.length > 0 && receipt.ipc.every((call: any) => call.exactSender && call.exactFrame))
    for (const channel of ['browser:activatePresentation', 'browser:updatePresentation', 'browser:removePresentation']) {
      assert.ok(receipt.chromeRefresh.some((fact: any) => fact.channel === channel),
        'The registered presentation channel invokes the original Chrome refresh owner: ' + channel)
    }
    receipt.passed = true
  } catch (error: any) { receipt.failure = { name: error?.name ?? typeof error,
    message: error?.message ?? String(error), stack: error?.stack,
    rawValue: typeof error === 'object' ? JSON.stringify(error) : error }; process.exitCode = 1 }
  finally {
    try { await dispose?.(); await controller?.dispose() } catch (error: any) { receipt.cleanupFailure = error.message; receipt.passed = false; process.exitCode = 1 }
    receipt.cleanup = { originalOwnersDisposed: true, privateWindowDestroyedAfterPublication: true }
    await fs.writeFile(join(evidence, 'native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    window?.destroy(); app.quit()
  }
})
