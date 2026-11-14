import assert from 'node:assert/strict'
import { localRuntimeConnector } from '../../../test/helpers/local-runtime-connector'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { registerIpc } from '../../../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { createDesktopApplicationAccessOwner } from '../../../src/main/application-access-owner'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { WorkbenchUserStateStore } from '../../../src/main/workbench-user-state'
import { WorkbenchWindows } from '../../../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../../../src/main/workbench-window-store'
import { topFrameOrigin, topFrameNavigationGuard } from '../../../src/main/top-frame-navigation'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'

const [html, privateRoot, preload, evidence, sourcePage] = process.argv.slice(2) as [string,string,string,string,string]
const mediaOnly=process.argv.includes('--media-only')
const surveyInitial=process.argv.includes('--survey-initial')
const previewFailure=process.argv.includes('--survey-preview-failure')
const moteResponsive = process.argv.includes('--mote-responsive')
app.setPath('userData', join(privateRoot, 'user-data'))
app.setPath('sessionData', join(privateRoot, 'session-data'))
const receipt: any = { passed: false, pid: process.pid, phases: [], ipc: [], captures: [], mediaEvents: [], frames: [], chromeRefresh: [],
  boundary: 'Production registerIpc/preload/BVM in an exact private Window; host preparation/empty Agent services isolated. Actual App/Store/Workbench product caller. Native first press, OS input, IME, clipboard and Run continuity are separately bounded, not signed by mounted media.',
  userAppRunRuntimeControls: 0, physicalInputQualified: false, T004Qualified: false }
let window: BrowserWindow, controller: RuntimeController, workbenchWindows: WorkbenchWindows | undefined, dispose: (() => Promise<void>) | undefined
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy(surveyInitial ? 'accessory' : 'regular')
    window = new BrowserWindow({ width: 1060, height: moteResponsive ? 720 : 460, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    const guard = topFrameNavigationGuard(topFrameOrigin({ rendererDevServerUrl: undefined, packagedRendererFilePath: html }))
    window.webContents.on('will-navigate', guard); window.webContents.on('will-redirect', guard)
    const requester = window.webContents, session = requester.session
    const rendererErrors: string[] = []
    receipt.rendererErrors = rendererErrors
    requester.on('console-message', event => {
      if (event.level === 'error' && rendererErrors.length < 20) rendererErrors.push(event.message)
    })
    requester.on('preload-error', (_event, _path, error) => rendererErrors.push(error.message))
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
      if (channel.startsWith('browser:') || channel === 'ui:openExternal') receipt.ipc.push(fact)
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
    const scratchTopics = new ScratchTopics()
    controller = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector, scratchTopics)
    controller.prepare = async () => ({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    const privateWorkspace = { id: '__scratch__', hostId: 'local', path: join(privateRoot,'topics'), name: 'Topics', kind: 'folder' as const }
    if (surveyInitial || moteResponsive) await fs.mkdir(privateWorkspace.path,{recursive:true})
    const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: surveyInitial || moteResponsive ? [privateWorkspace] : [] }
    const notes = new AgentMuxNotesStorage(undefined, join(privateRoot, 'notes'))
    assert.ok(notes.locatorPath.startsWith(privateRoot + '/'), 'The fixture must own the original Notes locator')
    await fs.mkdir(join(privateRoot, 'state'), { recursive: true })
    await fs.writeFile(notes.locatorPath, JSON.stringify({ schemaVersion: 1, directory: join(privateRoot, 'notes'), operations: {}, pending: null }))
    workbenchWindows = new WorkbenchWindows(window, new WorkbenchWindowStore(join(privateRoot, 'windows.json')), () => [])
    dispose = await registerIpc({
      appDocumentSources: () => ({ current: { mode: 'prod', filePath: html }, loading: null }),
      window, workbenchWindows, runtime: controller, initialConfig: config,
      configStore: new ConfigStore(join(privateRoot, 'config.json')), scratchTopics,
      workbenchUserState: new WorkbenchUserStateStore(join(privateRoot, 'workbench-user-state.json')),
      applicationAccess: createDesktopApplicationAccessOwner(controller, join(privateRoot, 'applications.sqlite'))
    })
    await window.loadFile(html, surveyInitial || moteResponsive ? { query: {
      workspace: privateWorkspace.path, ...(surveyInitial ? { survey: '1' } : { 'mote-responsive': '1' }),
      ...(previewFailure ? {'preview-failure':'1'} : {})
    } } : {}); if(surveyInitial)window.showInactive();else window.show(); if(!mediaOnly){app.focus({ steal: true }); window.focus()}
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
    try {
      await until('actual App and original browser stage ready', () => read('Boolean(window.nativeProductProof)&&nativeProductProof.facts().stages.length>0'))
    } catch (error) {
      receipt.rendererBoot = await read('({ready:document.readyState, api:!!window.agentmux, app:!!window.nativeProductProof, rootChildren:document.getElementById("root")?.childElementCount})')
      throw error
    }
    receipt.initialProduct = await read('nativeProductProof.facts()')
    await until('one original Browser source has loaded its actual black-box document', async () => window.contentView.children.some(view => (view as WebContentsView).webContents?.getURL() === pathToFileURL(sourcePage).href))
    const original = window.contentView.children.filter(view => (view as WebContentsView).webContents?.getURL() === pathToFileURL(sourcePage).href) as WebContentsView[]
    assert.equal(original.length, 1, 'Exactly one original production Browser page exists')
    receipt.originalProductSource = { sourceId: original[0]!.webContents.id, url: original[0]!.webContents.getURL(), bounds: original[0]!.getBounds(), visible: original[0]!.getVisible() }
    if (moteResponsive) {
      await until('Space still owns one visible native Browser', async () => original[0]!.getVisible() && original[0]!.getBounds().width > 0)
      receipt.originalProductSource.bounds = original[0]!.getBounds()
      receipt.originalProductSource.visible = original[0]!.getVisible()
      const page = original[0]!.webContents
      await page.executeJavaScript(`document.querySelector('#original-input').value = 'Unsent original page text'`)
    }
    requester.debugger.attach('1.3')
    const click = async (selector: string) => {
      const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing actual product control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest(${JSON.stringify(selector)})===e}})()`)
      assert.equal(point.hit, true, 'Actual requester product control is visible and hit')
      if (surveyInitial) {
        await read(`document.querySelector(${JSON.stringify(selector)}).click()`)
        return { ...point, activation: 'original-product-DOM-click', physicalInputQualified: false }
      }
      for (const type of ['mousePressed','mouseReleased']) await requester.debugger.sendCommand('Input.dispatchMouseEvent', { type,x:point.x,y:point.y,button:'left',clickCount:1 })
      return point
    }
    if (surveyInitial) {
      const live = () => read('nativeProductProof.facts().stages.some(stage=>stage.presentationId.startsWith("survey-")&&stage.stream&&stage.videoWidth>0&&nativeProductProof.paintIsPageFrame(stage.paint))')
      if (previewFailure) {
        await until('local preview recovery control', () => read('!!document.querySelector(".global-survey-surface .browser-presentation-notice > button")'))
        for (const width of [1060,640]) {
          window.setContentSize(width,460)
          await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
          const geometry = await read('(()=>{const pane=document.querySelector(".global-survey-surface .browser-surface"),notice=pane.querySelector(".browser-presentation-notice"),stage=pane.querySelector(".browser-stage");return {pane:pane.getBoundingClientRect().toJSON(),notice:notice.getBoundingClientRect().toJSON(),stage:stage.getBoundingClientRect().toJSON()}})()')
          assert.ok(geometry.notice.bottom <= geometry.stage.top + 1, 'Notice is above the actual Native viewport')
          assert.ok(geometry.notice.width <= geometry.pane.width, 'Notice does not create a sibling Region')
          const file = `actual-Survey-preview-recovery-${width}.png`
          await fs.writeFile(join(evidence,file),(await requester.capturePage()).toPNG())
          receipt.frames.push({file,source:'actual-compiled-App-injected-media-failure',width,geometry})
        }
        receipt.previewFailure = {injected:true,boundary:'Only first media acquisition rejects; original Native page, IPC, lease and second real stream are unmodified'}
        receipt.retryControl = await click('.global-survey-surface .browser-presentation-notice > button')
      }
      await until('fresh Survey gets actual original page paint', live)
      receipt.openProduct = await read('nativeProductProof.facts()')
      const selects = receipt.ipc.filter((fact: any) => fact.channel === 'browser:activatePresentation' && fact.result?.outcome === 'selected')
      assert.equal(selects.length, 1, 'Fresh Survey selects once before capture')
      const selected = receipt.ipc.find((fact: any) => fact.channel === 'browser:registerPresentation' && fact.args[0]?.occurrence.presentationId.startsWith('survey-'))
      assert.ok(selected, 'Exact Survey registration exists')
      assert.equal(original[0]!.getVisible(), true, 'Fresh original page is physically visible')
      receipt.sourceDocument = await original[0]!.webContents.executeJavaScript('({readyState:document.readyState,visibilityState:document.visibilityState,sourceFacts})')
      assert.equal(receipt.sourceDocument.visibilityState, 'visible')
      const frame = async (width: number) => {
        window.setContentSize(width, 460); await until('Survey paint survives width change', live)
        await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
        const file = `actual-Survey-native-${width}.png`
        await fs.writeFile(join(evidence,file),(await requester.capturePage()).toPNG())
        receipt.frames.push({file,source:'actual-compiled-App-original-Native-page',width})
      }
      await frame(1060); await frame(640)
      receipt.settingsControl = await click('button[aria-label="Settings"]')
      await until('Settings clears only current visible presentation', async () => (await read('nativeProductProof.facts().settings')) && !original[0]!.getVisible())
      receipt.hiddenSourceId = original[0]!.webContents.id
      receipt.returnControl = await click('button[aria-label="Settings"]')
      await until('Survey restores actual live frames after hiding', live)
      assert.equal(original[0]!.webContents.id, receipt.originalProductSource.sourceId, 'Same original Native page returns')
      receipt.restoredSource = await original[0]!.webContents.executeJavaScript('sourceFacts')
      assert.equal(receipt.restoredSource.loads, receipt.sourceDocument.sourceFacts.loads, 'No original page reload')
      await frame(1060)
      receipt.phases.push({name:'fresh-Survey-initial-selection-native-paint-and-local-Settings-restore',passed:true})
      receipt.firstPress = {qualified:false,reason:'Private source-paint scope; no OS foreground or physical input claim'}
      receipt.passed = true
      return
    }
    receipt.moteControl = await click('[data-pmo-teams-topic-launcher] button')
    await until('actual Mote popover is open', () => read('nativeProductProof.facts().mote'))
    await until('actual Mote and Space have both registered stage elements', () => read('nativeProductProof.facts().stages.length === 2'))
    receipt.openProduct = await read('nativeProductProof.facts()')
    const image = 'actual-App-two-presentations.png'
    await fs.writeFile(join(evidence,image), (await requester.capturePage()).toPNG());receipt.frames.push({file:image,source:'actual-compiled-App-requester'})
    assert.equal(receipt.openProduct.stages.length, 2, 'Actual App/Workbench Browser has two connected nonempty product stages')
    if (moteResponsive) {
      const space = receipt.openProduct.stages.find((stage: any) => !stage.presentationId.startsWith('mote-'))
      const bounds = original[0]!.getBounds()
      assert.ok(original[0]!.getVisible() && space.visible && Math.abs(bounds.width - space.width) <= 2,
        'The visible Space still owns the original native Browser while the Mote also has a stage')
      receipt.originalProductSource.bounds = bounds
    } else {
      await until('both actual product media stages have original page frames', () => read('nativeProductProof.facts().stages.length===2&&nativeProductProof.facts().stages.every(stage=>stage.stream&&stage.videoWidth>0&&stage.videoHeight>0&&nativeProductProof.paintIsPageFrame(stage.paint))'))
      receipt.openProduct = await read('nativeProductProof.facts()')
      assert.ok(receipt.openProduct.stages.every((stage: any) => stage.connected && stage.width>0 && stage.height>0 && stage.video && stage.stream && stage.videoWidth>0 && stage.videoHeight>0), 'Both actual product stages contain the original captured page')
      await fs.writeFile(join(evidence,image), (await requester.capturePage()).toPNG())
      assert.equal(new Set(receipt.openProduct.stages.map((stage:any)=>stage.streamId)).size,1,'Both product stages share the original stream')
      assert.deepEqual(original[0]!.getBounds(),receipt.originalProductSource.bounds,'Passive B does not move the selected original viewport')
      receipt.phases.push({name:'actual-App-two-occurrences-one-stream',passed:true,stages:2,sourceId:original[0]!.webContents.id})
    }
    receipt.stage = 'A-covered-by-Settings-B-still-live'
    receipt.settingsControl = await click('button[aria-label="Settings"]')
    await until('Settings visible through its actual product control', () => read('nativeProductProof.facts().settings'))
    receipt.settingsDismissedMote = !(await read('nativeProductProof.facts().mote'))
    if (receipt.settingsDismissedMote) {
      receipt.reopenedMoteControl = await click('[data-pmo-teams-topic-launcher] button')
      await until('Mote reopened legally above Settings', () => read('nativeProductProof.facts().settings&&nativeProductProof.facts().mote'))
    }
    const moteLive = () => read('nativeProductProof.facts().stages.some(stage=>stage.presentationId.startsWith("mote-")&&stage.stream&&stage.videoWidth>0&&nativeProductProof.paintIsPageFrame(stage.paint))')
    if (moteResponsive) {
      const retry = '#pmo-teams-topic-floating-panel .browser-presentation-notice > button:not([disabled])'
      let retried = false
      await until('the only visible Mote stage has actual page paint', async () => {
        if (await moteLive()) return true
        if (!retried && await read(`document.querySelector(${JSON.stringify(retry)})?.checkVisibility() ?? false`)) {
          receipt.previewRetry = await click(retry)
          retried = true
        }
        return false
      })
    } else {
      await until('B capture resumes above Settings', moteLive)
    }
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
    if (moteResponsive) {
      const originalView = original[0]!, page = originalView.webContents
      const originalFact = receipt.openProduct
      const toolbarSelector = '#pmo-teams-topic-floating-panel .browser-surface[data-browser-surface="product-browser"] .browser-toolbar'
      const moreSelector = toolbarSelector + ' button[aria-label="More browser tools"]'
      const measureToolbar = () => read(`(() => {
        const toolbar = document.querySelector(${JSON.stringify(toolbarSelector)})
        const measure = name => {
          const button = toolbar?.querySelector('button[aria-label="' + name + '"]')
          if (!button) return null
          const rect = button.getBoundingClientRect().toJSON()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return { rect, hit: button.contains(hit), enabled: !button.disabled, visible: button.checkVisibility() }
        }
        return { rect: toolbar?.getBoundingClientRect().toJSON(), close: measure('Close split'), more: measure('More browser tools') }
      })()`)
      const measure = async () => {
        const facts = await read('nativeProductProof.facts()')
        const stage = facts.stages.find((stage: any) => stage.presentationId.startsWith('mote-'))
        const native = originalView.getBounds()
        const document = await page.executeJavaScript(`({
          width: innerWidth, height: innerHeight, navigation: performance.timeOrigin,
          originalText: document.querySelector('#original-input').value, loads: sourceFacts.loads
        })`)
        return { facts, stage, native, document, toolbar: await measureToolbar(), visible: originalView.getVisible(), zoom: page.getZoomFactor(), sourceId: page.id }
      }
      type Measurement = Awaited<ReturnType<typeof measure>>
      // Browser chrome retains the focus ring outside its native surface.
      // Allow its two edges plus device-independent rounding around the DOM Stage.
      const fits = ({ stage, native, document, zoom }: Measurement) => stage?.visible && stage.videoWidth > 0 &&
        Math.abs(native.width - stage.width) <= 3 && Math.abs(native.height - stage.height) <= 3 &&
        Math.abs(document.width * zoom - native.width) <= 2 && Math.abs(document.height * zoom - native.height) <= 2 &&
        Math.abs(stage.videoWidth / stage.videoHeight - native.width / native.height) <= 0.02
      const capture = async (file: string, frame: Measurement) => {
        await fs.writeFile(join(evidence, file), (await requester.capturePage()).toPNG())
        receipt.frames.push({ file, source: 'actual-compiled-App-requester', frame })
      }
      let frame = await measure()
      assert.equal(originalFact.regionLayout.root.ratio, 0.64, 'The original Tab is an asymmetric Agent and Browser split')
      assert.equal(originalFact.browser.viewport, 'responsive', 'The original page uses its default Responsive viewport')
      assert.equal(frame.facts.stages.filter((stage: any) => stage.visible).length, 1, 'Only the Mote presentation is visible')
      assert.ok(Math.abs(frame.stage.width - receipt.originalProductSource.bounds.width) > 32, 'The old native viewport differs from the right Region by visible geometry')
      const originalNavigation = frame.document.navigation
      const assertOriginal = (proof: Measurement) => {
        assert.equal(proof.visible, false, 'The Mote preview did not take native input')
        assert.equal(proof.sourceId, receipt.originalProductSource.sourceId, 'The original native WebContents remains the same')
        assert.equal(proof.document.navigation, originalNavigation, 'The original document was not replaced')
        assert.equal(proof.document.loads, 1, 'The original page was not reloaded')
        assert.equal(proof.document.originalText, 'Unsent original page text', 'The original page input value was preserved')
        assert.deepEqual(proof.facts.browser, originalFact.browser, 'The exact Browser navigation and viewport mode were preserved')
        assert.deepEqual(proof.facts.regionLayout, originalFact.regionLayout, 'The exact Tab geometry and Region identity were retained')
        assert.deepEqual(proof.facts.siblingSessions, originalFact.siblingSessions, 'The sibling Agent binding remains in place')
        assert.equal(receipt.ipc.filter((fact: any) => fact.channel === 'browser:activatePresentation').length, 1, 'Only the original Space acquired native input')
      }
      const observedFrame = async (name: string) => {
        // Keep the reproduced screenshot even when the real native geometry never follows.
        try {
          await until('live capture follows the original Mote geometry', async () => {
            frame = await measure()
            return fits(frame)
          })
        } catch (error) {
          await capture(name, frame)
          throw new Error('Responsive Mote preview did not follow its only visible right Region', { cause: error })
        }
        await capture(name, frame)
        assertOriginal(frame)
        return frame
      }
      const assertToolbar = (proof: Measurement) => {
        const { rect, close, more } = proof.toolbar
        for (const [label, button] of [['Close split', close], ['More browser tools', more]]) {
          assert.ok(button?.visible && button.enabled && button.hit && button.rect.width > 0 && button.rect.height > 0,
            label + ' remains visible and hit-testable in the actual Browser toolbar')
          assert.ok(button.rect.left >= rect.left - 1 && button.rect.right <= rect.right + 1 &&
            button.rect.top >= rect.top - 1 && button.rect.bottom <= rect.bottom + 1, label + ' stays inside the toolbar')
        }
        assert.ok(more.rect.right <= close.rect.left + 1, 'More and Close have separate pointer targets')
      }
      const verifyMore = async (proof: Measurement) => {
        const { more } = proof.toolbar
        // CDP pointer input does not itself move physical WebContents focus like
        // a click on the native app chrome. Establish that prerequisite explicitly.
        if (!window.isFocused()) { app.focus({ steal: true }); window.focus() }
        requester.focus()
        const chromeFocus = { window: window.isFocused(), renderer: requester.isFocused(), document: await read('document.hasFocus()') }
        await read(`(() => {
          if (window.moteToolbarInputs) { window.moteToolbarInputs.length = 0; return }
          window.moteToolbarInputs = []
          const record = event => {
            const target = event.target instanceof Element ? event.target.closest('button,[role="menuitem"]') : null
            window.moteToolbarInputs.push({ type: event.type, trusted: event.isTrusted,
              action: target?.getAttribute('aria-label') ?? null, key: event instanceof KeyboardEvent ? event.key : null })
          }
          for (const type of ['pointerover', 'pointerdown', 'click', 'keydown']) document.addEventListener(type, record, { capture: true })
        })()`)
        await requester.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved',
          x: more.rect.x + more.rect.width / 2, y: more.rect.y + more.rect.height / 2 })
        const point = await click(moreSelector)
        const readMenu = () => read(`(() => {
          const toggle = document.querySelector(${JSON.stringify(moreSelector)})
          const menus = [...document.querySelectorAll('.browser-menu[data-state="open"]')].filter(menu => menu.checkVisibility())
          const external = menus[0]?.querySelector('[aria-label="Open in external browser"]:not([aria-disabled="true"])')
          return { toggle: toggle?.getAttribute('aria-expanded'), controls: toggle?.getAttribute('aria-controls'),
            menus: menus.map(menu => menu.id), external: external?.checkVisibility() ?? false,
            inputs: window.moteToolbarInputs.slice(-20) }
        })()`)
        const pointerState = await readMenu()
        receipt.toolbarPointer = pointerState
        const confirmMenu = async (input: 'pointerdown' | 'keydown') => {
          await until('More opens the original Browser tool menu using ' + input, async () => {
            const state = await readMenu()
            receipt.toolbarMenu = state
            assert.ok(!receipt.ipc.some((fact: any) => fact.channel === 'ui:openExternal'),
              'The gesture that opens More must not activate an external Browser menu item')
            return state.toggle === 'true' && state.menus.length === 1 && state.menus[0] === state.controls && state.external &&
              state.inputs.some((event: any) => event.type === input && event.trusted && event.action === 'More browser tools')
          })
          return receipt.toolbarMenu
        }
        const key = async (key: string, windowsVirtualKeyCode: number) => {
          for (const type of ['keyDown', 'keyUp']) await requester.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode })
        }
        const closeMore = async (menu: { controls: string }) => {
          await read(`document.getElementById(${JSON.stringify(menu.controls)}).focus({preventScroll:true})`)
          await until('the exact More menu owns keyboard input', () => read(`document.getElementById(${JSON.stringify(menu.controls)})?.contains(document.activeElement)`))
          await key('Escape', 27)
          await until('Closing More restores the same preview', async () => {
            const state = await measure()
            const current = await readMenu()
            receipt.toolbarAfterEscape = { stage: state.stage, native: state.native, menu: current }
            return fits(state) && current.toggle === 'false'
          })
        }
        const openedByPointer = await confirmMenu('pointerdown')
        await closeMore(openedByPointer)
        await read(`document.querySelector(${JSON.stringify(moreSelector)}).focus({preventScroll:true})`)
        await until('focus is on the exact More trigger', () => read(`document.querySelector(${JSON.stringify(moreSelector)}) === document.activeElement`))
        await key('Enter', 13)
        const openedByKeyboard = await confirmMenu('keydown')
        await closeMore(openedByKeyboard)
        assertOriginal(await measure())
        return { point, chromeFocus, openedByPointer, openedByKeyboard }
      }
      const wide = await observedFrame('actual-Mote-responsive-sole.png')
      assertToolbar(wide)
      const wideMore = await verifyMore(wide)
      window.setContentSize(640, 420)
      await until('Mote Region width changes with its original host window', async () => {
        frame = await measure()
        return frame.stage?.visible && Math.abs(frame.stage.width - wide.stage.width) > 12
      })
      const narrow = await observedFrame('actual-Mote-responsive-resized.png')
      assertToolbar(narrow)
      receipt.moteResponsive = { dual: receipt.originalProductSource, wide, wideMore, narrow }
      receipt.moteResponsive.narrowMore = await verifyMore(narrow)
      receipt.phases.push({ name: 'responsive-Mote-sole-layout-follows-the-right-Region-without-input-transfer', passed: true })
      receipt.passed = true
      return
    }
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
    try { await dispose?.(); workbenchWindows?.dispose(); await controller?.dispose() } catch (error: any) { receipt.cleanupFailure = error.message; receipt.passed = false; process.exitCode = 1 }
    receipt.cleanup = { originalOwnersDisposed: true, privateWindowDestroyedAfterPublication: true }
    await fs.writeFile(join(evidence, 'native-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    window?.destroy(); app.quit()
  }
})
