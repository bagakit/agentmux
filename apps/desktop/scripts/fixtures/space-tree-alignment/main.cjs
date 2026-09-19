const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot] = process.argv.slice(2)
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
    fs.writeFileSync(path.join(privateRoot, name), (await win.webContents.capturePage()).toPNG())
  }
  const aligned = (a, b, message) => assert.ok(Math.abs(a - b) < .5, `${message}: ${a} vs ${b}`)
  const check = g => {
    assert.equal(g.topicCount, 13)
    for (const key of ['mote', 'topics', 'topic', 'standalone', 'alpha', 'core', 'beta', 'group']) {
      assert.ok(g[key]?.icon?.width > 0 && g[key]?.title?.width > 0, `${key} must be rendered and readable`)
    }
    aligned(g.mote.icon.x, g.topics.icon.x, 'same-level Mote and Topics icons')
    aligned(g.standalone.icon.x, g.topics.icon.x, 'same-level Folder and Topics icons')
    aligned(g.group.icon.x, g.topics.icon.x, 'same-level path group and Topics icons')
    aligned(g.mote.title.x, g.topics.title.x, 'same-level Mote and Topics titles')
    aligned(g.standalone.title.x, g.topics.title.x, 'same-level Folder and Topics titles')
    aligned(g.topic.icon.x - g.topics.icon.x, g.indent, 'Topic must be exactly one level inside Topics')
    aligned(g.alpha.icon.x - g.group.icon.x, g.indent, 'group adds exactly one level')
    aligned(g.core.icon.x - g.alpha.icon.x, g.indent, 'nested Folder adds exactly one level')
    aligned(g.alpha.icon.x, g.beta.icon.x, 'group siblings align')
    aligned(g.mote.box.height, g.topics.box.height, 'top-level row rhythm')
    aligned(g.topic.box.height, g.standalone.box.height, 'Topic and Folder row rhythm')
    aligned(g.mote.glyph.width, g.mote.icon.width, 'Mote glyph follows the density cell')
    aligned(g.topics.glyph.width, g.topics.icon.width, 'Topics glyph follows the density cell')
    assert.ok(g.edit.right <= g.rail.right && g.edit.width >= 20, 'Mote edit retains a real hit area')
    assert.ok(g.scroll && g.scroll.scrollWidth <= g.scroll.clientWidth, 'one bounded scroll surface')
    assert.ok(g.activity.length > 0, 'real status consumer must render a nonempty metric cluster')
    for (const activity of g.activity) assert.ok(activity.box.right <= g.rail.right, 'status cluster stays inside the rail')
    assert.ok(g.standalone.title.right <= g.activity[0].box.x, 'status cluster does not overlap the Folder title')
    assert.deepEqual(g.original, original)
  }
  try {
    win = new BrowserWindow({ width: 260, height: 760, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(html)
    await until('window.spaceTreeGeometry?.().topicCount === 13')
    original = await read('window.spaceTreeBaseline')
    assert.equal(original.sessions.length, 13)
    assert.equal(Object.keys(original.tabs).length, 1)
    assert.ok(original.layouts.standalone)
    await capture('default.png')
    const g = await read('window.spaceTreeGeometry()')
    result.default = g
    check(g)
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const click = async selector => {
      const r = await read(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'nearest'}); const r = node.getBoundingClientRect(); return {x:r.x + r.width/2, y:r.y + r.height/2} })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...r })
    }
    for (const tier of ['compact', 'dense']) {
      await click('.sidebar__heading-actions > button')
      await until(`document.querySelector('.project-rail').dataset.railDensity === '${tier}'`)
      result[tier] = await read('window.spaceTreeGeometry()'); check(result[tier])
      assert.ok(result[tier].indent < (tier === 'compact' ? result.default.indent : result.compact.indent))
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
    assert.equal(result.collapsed.activity.length, 2)
    assert.ok(result.collapsed.group.title.right <= result.collapsed.activity[1].box.x)
    assert.ok(result.collapsed.scroll.scrollWidth <= result.collapsed.scroll.clientWidth)
    assert.deepEqual(result.collapsed.original, original)
    await capture('collapsed.png')
    const savedDisclosure = await read('window.spaceTreeDisclosure()')
    const savedScroll = await read('document.querySelector(".space-tree").scrollTop')
    const press = async key => {
      const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Escape: 27, Enter: 13 }
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key], ...(key === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    }
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
    assert.equal(await read('document.activeElement.dataset.spaceNav'), 'space:topics')
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
    await until('document.querySelectorAll(".space-tree-empty").length === 2')
    assert.equal(await read('document.querySelectorAll(".space-topic-row, [data-workspace-id]").length'), 0)
    await capture('no-results.png')
    await click('[aria-label="Clear Space search"]')
    await until('window.spaceTreeGeometry().topicCount === 13')
    assert.equal(await read('document.querySelector(".space-tree").scrollTop'), savedScroll)
    assert.deepEqual(await read('window.spaceTreeDisclosure()'), savedDisclosure)
    assert.deepEqual((await read('window.spaceTreeGeometry()')).original, original)
    await capture('restored.png')
    result.navigation = { input: 'CDP Input.insertText and keyDown/keyUp through actual mounted handlers', query: 'core', savedDisclosure, savedScroll, preserved: true, exactFolderEnter: true }
    await read('document.querySelector(\'[aria-label="Edit Mote SOUL.md"]\').focus()')
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
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
