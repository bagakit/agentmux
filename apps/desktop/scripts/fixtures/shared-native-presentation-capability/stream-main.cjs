const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createServer } = require('node:http')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [privateRoot, evidence, nativeBundle, preload, genericPage, consumerHtml, route] = process.argv.slice(2)
assert.ok(['stream', 'receiver-tab'].includes(route))
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.shared-native-stream-capability.v1', passed: false,
  pid: process.pid, route, electron: process.versions.electron, cases: [], frames: [], captureRequests: [], forwardedInputs: [],
  nativeActivationCases: [], handlerTouched: false,
  nativeInputEvents: [], capabilitySupported: false, productImplemented: false, T004Qualified: false, userAppRunRuntimeControl: 0,
  scope: 'One original production Browser WebContents and one MediaStream into two actual video positions. Diagnostic video pixel samples and final Renderer PNGs are evidence, not the presentation transport. Private Window focus only; no user App or OS physical input qualification.' }
const pause = ms => new Promise(done => setTimeout(done, ms))
let window, native, server, consumerSession, originalContents, originalMainFrame, expectedConsumerFrame
let checkpointQueue = Promise.resolve()
const checkpoint = stage => {
  receipt.lastCheckpoint = { stage, at: Date.now() }
  const bytes = JSON.stringify(receipt, null, 2) + '\n'
  checkpointQueue = checkpointQueue.then(() => fs.writeFile(path.join(evidence, 'actual-live.json'), bytes))
  return checkpointQueue
}
app.whenReady().then(async () => {
  try {
    const html = await fs.readFile(consumerHtml)
    server = createServer((request, response) => {
      if (request.url !== '/consumer.html') return response.writeHead(404).end()
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
    })
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const consumerUrl = `http://127.0.0.1:${server.address().port}/consumer.html`, consumerOrigin = new URL(consumerUrl).origin
    window = new BrowserWindow({ width: 1048, height: 740, useContentSize: true, show: false,
      webPreferences: { preload, partition: 'shared-stream-exclusive-consumer', contextIsolation: true, sandbox: true, nodeIntegration: false } })
    const { installMoteNative } = await import(pathToFileURL(nativeBundle).href)
    native = await installMoteNative({ window, privateRoot, evidence, phase: 'stream-capability', fixturePage: genericPage })
    await window.loadURL(consumerUrl)
    expectedConsumerFrame = window.webContents.mainFrame
    assert.equal(expectedConsumerFrame.origin, consumerOrigin)
    assert.deepEqual(BrowserWindow.getAllWindows().map(item => item.id), [window.id], 'Only this private probe Window exists')
    assert.equal(app.getPath('userData'), path.join(privateRoot, 'user-data'))
    assert.ok(process.argv.includes(privateRoot), 'Exact owned probe process and profile')
    receipt.privateActivation = { pid: process.pid, privateRoot, windowIds: BrowserWindow.getAllWindows().map(item => item.id),
      mechanism: 'Root-approved app.focus({steal:true}) for this sole private probe process, then its exact Window.focus; user AgentMux not controlled' }
    window.show()
    app.focus({ steal: true })
    window.focus()
    const until = async (label, predicate) => {
      const deadline = Date.now() + 12000
      do { if (await predicate()) return; await pause(30) } while (Date.now() < deadline)
      throw new Error('Private stream scene did not settle: ' + label)
    }
    await pause(150)
    receipt.privateFocus = { windowId: window.id, focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      focused: window.isFocused(), appActive: app.isActive(), consumerDocumentFocused: await window.webContents.executeJavaScript('document.hasFocus()'),
      userAppFocusCalls: 0, qualification: 'Observed prerequisite; does not block the separate capture/pixel capability phase.' }
    const browserId = 'original-live-stream-page'
    await window.webContents.executeJavaScript(`window.moteNative.browser.create('${browserId}',window.moteNative.fixturePageUrl+'?owner=${browserId}',null)`)
    const sourceBounds = { x: 20, y: 450, width: 480, height: 240 }
    native.browsers.setBounds(browserId, sourceBounds)
    const original = native.browsers.nativeOwner(browserId).view
    const contents = originalContents = original.webContents, originalSession = contents.session
    await until('original source page', () => !contents.isLoading() && contents.executeJavaScript('Boolean(window.nativeFixture)'))
    originalMainFrame = contents.mainFrame
    const navigations = []
    contents.on('did-navigate', (_event, url) => navigations.push(url))
    contents.on('input-event', (_event, input) => receipt.nativeInputEvents.push({ webContentsId: contents.id, input, at: Date.now() }))
    await contents.executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');e.value='One original streamed page draft';e.setSelectionRange(2,9);const tile=document.createElement('div');tile.id='stream-live-color';tile.style='position:fixed;left:8px;top:8px;width:64px;height:64px;background:rgb(15,22,29);z-index:1000';document.body.append(tile);document.getElementById('native-proof-action').addEventListener('click',event=>{window.streamClick={clientX:event.clientX,clientY:event.clientY,trusted:event.isTrusted}})})()`)
    const page = () => contents.executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');return {...window.nativeFixture.facts(),selectionStart:e.selectionStart,selectionEnd:e.selectionEnd,url:location.href,viewport:{width:innerWidth,height:innerHeight},lastClick:window.streamClick}})()`)
    const describe = () => ({ webContentsId: contents.id, processId: contents.getOSProcessId(), sessionSame: contents.session === originalSession,
      sourceBounds: original.getBounds(), sourceDrawn: original.getVisible(), sourceZoom: contents.getZoomFactor(),
      sourceBackgroundThrottling: contents.getBackgroundThrottling(), consumerBackgroundThrottling: window.webContents.getBackgroundThrottling(),
      children: window.contentView.children.map(view => ({ sameOriginal: view === original, contentsId: view.webContents?.id,
        bounds: view.getBounds(), drawn: view.getVisible() })), resources: native.browsers.resourceOwnerCounts() })
    receipt.original = { owner: describe(), page: await page() }
    receipt.cost = { before: app.getAppMetrics(), samplesOnly: true, scope: 'Fixed two projections/one original Browser; not a throughput or competitor benchmark.' }
    await checkpoint('original-page-ready')
    const viewport = receipt.original.page.viewport
    consumerSession = window.webContents.session
    if (route === 'stream') {
    consumerSession.setDisplayMediaRequestHandler((request, callback) => {
      let requestOrigin
      try { requestOrigin = new URL(request.securityOrigin).origin } catch {}
      const checks = { exactConsumerFrame: request.frame === expectedConsumerFrame && request.frame === window.webContents.mainFrame,
        exactOrigin: requestOrigin === consumerOrigin, exactConsumerUrl: expectedConsumerFrame.url === consumerUrl,
        userGesture: request.userGesture === true, videoOnly: request.videoRequested === true && request.audioRequested === false,
        originalAlive: contents.isDestroyed() === false, originalFrame: originalMainFrame === contents.mainFrame,
        originalUrl: contents.getURL() === receipt.original.page.url }
      assert.equal(Object.keys(checks).length, 8)
      const allowed = Object.values(checks).every(value => value === true)
      receipt.captureRequests.push({ allowed, frameProcessId: request.frame?.processId, frameRoutingId: request.frame?.routingId,
        securityOrigin: request.securityOrigin, userGesture: request.userGesture, videoRequested: request.videoRequested,
        audioRequested: request.audioRequested, sourceWebContentsId: contents.id, requestOrigin, checks })
      void checkpoint('capture-request-checked').catch(error => { receipt.checkpointFailure = error.message })
      callback(allowed ? { video: originalMainFrame } : null)
    }, { useSystemPicker: false })
    receipt.handlerTouched = true
    }
    ipcMain.handle('shared-native-stream:input', (event, value) => {
      assert.equal(event.sender, window.webContents)
      assert.equal(event.senderFrame, expectedConsumerFrame)
      assert.equal(expectedConsumerFrame, window.webContents.mainFrame)
      assert.equal(expectedConsumerFrame.url, consumerUrl)
      assert.equal(contents.mainFrame, originalMainFrame)
      assert.equal(contents.getURL(), receipt.original.page.url)
      assert.equal(window.isFocused(), true)
      assert.ok(['a', 'b'].includes(value.binding))
      assert.ok(['mouseDown', 'mouseUp'].includes(value.type))
      assert.equal(value.trusted, true)
      assert.equal(value.visible, true)
      assert.ok(Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= 0 && value.y >= 0 && value.x < 1 && value.y < 1)
      const actualBounds = original.getBounds()
      assert.deepEqual(actualBounds, sourceBounds, 'Consumer projections never resize the original authoritative viewport')
      const input = { type: value.type, x: Math.round(value.x * actualBounds.width), y: Math.round(value.y * actualBounds.height), button: 'left', clickCount: 1 }
      contents.sendInputEvent(input)
      receipt.forwardedInputs.push({ binding: value.binding, sourceWebContentsId: contents.id, consumer: value, input })
      return { sourceWebContentsId: contents.id }
    })
    const renderer = expression => window.webContents.executeJavaScript(expression)
    receipt.captureInvocation = { attempted: true, startedAt: Date.now(), sourceWebContentsId: contents.id, consumerWebContentsId: window.webContents.id }
    let sourceId
    if (route === 'receiver-tab') {
      assert.equal(expectedConsumerFrame, window.webContents.mainFrame)
      assert.equal(expectedConsumerFrame.url, consumerUrl)
      const issuedAt = Date.now()
      sourceId = contents.getMediaSourceId(window.webContents)
      assert.ok(typeof sourceId === 'string' && sourceId.length > 0)
      receipt.captureGrant = { sourceWebContentsId: contents.id, receiverId: window.webContents.id,
        issuedAt, requestStartedAt: Date.now(), requestDelayMs: Date.now() - issuedAt,
        expiresForRequestAfterMs: 10000, streamLifetimeClaimed: false, tokenNonempty: true }
      assert.ok(receipt.captureGrant.requestDelayMs < 10000)
    }
    await checkpoint('capture-api-invoked')
    let captureTimer
    try {
      receipt.streamStart = await Promise.race([
        window.webContents.executeJavaScript(`window.streamFixture.start(${JSON.stringify(viewport)},${JSON.stringify({ route, sourceId })})`, true),
        new Promise((_done, reject) => { captureTimer = setTimeout(() => reject(new Error('Private capture/start phase did not settle within 12 seconds')), 12000) })
      ])
    } finally { clearTimeout(captureTimer) }
    await checkpoint('single-stream-and-two-players-ready')
    assert.equal(receipt.streamStart.trackCount, 1)
    assert.ok(receipt.streamStart.settings.width > 0 && receipt.streamStart.settings.height > 0)
    assert.ok(receipt.streamStart.settings.width <= viewport.width && receipt.streamStart.settings.height <= viewport.height,
      'Actual stream output stays within the authoritative logical source viewport')
    receipt.cost.outputFrame = { width: receipt.streamStart.settings.width, height: receipt.streamStart.settings.height,
      sourceLogicalViewport: viewport, outputPixels: receipt.streamStart.settings.width * receipt.streamStart.settings.height,
      originalUnconstrainedOutput: { width: 1920, height: 960 },
      boundary: 'Output raster only; no native capture/compositor CPU or whole-app scalability qualification.' }
    const color = async (label, rgb, ids = ['a', 'b']) => {
      await contents.executeJavaScript(`document.getElementById('stream-live-color').style.background='rgb(${rgb.join(',')})'`)
      const result = await renderer(`window.streamFixture.expectColor(${JSON.stringify(label)},${JSON.stringify(rgb)},${JSON.stringify(ids)})`)
      for (const id of ids) {
        assert.equal(result.matches[id], true)
        assert.ok(result.samples[id].length > 0, 'Each presented position has actual nonempty pixel observations')
      }
      receipt.cases.push({ name: label, source: describe(), actualLivePixels: result })
      await checkpoint(label)
    }
    const capture = async label => {
      const image = await window.webContents.capturePage(), file = label + '.png'
      assert.equal(image.isEmpty(), false)
      await fs.writeFile(path.join(evidence, file), image.toPNG())
      receipt.frames.push({ file, source: 'consumer-renderer-with-two-live-video-projections', diagnosticOnly: true,
        notTransport: true, nativeSourceCompositionQualified: false })
    }
    await color('two-live-positions-before-native-hide', [240, 42, 55])
    await capture('two-live-positions-source-visible')
    native.browsers.setBounds(browserId, null)
    assert.equal(original.getVisible(), false)
    assert.equal(native.browsers.nativeOwner(browserId), undefined)
    await color('two-live-new-pixels-after-original-native-view-hidden', [41, 204, 92])
    const facts = await renderer('window.streamFixture.facts()')
    assert.equal(facts.captureCount, 1)
    assert.equal(facts.sameStream, true)
    assert.equal(facts.sameTrack, true)
    assert.equal(facts.videos.length, 2)
    assert.ok(facts.videos.every(video => video.display === 'block' && video.readyState >= 2 && video.width > 0 && video.height > 0))
    const click = async binding => {
      const before = await page(), inputCount = receipt.nativeInputEvents.length
      const target = await contents.executeJavaScript(`(()=>{const r=document.getElementById('native-proof-action').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      const point = await renderer(`window.streamFixture.point(${JSON.stringify(binding)},${JSON.stringify(target)})`)
      assert.equal(point.target, binding, 'Actual consumer DOM center reaches this live video position')
      assert.equal(window.webContents.debugger.isAttached(), false)
      window.webContents.debugger.attach('1.3')
      try {
        for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',
          { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
      } finally { window.webContents.debugger.detach() }
      await renderer('window.streamFixture.waitInput()')
      await until('original source receives input from ' + binding, async () => (await page()).clicks === before.clicks + 1)
      const after = await page(), inputs = receipt.nativeInputEvents.slice(inputCount)
      assert.equal(after.lastTrusted, true)
      assert.ok(inputs.some(record => record.webContentsId === contents.id && record.input.type === 'mouseDown'))
      assert.equal(after.lastClick.trusted, true)
      assert.ok(Math.abs(after.lastClick.clientX - target.x) <= 2 && Math.abs(after.lastClick.clientY - target.y) <= 2,
        'Actual original client coordinates agree with contain/letterbox mapping and authoritative zoom')
      assert.deepEqual(after.events.slice(before.events.length), [
        { type: 'mousedown', target: 'native-proof-action', trusted: true },
        { type: 'mouseup', target: 'native-proof-action', trusted: true },
        { type: 'click', target: 'native-proof-action', trusted: true }
      ])
      receipt.cases.push({ name: 'trusted-consumer-input-' + binding, before, after, point, sourceNativeInputs: inputs,
        scope: 'Trusted root CDP pointer → exact private IPC → original WebContents.sendInputEvent; no physical OS targeting/IME qualification.' })
    }
    receipt.inputQualification = { windowId: window.id, focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
      focused: window.isFocused(), attempted: false, qualified: false }
    const inputFocused = window.isFocused() && BrowserWindow.getFocusedWindow() === window
    if (inputFocused && route === 'stream') {
      receipt.inputQualification.attempted = true
      await click('a')
      await click('b')
    } else if (!inputFocused) receipt.inputQualification.reason = 'Exact private Window focus not established; input capability untested. Capture/paint observations remain independent.'
    let expectedFinalPage = receipt.original.page
    if (route === 'receiver-tab') {
      assert.equal(inputFocused, true, 'Original native input counter requires exact private Window focus')
      const originalZoom = contents.getZoomFactor()
      for (const binding of ['a', 'b']) {
        const beforeMove = await page()
        const fit = (await renderer('window.streamFixture.facts()')).videos.find(video => video.id === binding).fit
        assert.ok(fit && fit.width > 0 && fit.height > 0)
        const activeBounds = { x: Math.round(fit.x), y: Math.round(fit.y), width: Math.round(fit.width), height: Math.round(fit.height) }
        assert.equal(activeBounds.width, sourceBounds.width, 'Move to actual fit pixels without resizing the source')
        assert.equal(activeBounds.height, sourceBounds.height)
        native.browsers.setBounds(browserId, activeBounds)
        await pause(80)
        assert.equal(native.browsers.nativeOwner(browserId).view, original)
        assert.deepEqual(original.getBounds(), activeBounds)
        assert.equal(contents.mainFrame, originalMainFrame)
        assert.equal(contents.getZoomFactor(), originalZoom)
        const afterMove = await page()
        assert.deepEqual(afterMove.viewport, viewport)
        assert.equal(afterMove.draft, beforeMove.draft)
        assert.equal(afterMove.selectionStart, beforeMove.selectionStart)
        assert.equal(afterMove.selectionEnd, beforeMove.selectionEnd)
        const children = window.contentView.children, originalIndex = children.indexOf(original)
        assert.ok(originalIndex >= 0)
        const overlaps = bounds => bounds.x < activeBounds.x + activeBounds.width && bounds.x + bounds.width > activeBounds.x &&
          bounds.y < activeBounds.y + activeBounds.height && bounds.y + bounds.height > activeBounds.y
        const occludingNativeViews = children.slice(originalIndex + 1).filter(view => view.getVisible() && overlaps(view.getBounds()))
        assert.equal(occludingNativeViews.length, 0, 'No higher native child overlaps this exact active rectangle')
        const point = await contents.executeJavaScript(`(()=>{const r=document.getElementById('native-proof-editor').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        assert.ok(point.x > 0 && point.y > 0 && point.x < viewport.width && point.y < viewport.height)
        contents.focus()
        assert.equal(window.webContents.debugger.isAttached(), false)
        assert.equal(contents.debugger.isAttached(), false)
        contents.debugger.attach('1.3')
        let beforeInput, afterInput
        try {
          for (const type of ['mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent',
            { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
          beforeInput = await page()
          assert.equal(beforeInput.editorFocused, true)
          assert.equal(beforeInput.focused, true)
          const expectedText = beforeInput.draft.slice(0, beforeInput.selectionStart) + 'x' + beforeInput.draft.slice(beforeInput.selectionEnd)
          for (const type of ['keyDown', 'char', 'keyUp']) await contents.debugger.sendCommand('Input.dispatchKeyEvent',
            { type, key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, ...(type === 'char' ? { text: 'x', unmodifiedText: 'x' } : {}) })
          afterInput = await page()
          assert.equal(afterInput.draft, expectedText)
          assert.equal(afterInput.selectionStart, beforeInput.selectionStart + 1)
          assert.equal(afterInput.selectionEnd, afterInput.selectionStart)
          const events = afterInput.keyboardEvents.slice(beforeInput.keyboardEvents.length)
          assert.ok(events.length > 0)
          for (const type of ['keydown', 'beforeinput', 'input', 'keyup']) assert.ok(events.some(event => event.type === type && event.trusted === true))
          receipt.nativeActivationCases.push({ binding, activeBounds, fit, originalIndex, occludingNativeViews: 0,
            beforeMove, afterMove, beforeInput, afterInput, events,
            eventPath: 'Original WebContents.focus + original-target CDP pointer/key/char; not OS/window-coordinate hit or physical IME',
            nativeOwner: describe(), nativePaintHitQualified: false })
        } finally { contents.debugger.detach() }
        expectedFinalPage = afterInput
        await color('same-stream-after-original-native-activation-' + binding, binding === 'a' ? [163, 52, 213] : [230, 171, 39])
        await capture('native-origin-at-' + binding)
      }
    }
    await capture('two-live-positions-source-hidden')
    await renderer("window.streamFixture.hide('a')")
    const hidden = await renderer('window.streamFixture.facts()')
    assert.equal(hidden.videos.find(video => video.id === 'a').display, 'none')
    await color('position-a-hidden-position-b-live-new-pixels', [35, 125, 240], ['b'])
    if (inputFocused && route === 'stream') await click('b')
    await capture('one-binding-hidden-other-live')
    const finalPage = await page()
    assert.equal(finalPage.draft, expectedFinalPage.draft)
    assert.equal(finalPage.selectionStart, expectedFinalPage.selectionStart)
    assert.equal(finalPage.selectionEnd, expectedFinalPage.selectionEnd)
    assert.equal(finalPage.url, receipt.original.page.url)
    assert.deepEqual(navigations, [])
    assert.equal(contents.session, originalSession)
    assert.equal(contents.id, receipt.original.owner.webContentsId)
    assert.equal(contents.getOSProcessId(), receipt.original.owner.processId)
    assert.equal(native.receipt.bindings.length, 1)
    assert.equal(native.browsers.resourceOwnerCounts().browserViews, 1)
    assert.equal(receipt.captureRequests.length, route === 'stream' ? 1 : 0)
    if (route === 'stream') assert.equal(receipt.captureRequests[0].allowed, true)
    receipt.final = { owner: describe(), page: finalPage, consumer: await renderer('window.streamFixture.facts()'), navigations }
    receipt.cost.after = app.getAppMetrics()
    receipt.cost.browserCreates = native.receipt.bindings.length
    receipt.cost.originalBrowserViews = 1
    receipt.cost.captureTracks = receipt.streamStart.trackCount
    receipt.cost.captureRequests = receipt.captureRequests.length
    receipt.cost.mainFrameBitmapTransports = 0
    receipt.capturePaintSupported = true
    receipt.inputQualification.qualified = inputFocused
    receipt.partialResearchCompleted = true
    receipt.capabilitySupported = inputFocused
    receipt.passed = inputFocused
    await checkpoint('bounded-research-complete')
  } catch (error) {
    receipt.failure = { name: error?.name ?? typeof error, message: error?.message ?? String(error), stack: error?.stack }
    if (window && !window.isDestroyed()) {
      try { receipt.consumerFailure = await window.webContents.executeJavaScript('window.streamFixture?.facts()') } catch {}
      await fs.writeFile(path.join(evidence, 'failure-consumer-renderer.png'), (await window.webContents.capturePage()).toPNG())
    }
  } finally {
    if (window && !window.isDestroyed()) {
      try { receipt.stoppedTracks = await window.webContents.executeJavaScript('window.streamFixture?.stop()') } catch (error) { receipt.stopError = error.message }
    }
    if (consumerSession && receipt.handlerTouched) { consumerSession.setDisplayMediaRequestHandler(null); receipt.handlerReset = true }
    ipcMain.removeHandler('shared-native-stream:input')
    if (native) await native.dispose()
    if (server) await new Promise(done => server.close(done))
    await checkpointQueue
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(receipt.passed ? 0 : 1)
  }
})
