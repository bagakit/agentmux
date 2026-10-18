const { app, BrowserWindow, Menu, session } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, evidence] = process.argv.slice(2)
assert.ok(evidence?.includes('/capture-'))
for (const [key, value] of Object.entries(process.env)) if (key.startsWith('AGENTMUX_') || key === 'AGENT_SESSION_STORE') assert.ok(value.startsWith(evidence + '/'))
app.setPath('userData', path.join(evidence, 'userData')); app.setPath('sessionData', path.join(evidence, 'userData', 'session')); Menu.setApplicationMenu(null)
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', images: [], geometry: [], operations: [], mutations: [], errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].includes(new URL(details.url).protocol) }))
    win = new BrowserWindow({ width: 1240, height: 900, show: false, backgroundColor: '#181818', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    await win.loadFile(html, { query: { workspacePath: path.join(evidence, 'workspace'), scenario: 'companion-navigation' } }); win.webContents.focus()
    const read = script => win.webContents.executeJavaScript(script)
    const until = async (script, label) => { for (let i = 0; i < 150; i++) { if (await read(script)) return; await pause(30) } throw Error('Private Renderer condition timed out: ' + label) }
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`
    const tab = label => `[...document.querySelectorAll('[aria-label="Mote pages"] [role="tab"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
    const click = async expression => {
      const point = await read(`(()=>{const e=${expression};if(!e)throw Error('Missing control');e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!(hit===e||e.contains(hit)))throw Error('Control not hittable: '+e.textContent);return {x,y,label:e.getAttribute('aria-label')||e.textContent}})()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 }); await pause(80); result.operations.push({ action: 'native-click', ...point })
    }
    const page = async label => { await click(tab(label)); await until(`(${tab(label)})?.getAttribute('aria-selected')==='true'`, label) }
    const measure = () => read(`(()=>{
      const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
      const hit=e=>{const r=rect(e);if(!r)return null;const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r,hit:h===e||e.contains(h)}};
      const panel=${q('[data-mote-details]')},name=panel?.querySelector('.mote-details__full-name'),cal=panel?.querySelector('.mote-calendar'),css=cal&&getComputedStyle(cal),visible=!!cal?.getBoundingClientRect().height&&getComputedStyle(cal).visibility!=='hidden';
      return {viewport:{width:innerWidth,height:innerHeight},section:panel?.dataset.section,panel:rect(panel),name:{text:name?.textContent,label:name?.getAttribute('aria-label'),expanded:name?.getAttribute('aria-expanded'),...hit(name),textRect:rect(name?.querySelector('strong')),font:name?parseFloat(getComputedStyle(name.querySelector('strong')).fontSize):0},tabs:[...document.querySelectorAll('[aria-label="Mote pages"] [role="tab"]')].map(e=>({label:e.textContent,selected:e.getAttribute('aria-selected'),...hit(e)})),question:hit(${q('[aria-label="A question for this Mote"]')}),
      calendar:visible?{rect:rect(cal),width:cal.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),canvas:rect(cal.querySelector('.mote-calendar__canvas')),agenda:rect(cal.querySelector('.mote-calendar__day')),message:rect(cal.querySelector('.mote-calendar__day .calendar-schedules__context')),selected:cal.querySelector('[data-mote-date][aria-pressed="true"]')?.dataset.moteDate,occurrence:cal.querySelector('[data-calendar-schedule-id][aria-pressed="true"]')?.dataset.calendarScheduleId,details:!!cal.querySelector('[data-schedule-id="daily-brief"] details')?.open,focus:document.activeElement?.textContent,scroll:cal.scrollTop}:null,
      overflow:[document.documentElement,panel].map(e=>({client:e.clientWidth,scroll:e.scrollWidth})),theme:document.documentElement.dataset.appearance,facts:window.moteCalendarScene.facts()};})()`)
    const readable = g => {
      assert.deepEqual(g.tabs.map(t=>t.label), ['Profile','Discussion','Ideas','Calendar']); assert.equal(g.tabs.filter(t=>t.selected==='true').length,1)
      assert.ok(g.name.rect.width >= 100, 'Identity readability failed: no horizontal name room'); assert.ok(g.name.font>=(g.section==='profile'?18:14),'Original name type scale must remain readable'); assert.equal(g.name.label,g.name.text)
      if(g.name.expanded==='false') assert.ok(g.name.textRect.height<30,'Identity readability failed: collapsed name stacks vertically')
      for(const o of g.overflow)assert.ok(o.scroll<=o.client+1,'Original surface overflowed')
      if(g.section==='profile'||g.section==='discussion')assert.ok(g.question.hit&&g.question.rect.width>=160,'Original question must remain reachable')
    }
    const calendarWidth = g => {
      const c=g.calendar;assert.ok(c&&c.agenda&&c.canvas,'Original Calendar and agenda required')
      if(c.width>=980){assert.ok(c.agenda.width>=320,'Calendar reading width failed: agenda below 320px');assert.ok(c.agenda.width/c.width>=.32&&c.agenda.width/c.width<=.42,'Calendar reading width failed: unbalanced detail ratio');assert.ok(Math.abs(c.agenda.top-c.canvas.top)<2);assert.ok(c.agenda.left>=c.canvas.right)}
      else {assert.ok(c.agenda.width>=c.width-2,'Calendar reading width failed: narrow details must fill original reading area');assert.ok(c.agenda.top>=c.canvas.bottom)}
    }
    const sync = async () => { await read('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))'); win.webContents.invalidate(); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))') }
    const capture = async name => {await sync();const g=await measure();readable(g);if(g.calendar)calendarWidth(g);await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.geometry.push({capture:name,...g});return g}
    await until(`!!${q('[aria-label="Mote pages"]')}`, 'Real MoteSpaceFrame')
    await read(`window.moteCalendarScene.name('一起澄清问题与推进项目的长期工作搭档')`)
    await page('Profile');await until(`!!${q('[data-behavior-axis]')}`, 'Original saved personality')
    await click(q('[aria-label="A question for this Mote"]'));win.webContents.insertText('先保留这个问题，等原资料确认后一起继续。');await pause(80)
    await read(`window.originalQuestion=${q('[aria-label="A question for this Mote"]')};window.originalComposer=${q('[aria-label="Message Agent"]')}`)
    const profile=await capture('profile-long-chinese-dark')
    await page('Discussion');const discussion=await capture('discussion-compact-chinese-dark')
    for(let i=0;i<4;i++)assert.deepEqual(discussion.tabs[i].rect,profile.tabs[i].rect,'Same navigation position across modes')
    assert.equal(await read(`window.originalQuestion===${q('[aria-label="A question for this Mote"]')}&&window.originalComposer===${q('[aria-label="Message Agent"]')}`),true,'Original inputs retain exact DOM')
    await page('Ideas');const ideas=await measure();for(let i=0;i<4;i++)assert.deepEqual(ideas.tabs[i].rect,profile.tabs[i].rect)
    await page('Calendar');const cal=await measure();for(let i=0;i<4;i++)assert.deepEqual(cal.tabs[i].rect,profile.tabs[i].rect)
    await page('Profile');win.setContentSize(360,760);await pause(80);await capture('profile-narrow-chinese-dark')
    await click(q('.mote-details__full-name'));await capture('profile-narrow-complete-name-dark')
    await read(`window.moteCalendarScene.name('AnUnbrokenNameForOurLongTermResearchAndDesignCompanion');window.moteCalendarScene.theme('light')`);await pause(80)
    await click(q('.mote-details__full-name'));await capture('profile-narrow-latin-light')
    await page('Calendar');await read(`window.moteCalendarScene.name('产品设计搭档')`)
    const resizeCalendar=async width=>{win.setContentSize(width+50,1000);await pause(80);const g=await measure();win.setContentSize(Math.round(width+50+width-g.calendar.width),1000);await pause(80);assert.ok(Math.abs((await measure()).calendar.width-width)<1,'Exact calendar container width')}
    await resizeCalendar(1200)
    await until(`!!${q('[data-calendar-schedule-id="daily-brief"]')}`,'Original daily occurrence')
    await click(q('[data-calendar-schedule-id="daily-brief"]'))
    await until(`${q('[data-schedule-id="daily-brief"] details')}?.open`,'Original details expanded')
    await read(`${q('.mote-calendar')}.scrollTop=0`)
    const wide=await capture('calendar-reading-wide-light');assert.ok(wide.calendar.message.width>=290);assert.equal(wide.calendar.occurrence,'daily-brief')
    let key,failure;try{key=await win.webContents.insertCSS('@container mote-calendar (min-width:980px){.mote-calendar__workspace{grid-template-columns:minmax(0,1fr) 240px!important}}');await sync();try{calendarWidth(await measure())}catch(e){failure=e}}finally{if(key)await win.webContents.removeInsertedCSS(key)}await sync();calendarWidth(await measure());assert.ok(failure instanceof assert.AssertionError&&failure.message.includes('Calendar reading width failed'));result.mutations.push({name:'original-fixed-detail-width',red:failure.message,restored:true})
    await resizeCalendar(980);await capture('calendar-reading-boundary-light')
    await resizeCalendar(979);await capture('calendar-reading-full-row-light')
    win.setContentSize(360,900);await pause(80);await read(`${q('[data-schedule-id="daily-brief"]')}.scrollIntoView({block:'start'})`);await capture('calendar-reading-narrow-light')
    assert.equal(await read(`window.originalQuestion===${q('[aria-label="A question for this Mote"]')}&&window.originalQuestion.value==='先保留这个问题，等原资料确认后一起继续。'`),true)
    const final=await measure();assert.deepEqual(final.facts.drafts,final.facts.initialDrafts);assert.equal(final.facts.tabIds.length,2);assert.equal(final.facts.sessions.length,2);assert.equal(final.facts.calls.filter(c=>/schedule\.(create|pause|resume|cancel)/.test(c.method)).length,0)
    result.passed=true
  }catch(error){result.error={message:error.message,stack:error.stack}}
  finally{await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}
})
