const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', engine: { electron: process.versions.electron, chromium: process.versions.chrome }, images: [], operations: [], errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
assert.ok(evidence && evidence.includes('/capture-'))
for (const key of Object.keys(process.env)) if (key.startsWith('CTXMUX_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key]
for (const [key, value] of Object.entries(process.env)) if (key.startsWith('AGENTMUX_') || key === 'AGENT_SESSION_STORE') assert.ok(value.startsWith(evidence + '/'), 'Every inherited AgentMux path must belong to this capture')
app.setPath('userData', path.join(evidence, 'userData'))
app.setPath('sessionData', path.join(evidence, 'userData', 'session'))
Menu.setApplicationMenu(null)
let win
app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const allowed = ['file:', 'data:', 'blob:', 'devtools:'].includes(url.protocol)
      if (!allowed) result.errors.push('PRIVATE_FIXTURE_BLOCKED_NETWORK:' + url.protocol)
      callback({ cancel: !allowed })
    })
    win = new BrowserWindow({ width: 1240, height: 900, show: false, backgroundColor: '#181818',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(html, { query: { workspacePath: path.join(evidence, 'workspace') } })
    win.webContents.focus()
    const read = script => win.webContents.executeJavaScript(script)
    const until = async (script, message = script) => {
      for (let i = 0; i < 180; i++) { if (await read(script)) return; await pause(30) }
      throw new Error('Private Renderer condition timed out: ' + message)
    }
    const panel = `([...document.querySelectorAll('.mote-profile-popover [data-mote-details]'),...document.querySelectorAll('[data-mote-details]')].find(n=>n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0&&getComputedStyle(n).visibility!=='hidden'))`
    const inPanel = selector => `(${panel})?.querySelector(${JSON.stringify(selector)})`
    const button = (text, root = panel) => `[...(${root}).querySelectorAll('button,[role="tab"],summary')].find(n=>n.textContent.trim()===${JSON.stringify(text)})`
    const click = async (script, name) => {
      const rect = await read(`(()=>{const n=${script};if(!n)throw Error('Missing observed control: '+${JSON.stringify(name ?? script)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden control');return {x:r.x+r.width/2,y:r.y+r.height/2,label:n.getAttribute('aria-label')||n.textContent.trim()}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 })
      result.operations.push({ action: 'native-click', name: name ?? rect.label, label: rect.label }); await pause(100)
    }
    const key = async (keyCode, modifiers = []) => {
      const nativeCode = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' }[keyCode] ?? keyCode
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: nativeCode, modifiers })
      if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
      else if (keyCode.length === 1 && modifiers.length === 0) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: nativeCode, modifiers })
      await pause(100)
      result.operations.push({ action: 'native-key', keyCode, nativeCode, modifiers,
        focus: await read(`(()=>{const n=document.activeElement;return {tag:n?.tagName,label:n?.getAttribute('aria-label'),value:n?.value,text:n?.tagName==='BUTTON'?n.textContent:null}})()`) })
    }
    const type = async (script, value) => {
      await click(script)
      const original = await read(`(${script}).value ?? (${script}).textContent`)
      await key('End')
      for (let index = 0; index < original.length; index++) await key('Backspace')
      assert.equal(await read(`(${script}).value ?? (${script}).textContent`), '', 'Native field replacement must clear the previous value')
      win.webContents.insertText(value); await pause(100)
      assert.equal(await read(`(${script}).value ?? (${script}).textContent`), value)
      result.operations.push({ action: 'native-type', value })
    }
    const capture = async name => {
      await pause(180)
      const facts = await read(`(()=>{const n=${panel};const r=n?.getBoundingClientRect();return {fixture:window.moteCalendarScene.facts(),appearance:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight},panel:r?{width:r.width,height:r.height}:null,bodyOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:!!n&&n.scrollWidth>n.clientWidth,heading:n?.textContent,activeElement:document.activeElement?.getAttribute('aria-label'),iconSprite:!!document.querySelector('svg symbol'),controls:[...(n?.querySelectorAll('button,input,textarea,select')??[])].map(c=>({tag:c.tagName,label:c.getAttribute('aria-label'),text:c.textContent.trim().slice(0,100),value:c.value}))}})()`)
      assert.equal(facts.bodyOverflow, false, 'The complete viewport overflowed')
      assert.equal(facts.panelOverflow, false, 'The original product panel overflowed')
      for (const [id, expected] of Object.entries(facts.fixture.initialDrafts)) assert.equal(facts.fixture.drafts[id], expected, 'An arrangement operation changed the original manual draft')
      assert.equal(facts.fixture.tabIds.length, 2); assert.equal(facts.fixture.sessions.length, 2)
      assert.equal(facts.iconSprite, true, 'The original theme icon runtime must be mounted')
      await fs.writeFile(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG())
      result.images.push(name + '.png'); result.operations.push({ action: 'capture', name, ...facts })
    }
    const showCalendar = async () => {
      await until(`!!(${button('Calendar')})`, 'Original Mote Calendar tab')
      await click(button('Calendar'), 'Calendar')
      await until(`!!(${button('Upcoming')})&&!!(${button('Month')})`, 'Upcoming and Month modes')
      await until(`window.moteCalendarScene.facts().calls.some(c=>c.method==='schedule.list'&&c.params.scope)`, 'Mote-wide scope read')
    }
    await until('!!window.moteCalendarScene&&!!document.querySelector("[data-mote-details]")', 'Original Mote frame')
    await showCalendar()
    await capture('01-space-upcoming-dark')
    win.setContentSize(332, 900); await pause(100)
    await capture('02-narrow-upcoming-dark')
    // Keyboard changes the original SurfaceModeSwitch, rather than setting local view state.
    await click(button('Upcoming'), 'Upcoming mode keyboard start'); await key('ArrowRight')
    await until(`(${button('Month')})?.getAttribute('aria-selected')==='true'`, 'Keyboard-selected Month mode')
    await capture('03-narrow-month-dark')
    const dates = await read(`(()=>{const root=${panel};return [...root.querySelectorAll('[data-mote-date]')].map(n=>({date:n.getAttribute('data-mote-date'),pressed:n.getAttribute('aria-pressed'),label:n.getAttribute('aria-label')}))})()`)
    assert.ok(dates.length >= 28, 'The original visible Month date controls must be present')
    const currentDateIndex = dates.findIndex(item => item.pressed === 'true')
    const selectedDate = dates[currentDateIndex + 2] ?? dates.find(item => item.pressed !== 'true')
    assert.ok(selectedDate)
    await click(inPanel('[data-mote-date="' + selectedDate.date + '"]'), 'Month day ' + selectedDate.date)
    await capture('04-narrow-selected-day-dark')
    win.setContentSize(1240, 900); await read(`window.moteCalendarScene.theme('light')`); await capture('05-space-month-light')
    await click(button('Upcoming'), 'Upcoming')
    await capture('06-space-upcoming-light')
    // Long-message rows and state details are captured after native disclosure.
    await read(`(()=>{const n=(${panel}).querySelector('.mote-calendar');if(n)n.scrollTop=n.scrollHeight})()`)
    await capture('07-space-arrangement-states-light')
    // Shared production form: one exact countdown and a lost original receipt.
    win.setContentSize(332, 900)
    await click(button('New arrangement'), 'Open original shared arrangement form')
    // A mouse opens the macOS native select popup outside the hidden Renderer.
    // Enter its original field through native Tab instead, then use the closed select's keys.
    for (let step = 0; step < 3 && await read(`document.activeElement?.getAttribute('aria-label')!=='Arrangement timing'`); step++) await key('Tab')
    assert.equal(await read(`document.activeElement?.getAttribute('aria-label')`), 'Arrangement timing')
    for (const letter of 'Countdown') await key(letter)
    await key('Enter')
    await until(`(${inPanel('[aria-label="Arrangement timing"]')})?.value==='afterMs'`, 'Native-selected countdown')
    await type(inPanel('[aria-label="Countdown duration"]'), '20')
    const message = '20 分钟后回来一起核对实验结果，手动草稿留在原对话。'
    await type(inPanel('[aria-label="Arranged message"]'), message)
    await capture('08-narrow-countdown-form-light')
    await read('window.moteCalendarScene.loseCreateReceipt()')
    await click(button('Save arrangement'), 'Save original countdown')
    await until(`!!(${button('Check original operation')})`, 'Lost receipt retains original operation')
    await capture('09-narrow-create-unconfirmed-light')
    await click(button('Check original operation'), 'Check original operation')
    await until(`window.moteCalendarScene.facts().calls.some(c=>c.method==='schedule.inspect')`, 'Exact original inspect')
    await capture('10-narrow-original-inspected-light')
    await click(button('Retry original operation'), 'Retry original operation')
    await until(`window.moteCalendarScene.facts().calls.filter(c=>c.method==='schedule.create').length===2&&!(${button('Retry original operation')})`, 'Original receipt confirmed')
    const creates = await read(`window.moteCalendarScene.facts().calls.filter(c=>c.method==='schedule.create')`)
    assert.deepEqual(creates[0], creates[1], 'A retry must keep its original operation and exact target/message')
    assert.equal(creates[0].params.afterMs, 1_200_000); assert.equal(creates[0].params.prompt, message)
    await capture('11-narrow-countdown-saved-light')
    const timerRow = `(${panel}).querySelector('[data-schedule-id="research-timer"]')`
    await click(`(${timerRow}).querySelector('summary')`, 'Original research countdown controls')
    await click(button('Pause arrangement', timerRow), 'Pause exact research countdown')
    await until(`window.moteCalendarScene.facts().records.find(r=>r.loopId==='research-timer').status==='paused'`, 'Original timer paused')
    await capture('12-narrow-paused-timer-light')
    await click(button('Resume arrangement', timerRow), 'Resume exact research countdown')
    await until(`window.moteCalendarScene.facts().records.find(r=>r.loopId==='research-timer').status==='active'`, 'Original timer resumed')
    await click(button('Open original discussion', timerRow), 'Return to countdown original discussion')
    await until(`window.moteCalendarScene.facts().selection.tabId==='calendar-tab-1'`, 'Original research discussion selected')
    win.setContentSize(1240, 900); await capture('13-space-original-discussion-light')
    await read(`window.moteCalendarScene.scenario('empty')`); await showCalendar()
    await capture('14-space-empty-light')
    win.setContentSize(332, 900); await capture('15-narrow-empty-light')
    await read(`window.moteCalendarScene.scenario('unavailable')`); await showCalendar()
    await capture('16-narrow-unavailable-light')
    await read(`window.moteCalendarScene.scenario('populated');window.moteCalendarScene.theme('dark')`)
    win.setContentSize(1240, 900); await showCalendar(); await click(button('Month'), 'Space Month before second Calendar')
    await click(`document.querySelector('[aria-label="Show Mote profile"]')`, 'Open second Calendar in original popover')
    await showCalendar(); await click(button('Month'), 'Popover Month')
    const popupDate = await read(`(${panel}).querySelector('[data-mote-date][aria-pressed="true"]').getAttribute('data-mote-date')`)
    await click(inPanel('[data-mote-date="' + popupDate + '"]'), 'Popover selected date')
    await key('ArrowDown')
    assert.equal(await read(`!!document.activeElement.closest('.mote-profile-popover')`), true, 'Keyboard date navigation escaped the currently operated Calendar')
    assert.notEqual(await read(`(${panel}).querySelector('[data-mote-date][aria-pressed="true"]').getAttribute('data-mote-date')`), popupDate)
    await capture('17-space-two-calendar-focus-dark')
    await click(`document.querySelector('[aria-label="Close Mote profile"]')`, 'Close second Calendar')
    await read(`window.moteCalendarScene.presentation('card')`); win.setContentSize(332, 900)
    await click(`document.querySelector('[aria-label="Show Mote profile"]')`, 'Original Mote profile popover')
    await showCalendar(); await capture('18-narrow-profile-calendar-dark')
    await click(`document.querySelector('[aria-label="Close Mote profile"]')`, 'Close Mote profile')
    await click(`document.querySelector('[data-fixture-session="1"]')`, 'Return to research discussion')
    assert.equal(await read('window.moteCalendarScene.facts().selection.tabId'), 'calendar-tab-1')
    await capture('19-narrow-original-discussion-dark')
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.failureDom = await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'Unavailable')
      await fs.writeFile(path.join(evidence, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {})
    }
  } finally {
    await fs.writeFile(path.join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
