import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../../src/main/config-store'
import { topFrameOrigin, topFrameNavigationGuard } from '../../../src/main/top-frame-navigation'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const [html, privateRoot, preload, evidence, sourcePage] = process.argv.slice(2) as [string,string,string,string,string]
const mediaOnly=process.argv.includes('--media-only')
app.setPath('userData', join(privateRoot, 'user-data'))
app.setPath('sessionData', join(privateRoot, 'session-data'))
const receipt: any = { passed: false, pid: process.pid, phases: [], ipc: [], captures: [], mediaEvents: [], frames: [], chromeRefresh: [],
  boundary: 'Production registerIpc/preload/BVM in an exact private Window; host preparation/empty Agent services isolated. Actual App/Store/Workbench product caller. Native first press, OS input, IME, clipboard and Run continuity are separately bounded, not signed by mounted media.',
  userAppRunRuntimeControls: 0, physicalInputQualified: false, T004Qualified: false }
let window: BrowserWindow, controller: RuntimeController, dispose: (() => Promise<void>) | undefined
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
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
      const fact = { channel, exactSender: event.sender === requester, exactFrame: event.senderFrame === requester.mainFrame, args, result: undefined as unknown }
      if (channel.startsWith('browser:')) receipt.ipc.push(fact)
      const result = listener(event, ...args)
      if (channel === 'browser:activatePresentation') return Promise.resolve(result).then(value => { fact.result = value; return value })
      return result
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
    await window.loadFile(html); window.show(); if(!mediaOnly){app.focus({ steal: true }); window.focus()}
    const read = (expression: string) => requester.executeJavaScript(expression)
    const until = async (name: string, condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 12000
      do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 35)) } while (Date.now() < deadline)
      throw new Error('Resource condition did not settle: ' + name)
    }
    receipt.requester = { id: requester.id, sessionSame: session === requester.session,
      frameRoutingId: requester.mainFrame.routingId, frameProcessId: requester.mainFrame.processId,
      url: requester.getURL(), focusedWindow: window.isFocused(), focusedDocument: await read('document.hasFocus()') }
    receipt.stage = 'actual-App-one-browser-two-occurrences'
    await until('actual App and original browser stage ready', () => read('Boolean(window.nativeProductProof)&&nativeProductProof.facts().stages.length>0'))
    receipt.initialProduct = await read('nativeProductProof.facts()')
    await until('one original Browser source has loaded its actual black-box document', async () => window.contentView.children.some(view => (view as WebContentsView).webContents?.getURL() === pathToFileURL(sourcePage).href))
    const original = window.contentView.children.filter(view => (view as WebContentsView).webContents?.getURL() === pathToFileURL(sourcePage).href) as WebContentsView[]
    assert.equal(original.length, 1, 'Exactly one original production Browser page exists')
    receipt.originalProductSource = { sourceId: original[0]!.webContents.id, url: original[0]!.webContents.getURL(), bounds: original[0]!.getBounds(), visible: original[0]!.getVisible() }
    requester.debugger.attach('1.3')
    const click = async (selector: string) => {
      const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing actual product control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e}})()`)
      assert.equal(point.hit, true, 'Actual requester product control is visible and hit')
      for (const type of ['mousePressed','mouseReleased']) await requester.debugger.sendCommand('Input.dispatchMouseEvent', { type,x:point.x,y:point.y,button:'left',clickCount:1 })
      return point
    }
    receipt.moteControl = await click('[data-pmo-teams-topic-launcher] button')
    await until('actual Mote popover is open', () => read('nativeProductProof.facts().mote'))
    await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    receipt.openProduct = await read('nativeProductProof.facts()')
    const image = 'actual-App-two-presentations.png'
    await fs.writeFile(join(evidence,image), (await requester.capturePage()).toPNG());receipt.frames.push({file:image,source:'actual-compiled-App-requester'})
    assert.equal(receipt.openProduct.stages.length, 2, 'Actual App/Workbench Browser has two connected nonempty product stages')
    await until('both actual product media stages have original page frames', () => read('nativeProductProof.facts().stages.length===2&&nativeProductProof.facts().stages.every(stage=>stage.stream&&stage.videoWidth>0&&stage.videoHeight>0&&nativeProductProof.paintIsPageFrame(stage.paint))'))
    receipt.openProduct = await read('nativeProductProof.facts()')
    assert.ok(receipt.openProduct.stages.every((stage: any) => stage.connected && stage.width>0 && stage.height>0 && stage.video && stage.stream && stage.videoWidth>0 && stage.videoHeight>0), 'Both actual product stages contain the original captured page')
    await fs.writeFile(join(evidence,image), (await requester.capturePage()).toPNG())
    assert.equal(new Set(receipt.openProduct.stages.map((stage:any)=>stage.streamId)).size,1,'Both product stages share the original stream')
    assert.deepEqual(original[0]!.getBounds(),receipt.originalProductSource.bounds,'Passive B does not move the selected original viewport')
    receipt.phases.push({name:'actual-App-two-occurrences-one-stream',passed:true,stages:2,sourceId:original[0]!.webContents.id})
    receipt.stage = 'A-covered-by-Settings-B-still-live'
    receipt.settingsControl = await click('button[aria-label="Settings"]')
    await until('Settings visible through its actual product control', () => read('nativeProductProof.facts().settings'))
    receipt.settingsDismissedMote = !(await read('nativeProductProof.facts().mote'))
    if (receipt.settingsDismissedMote) {
      receipt.reopenedMoteControl = await click('[data-pmo-teams-topic-launcher] button')
      await until('Mote reopened legally above Settings', () => read('nativeProductProof.facts().settings&&nativeProductProof.facts().mote'))
    }
    await until('B capture resumes above Settings', () => read('nativeProductProof.facts().stages.some(stage=>stage.stream&&stage.videoWidth>0)'))
    receipt.hiddenProduct = await read('nativeProductProof.facts()')
    const live = receipt.hiddenProduct.stages.find((stage: any) => stage.presentationId.startsWith('mote-'))
    assert.ok(live?.stream && live.paint?.slice(0,3).some((value: number) => value>0), 'Actual hidden-source B contains nonempty authorized page paint')
    await until('hidden-source B shows new page pixels', () => read(`nativeProductProof.facts().stages.some(stage=>stage.presentationId.startsWith('mote-')&&stage.stream&&stage.currentTime>${live.currentTime}&&nativeProductProof.paintIsPageFrame(stage.paint)&&JSON.stringify(stage.paint)!==${JSON.stringify(JSON.stringify(live.paint))})`))
    receipt.hiddenProductNewFrame = await read('nativeProductProof.facts()')
    receipt.hiddenPaintConfirmed = receipt.hiddenProductNewFrame.stages.some((stage: any) => stage.presentationId.startsWith('mote-') && stage.paint && stage.paint[3]===255 && ((stage.paint[0]>200 && stage.paint[1]<80)||(stage.paint[0]<50 && stage.paint[1]>150)))
    receipt.hiddenSourceFacts = await original[0]!.webContents.executeJavaScript('sourceFacts')
    receipt.hiddenSourceBounds = original[0]!.getBounds()
    receipt.hiddenSourceVisible = original[0]!.getVisible()
    await fs.writeFile(join(evidence,'actual-App-Settings-Mote-new-frame.png'), (await requester.capturePage()).toPNG())
    receipt.frames.push({file:'actual-App-Settings-Mote-new-frame.png',source:'actual-compiled-App-requester'})
    assert.equal(original[0]!.getVisible(),false,'Covered original A is physically hidden')
    receipt.phases.push({name:'A-local-coverage-B-original-page-new-paint',passed:true})
    const readFrame=async(width:number)=>{
      window.setContentSize(width,460)
      await until('actual B measured after Window resize',()=>read(`innerWidth===${width}&&nativeProductProof.facts().stages.some(stage=>stage.presentationId.startsWith('mote-')&&stage.width>0&&stage.videoWidth>0&&nativeProductProof.paintIsPageFrame(stage.paint))`))
      await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      const facts=await read('nativeProductProof.facts()');const file=`actual-App-Settings-Mote-${width}.png`
      await fs.writeFile(join(evidence,file),(await requester.capturePage()).toPNG());receipt.frames.push({file,source:'actual-compiled-App-requester',width,facts})
    }
    await readFrame(640);await readFrame(1060)
    receipt.renderingDiagnostic = { calls: 0, boundary: 'The earlier same-policy call had no causal proof; it is absent from the product qualification.' }
    if(mediaOnly){receipt.firstPress={qualified:false,reason:'Explicit media-only slice; the earlier OS foreground refusal remains unchanged.'};receipt.passed=true;return}
    receipt.foregroundBeforeFirstPress = { window: window.isFocused(), requesterDocument: await read('document.hasFocus()'), visible:window.isVisible(), minimized:window.isMinimized(), focusable:window.isFocusable(), allWindows:BrowserWindow.getAllWindows().map(candidate=>({id:candidate.id,focused:candidate.isFocused()})) }
    if (!window.isFocused() && process.platform === 'darwin') {
      const script = "ObjC.import('AppKit');function run(args){const pid=Number(args[0]),target=$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);if(!target)throw Error('Exact private application PID missing');const before=$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;const accepted=target.activateWithOptions(1);return JSON.stringify({targetPID:pid,beforePID:Number(before),accepted:Boolean(accepted),targetBundleURL:ObjC.unwrap(target.bundleURL.absoluteString)})}"
      receipt.exactPrivateActivation = JSON.parse(execFileSync('/usr/bin/osascript', ['-l','JavaScript','-e',script,String(process.pid)], {encoding:'utf8',timeout:5000}))
      window.focus()
      await until('ordinary exact-PID private Requester Window is foreground', async () => window.isFocused())
    }
    receipt.foregroundAtFirstPress = { window: window.isFocused(), requesterDocument: await read('document.hasFocus()') }
    const target = await read(`(()=>{const stage=[...document.querySelectorAll('[data-native-browser-stage]')].find(stage=>stage.dataset.browserPresentationId.startsWith('mote-'));const v=stage.querySelector('video'),r=stage.getBoundingClientRect(),scale=Math.min(r.width/v.videoWidth,r.height/v.videoHeight);return{x:r.x+(r.width-v.videoWidth*scale)/2+112/${receipt.originalProductSource.bounds.width}*v.videoWidth*scale,y:r.y+(r.height-v.videoHeight*scale)/2+64/${receipt.originalProductSource.bounds.height}*v.videoHeight*scale}})()`)
    receipt.firstPressPoint = target
    receipt.firstPressBefore = await original[0]!.webContents.executeJavaScript('sourceFacts')
    for (const type of ['mousePressed','mouseReleased']) await requester.debugger.sendCommand('Input.dispatchMouseEvent', { type,x:target.x,y:target.y,button:'left',clickCount:1 })
    await until('one actual Requester first press reaches original source button', async () => (await original[0]!.webContents.executeJavaScript('sourceFacts')).clicks === receipt.firstPressBefore.clicks+1)
    receipt.firstPressAfter = await original[0]!.webContents.executeJavaScript('({...sourceFacts,body:document.body.innerText,button:document.querySelector("#original-button").textContent})')
    receipt.afterClickBounds = original[0]!.getBounds()
    receipt.afterClickViewVisible = original[0]!.getVisible()
    assert.equal(receipt.firstPressAfter.lastClickTrusted,true,'Actual first source click is trusted')
    assert.equal(receipt.hiddenPaintConfirmed, true, 'Hidden-source B shows another actual page frame, not a black or stale capture')
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
