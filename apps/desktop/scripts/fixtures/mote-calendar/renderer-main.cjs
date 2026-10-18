const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', engine: { electron: process.versions.electron, chromium: process.versions.chrome }, images: [], operations: [], geometry: [], mutations: [], errors: [] }
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
    const button = (text, root = panel) => `[...(${root}).querySelectorAll('button,[role="tab"],summary')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(text)}||n.textContent.trim()===${JSON.stringify(text)})`
    const geometry = () => read(`(()=>{
      const n=${panel};if(!n)return null;
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,top:r.top,right:r.right,bottom:r.bottom,left:r.left,width:r.width,height:r.height}};
      const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&getComputedStyle(e).visibility!=='hidden';
      const control=e=>{const r=rect(e),hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:e.getAttribute('aria-label')||e.textContent.trim(),rect:r,hit:!!hit&&(hit===e||e.contains(hit))}};
      const mode=[...n.querySelectorAll('.mote-details__main > .mote-details__mode')].find(e=>!e.hidden),content=mode?.querySelector('.mote-details__content');
      const calendar=n.querySelector('.mote-calendar'),first=visible(calendar)?calendar.querySelector('[data-mote-date]'):null;
      const close=n.closest('.mote-profile-popover')?.querySelector('[aria-label="Close Mote profile"]');
      const bounds=rect(n),tabs=n.querySelector('[role="tablist"][aria-label="Mote details"]'),fonts=[...n.querySelectorAll('.mote-details__content,.mote-details__prose')].filter(visible);
      return {panel:bounds,section:n.dataset.section,main:rect(n.querySelector('.mote-details__main')),name:n.querySelector('.mote-details__name strong')?.textContent.trim(),header:rect(n.querySelector('.mote-details__profile')),
        content:rect(content),contentOffset:content?rect(content).top-bounds.top:null,calendarOffset:first?rect(first).top+calendar.scrollTop-bounds.top:null,
        calendarScroll:visible(calendar)?calendar.scrollTop:null,calendar:visible(calendar)?rect(calendar):null,
        calendarToolbar:visible(calendar)?rect(calendar.querySelector('.mote-calendar__toolbar')):null,
        calendarControls:visible(calendar)?[...calendar.querySelectorAll('.mote-calendar__toolbar button')].map(control):[],
        canvas:visible(calendar)?rect(calendar.querySelector('.mote-calendar__canvas')):null,agenda:visible(calendar)?rect(calendar.querySelector('.mote-calendar__day')):null,
        nameRect:rect(n.querySelector('.mote-details__name')),close:visible(close)?control(close):null,coarse:matchMedia('(pointer: coarse)').matches,
        densityPolicy:matchMedia('(pointer: coarse)').matches?'coarse: 44px targets and unobstructed readable content':'fine: rail beside main content, first useful content visible, original Calendar density',
        tabs:[...tabs?.querySelectorAll('[role="tab"]')??[]].map(control),
        identity:[...n.querySelectorAll('[aria-label="Change Mote avatar"],[aria-label="Rename Mote"]')].map(control),
        fonts:fonts.map(e=>({prose:e.classList.contains('mote-details__prose'),size:parseFloat(getComputedStyle(e).fontSize),lineHeight:getComputedStyle(e).lineHeight})),
        overflow:[n,content,visible(calendar)?calendar.querySelector('.mote-calendar__toolbar'):null].filter(visible).map(e=>({className:e.className,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth})),
        scenario:window.moteCalendarScene.facts().mode};
    })()`)
    const headerBudget = facts => {
      assert.equal(facts.coarse, false, 'The compact height budget is defined for the default fine pointer')
      assert.ok(facts.panel.width > 0 && facts.contentOffset > 0, 'A nonempty actual Mote content position is required')
      const rail = facts.section === 'profile' && facts.panel.width >= 720
      if (rail) {
        assert.ok(facts.main.left >= facts.header.right - 1, 'The identity rail must sit beside the working content')
        assert.ok(facts.header.width < facts.panel.width / 3, 'The identity rail must leave the majority of Space for work')
      }
      const budget = rail ? 72 : facts.panel.height * 0.55
      if (!rail) assert.ok(facts.header.height <= facts.panel.height * 0.45 + 1, 'The compact identity must leave most of the height for work')
      assert.ok(facts.contentOffset <= budget, 'Mote header density budget exceeded: ' + facts.contentOffset + ' > ' + budget)
    }
    const calendarBudget = facts => {
      assert.equal(facts.coarse, false, 'The compact Calendar height budget is defined for the default fine pointer')
      assert.ok(facts.calendar && facts.calendarOffset > 0, 'A nonempty actual Calendar first date is required')
      const budget = facts.calendarToolbar.width > 600 ? 180 : 250
      assert.ok(facts.calendarOffset <= budget, 'Calendar first-date density budget exceeded: ' + facts.calendarOffset + ' > ' + budget)
    }
    const checkGeometry = facts => {
      assert.equal(facts.tabs.length, 3, 'All original Mote tabs must be present before measuring')
      assert.deepEqual(facts.tabs.map(tab => tab.label), ['Profile', 'Ideas', 'Calendar'])
      assert.equal(facts.identity.length, 2, 'Original avatar and rename controls must remain present')
      if (!facts.coarse && facts.name === 'Mote') headerBudget(facts)
      if (!facts.coarse && facts.name === 'Mote' && facts.calendarOffset !== null && facts.scenario === 'populated') calendarBudget(facts)
      assert.ok(facts.fonts.length > 0, 'Visible original body text must be measured')
      for (const font of facts.fonts) assert.ok(font.size >= (font.prose ? 13 : 12), 'Density cannot reduce the original body/prose text size')
      for (const item of facts.overflow) assert.ok(item.scrollWidth <= item.clientWidth + 1, 'A visible content region overflowed: ' + item.className)
      if (facts.coarse && facts.calendar) {
        assert.ok(facts.calendarControls.length >= 4, 'Original Calendar controls must be present on a coarse pointer')
        for (const control of facts.calendarControls) assert.ok(control.rect.width >= 44 && control.rect.height >= 44 && control.hit, 'A coarse Calendar control needs an unobstructed 44px target: ' + control.label)
      }
      for (const item of [...facts.tabs, ...facts.identity, ...(facts.close ? [facts.close] : [])]) {
        assert.ok(item.rect.width > 0 && item.rect.height > 0, 'An original header control became empty: ' + item.label)
        assert.equal(item.hit, true, 'An original header control is covered or clipped: ' + item.label)
      }
      if (facts.close) {
        const a = facts.nameRect, b = facts.close.rect
        assert.ok(a && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top), 'A long Mote name overlaps the original close control')
      }
    }
    const densityMutation = async (name, css, check) => {
      const before = await geometry(); check(before)
      let mutant, failure, key
      try {
        key = await win.webContents.insertCSS(css); await pause(60)
        mutant = await geometry()
        try { check(mutant) } catch (error) { failure = error }
      } finally { if (key) await win.webContents.removeInsertedCSS(key) }
      await pause(60)
      const restored = await geometry(); check(restored)
      assert.ok(failure instanceof assert.AssertionError && failure.message.includes('density budget exceeded'), 'A real CSS mutation must fail its own geometry budget: ' + name)
      result.mutations.push({ name, css, red: { message: failure.message, geometry: mutant }, restored: { passed: true, geometry: restored }, baseline: before })
    }
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
    const capture = async (name, originalDiscussion = false) => {
      await pause(180)
      const measured = await geometry()
      result.geometry.push({ capture: name, ...measured })
      if (measured) checkGeometry(measured)
      else assert.equal(originalDiscussion, true, 'An expected visible Mote surface is missing')
      const facts = await read(`(()=>{const n=${panel};const r=n?.getBoundingClientRect();return {fixture:window.moteCalendarScene.facts(),appearance:document.documentElement.dataset.appearance,viewport:{width:innerWidth,height:innerHeight},panel:r?{width:r.width,height:r.height}:null,bodyOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:!!n&&n.scrollWidth>n.clientWidth,heading:n?.textContent,activeElement:document.activeElement?.getAttribute('aria-label'),iconSprite:!!document.querySelector('svg symbol'),controls:[...(n?.querySelectorAll('button,input,textarea,select')??[])].map(c=>({tag:c.tagName,label:c.getAttribute('aria-label'),text:c.textContent.trim().slice(0,100),value:c.value}))}})()`)
      assert.equal(facts.bodyOverflow, false, 'The complete viewport overflowed')
      assert.equal(facts.panelOverflow, false, 'The original product panel overflowed')
      for (const [id, expected] of Object.entries(facts.fixture.initialDrafts)) assert.equal(facts.fixture.drafts[id], expected, 'An arrangement operation changed the original manual draft')
      assert.equal(facts.fixture.tabIds.length, 2); assert.equal(facts.fixture.sessions.length, 2)
      assert.equal(facts.iconSprite, true, 'The original theme icon runtime must be mounted')
      if (originalDiscussion) {
        assert.equal(facts.fixture.selection.tabId, 'calendar-tab-1', 'Returning to the original discussion must keep its exact Tab')
        const original = facts.fixture.initialDrafts['calendar-renderer-session-1']
        assert.ok(original?.trim(), 'The original manual draft must not be an empty fixture')
        const composer = await read(`(()=>{const e=document.querySelector('.calendar-fixture__composer [aria-label="Message Agent"]');return e&&(e.value??e.textContent)})()`)
        assert.equal(composer, original, 'The visible original Composer must retain the exact manual draft')
      }
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
    await until(`(${panel}).textContent.includes('What shall we work on?')`, 'Companion profile')
    await until(`!(${panel}).textContent.includes('Reading original goals')`, 'Original Goal data ready')
    await capture('profile-wide-dark')
    await click(inPanel('.mote-memory > summary'), 'Original memory entry')
    await until(`(${inPanel('.mote-memory')})?.textContent.includes('Saved in MEMORY.md')`, 'Original saved memory')
    await capture('profile-memory-wide-dark')
    await click(inPanel('.mote-memory > summary'), 'Close original memory')
    const homeArrangement = await read(`(${inPanel('[data-upcoming-id]')})?.dataset.upcomingId`)
    assert.ok(homeArrangement, 'The companion home must display an original arrangement')
    await click(inPanel('[data-upcoming-id="' + homeArrangement + '"]'), 'Original upcoming arrangement')
    await until(`(${panel}).querySelector('[data-schedule-id="'+${JSON.stringify(homeArrangement)}+'"] details')?.open`, 'Selected original arrangement opened in Calendar')
    await capture('profile-upcoming-to-calendar-dark')
    await click(button('Profile'), 'Return to original companion home')
    await densityMutation('navigation-excess-height', '.mote-details__navigation-bar { padding-block: 90px !important; }', headerBudget)
    win.setContentSize(332, 900); await capture('profile-narrow-dark')
    win.webContents.debugger.attach('1.3')
    try {
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await until(`matchMedia('(pointer: coarse)').matches`, 'Actual coarse pointer emulation')
      const touch = await geometry(); checkGeometry(touch)
      for (const tab of touch.tabs) assert.ok(tab.rect.width >= 44 && tab.rect.height >= 44 && tab.hit, 'A coarse Mote tab needs an unobstructed 44px target: ' + tab.label)
      await capture('profile-coarse-narrow-dark')
      await click(button('Ideas'), 'Coarse Ideas tab')
      const noteControl = inPanel('.mote-details__ideas .mote-details__note')
      await click(noteControl, 'Coarse original note')
      await until(`(${inPanel('.mote-details__preview')})?.textContent.includes('Read from the saved file')`, 'Coarse selected note body')
      const back = await read(`(()=>{const e=${inPanel('[aria-label="Back to notes"]')};const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:r.width,height:r.height,hit:hit===e||e.contains(hit)}})()`)
      assert.ok(back.width >= 44 && back.height >= 44 && back.hit, 'Coarse Back to notes needs an unobstructed 44px target')
      await click(inPanel('[aria-label="Back to notes"]'), 'Coarse return to notes')
      const note = await read(`(()=>{const e=${noteControl};const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:r.width,height:r.height,hit:hit===e||e.contains(hit)}})()`)
      assert.ok(note.width >= 44 && note.height >= 44 && note.hit, 'A coarse saved note needs an unobstructed 44px target')
      result.operations.push({ action: 'coarse-targets', tabs: touch.tabs, note, back })
      await capture('ideas-coarse-narrow-dark')
      await showCalendar(); await capture('calendar-coarse-narrow-dark')
      await click(button('Profile'), 'Return from coarse notes')
    } finally {
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
      win.webContents.debugger.detach()
    }
    await until(`!matchMedia('(pointer: coarse)').matches`, 'Restore original fine pointer')
    await click(button('Connection & preferences'), 'Original preferences disclosure')
    await capture('profile-preferences-narrow-dark')
    await click(button('Ideas'), 'Ideas workspace')
    await click(button('Find a worthwhile idea'), 'Original idea request')
    const ideaDirection = '比较两种交互方式，先留下可以检查的小结。'
    await type(inPanel('[aria-label="Idea direction"]'), ideaDirection)
    await capture('ideas-request-narrow-dark')
    await click(button('Find a worthwhile idea'), 'Close original idea request')
    await click(inPanel('.mote-details__ideas .mote-details__note'), 'Read an original saved note')
    await until(`(${inPanel('.mote-details__preview')})?.textContent.includes('Read from the saved file')`, 'Original saved note body')
    await capture('ideas-reader-narrow-dark')
    await read('window.moteCalendarScene.noteReadFailure(true)')
    await until(`(${inPanel('.mote-details__preview')})?.textContent.includes('Last confirmed saved content')`, 'Unknown note read retains its original body')
    await capture('ideas-note-unavailable-narrow-dark')
    await read('window.moteCalendarScene.noteReadFailure(false)')
    await until(`(${inPanel('.mote-details__preview')})?.textContent.includes('Read from the saved file')`, 'Same original note recovered')
    await click(inPanel('[aria-label="Back to notes"]'), 'Return to original notes')
    await type(inPanel('[aria-label="Find a note"]'), 'no matching note')
    await capture('ideas-no-matches-narrow-dark')
    await click(inPanel('[aria-label="Clear note filter"]'), 'Clear local filter')
    await click(inPanel('.mote-details__ideas .mote-details__note[aria-pressed="true"]'), 'Return to the same original note')
    win.setContentSize(1240, 900); await capture('ideas-reader-wide-dark')
    await read(`window.moteCalendarScene.theme('light')`); await capture('ideas-reader-wide-light')
    await click(button('Profile'), 'Return to companion profile')
    await capture('profile-wide-light')
    await read(`window.moteCalendarScene.name('一起做研究与设计的长期搭档 Mote')`)
    win.setContentSize(332, 700); await capture('profile-long-name-short-light')
    await read(`window.moteCalendarScene.name('Mote');window.moteCalendarScene.summary('We keep original decisions, sources and unsent thoughts together. '.repeat(24))`)
    win.setContentSize(332, 640); await capture('profile-long-summary-collapsed-light')
    await click(button('Read more'), 'Expand original long summary')
    await capture('profile-long-summary-expanded-light')
    await click(button('Less'), 'Collapse original long summary')
    await read(`window.moteCalendarScene.summary('A small working result, then the next decision.')`); win.setContentSize(1240, 900)
    await read(`window.moteCalendarScene.theme('dark')`)
    await showCalendar()
    await click(button('Month'), 'Month after the selected home arrangement')
    await capture('01-space-month-dark')
    await densityMutation('calendar-toolbar-excess-spacing', '.mote-calendar__toolbar { padding-block: 90px !important; }', calendarBudget)
    await read(`document.querySelector('.calendar-fixture').dataset.mediumProof=''`)
    await capture('calendar-medium-month-dark')
    const medium = await geometry()
    assert.ok(medium.calendarToolbar.width <= 600 && medium.panel.width >= 560, 'The intermediate pane must exercise the separate header and Calendar breakpoints')
    await read(`delete document.querySelector('.calendar-fixture').dataset.mediumProof`)
    await read(`document.querySelector('.calendar-fixture').dataset.wideProof=''`)
    win.setContentSize(1600, 900); await capture('calendar-expanded-month-dark')
    const expanded = await geometry()
    assert.ok(expanded.calendar.width > 1000, 'The actual product Calendar must cross its wide-container breakpoint')
    assert.ok(expanded.canvas.width > 0 && expanded.agenda.width > 0 && expanded.agenda.left >= expanded.canvas.right, 'A wide Calendar must show its original canvas and agenda side by side')
    await read(`delete document.querySelector('.calendar-fixture').dataset.wideProof`)
    win.setContentSize(1240, 900)
    await click(button('Week'), 'Week point-time view')
    await capture('calendar-week-wide-dark')
    await click(button('Upcoming'), 'Upcoming original arrangements')
    await capture('calendar-upcoming-wide-dark')
    win.setContentSize(332, 900); await pause(100)
    await capture('02-narrow-upcoming-dark')
    // Keyboard changes the original SurfaceModeSwitch, rather than setting local view state.
    await click(button('Upcoming'), 'Upcoming mode keyboard start'); await key('Home')
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
    // Enter through the actual message field, then traverse the form backwards.
    await until(`(${inPanel('.schedule-create')})?.open`, 'Original arrangement form opened')
    await click(inPanel('.schedule-create [aria-label="Arranged message"]'), 'Original arrangement message field')
    const formControls = await read(`(${inPanel('.schedule-create')}).querySelectorAll('button,input,textarea,select,summary').length`)
    for (let step = 0; step < formControls && await read(`document.activeElement?.getAttribute('aria-label')!=='Arrangement timing'`); step++) await key('Tab', ['shift'])
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
    assert.equal(await read(`(${panel}).textContent.includes('Arrangement saved')`), false, 'Unknown writes cannot claim saved')
    await capture('09-narrow-create-unconfirmed-light')
    await click(button('Check original operation'), 'Check original operation')
    await until(`window.moteCalendarScene.facts().calls.some(c=>c.method==='schedule.inspect')`, 'Exact original inspect')
    await capture('10-narrow-original-inspected-light')
    await click(button('Retry original operation'), 'Retry original operation')
    await until(`window.moteCalendarScene.facts().calls.filter(c=>c.method==='schedule.create').length===2&&!(${button('Retry original operation')})`, 'Original receipt confirmed')
    const creates = await read(`window.moteCalendarScene.facts().calls.filter(c=>c.method==='schedule.create')`)
    assert.deepEqual(creates[0], creates[1], 'A retry must keep its original operation and exact target/message')
    assert.equal(creates[0].params.afterMs, 1_200_000); assert.equal(creates[0].params.prompt, message)
    await until(`(${panel}).textContent.includes('Arrangement saved')`, 'Confirmed original create has visible success feedback')
    await capture('11-narrow-countdown-saved-light')
    await click(button('View arrangement'), 'View the exact confirmed arrangement')
    const createdId = await read(`(()=>{const f=window.moteCalendarScene.facts();const call=f.calls.find(c=>c.method==='schedule.create');return f.records.find(r=>r.creationOperationId===call.params.operationId).loopId})()`)
    await until(`(${panel}).querySelector('[data-schedule-id="'+${JSON.stringify(createdId)}+'"] details')?.open`, 'Confirmed original row opened')
    await capture('calendar-created-arrangement-detail-light')
    const timerRow = `(${panel}).querySelector('[data-schedule-id="research-timer"]')`
    await click(`(${timerRow}).querySelector('summary')`, 'Original research countdown controls')
    await click(button('Pause arrangement', timerRow), 'Pause exact research countdown')
    await until(`window.moteCalendarScene.facts().records.find(r=>r.loopId==='research-timer').status==='paused'`, 'Original timer paused')
    await capture('12-narrow-paused-timer-light')
    await click(button('Resume arrangement', timerRow), 'Resume exact research countdown')
    await until(`window.moteCalendarScene.facts().records.find(r=>r.loopId==='research-timer').status==='active'`, 'Original timer resumed')
    await click(button('Open original discussion', timerRow), 'Return to countdown original discussion')
    await until(`window.moteCalendarScene.facts().selection.tabId==='calendar-tab-1'`, 'Original research discussion selected')
    win.setContentSize(1240, 900); await capture('13-space-original-discussion-light', true)
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
    await read(`window.moteCalendarScene.name('一起做研究与设计的长期搭档 Mote')`)
    await click(`document.querySelector('[aria-label="Show Mote profile"]')`, 'Original Mote profile popover')
    await showCalendar(); await capture('18-narrow-profile-calendar-dark')
    await click(`document.querySelector('[aria-label="Close Mote profile"]')`, 'Close Mote profile')
    await click(`document.querySelector('[data-fixture-session="1"]')`, 'Return to research discussion')
    assert.equal(await read('window.moteCalendarScene.facts().selection.tabId'), 'calendar-tab-1')
    await capture('19-narrow-original-discussion-dark', true)
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
