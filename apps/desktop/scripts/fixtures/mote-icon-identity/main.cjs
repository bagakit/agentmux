const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, pid: process.pid,
  boundary: 'Actual MoteIcon, SpaceTopicsTree, SpaceCreateMenu, AgentAvatar, WorkbenchTabMarks and QuickSwitcher, with preview API data in a private Electron profile. No user App, Run, install or restart.' }
let win
app.whenReady().then(async () => {
  const read = expression => win.webContents.executeJavaScript(expression)
  const until = async expression => {
    const deadline = Date.now() + 5000
    do {
      if (await read(expression)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    throw new Error(`Mote review did not settle: ${expression}`)
  }
  const capture = async name => {
    await read('Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))')
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    fs.writeFileSync(path.join(privateRoot, name), (await win.webContents.capturePage()).toPNG())
  }
  try {
    win = new BrowserWindow({ width: 860, height: 570, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    await win.loadFile(html)
    await until('window.moteReviewFacts?.().samples.length === 6')
    result.nativeScale = await read('devicePixelRatio')
    result.svg = await read('window.moteReviewSVG')
    assert.ok(result.svg.startsWith('<svg') && result.svg.includes('fill="currentColor"'))
    fs.writeFileSync(path.join(privateRoot, 'mote.svg'), result.svg)
    result.specimen = await read('window.moteReviewFacts()')
    assert.equal(result.specimen.samples.length, 6)
    assert.ok(result.specimen.contourBounds.width > 15 && result.specimen.contourBounds.height > 15)
    const paths = new Set(result.specimen.samples.map(sample => sample.path))
    assert.equal(paths.size, 1)
    for (const sample of result.specimen.samples) {
      const size = Number(sample.sample.split('-')[1])
      assert.equal(sample.width, size)
      assert.equal(sample.height, size)
      assert.equal(sample.filter, 'none')
    }
    assert.notEqual(result.specimen.samples[0].fill, result.specimen.samples[3].fill)
    assert.equal(result.specimen.treePath, result.specimen.samples[0].path)
    await capture('specimen.png')
    win.webContents.debugger.attach('1.3')
    const input = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const click = async selector => {
      const p = await read(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...p })
    }
    await click('[aria-label="Add Space"]')
    await until('!!window.moteReviewFacts().creationPath')
    result.creation = await read('window.moteReviewFacts()')
    assert.equal(result.creation.creationPath, result.specimen.treePath)
    await capture('creation-menu.png')
    await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until('!window.moteReviewFacts().creationPath')
    await click('#open-switcher')
    await until('window.moteReviewFacts().switcherLauncher')
    result.switcher = await read('window.moteReviewFacts()')
    await capture('quick-switcher.png')
    result.passed = true
  } catch (error) { result.failure = { message: error.message, stack: error.stack } }
  finally {
    fs.writeFileSync(path.join(privateRoot, 'native.json'), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
