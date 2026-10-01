const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, evidence, nativeBundle] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, phase, frames: [], userRunTouched: false,
  boundary: 'Complete desktop production App and ordinary persistence/initialize in one isolated profile. Public Session snapshots/attachment/recovery are controlled facts; original Main Browser and Chrome owners are real and separately verified. No actual Core/ctxmux Run survival claim.' }
// Publish the private phase result before exiting, even if its sole window is lost.
// Explicit app.quit / OS termination remains outside this window-closure observation.
app.on('window-all-closed', () => {
  result.passed = false
  result.unexpectedWindowClosure = { observedAt: Date.now(), step: result.step }
  process.stderr.write('Private proof window closed: ' + JSON.stringify(result.unexpectedWindowClosure) + '\n')
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, native
const bounded = async (work, label, budget = 12000) => {
  let timer
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Private proof step timed out: ' + label)), budget) })]) }
  finally { clearTimeout(timer) }
}
app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin') app.setActivationPolicy('regular')
    app.setAccessibilitySupportEnabled(true)
    win = new BrowserWindow({ width: 1100, height: 760, useContentSize: true, show: false, webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false
    } })
    result.step = 'load-original-native-owners'
    const { installMoteNative } = await bounded(import(pathToFileURL(nativeBundle).href), result.step)
    result.step = 'install-private-native-boundary'
    native = await bounded(installMoteNative({ window: win, privateRoot, evidence, phase, fixturePage: path.join(__dirname, 'browser.html'), osCli: '/usr/local/bin/orca' }), result.step)
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) process.stderr.write('Renderer: ' + message + '\n') })
    result.step = 'load-complete-production-App'
    await bounded(win.loadFile(html, { query: { phase } }), result.step)
    const read = expression => bounded(win.webContents.executeJavaScript(expression), 'Renderer observation')
    const until = async expression => {
      const deadline = Date.now() + 10000
      do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Mote proof did not settle: ' + expression)
    }
    const waitNative = async predicate => {
      const deadline = Date.now() + 8000
      do { const current = native.owners(); if (predicate(current)) return current; await pause(30) } while (Date.now() < deadline)
      throw new Error('Native owner did not settle: ' + JSON.stringify(native.owners()))
    }
    const facts = () => read('window.moteProof.facts()')
    result.step = 'ordinary-initialize-and-actual-footer'
    await until('window.moteProof?.ready && !!document.querySelector("[data-pmo-teams-topic-launcher] button")')
    win.showInactive()
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => bounded(win.webContents.debugger.sendCommand(method, params), 'Original Renderer input ' + method)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const entry = 'document.querySelector("[data-pmo-teams-topic-launcher] button")'
    const panel = 'document.getElementById("pmo-teams-topic-floating-panel")'
    const pointFor = expression => read('(()=>{const e=' + expression + ';if(!e)throw new Error("Missing observed control");const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    const move = async point => input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    const click = async expression => {
      const point = await pointFor(expression)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
    }
    const key = async (key, code, virtualKey) => {
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtualKey,
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    }
    const painted = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const capture = async name => {
      await painted()
      const file = phase + '-' + name + '.png'
      await fs.writeFile(path.join(evidence, file), (await bounded(win.webContents.capturePage(), 'Original Renderer capture')).toPNG())
      result.frames.push({ name, file, source: 'original-renderer-excludes-native-WebContentsViews' })
    }
    const expectedRegions = ['custom-browser-region', 'custom-mote-region', 'mote-neighbor-region', 'mote-primary-region', 'ordinary-topic-region', 'original-reader-region', 'original-worker-region', 'project-browser-region', 'quiet-mote-region']
    const forbidden = one => ['launchAgent', 'stop', 'write', 'submitPrompt'].includes(one.operation) ||
      one.operation === 'launchTerminal' && one.presentation !== 'pinned'
    const visible = async (target, topic) => {
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.moteTargetTab===' + JSON.stringify(target))
      const current = await facts()
      assert.equal(current.ui.entryTarget, target)
      assert.equal(current.ui.panelTarget, target)
      assert.equal(current.ui.panelTopic, topic)
      assert.equal(current.ui.expanded, 'true')
      assert.equal(current.ui.panelVisible, true)
      assert.equal(current.ui.globalChrome, 0, 'Projection cannot copy Goals/Focus global chrome')
      assert.equal(current.ui.titleRows, 0, 'The redundant independent title row is removed')
      assert.equal(current.ui.footerHeight, 24)
      const footer = current.ui.footerRect
      assert.ok(current.ui.entryRect && current.ui.entryAvatarRect, 'The real entry and avatar geometry are nonempty')
      for (const rect of [current.ui.entryRect, current.ui.entryAvatarRect, current.ui.entryStatusRect].filter(Boolean)) {
        assert.ok(rect.width > 0 && rect.height > 0, 'Each actual painted entry part has a positive area')
        assert.ok(rect.y >= 0 && rect.bottom <= footer.bottom && rect.bottom >= footer.y,
          'The complete larger Mote entry stays visible at the low footer; native drawing clearance is verified separately')
      }
      assert.deepEqual(current.ui.choices.map(one => one.topicId).sort(), ['launcher:custom-coordinator', 'launcher:custom-research', 'launcher:leader'])
      assert.equal(current.ui.choices.length, 3, 'One choice per real object, regardless of Tab/Session count')
      assert.deepEqual(current.ui.actions.map(action => action.label).sort(),
        ['Show archived Motes', 'Show Mote avatars only', 'Open Mote Space', 'Close Mote'].sort())
      for (const action of current.ui.actions) {
        assert.ok(action.width >= 20 && action.height >= 20, 'Original actions retain their actual hit areas')
        assert.ok(action.right <= win.getContentBounds().width && action.bottom <= win.getContentBounds().height)
      }
      const box = current.ui.panelRect, anchor = current.ui.entryRect
      assert.ok(box.x >= 0 && box.right <= win.getContentBounds().width && box.y >= 0)
      assert.ok(box.bottom <= anchor.y && anchor.y - box.bottom <= 16, 'One small actual gap joins panel and footer button')
      assert.deepEqual([...current.ui.regions].sort(), expectedRegions, 'The original nonempty workface has exactly one View per Region')
      assert.deepEqual(current.calls.filter(forbidden), [])
      return current
    }
    const verifyNativeEntryClearance = async label => {
      const before = await facts(), zoom = win.webContents.getZoomFactor(), entryBox = before.ui.entryRect
      assert.ok(entryBox && entryBox.width > 0 && entryBox.height > 0)
      const bounds = { x: entryBox.x * zoom, y: entryBox.y * zoom, width: entryBox.width * zoom, height: entryBox.height * zoom }
      const owners = await waitNative(current => current.chrome.some(owner => owner.drawn && owner.interactive &&
        JSON.stringify(owner.region.bounds) === JSON.stringify(bounds)))
      const matches = owners.chrome.filter(owner => JSON.stringify(owner.region.bounds) === JSON.stringify(bounds))
      assert.equal(matches.length, 1, 'The real original entry has exactly one locally bounded Chrome projection')
      const entryOwner = matches[0]
      assert.equal(entryOwner.ownerWindowId, win.id); assert.equal(entryOwner.region.radius, bounds.width / 2)
      assert.deepEqual(entryOwner.bounds, bounds)
      const inside = (point, box) => point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height
      const points = [{ x: bounds.x + bounds.width / 2, y: bounds.y + 2 },
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }]
      for (const point of points) {
        const topmost = [...owners.orderedChildren].reverse().find(owner => owner.drawn && inside(point, owner.bounds))
        assert.equal(topmost?.webContentsId, entryOwner.webContentsId, 'Raised and center entry points hit its actual original Chrome, not the underlying Browser')
      }
      const browsers = owners.browsers.filter(owner => owner.drawn)
      assert.ok(browsers.length > 0, 'An original Native Browser is actually present')
      const near = { x: bounds.x + bounds.width + 8, y: bounds.y + 2 }
      const nearbyBrowser = browsers.find(owner => inside(near, owner.bounds))
      if (label === 'browser-behind-mote') {
        assert.ok(nearbyBrowser, 'The original Browser still occupies the space beside the local entry box')
        assert.equal([...owners.orderedChildren].reverse().find(owner => owner.drawn && inside(near, owner.bounds))?.webContentsId,
          nearbyBrowser.webContentsId, 'The local entry projection does not cover the adjacent original page')
      }
      const closeInput = await native.verifyChromeControl(bounds, label + '-entry-close')
      assert.equal(closeInput.passed, true, JSON.stringify(closeInput.failure))
      await until('!' + panel + '?.matches(":popover-open")')
      const closed = await facts()
      assert.equal(closed.ui.entryTarget, before.ui.entryTarget)
      await waitNative(current => current.chrome.some(owner => owner.drawn && owner.interactive &&
        JSON.stringify(owner.region.bounds) === JSON.stringify(bounds)))
      const reopenInput = await native.verifyChromeControl(bounds, label + '-entry-open')
      assert.equal(reopenInput.passed, true, JSON.stringify(reopenInput.failure))
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.motePresentation==="pinned"')
      const reopened = await facts()
      assert.equal(reopened.ui.panelTarget, before.ui.panelTarget); assert.equal(reopened.ui.panelTopic, before.ui.panelTopic)
      for (const key of ['tabs', 'layouts', 'activeWorkspaceId', 'mainSurface', 'drafts', 'outbox', 'runs'])
        assert.deepEqual(reopened[key], before[key], 'Actual native entry input preserves ' + key)
      assert.deepEqual(reopened.focus.execution, before.focus.execution)
      const finalOwners = await waitNative(current => current.chrome.some(owner => owner.drawn && owner.interactive &&
        JSON.stringify(owner.region.bounds) === JSON.stringify(bounds)))
      const originalBrowsers = owner => owner.browsers.map(({ browserId, webContentsId, ownerWindowId, bounds, drawn, attached }) =>
        ({ browserId, webContentsId, ownerWindowId, bounds, drawn, attached }))
      assert.deepEqual(originalBrowsers(finalOwners), originalBrowsers(owners), 'Native entry input keeps original Browser identity, geometry and attachment')
      ;(result.nativeEntryClearance ??= []).push({ label, entry: bounds, owner: entryOwner, points, near,
        closeInput, reopenInput, closedTarget: closed.ui.entryTarget, reopenedTarget: reopened.ui.panelTarget, owners: finalOwners })
    }
    const choose = async (topic, target) => {
      const choice = panel + '.querySelector(' + JSON.stringify('[data-mote-topic-id="' + topic + '"]') + ')'
      const geometry = await read('(()=>{const e=' + choice + ',scroller=e.closest(".mote-chooser__choices"),r=e.getBoundingClientRect(),s=scroller.getBoundingClientRect();return {x:s.x+s.width/2,y:s.y+s.height/2,deltaX:r.right>s.right?r.right-s.right:r.x<s.x?r.x-s.x:0}})()')
      if (geometry.deltaX) {
        await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX: geometry.deltaX, deltaY: 0 })
        await until('(()=>{const e=' + choice + ',r=e.getBoundingClientRect(),s=e.closest(".mote-chooser__choices").getBoundingClientRect();return r.x>=s.x-1 && r.right<=s.right+1})()')
      }
      await click(choice)
      if (target) {
        await until(panel + '.dataset.moteTargetTopic===' + JSON.stringify(topic))
        if ((await facts()).ui.panelTarget !== target) {
          const toggle = panel + '.querySelector("button[aria-label=\'Show Mote discussions\']")'
          if (await read(toggle + '?.getAttribute("aria-expanded")==="false"')) {
            await click(toggle)
            await until(toggle + '?.getAttribute("aria-expanded")==="true"')
          }
          await click(panel + '.querySelector(' + JSON.stringify('button[data-workbench-tab-id="' + target + '"]') + ')')
        }
        return visible(target, topic)
      }
      await until(panel + '.dataset.moteTargetTopic===' + JSON.stringify(topic))
      return facts()
    }
    const close = async () => {
      await click(panel + '.querySelector("button[aria-label=\'Close Mote\']")')
      await until('!' + panel + '?.matches(":popover-open")')
    }
    const pin = async () => {
      await click(entry)
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.motePresentation==="pinned"')
    }
    result.initial = await facts()
    assert.equal(Object.keys(result.initial.tabs).length, 8)
    let originalProjectLayout = result.initial.tabs['original-project-tab'].layout
    let executionBeforeMoteSequence = result.initial.focus.execution
    if (phase === 'seed') {
      assert.equal(result.initial.drafts['project-worker'], 'Original project draft stays unsent')
      assert.equal(result.initial.drafts['mote-primary'], 'Keep my original Mote draft')
      assert.equal(result.initial.drafts['custom-mote'], 'Keep the custom Mote draft')
      assert.equal(result.initial.mainSurface, 'board')
      assert.equal(result.initial.ui.expanded, 'false')
      await capture('wide-closed')
      await move(await pointFor(entry))
      let current = await visible('mote-primary-tab', 'launcher:leader')
      assert.equal(current.floating.open, false, 'Hover is not a durable pin')
      for (const protectedKey of ['focus', 'drafts', 'viewModes', 'outbox', 'mainSurface', 'activeWorkspaceId']) assert.deepEqual(current[protectedKey], result.initial[protectedKey], 'Hover preserves ' + protectedKey)
      assert.deepEqual(current.calls.filter(one => ['ensureTopic', 'ensureMote'].includes(one.operation)),
        result.initial.calls.filter(one => ['ensureTopic', 'ensureMote'].includes(one.operation)),
        'Hover adds no preparation beyond ordinary primary Mote initialization')
      assert.match(current.ui.entryTitle, /Working/)
      await capture('wide-hover-all-motes')
      result.step = 'hover-crosses-button-gap-into-original-portaled-view'
      const box = current.ui.panelRect, anchor = current.ui.entryRect
      await move({ x: anchor.x + anchor.width / 2, y: (anchor.y + box.bottom) / 2 })
      await pause(60)
      await move({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      await pause(230)
      await visible('mote-primary-tab', 'launcher:leader')
      await move({ x: 1090, y: 200 })
      await until('!' + panel + '?.matches(":popover-open")')
      assert.equal((await facts()).floating.open, false)
      // Hover over a real draft receiver and original split Terminal; focus and geometry remain owned.
      result.step = 'hover-preserves-original-input-and-split'
      await read('window.moteProof.showProject()')
      const composer = 'document.querySelector("[data-workbench-region-id=original-worker-region] [contenteditable=true]")'
      await until('!!' + composer)
      await click(composer)
      await painted(); await pause(100)
      const focused = await facts()
      assert.equal(focused.ui.activeElement.editable, true)
      originalProjectLayout = focused.tabs['original-project-tab'].layout
      // The explicit Project navigation/click above legitimately records execution
      // focus. Compare all subsequent Mote actions to that complete owned history.
      assert.ok(focused.focus.execution.history.length > 0)
      executionBeforeMoteSequence = focused.focus.execution
      result.executionBeforeMoteSequence = executionBeforeMoteSequence
      await move(await pointFor(entry))
      current = await visible('mote-primary-tab', 'launcher:leader')
      assert.deepEqual(current.ui.activeElement, focused.ui.activeElement, 'Hover does not move the real draft receiver or caret')
      assert.deepEqual(current.focus.execution, focused.focus.execution)
      assert.deepEqual(current.viewModes, focused.viewModes)
      await painted(); await pause(150)
      assert.deepEqual((await facts()).resizes, focused.resizes, 'Unrelated original Terminal does not resize for this Mote hover')
      await capture('wide-hover-original-split')
      await click(entry)
      current = await visible('mote-primary-tab', 'launcher:leader')
      assert.equal(current.floating.open, true)
      assert.deepEqual(current.viewModes, focused.viewModes,
        'The already effective dialogue mode needs no additional stored write; neighboring modes remain unchanged')
      await move({ x: 1090, y: 200 }); await pause(230)
      await visible('mote-primary-tab', 'launcher:leader')
      await capture('wide-pinned')
      result.step = 'chooser-uses-original-custom-draft-and-empty-mote'
      const beforeChoice = await facts()
      await choose('launcher:custom-coordinator', 'custom-mote-tab')
      current = await facts()
      assert.deepEqual(current.focus.execution, beforeChoice.focus.execution, 'A custom SOUL Mote stays out of execution history')
      assert.deepEqual(current.drafts, beforeChoice.drafts)
      const customComposer = panel + '.querySelector("[data-workbench-region-id=custom-mote-region] [contenteditable=true]")'
      await until('!!' + customComposer)
      await click(customComposer)
      // Place the test caret deliberately; trusted input still reaches the exact
      // original Composer. Clicking the center may choose a wrapped middle line.
      await read('(()=>{const e=' + customComposer + ',r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)})()')
      await input('Input.insertText', { text: ' · typed in the original owner' })
      await until('window.moteProof.facts().drafts["custom-mote"]==="Keep the custom Mote draft · typed in the original owner"')
      assert.deepEqual((await facts()).focus.execution, beforeChoice.focus.execution)
      await capture('wide-custom-original-draft')
      await choose('launcher:custom-research', 'quiet-mote-tab')
      current = await facts()
      assert.deepEqual(current.focus.execution, beforeChoice.focus.execution)
      assert.equal(current.drafts['quiet-mote-region'], 'Keep the original launcher draft')
      assert.deepEqual(current.calls.filter(forbidden), [])
      await capture('wide-mote-without-agent')
      result.step = 'narrow-chooser-status-and-restoring-workface'
      await choose('launcher:leader', 'mote-primary-tab')
      await read('window.moteProof.longName()')
      win.setContentSize(640, 680)
      await until('innerWidth===640 && ' + panel + '.getBoundingClientRect().right<=640')
      await visible('mote-primary-tab', 'launcher:leader'); await capture('narrow-long-goal-all-motes')
      await choose('launcher:custom-research', 'quiet-mote-tab')
      await capture('narrow-all-motes-reachable')
      await choose('launcher:leader', 'mote-primary-tab')
      await read('window.moteProof.status("disconnected")')
      await until('!/Working/.test(window.moteProof.facts().ui.entryTitle)')
      await capture('narrow-disconnected')
      await read('window.moteProof.pending()')
      await until('!' + panel + '.dataset.moteTargetSession || /restor|unknown|unavailable|waiting/i.test(' + panel + '.dataset.moteStatus)')
      assert.equal((await facts()).drafts['mote-primary'], 'Keep my original Mote draft')
      await capture('narrow-restoring')
      await read('window.moteProof.restoreFacts()')
      await until(panel + '.dataset.moteTargetSession==="mote-primary"')
      await read('window.moteProof.directory(true)')
      await until('/could not be read/i.test(' + panel + '.textContent)')
      await visible('mote-primary-tab', 'launcher:leader')
      await capture('narrow-directory-read-failed')
      await read('window.moteProof.directory(false)')
      await until('!/could not be read/i.test(' + panel + '.textContent)')
      await choose('launcher:custom-coordinator', 'custom-mote-tab')
      const beforeFull = await facts()
      await click(panel + '.querySelector("button[aria-label=\'Open Mote Space\']")')
      await until('!' + panel + '?.matches(":popover-open") && window.moteProof.facts().mainSurface==="workbench"')
      current = await facts()
      assert.equal(current.activeWorkspaceId, '__scratch__')
      assert.equal(current.layouts.__scratch__.groups.find(one => one.id === current.layouts.__scratch__.activeGroupId).activeTabId, 'custom-mote-tab')
      for (const protectedKey of ['tabs', 'runs', 'drafts', 'outbox']) assert.deepEqual(current[protectedKey], beforeFull[protectedKey], 'Full Space retains ' + protectedKey)
      assert.deepEqual(current.focus.execution, beforeFull.focus.execution)
      win.setContentSize(1100, 760)
      await until('innerWidth===1100')
      await capture('wide-custom-full-space')
      // Native evidence is real composition/owner/input, separate from Renderer pictures.
      result.step = 'native-browser-behind-popover-composition-and-input'
      await read('window.moteProof.showProject("project-browser-tab")')
      await waitNative(owners => owners.browsers.some(one => one.browserId === 'private-browser-behind' && one.drawn && one.bounds.width > 0 && !one.loading))
      await pin(); await choose('launcher:leader', 'mote-primary-tab')
      await waitNative(owners => owners.chrome.length > 0 && owners.chrome.every(one => one.interactive))
      await verifyNativeEntryClearance('browser-behind-mote')
      const behindOs = await native.captureOsWindow('browser-behind-mote')
      const behindFrames = await native.captureNativeFrames('browser-behind-mote')
      assert.equal(behindFrames.passed, true, JSON.stringify(behindFrames.failure))
      const behindInput = await native.verifyPageInput('private-browser-behind', 'browser-behind-mote')
      if (!behindInput.passed) await close()
      await until('!' + panel + '?.matches(":popover-open")')
      result.step = 'native-browser-inside-popover-composition-and-input'
      await pin(); await choose('launcher:custom-coordinator', 'custom-browser-tab')
      await waitNative(owners => owners.browsers.some(one => one.browserId === 'private-browser-inside' && one.drawn && one.bounds.width > 0 && !one.loading) && owners.chrome.length > 0 && owners.chrome.every(one => one.interactive))
      await verifyNativeEntryClearance('browser-inside-mote')
      const insideOs = await native.captureOsWindow('browser-inside-mote')
      const insideFrames = await native.captureNativeFrames('browser-inside-mote')
      assert.equal(insideFrames.passed, true, JSON.stringify(insideFrames.failure))
      const insideInput = await native.verifyPageInput('private-browser-inside', 'browser-inside-mote')
      result.nativeCapture = { boundary: 'Independent original native-page and native-chrome images plus actual topmost owner/input. These images are not an OS-composited window. Exact-PID OS capture is supplementary and retains any provider failure.', behind: { os: behindOs.captured, independentFrames: behindFrames.passed }, inside: { os: insideOs.captured, independentFrames: insideFrames.passed } }
      assert.equal(behindInput.passed, true, JSON.stringify(behindInput.failure))
      assert.equal(insideInput.passed, true, JSON.stringify(insideInput.failure))
      await visible('custom-browser-tab', 'launcher:custom-coordinator')
      result.step = 'native-original-page-hover-after-same-float-reopen'
      await close()
      await move(await pointFor(entry))
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.motePresentation==="preview"')
      await waitNative(owners => owners.browsers.some(one => one.browserId === 'private-browser-inside' && one.drawn) && owners.chrome.length > 0 && owners.chrome.every(one => one.interactive))
      const bridgePoint = await read('(()=>{const e=' + entry + '.getBoundingClientRect();return {x:e.x+e.width/2,y:e.y-3}})()')
      await move(bridgePoint)
      const insideHover = await native.verifyPageHover('private-browser-inside', 'browser-inside-mote-hover-bridge')
      assert.equal(insideHover.passed, true, JSON.stringify(insideHover.failure))
      await pause(230)
      await visible('custom-browser-tab', 'launcher:custom-coordinator')
      assert.equal(await read(panel + '.dataset.motePresentation'), 'preview')
      const insidePreviewClick = await native.verifyPageInput('private-browser-inside', 'browser-inside-mote-explicit-pin')
      assert.equal(insidePreviewClick.passed, true, JSON.stringify(insidePreviewClick.failure))
      await until(panel + '.dataset.motePresentation==="pinned"')
      result.step = 'native-original-editor-ordinary-escape'
      // Real DevTools composition starts in the page, but CDP raw Escape reports
      // before-input-event.isComposing=false. Keep that diagnostic separately; it
      // cannot qualify a native IME key. The Source composing guard has owning tests.
      const ordinaryEscape = await native.verifyPageEscape('private-browser-inside', 'browser-inside-mote-ordinary-escape')
      assert.equal(ordinaryEscape.passed, true, JSON.stringify(ordinaryEscape.failure))
      await until('!' + panel + '?.matches(":popover-open")')
      result.step = 'keyboard-dismissal-and-original-owner-restoration'
      await pin()
      await choose('launcher:custom-coordinator', 'custom-mote-tab')
      await close()
      win.webContents.focus()
      await read(entry + '.focus({preventScroll:true})')
      await key('Enter', 'Enter', 13)
      await until(panel + '?.matches(":popover-open") && ' + panel + '.dataset.motePresentation==="pinned"')
      await visible('custom-mote-tab', 'launcher:custom-coordinator')
      await key('Escape', 'Escape', 27)
      await until('!' + panel + '?.matches(":popover-open")')
      await read('window.moteProof.showGoals()')
      await pin()
      await visible('custom-mote-tab', 'launcher:custom-coordinator')
      result.step = 'explicit-original-mote-mode-choice'
      const customModeOwner = panel + '.querySelector("[data-workbench-region-id=custom-mote-region]")'
      await click(customModeOwner + '.querySelector("button[aria-label=\'Show Terminal\']")')
      await until('window.moteProof.facts().viewModes["custom-mote"]==="terminal" && ' + customModeOwner + '.querySelector("[data-agent-surface-mode=terminal]")')
      assert.ok(await read('!!' + customModeOwner + '.querySelector("button[aria-label=\'Show Activity\']")'), 'The original mode control describes the actual original pane')
      await capture('wide-final-custom-pinned')
      const explicitTerminal = await facts()
      await close(); await pin()
      await until('window.moteProof.facts().viewModes["custom-mote"]==="activity" && ' + customModeOwner + '.querySelector("[data-agent-surface-mode=activity]")')
      const explicitlyReopened = await facts()
      assert.deepEqual(explicitlyReopened.viewModes, { ...explicitTerminal.viewModes, 'custom-mote': 'activity' },
        'Explicit reopening returns the exact original Agent to dialogue without changing neighboring modes')
      assert.deepEqual(explicitlyReopened.drafts, explicitTerminal.drafts)
      result.explicitReopen = { target: explicitlyReopened.ui.panelTarget, session: explicitlyReopened.ui.panelSession,
        viewModes: explicitlyReopened.viewModes, drafts: explicitlyReopened.drafts }
      // A later manual Terminal choice is durable; ordinary process restore is
      // not another human reopen and must retain that current choice.
      await click(customModeOwner + '.querySelector("button[aria-label=\'Show Terminal\']")')
      await until('window.moteProof.facts().viewModes["custom-mote"]==="terminal"')
    } else {
      result.step = 'ordinary-process-restart-retains-original-workface'
      const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
      const restored = await visible('custom-mote-tab', 'launcher:custom-coordinator')
      for (const protectedKey of ['tabs', 'layouts', 'activeWorkspaceId', 'mainSurface', 'drafts', 'outbox', 'viewModes']) assert.deepEqual(restored[protectedKey], prior[protectedKey], 'Ordinary process restart preserves ' + protectedKey)
      assert.deepEqual(restored.focus.execution, prior.focus.execution)
      for (const key of ['targetTopicId', 'targetTabId', 'open']) assert.deepEqual(restored.floating[key], prior.floating[key])
      await until('window.moteProof.facts().calls.some(one=>one.operation==="recover" && one.sessionId==="custom-mote" && one.runId==="original-run-custom-mote")')
      assert.deepEqual((await facts()).calls.filter(one => one.operation === 'recover'), [{ operation: 'recover', sessionId: 'custom-mote', runId: 'original-run-custom-mote' }])
      assert.deepEqual(restored.runs, prior.runs, 'Original public Run references remain, without creating another Session')
      await until('document.querySelector("[data-workbench-region-id=custom-mote-region] [data-agent-surface-mode=terminal]")')
      assert.ok(await read('!!' + panel + '.querySelector("[data-workbench-region-id=custom-mote-region] button[aria-label=\'Show Activity\']")'), 'The original pane and mode control read the same explicit choice after restart')
      await capture('wide-restarted-custom-mote')
    }
    result.final = await visible('custom-mote-tab', 'launcher:custom-coordinator')
    assert.equal(originalProjectLayout.root.ratio, 0.63)
    assert.deepEqual(result.final.tabs['original-project-tab'].layout, originalProjectLayout, 'Mote interactions retain the layout and actual Region selected before hover')
    assert.deepEqual(result.final.focus.execution, executionBeforeMoteSequence, 'Every Mote interaction preserves complete original execution history after explicit Project focus')
    await until('(()=>{const saved=JSON.parse(localStorage.getItem("agentmux-workbench-v1"))?.state,current=window.moteProof.facts();return !!saved?.restoredWorkbench?.tabs["custom-mote-tab"] && JSON.stringify(saved.restoredWorkbench.layouts)===JSON.stringify(current.layouts) && JSON.stringify(saved.agentComposerDrafts)===JSON.stringify(current.drafts) && saved.activeWorkspaceId===current.activeWorkspaceId && saved.mainSurface===current.mainSurface && JSON.stringify(saved.agentFocus.execution)===JSON.stringify(current.focus.execution) && JSON.stringify(saved.viewModes)===JSON.stringify(current.viewModes)})()')
    await win.webContents.session.flushStorageData()
    result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
    result.surfaceEvents = await read('window.moteProof.surfaceEvents()')
    result.native = native.receipt
    assert.equal(result.unexpectedWindowClosure, undefined, 'The original private workface remains until phase publication')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) result.observation = await bounded(win.webContents.executeJavaScript('({setup:window.moteSetup,body:document.body.innerText,proofPresent:!!window.moteProof,facts:window.moteProof?.facts(),surfaceEvents:window.moteProof?.surfaceEvents()})'), 'failure observation', 2000).catch(failed => ({ error: failed.message }))
    if (native) result.native = native.receipt
  } finally {
    if (win && !win.isDestroyed()) {
      try { await bounded(win.webContents.executeJavaScript('window.moteProof?.dispose()'), 'Renderer owner disposal', 5000) } catch (error) { result.passed = false; result.rendererCleanupFailure = { name: error.name, message: error.message, stack: error.stack } }
    }
    if (native) {
      try { await bounded(native.dispose(), 'native owner disposal', 5000) } catch (error) { result.passed = false; result.cleanupFailure = { name: error.name, message: error.message, stack: error.stack } }
    }
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
