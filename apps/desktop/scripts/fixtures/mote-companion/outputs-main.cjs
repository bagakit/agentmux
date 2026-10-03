const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 720, height: 840, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html)
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('!!document.querySelector(".conversation-file")')); i++) await pause(30)
    assert.equal(await read('document.querySelectorAll(".conversation-file").length'), 8)
    const click = async selector => {
      const rect = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing real control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      await pause(100)
    }
    const capture = async name => {
      await pause(100)
      const facts = await read(`(()=>{const n=document.querySelector('.outputs-scene');return {overflow:n.scrollWidth>n.clientWidth,draft:document.querySelector('[role=textbox]')?.textContent,refs:document.querySelectorAll('.conversation-file').length}})()`)
      assert.equal(facts.overflow, false); assert.equal(facts.refs, 8); assert.equal(facts.draft, '请保留这段尚未发送的草稿。')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await capture('outputs-wide-dark')
    win.setContentSize(360, 900); await capture('outputs-narrow-dark')
    await click('.conversation-files__more > summary')
    assert.equal(await read('document.querySelector(".conversation-files__more").open'), true)
    await click('.conversation-file[aria-label="Open deliverables/missing.md"]')
    assert.equal(await read('outputScene.actions.at(-1).path'), 'deliverables/missing.md')
    await capture('outputs-narrow-unavailable')
    // The original editor receives the recorded line/column, without filesystem reads here.
    await click('.conversation-file[aria-label="Open src/scheduler.ts:42:3"]')
    assert.deepEqual(await read('outputScene.actions.at(-1)'), { path: 'src/scheduler.ts', location: { line: 42, column: 3 } })
    win.setContentSize(720, 840); await capture('outputs-wide-expanded')
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
