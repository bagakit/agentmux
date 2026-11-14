const { app, BrowserWindow, Menu, session } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const assert = require('node:assert/strict')

const [html, evidence] = process.argv.slice(2)
assert(evidence?.includes('/capture-'))
app.setPath('userData', join(evidence, 'userData'))
Menu.setApplicationMenu(null)
const result = { passed: false, captureOnly: true, images: [], observations: {}, errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].includes(new URL(request.url).protocol) }))
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, info) => { if (info.level === 'error') result.errors.push(info.message) })
    await win.loadFile(html, { query: { workspacePath: join(evidence, 'workspace'), scenario: 'calendar-density' } })
    win.webContents.focus()
    const read = async script => {
      try { return await win.webContents.executeJavaScript(script) }
      catch (cause) { throw new Error('Renderer observation failed: ' + script, { cause }) }
    }
    const locator = selector => `document.querySelector(${JSON.stringify(selector)})`
    const control = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(element=>element.textContent.trim()===${JSON.stringify(text)})`
    const waitFor = async (expression, label) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await read(expression)) return
        await pause(30)
      }
      throw new Error('Missing original renderer state: ' + label)
    }
    const click = async expression => {
      const point = await read(`(()=>{const element=${expression};if(!element)throw Error('Missing action');element.scrollIntoView({block:'nearest',inline:'nearest'});const rect=element.getBoundingClientRect(),x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2);const hit=document.elementFromPoint(x,y);if(hit!==element&&!element.contains(hit))throw Error('Action is not reachable: '+element.textContent);return{x,y}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    }
    const capture = async name => {
      await read('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
      const image = await win.capturePage()
      const file = name + '.png'
      await writeFile(join(evidence, file), image.resize({ width: Math.min(1440, win.getContentSize()[0]), quality: 'best' }).toPNG())
      result.images.push(file)
    }
    const modes = '[aria-label="Calendar view"] button'
    await waitFor(`!!${control('[role="tab"]', 'Calendar')}`, 'Calendar tab')
    await click(control('[role="tab"]', 'Calendar'))
    await waitFor(`document.querySelectorAll('.mote-calendar__day [data-schedule-id]').length===2`, 'two original schedules')
    assert.equal(await read(`document.querySelector('.workspace-files-source')?.getBoundingClientRect().height ?? 0`), 0)
    result.observations.railWidth = await read(`document.querySelector('.mote-calendar__day').getBoundingClientRect().width`)
    assert(result.observations.railWidth >= 320 && result.observations.railWidth <= 340)
    const completed = locator('[data-calendar-schedule-id="completed-timer"]')
    await waitFor(`${completed}?.getAttribute('aria-label').includes('Input accepted')`, 'confirmed completed timer')
    await click(completed)
    const events = locator('[aria-label="Calendar events"]')
    await waitFor(`${events}?.textContent.includes('Sent to terminal') && ${events}?.textContent.includes('Agent turn completed')`, 'two original events in the same period')
    await capture('calendar-events')
    await click(locator('.mote-calendar__event[data-event-schedule="group-watch"]'))
    await waitFor(`document.querySelector('.mote-calendar__recap')?.textContent.includes('Review the open commitments')`, 'frozen exact event recap')
    assert.equal(await read(`!!document.querySelector('[data-selected="true"] [data-calendar-schedule-id="group-watch"]')`), false)
    assert.equal(await read(`(() => { const list = ${events}.getBoundingClientRect(); const pane = document.querySelector('.mote-calendar__day').getBoundingClientRect(); const next = document.querySelector('.mote-calendar__day > header').getBoundingClientRect(); return list.top >= pane.top && list.bottom <= pane.bottom && list.bottom <= next.top })()`), true)
    await capture('calendar-event-recap')
    win.setContentSize(430, 880)
    await read(`${events}.scrollIntoView({block:'nearest'})`)
    await capture('calendar-event-recap-narrow')
    win.setContentSize(1440, 900)
    const tomorrow = await read(`(()=>{const dates=[...document.querySelectorAll('[data-mote-date]')],i=dates.findIndex(button=>button.closest('[data-today=true]'));return dates[i+1].dataset.moteDate})()`)
    await click(locator(`[data-mote-date="${tomorrow}"]`))
    await waitFor(`document.querySelector('.mote-calendar__plan-total strong')?.textContent.replace(/[^0-9]/g,'')==='2160'`, 'daily forecast of 2160')
    await pause(220)
    await capture('month-density')
    await click(control(modes, '3 Days'))
    await waitFor(`document.querySelectorAll('[data-calendar-hour]').length===72`, '72 original hour groups')
    result.observations.transition = await read(`document.querySelector('.mote-calendar__canvas').getAnimations().filter(a=>a.playState==='running').length`)
    if (result.observations.transition) await capture('three-day-transition')
    const hour = locator(`[data-calendar-hour="${tomorrow}:20"]`)
    await pause(220)
    await click(hour)
    await waitFor(`document.querySelector('.mote-calendar__plan-total strong')?.textContent==='90'`, 'hour forecast of 90')
    await capture('three-day-density')
    await click(locator('.mote-calendar__time-details > summary'))
    await waitFor(`document.querySelectorAll('.mote-calendar__time-page li').length===12`, '12 time rows in visible page')
    await pause(220)
    await capture('hour-details')
    await click(control('.mote-calendar__time-pager button', 'Next'))
    await waitFor(`document.querySelector('.mote-calendar__time-pager')?.textContent.includes('13–24 / 90')`, 'second page of times')
    win.setContentSize(430, 880)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click(control(modes, 'Day'))
    await waitFor(`document.querySelectorAll('[data-calendar-hour]').length===24`, '24 day hours')
    assert.equal(await read(`document.querySelector('.mote-calendar__canvas').getAnimations().length`), 0)
    assert.equal(await read(`document.querySelector('.mote-calendar').scrollWidth<=document.querySelector('.mote-calendar').clientWidth+1`), true)
    await capture('day-narrow-reduced')
    const facts = await read('window.moteCalendarScene.facts()')
    const receipts = facts.calls.filter(call => call.method === 'schedule.history')
    assert.ok(receipts.every(call => call.params.to - call.params.from <= 90_000_000 && call.params.limit === 12))
    assert.ok(receipts.some(call => call.params.scheduleId === 'completed-timer'))
    assert.ok(receipts.some(call => call.params.scheduleId === 'group-watch'))
    assert.equal(facts.calls.filter(call => /schedule\.(create|pause|resume|cancel)/u.test(call.method)).length, 0)
    assert.deepEqual(facts.drafts, facts.initialDrafts)
    assert.deepEqual(result.errors, [])
    result.passed = true
  } catch (error) {
    result.failure = error.stack
    console.error(error)
  } finally {
    await writeFile(join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    app.exit(result.passed ? 0 : 1)
  }
})
