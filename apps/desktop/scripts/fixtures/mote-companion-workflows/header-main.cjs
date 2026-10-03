const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, images: [], operations: [], pid: process.pid }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 720, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('!!window.moteHeader')); i++) await pause(30)
    const click = async selector => {
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing original control');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 })
      await pause(120)
    }
    await click('[aria-label="Hide file tree"]')
    assert.equal(await read('!!document.querySelector(\'[aria-label="Show file tree"]\')'), true)
    await click('[aria-label="Show file tree"]')
    assert.equal(await read('!!document.querySelector(\'[aria-label="Hide file tree"]\')'), true)
    result.originalCollapseInteraction = { method: 'Chromium sendInputEvent', collapsedAndExpanded: true }
    for (const narrow of [false, true]) for (const light of [false, true]) {
      win.setContentSize(narrow ? 320 : 1080, 720)
      await read(`moteHeader.narrow(${narrow});moteHeader.theme(${light})`); await pause(180)
      const facts = await read(`(()=>{const h=document.querySelector('.workspace-tool-context--explorer');return {header:h.textContent,appearance:document.documentElement.dataset.appearance,background:getComputedStyle(document.documentElement).backgroundColor,scopeControls:!!h.querySelector('.workspace-files-scope'),captureControl:!!h.querySelector('[aria-label="Collect sources in a knowledge topic"]'),horizontalOverflow:document.body.scrollWidth>innerWidth,...moteHeader.facts()}})()`)
      assert.equal(facts.appearance, light ? 'light' : 'dark')
      if (light) assert.notEqual(facts.background, result.operations.at(-1)?.background)
      assert.ok(facts.header.includes('Mote')); assert.equal(facts.scopeControls, false); assert.equal(facts.captureControl, false)
      assert.equal(facts.horizontalOverflow, false); assert.equal(facts.drafts['original-region'], 'Keep this original unsent question.')
      assert.ok(facts.calls.some(call => call.operation === 'readDirectory' && call.path === 'topic--launcher--leader'))
      assert.ok(!facts.calls.some(call => call.path === '' || call.operation === 'write'))
      const file = `header-${narrow ? 'narrow' : 'wide'}-${light ? 'light' : 'dark'}.png`
      await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.images.push(file); result.operations.push({ file, ...facts })
    }
    result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
