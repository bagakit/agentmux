const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, WebContentsView } = require('electron')
const [privateRoot, evidence, nativeBundle, preload, genericPage] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const receipt = { schema: 'agentmux.shared-native-presentation-capability.v1', passed: false,
  pid: process.pid, electron: process.versions.electron, cases: [], frames: [],
  capabilitySupported: false, userAppRunRuntimeControl: 0,
  scope: 'Direct Electron WebContentsView adoption and the current production Browser owner only. Captured page frames are diagnostic single-WebContents images, never proof of two live native positions or OS composition. No offscreen/texture/new engine/product ABI is selected.' }
const pause = ms => new Promise(done => setTimeout(done, ms))
let window, native
app.whenReady().then(async () => {
  try {
    window = new BrowserWindow({ width: 820, height: 600, useContentSize: true, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    const { installMoteNative } = await import(pathToFileURL(nativeBundle).href)
    native = await installMoteNative({ window, privateRoot, evidence, phase: 'capability', fixturePage: genericPage })
    await window.loadURL('data:text/html,<style>body{margin:0;background:%23202730;color:white;font:16px system-ui}header{height:42px;display:flex;justify-content:space-around}</style><header><span>Position A</span><span>Position B</span></header>')
    window.showInactive()
    const browserId = 'original-shared-page'
    const snapshot = await window.webContents.executeJavaScript(`window.moteNative.browser.create('${browserId}',window.moteNative.fixturePageUrl+'?owner=${browserId}',null)`)
    const left = { x: 10, y: 48, width: 390, height: 532 }, right = { x: 420, y: 48, width: 390, height: 532 }
    native.browsers.setBounds(browserId, left)
    const original = native.browsers.nativeOwner(browserId).view
    const contents = original.webContents, originalSession = contents.session
    const until = async (label, predicate) => {
      const deadline = Date.now() + 12000
      do { if (await predicate()) return; await pause(30) } while (Date.now() < deadline)
      throw new Error('Private capability scene did not settle: ' + label)
    }
    await until('original ordinary page ready', () => !contents.isLoading() && contents.executeJavaScript('Boolean(window.nativeFixture)'))
    const navigations = []
    contents.on('did-navigate', (_event, url) => navigations.push(url))
    await contents.executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');e.value='One original page draft';e.setSelectionRange(2,9)})()`)
    const page = () => contents.executeJavaScript(`(()=>{const e=document.getElementById('native-proof-editor');return {...window.nativeFixture.facts(),selectionStart:e.selectionStart,selectionEnd:e.selectionEnd,url:location.href,viewport:{width:innerWidth,height:innerHeight},title:document.getElementById('page-name').textContent}})()`)
    const describe = () => ({ webContentsId: contents.id, sessionSame: contents.session === originalSession,
      processId: contents.getOSProcessId(), originalViewChildren: window.contentView.children.filter(view => view === original).length,
      children: window.contentView.children.map(view => ({ sameOriginal: view === original, contentsId: view.webContents?.id,
        bounds: view.getBounds(), drawn: view.getVisible() })), resources: native.browsers.resourceOwnerCounts() })
    const frame = async label => {
      const image = await contents.capturePage(), file = label + '.png'
      assert.equal(image.isEmpty(), false)
      await fs.writeFile(path.join(evidence, file), image.toPNG())
      receipt.frames.push({ file, webContentsId: contents.id, bounds: original.getBounds(),
        diagnosticOnly: true, source: 'original-single-webcontents-not-os-composition' })
    }
    const input = async label => {
      const before = await page(), count = native.receipt.nativeInputEvents.length
      const point = await contents.executeJavaScript(`(()=>{const e=document.getElementById('native-proof-action'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})()`)
      assert.equal(point.hit, true)
      assert.equal(original.getVisible(), true)
      assert.ok(window.contentView.children.includes(original))
      const bounds = original.getBounds()
      assert.ok(point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height)
      assert.equal(contents.debugger.isAttached(), false)
      contents.debugger.attach('1.3')
      try {
        for (const type of ['mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent',
          { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
      } finally { contents.debugger.detach() }
      await pause(80)
      const after = await page(), events = native.receipt.nativeInputEvents.slice(count)
      assert.equal(after.clicks, before.clicks + 1)
      assert.equal(after.lastTrusted, true)
      assert.ok(events.some(event => event.browserId === browserId && event.input.type === 'mouseDown'))
      assert.deepEqual(after.events.slice(before.events.length), [
        { type: 'mousedown', target: 'native-proof-action', trusted: true },
        { type: 'mouseup', target: 'native-proof-action', trusted: true },
        { type: 'click', target: 'native-proof-action', trusted: true }
      ])
      return { label, before, after, events, point, mechanism: 'Trusted CDP directed to original native WebContents; physical/OS-coordinate targeting not qualified' }
    }
    receipt.original = { snapshot, owner: describe(), page: await page() }
    receipt.initialInput = await input('original-single-position')
    await frame('original-one-position')

    const childrenBefore = window.contentView.children.length
    let second
    const adoption = { api: 'new WebContentsView({webContents: original.webContents})', before: describe() }
    try {
      second = new WebContentsView({ webContents: contents })
      window.contentView.addChildView(second)
      second.setBounds(right)
      adoption.constructed = true
      adoption.sameWebContents = second.webContents === contents
      adoption.after = describe()
    } catch (error) {
      adoption.constructed = false
      adoption.exception = { name: error.name, message: error.message, stack: error.stack }
      adoption.after = describe()
    }
    receipt.cases.push({ name: 'second-view-of-original-webcontents', ...adoption })
    // An unexpected successful constructor does not establish two drawable surfaces.
    // Preserve it as unknown instead of calling two getVisible flags a capability.
    assert.equal(adoption.constructed, false, 'Direct duplicate adoption is actually rejected on this installed Electron')
    assert.match(adoption.exception.message, /already|attached|presented|bound/i,
      'The actual exception concerns existing ownership, not preparation or resource failure')
    assert.equal(window.contentView.children.length, childrenBefore)
    assert.equal(contents.isDestroyed(), false)
    assert.equal(contents.session, originalSession)
    assert.equal(native.browsers.resourceOwnerCounts().browserViews, 1)

    const duplicateBefore = describe()
    window.contentView.addChildView(original)
    window.contentView.addChildView(original)
    assert.equal(window.contentView.children.length, childrenBefore)
    assert.equal(window.contentView.children.filter(view => view === original).length, 1)
    native.browsers.setBounds(browserId, right)
    assert.deepEqual(original.getBounds(), right)
    assert.equal(native.browsers.nativeOwner(browserId).view, original)
    receipt.cases.push({ name: 'same-view-readd-is-one-child-and-last-bounds-migration', before: duplicateBefore,
      after: describe(), rejectedAsMultiPresentation: true, simultaneousPositions: 1 })
    await contents.executeJavaScript(`document.getElementById('page-name').textContent='Same original page updated'`)
    receipt.afterCounterexampleInput = await input('original-after-rejection-and-migration')
    await frame('original-updated-after-migration')
    native.browsers.setBounds(browserId, null)
    assert.equal(original.getVisible(), false)
    assert.equal(native.browsers.nativeOwner(browserId), undefined)
    const hidden = describe()
    native.browsers.setBounds(browserId, right)
    assert.equal(native.browsers.nativeOwner(browserId).view, original)
    assert.equal(original.getVisible(), true)
    receipt.cases.push({ name: 'current-single-owner-hide-and-restore', hidden, returned: describe(),
      independentOtherBindingQualified: false, reason: 'No second live native presentation exists; cannot claim per-binding hiding.' })
    const finalPage = await page()
    assert.equal(finalPage.draft, receipt.original.page.draft)
    assert.equal(finalPage.selectionStart, receipt.original.page.selectionStart)
    assert.equal(finalPage.selectionEnd, receipt.original.page.selectionEnd)
    assert.equal(finalPage.url, receipt.original.page.url)
    assert.deepEqual(navigations, [])
    assert.equal(native.receipt.bindings.length, 1)
    receipt.final = { page: finalPage, owner: describe(), navigations }
    receipt.cost = { browserCreates: native.receipt.bindings.length, browserViews: 1, originalPageProcesses: native.browsers.resourceProcessIds(),
      samples: app.getAppMetrics(), measurement: 'One fixed installed-version/private-page sample; no scalability or CPU/RSS superiority claim.' }
    receipt.conclusion = 'Direct Electron43.7.7 WebContentsView adoption rejects the already-owned original WebContents. Readding/moving the same View preserves one original page but presents one position. Simultaneous same-page paint/update/input and per-binding hide are not supported by this direct candidate. Other rendering routes remain untested; no product engine or T004 outcome is approved.'
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure-root-renderer.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    if (native) await native.dispose()
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(receipt.passed ? 0 : 1)
  }
})
