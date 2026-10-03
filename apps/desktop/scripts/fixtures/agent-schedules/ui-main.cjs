const { fixtureClock: _hygiene_fixtureClock } = require("../../lib/fixture-values.mjs")
const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
const checkIn = process.argv.includes('--checkin')
app.setPath('userData', path.join(evidence, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 680, height: 840, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, checkIn ? { query: { checkin: '1' } } : {})
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
    await capture(checkIn ? 'checkin-wide-waiting' : 'calendar-wide-active')
    win.setContentSize(360, 900); await capture(checkIn ? 'checkin-narrow-waiting' : 'calendar-narrow-active')
    await click('document.querySelector(".calendar-schedules > details > summary")')
    if (checkIn) {
      assert.equal(await read(`document.querySelector('[aria-label="Enable quiet follow-up"]').checked`), false)
      await capture('checkin-narrow-default-off')
      await click(`document.querySelector('[aria-label="Enable quiet follow-up"]')`)
      assert.equal(await read(`document.querySelector('[aria-label="Enable quiet follow-up"]').checked`), true)
    }
    await click('document.querySelector(".calendar-schedules textarea")')
    win.webContents.insertText('明天请先问我设计方向是否有变化。')
    await pause(100)
    const key = async keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await pause(100) }
    await key('Tab'); assert.equal(await read('document.activeElement.getAttribute("aria-label")'), 'Enable quiet follow-up')
    await key('Tab'); assert.equal(await read('document.activeElement.textContent'), 'Time rules')
    await key('Tab'); assert.equal(await read('document.activeElement.textContent'), 'Save arrangement')
    await read('document.querySelector(".schedule-scene__body").scrollTop=200')
    await capture(checkIn ? 'checkin-narrow-opt-in' : 'calendar-narrow-form')
    await key('Enter')
    if (checkIn) {
      assert.equal(await read('scheduleScene.operations.length'), 0)
      assert.equal(await read('document.querySelector("[data-schedule-state]").dataset.scheduleState'), 'active')
      assert.equal(await read('document.querySelector(".calendar-schedules textarea").disabled'), false)
      await capture('checkin-narrow-existing-follow-up')
      await click('[...document.querySelectorAll("button")].find(n=>n.textContent==="Cancel arrangement")')
      assert.equal(await read('scheduleScene.operations[0].method'), 'cancel')
      await click('[...document.querySelectorAll("button")].find(n=>n.textContent==="Save arrangement")')
      assert.deepEqual(await read('scheduleScene.operations.filter(n=>n.method==="create")[0].params.checkIn'), { silenceMs: 64800000, minIntervalMs: 72000000, dailyBudget: 1, quiet: { start: _hygiene_fixtureClock(22, 0), end: _hygiene_fixtureClock(8, 0) } })
    }
    assert.equal(await read('scheduleScene.operations.filter(n=>n.method==="create").length'), 1)
    await read('document.querySelector(".schedule-scene__body").scrollTop=0')
    await capture(checkIn ? 'checkin-narrow-unknown-create' : 'calendar-narrow-unknown')
    await click('[...document.querySelectorAll("button")].find(n=>n.textContent==="Retry original operation")')
    assert.deepEqual(await read('scheduleScene.operations.filter(n=>n.method==="create")[0]'), await read('scheduleScene.operations.filter(n=>n.method==="create")[1]'))
    win.setContentSize(680, 840)
    if (checkIn) { await read('scheduleScene.outcome("unknown")'); await capture('checkin-wide-unknown'); await read('scheduleScene.outcome("skipped")'); await capture('checkin-wide-skipped') }
    else await capture('calendar-wide-unknown')
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) { result.error = { message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
