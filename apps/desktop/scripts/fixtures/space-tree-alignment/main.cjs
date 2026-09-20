const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, mode] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid, boundary: 'Actual WorkspaceSidebar, SpaceTopicsTree, store disclosure/density and CSS; preview API/navigation data; private Electron profile. No user App, Run or keyboard operations.' }
let win
let original
app.whenReady().then(async () => {
  const read = expression => win.webContents.executeJavaScript(expression)
  const until = async expression => {
    const deadline = Date.now() + 5000
    do {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    throw new Error(`Space tree did not settle: ${expression}`)
  }
  const capture = async name => {
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await read('Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation => animation.finished))')
    fs.writeFileSync(path.join(privateRoot, name), (await win.webContents.capturePage()).toPNG())
  }
  const aligned = (a, b, message) => assert.ok(Math.abs(a - b) < .5, `${message}: ${a} vs ${b}`)
  const check = g => {
    assert.equal(g.topicCount, 13)
    for (const key of ['mote', 'topics', 'standalone', 'alpha', 'core', 'beta', 'group']) {
      assert.ok(g[key]?.icon?.width > 0 && g[key]?.title?.width > 0, `${key} must be rendered and readable`)
    }
    aligned(g.standalone.icon.x, g.mote.icon.x, 'root Folder and Mote icons share the natural edge')
    aligned(g.group.icon.x, g.mote.icon.x, 'path group occupies the existing type slot')
    assert.ok(g.topic.title.x <= 8, 'Topic leaves do not reserve any empty type/disclosure slot')
    assert.equal(g.topic.icon, null)
    assert.ok(g.indent >= 12, 'every density retains meaningful nesting')
    aligned(g.alpha.icon.x - g.group.icon.x, g.indent, 'group adds exactly one level')
    aligned(g.core.icon.x - g.alpha.icon.x, g.indent, 'nested Folder adds exactly one level')
    aligned(g.alpha.icon.x, g.beta.icon.x, 'group siblings align')
    assert.ok(g.topics.title.width > 0, 'section label remains readable')
    aligned(g.topic.box.height, g.standalone.box.height, 'Topic and Folder row rhythm')
    aligned(g.mote.glyph.width, g.mote.icon.width, 'Mote glyph follows the density cell')
    assert.ok(g.topics.icon.width > 0)
    assert.ok(g.edit.right <= g.rail.right, 'quiet Mote edit stays inside the row')
    assert.ok(g.scroll && g.scroll.scrollWidth <= g.scroll.clientWidth, 'one bounded scroll surface')
    assert.ok(g.activity.length > 0, 'real status consumer must render a nonempty metric cluster')
    for (const activity of g.activity) assert.ok(activity.box.right <= g.rail.right, 'status cluster stays inside the rail')
    assert.ok(g.standalone.title.right <= g.standalone.activity.x, 'status cluster does not overlap the Folder title')
    assert.deepEqual(g.original, original)
  }
  try {
    win = new BrowserWindow({ width: 260, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(html)
    await until(mode === 'restore' ? 'window.spaceTreeRetained && window.spaceTreeGeometry?.().topicCount === 0' : 'window.spaceTreeGeometry?.().topicCount === 13')
    original = await read('window.spaceTreeBaseline')
    if (mode === 'restore') {
      const retained = await read('window.spaceTreeRetained')
      assert.ok(retained && retained.sessions.length > 0 && Object.keys(retained.tabs).length > 0)
      assert.equal(await read('document.querySelector(".project-rail").dataset.railDensity'), 'dense')
      assert.deepEqual(await read('window.spaceTreeDisclosure()'), retained.collapsedProjectGroups)
      assert.equal(await read('document.querySelectorAll(".space-topic-row").length'), 0)
      assert.ok(await read('!!document.querySelector(".space-mote-row")'))
      assert.equal(await read('document.querySelector(".space-pin--pinned").getAttribute("aria-label")'), 'Unpin Mote')
      assert.deepEqual((await read('window.spaceTreeGeometry()')).original, original)
      await capture('restart.png')
      result.restart = { retained, distinctProcess: true }
      result.passed = true
      return
    }

    assert.equal(original.sessions.length, 30)
    assert.equal(Object.keys(original.tabs).length, 1)
    assert.ok(original.layouts.standalone)
    await capture('default.png')
    const g = await read('window.spaceTreeGeometry()')
    result.default = g
    check(g)
    const rich = await read('(() => { const topic = document.querySelector(".space-topic-row").closest(".project-rail-entry"); return { label:topic.querySelector(".project-activity").getAttribute("aria-label"), mark:topic.querySelector(".space-pin--pinned").getAttribute("aria-label"), metrics:[...topic.querySelectorAll(".project-activity__metric")].map(node=>node.textContent) } })()')
    assert.deepEqual(rich.metrics, ['12', '3'])
    assert.ok(rich.label.includes('12 Needs you') && rich.label.includes('3 Error') && rich.label.includes('Topic · Release planning'))
    assert.equal(rich.mark, 'Unpin Release planning and decisions')
    for (const width of [274, 180]) {
      win.setContentSize(width, 760)
      await until(`innerWidth === ${width}`)
      const richGeometry = await read('window.spaceTreeGeometry()')
      check(richGeometry)
      assert.ok(richGeometry.topic.title.width >= 20, 'long Topic name stays readable beside two-digit attention and mark')
      assert.ok(richGeometry.topic.title.right <= richGeometry.topic.activity.x)
      await capture(`rich-${width}.png`)
    }
    win.setContentSize(260, 760)
    await until('innerWidth === 260')
    result.rich = rich
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const click = async selector => {
      const r = await read(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'nearest'}); const r = node.getBoundingClientRect(); return {x:r.x + r.width/2, y:r.y + r.height/2} })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...r })
    }
    const originalDisclosure = await read('window.spaceTreeDisclosure()')
    for (const label of ['Create Mote', 'Create Topic', 'Open Folder']) await click(`[aria-label="${label}"]`)
    result.creationCalls = await read('window.spaceTreeOpenCalls')
    assert.deepEqual(result.creationCalls, [{kind:'mote'}, {kind:'topic'}, {kind:'open-folder'}])
    assert.deepEqual(await read('window.spaceTreeDisclosure()'), originalDisclosure)
    await read('window.spaceTreeOpenCalls.length = 0')
    for (const tier of ['compact', 'dense']) {
      await click('.space-tree-search > button:last-child')
      await until(`document.querySelector('.project-rail').dataset.railDensity === '${tier}'`)
      result[tier] = await read('window.spaceTreeGeometry()'); check(result[tier])
      assert.equal(result[tier].indent, result.default.indent)
      assert.ok(result[tier].mote.icon.width < (tier === 'compact' ? result.default.mote.icon.width : result.compact.mote.icon.width))
      assert.ok(result[tier].mote.box.height < (tier === 'compact' ? result.default.mote.box.height : result.compact.mote.box.height))
      await capture(`${tier}.png`)
    }
    await click('[aria-label="Collapse Topics"]')
    await until('window.spaceTreeGeometry().topicCount === 0')
    assert.equal((await read('window.spaceTreeGeometry()')).topicExpanded, 'false')
    assert.ok(await read('!!document.querySelector(\'[data-workspace-id="alpha"]\')'))
    await click('[aria-label="Expand Topics"]')
    await until('window.spaceTreeGeometry().topicCount === 13')
    await click('.project-rail-group__header')
    await until('!document.querySelector(\'[data-workspace-id="alpha"]\')')
    assert.ok(await read('document.querySelector(".project-rail-group__label").getBoundingClientRect().width > 0'))
    assert.equal((await read('window.spaceTreeGeometry()')).topicCount, 13)
    await click('.project-rail-group__header')
    await until('!!document.querySelector(\'[data-workspace-id="alpha"]\')')
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await read('document.querySelector(\'[aria-label="Topics overview"]\').focus()')
    result.focus = (await read('window.spaceTreeGeometry()')).focus
    assert.equal(result.focus.visible, true)
    assert.notEqual(result.focus.outline, 'none')
    win.setContentSize(180, 340)
    await until('innerWidth === 180 && innerHeight === 340')
    result.narrow = await read('window.spaceTreeGeometry()'); check(result.narrow)
    assert.ok(result.narrow.scroll.scrollHeight > result.narrow.scroll.clientHeight)
    await capture('narrow.png')
    const scroll = result.narrow.scroll.box
    await input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroll.x + scroll.width / 2,
      y: scroll.y + scroll.height / 2, deltaX: 0, deltaY: 10000 })
    await until('document.querySelector(".space-tree").scrollTop > 0')
    const bottom = await read('window.spaceTreeGeometry()')
    assert.ok(bottom.beta.box.bottom <= bottom.scroll.box.bottom + .5)
    assert.deepEqual(bottom.header, result.narrow.header, 'heading stays fixed while tree scrolls')
    result.scrolled = bottom
    await capture('scrolled.png')
    await click('.project-rail-group__header')
    await until('!document.querySelector(\'[data-workspace-id="alpha"]\')')
    result.collapsed = await read('window.spaceTreeGeometry()')
    assert.ok(result.collapsed.group.title.width >= 20, 'collapsed group keeps a readable name beside address and live counts')
    assert.equal(result.collapsed.activity.length, 4)
    assert.ok(result.collapsed.group.title.right <= result.collapsed.group.activity.x)
    assert.ok(result.collapsed.scroll.scrollWidth <= result.collapsed.scroll.clientWidth)
    assert.deepEqual(result.collapsed.original, original)
    await capture('collapsed.png')
    const press = async key => {
      const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Escape: 27, Enter: 13, Tab: 9 }
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key], ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    }
    const disclosureHover = await read('(() => { const node = document.querySelector(".space-topics-heading [data-space-disclosure]"); node.scrollIntoView({block:"nearest"}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()')
    await input('Input.dispatchMouseEvent', { type:'mouseMoved', ...disclosureHover })
    await capture('disclosure-hover.png')
    await input('Input.dispatchMouseEvent', { type:'mouseMoved', x:10, y:10 })
    await read('document.querySelector(".space-motes-heading .space-section-add").focus()')
    let reachedDisclosure = false
    for (let index = 0; index < 12; index += 1) {
      await press('Tab')
      if (await read('document.activeElement.matches(".space-topics-heading [data-space-disclosure]")')) { reachedDisclosure = true; break }
    }
    assert.equal(reachedDisclosure, true, 'native Tab reaches the independent disclosure type slot')
    result.disclosureFocus = await read('({ visible:document.activeElement.matches(":focus-visible"), outline:getComputedStyle(document.activeElement).outlineStyle, label:document.activeElement.getAttribute("aria-label") })')
    assert.equal(result.disclosureFocus.visible, true)
    assert.notEqual(result.disclosureFocus.outline, 'none')
    await capture('disclosure-focus.png')
    result.disclosureGlyph = await read('(() => { const control=document.querySelector(".space-topics-heading [data-space-disclosure]"); return {hint:getComputedStyle(control.querySelector(".space-disclosure__hint")).opacity, width:control.getBoundingClientRect().width, glyph:control.querySelector(".space-disclosure__hint svg").getAttribute("class"), label:control.getAttribute("aria-label")} })()')
    assert.ok(result.disclosureGlyph.glyph.includes('chevron'))
    assert.ok(result.disclosureGlyph.width <= 15)
    assert.equal(result.disclosureGlyph.hint, '1')
    const savedDisclosure = await read('window.spaceTreeDisclosure()')
    const savedScroll = await read('document.querySelector(".space-tree").scrollTop')

    await click('[aria-label="Find Spaces"]')
    await input('Input.insertText', { text: 'core' })
    await until('!!document.querySelector(\'[data-workspace-id="core"]\') && !document.querySelector(\'[data-workspace-id="beta"]\')')
    result.found = await read('window.spaceTreeGeometry()')
    assert.equal(result.found.topicCount, 0)
    assert.ok(result.found.alpha && result.found.core, 'search reveals the original collapsed ancestor and its matching child')
    assert.deepEqual(await read('window.spaceTreeDisclosure()'), savedDisclosure)
    await capture('found.png')
    await click('[data-workspace-id="core"]')
    await read('window.spaceTreeOpenCalls.length = 0')
    await press('ArrowLeft')
    assert.equal(await read('document.activeElement.dataset.workspaceId'), 'alpha')
    await press('ArrowRight')
    assert.equal(await read('document.activeElement.dataset.workspaceId'), 'core')
    await press('Home')
    assert.equal(await read('document.activeElement.dataset.spaceNav'), 'space:motes')
    await press('End')
    assert.equal(await read('document.activeElement.dataset.workspaceId'), 'core')
    assert.deepEqual(await read('window.spaceTreeOpenCalls'), [], 'protocol navigation focuses without activating')
    await press('Enter')
    assert.deepEqual(await read('window.spaceTreeOpenCalls'), [{ kind: 'folder', id: 'core' }], 'native Enter reaches the exact original Folder owner')
    await click('[aria-label="Find Spaces"]')
    await press('Escape')
    await until('document.querySelector(\'[aria-label="Find Spaces"]\').value === "" && window.spaceTreeGeometry().topicCount === 13')
    assert.deepEqual(await read('window.spaceTreeDisclosure()'), savedDisclosure)
    assert.equal(await read('document.querySelector(".space-tree").scrollTop'), savedScroll)
    assert.ok(!await read('!!document.querySelector(\'[data-workspace-id="alpha"]\')'))
    await input('Input.insertText', { text: 'nothing-available' })
    await until('document.querySelectorAll(".space-tree-empty").length === 3')
    assert.equal(await read('document.querySelectorAll(".space-topic-row, [data-workspace-id]").length'), 0)
    await capture('no-results.png')
    await click('[aria-label="Clear Space search"]')
    await until('window.spaceTreeGeometry().topicCount === 13')
    assert.equal(await read('document.querySelector(".space-tree").scrollTop'), savedScroll)
    assert.deepEqual(await read('window.spaceTreeDisclosure()'), savedDisclosure)
    assert.deepEqual((await read('window.spaceTreeGeometry()')).original, original)
    await capture('restored.png')
    result.navigation = { input: 'CDP Input.insertText and keyDown/keyUp through actual mounted handlers', query: 'core', savedDisclosure, savedScroll, preserved: true, exactFolderEnter: true }
    await read('document.querySelector(\'.space-mote-row\').focus()'); await press('Tab'); await press('Tab')
    assert.equal(await read('getComputedStyle(document.activeElement).opacity'), '1', 'the quiet edit action becomes visible at keyboard focus')
    const hover = await read('(() => { const node = document.querySelector(".space-topic-row"); node.scrollIntoView({block:"nearest"}); const r = node.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })()')
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hover })
    await read('Promise.all(document.querySelector(".space-topic-row").getAnimations().map(animation => animation.finished))')
    result.visual = await read(`(() => {
      const active = document.querySelector('.project-rail-row--active')
      const plain = document.querySelector('.space-topic-row')
      const ordinaryWeight = getComputedStyle(plain.querySelector('strong')).fontWeight
      const hoverFill = getComputedStyle(plain).backgroundColor
      return { hovered: plain.matches(':hover'), selectedFill: getComputedStyle(active).backgroundColor, hoverFill, ordinaryWeight,
        selectedWeight: getComputedStyle(active.querySelector('strong')).fontWeight,
        topicGlyphs: document.querySelectorAll('.space-topic-row .project-rail-row__icon svg').length }
    })()`)
    assert.equal(result.visual.topicGlyphs, 0, 'identical Topic glyphs do not consume attention')
    assert.equal(result.visual.hovered, true, 'the pointer actually hovers a visible Topic row')
    assert.ok(Number(result.visual.selectedWeight) > Number(result.visual.ordinaryWeight))
    assert.notEqual(result.visual.selectedFill, result.visual.hoverFill, 'selected and hover surfaces remain distinguishable')
    await click('.space-folders-row')
    await until('!document.querySelector("[data-workspace-id]")')
    assert.equal((await read('window.spaceTreeGeometry()')).topicCount, 13)
    const folderSummary = await read('(() => { const node = document.querySelector(".space-folders-heading .project-activity"); const row = document.querySelector(".space-folders-row"); return { label: node.getAttribute("aria-label"), metrics: node.querySelectorAll(".project-activity__metric").length, width: row.querySelector("strong").getBoundingClientRect().width, right: node.getBoundingClientRect().right } })()')
    assert.ok(folderSummary.label.includes('1 Needs you') && folderSummary.label.includes('1 Error') && folderSummary.label.includes('2 Working'))
    assert.equal(folderSummary.metrics, 2)
    assert.ok(folderSummary.width > 0 && folderSummary.right <= result.narrow.width)
    assert.deepEqual((await read('window.spaceTreeGeometry()')).original, original)
    result.folderSummary = folderSummary
    await press('ArrowRight')
    await until('!!document.querySelector("[data-workspace-id]")')
    assert.equal(await read('window.spaceTreeDisclosure()["space:folders"]'), undefined)
    const moteHover = await read('(() => { const node = document.querySelector(".space-mote-row"); node.scrollIntoView({block:"nearest"}); const r = node.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 } })()')
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...moteHover })
    await until(`getComputedStyle(document.querySelector('[aria-label="Pin Mote"]')).display !== 'none'`)
    await click('[aria-label="Pin Mote"]')
    await until('!!document.querySelector(".space-pin--pinned")')
    await click('[aria-label="Collapse Topics"]')
    result.durable = await read('window.spaceTreePersist()')
    await read('document.documentElement.dataset.appearance = "light"')
    const themeFacts = () => read(`(() => { const root = document.documentElement; const style = getComputedStyle(root); const mote = getComputedStyle(document.querySelector('.space-mote-row')); const active = getComputedStyle(document.querySelector('.project-rail-row--active')); return { dataset:{...root.dataset}, inlineStyle:root.getAttribute('style'), text:style.getPropertyValue('--text').trim(), text2:style.getPropertyValue('--text-2').trim(), surface3:style.getPropertyValue('--surface-3').trim(), moteColor:mote.color, selectedColor:active.color, selectedFill:active.backgroundColor, transitions:document.getAnimations().map(animation => ({type:animation.constructor.name, iterations:animation.effect?.getComputedTiming().iterations})) } })()`)
    result.lightTransition = await themeFacts()
    await capture('light.png')
    result.lightStable = await themeFacts()
    assert.equal(result.lightStable.text, '#17201a')
    assert.equal(result.lightStable.text2, '#46554b')
    assert.equal(result.lightStable.surface3, '#d7dfda')
    assert.equal(result.lightStable.moteColor, 'rgb(70, 85, 75)')
    assert.equal(result.lightStable.selectedColor, 'rgb(23, 32, 26)')
    assert.equal(result.lightStable.selectedFill, 'rgb(215, 223, 218)')
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
