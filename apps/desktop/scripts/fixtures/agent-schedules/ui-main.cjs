const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 680, height: 840, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html)
    const read = script => win.webContents.executeJavaScript(script)
    for (let i = 0; i < 100 && !(await read('document.querySelector("[data-schedule-id]")')); i++) await pause(30)
    assert.equal(await read('document.querySelectorAll("[data-schedule-id]").length'), 1)
    const click = async script => {
      const rect = await read(`(()=>{const n=${script};if(!n)throw Error('Missing original control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 }); await pause(100)
    }
    const capture = async name => {
      await pause(100)
      const facts = await read(`(()=>{const n=document.querySelector('.schedule-scene');return {overflow:n.scrollWidth>n.clientWidth,draft:document.querySelector('[aria-label="Manual message"]').value, state:document.querySelector('[data-schedule-state]').dataset.scheduleState}})()`)
      assert.equal(facts.overflow, false); assert.equal(facts.draft, '这段手动消息还没发，请保留。')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png'); result.operations.push({ name, ...facts })
    }
    await capture('calendar-wide-active')
    win.setContentSize(360, 900); await capture('calendar-narrow-active')
    await click('document.querySelector(".calendar-schedules > details > summary")')
    await click('document.querySelector(".calendar-schedules textarea")')
    win.webContents.insertText('明天请先问我设计方向是否有变化。')
    await pause(100)
    const key = async keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(100) }
    await key('Tab'); assert.equal(await read('document.activeElement.textContent'), 'Time rules')
    await key('Tab'); assert.equal(await read('document.activeElement.textContent'), 'Save arrangement')
    await read('document.querySelector(".schedule-scene__body").scrollTop=200')
    await capture('calendar-narrow-form')
    await key('Enter')
    assert.equal(await read('scheduleScene.operations.length'), 1)
    await read('document.querySelector(".schedule-scene__body").scrollTop=0')
    await capture('calendar-narrow-unknown')
    await click('[...document.querySelectorAll("button")].find(n=>n.textContent==="Retry original operation")')
    assert.deepEqual(await read('scheduleScene.operations[0]'), await read('scheduleScene.operations[1]'))
    win.setContentSize(680, 840); await capture('calendar-wide-unknown')
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
