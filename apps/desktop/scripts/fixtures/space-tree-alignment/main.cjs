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
      const r = await read(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x + r.width/2, y:r.y + r.height/2} })()`)
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
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
