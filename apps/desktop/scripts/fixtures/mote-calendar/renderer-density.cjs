const { app, BrowserWindow, Menu, session } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const assert = require('node:assert/strict')

const [html, evidence] = process.argv.slice(2)
const assignmentProof = process.argv.includes('--assignments')
assert(evidence?.includes('/capture-'))
app.setPath('userData', join(evidence, 'userData'))
Menu.setApplicationMenu(null)
const result = { passed: false, captureOnly: true, images: [], observations: {}, mutations: [], errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !['file:', 'data:', 'blob:', 'devtools:'].includes(new URL(request.url).protocol) }))
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, info) => { if (info.level === 'error') result.errors.push(info.message) })
    await win.loadFile(html, { query: { workspacePath: join(evidence, 'workspace'), scenario: assignmentProof ? 'calendar-assignments' : 'calendar-density' } })
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
    const settleMotion = () => read('Promise.allSettled(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished))')
    const click = async expression => {
      await waitFor(`(${expression})?.getBoundingClientRect().width>0`, 'visible action '+expression)
      await read(`(${expression}).scrollIntoView({block:'nearest',inline:'nearest'})`)
      const hitPoint = `(()=>{const el=${expression};if(!el)return null;const rect=el.getBoundingClientRect(),
        x=Math.round(rect.x+rect.width/2),y=Math.round(rect.y+rect.height/2),hit=document.elementFromPoint(x,y);
        return hit===el||el.contains(hit)?{x,y}:null})()`
      await waitFor(hitPoint,'unobstructed action '+expression)
      const point = await read(hitPoint)
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
    const dialog = locator('[role="dialog"][aria-label="New arrangement"]')
    const calendar = locator('[aria-label="Mote calendar"]')
    const key = code => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
      if (code === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
    }
    const dimensions = () => read(`(()=>{
      const panel=${calendar}.getBoundingClientRect(), canvas=document.querySelector('.mote-calendar__canvas').getBoundingClientRect()
      const scroll=document.querySelector('.mote-calendar__week-scroll').getBoundingClientRect()
      return {width:panel.width,canvasWidth:canvas.width,bottomGap:panel.bottom-scroll.bottom,scrollHeight:scroll.height}
    })()`)
    const reach = async expression => {
      const hit = await read(`(()=>{const el=${expression},r=el?.getBoundingClientRect(); if(!r||!r.width||!r.height)return false;
        const target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return target===el||el.contains(target)})()`)
      assert.equal(hit,true,'Reachable action: ' + expression)
    }
    const view = async name => {
      await click(control(modes, name))
      await waitFor(`(${control(modes,name)})?.getAttribute('aria-selected')==='true'`, name+' view')
    }
    const verifyEventSurface = async (selector, declaration, reason) => {
      await waitFor(`${locator(selector)}?.getBoundingClientRect().width>0`, 'rendered event ' + selector)
      const inspect = async () => {
        const style = await read(`(() => {const s=getComputedStyle(${locator(selector)});return {
          start:s.borderInlineStartWidth,end:s.borderInlineEndWidth,fill:s.backgroundColor,image:s.backgroundImage
        }})()`)
        assert.equal(style.start, style.end, 'Rendered event has a one-sided stripe')
        assert.ok(style.fill !== 'rgba(0, 0, 0, 0)' || style.image !== 'none', 'Rendered event has no surface fill')
      }
      await inspect()
      const sheet = await win.webContents.insertCSS(`${selector} { ${declaration}; transition:none!important; }`)
      try {
        await assert.rejects(inspect, reason)
      } finally {
        await win.webContents.removeInsertedCSS(sheet)
      }
      await inspect()
      result.mutations.push({ selector, declaration, rejected: reason.source, restored: true })
    }
    await waitFor(`!!${control('[role="tab"]', 'Calendar')}`, 'Calendar tab')
    await click(control('[role="tab"]', 'Calendar'))
    if (assignmentProof) {
      await view('Upcoming')
      const direct = { scheduleId: 'calendar-direct-work', method: 'space.mote.direct.inspect', sourceId: 'another-private-assignment',
        target: 'threadId', conversationId: 'private-work-review' }
      const group = { scheduleId: 'calendar-group-work', method: 'space.mote.group.inspect', sourceId: 'calendar-original-group-assignment',
        replyId: 'calendar-original-group-report', target: 'groupId', conversationId: 'calendar-public-work' }
      const facts = () => read('window.moteCalendarScene.facts()')
      await waitFor(`!!${locator('[data-schedule-id="calendar-direct-work"]')}`, 'published assignment in original schedule row')
      const before = await facts()
      const assignmentCalls = snapshot => snapshot.calls.filter(call => call.method.startsWith('space.mote.direct.') || call.method.startsWith('space.mote.group.'))
      assert.deepEqual(assignmentCalls(before), [], 'Calendar listing does not read conversation bodies')
      await settleMotion()
      await capture('calendar-published-assignments')
      result.observations.assignments = []
      for (const item of [direct, group]) {
        const { scheduleId, method, sourceId, replyId, target, conversationId } = item
        const requestsBefore = assignmentCalls(await facts()).length
        const row = '[data-schedule-id="' + scheduleId + '"]'
        const trigger = control(row + ' button', '查看作业与回报')
        assert.ok((await read(`${locator(row)}.innerText`)).includes('Last assignment published'))
        await click(trigger)
        const detail = '.mote-direct-panel[data-view="assignment"]'
        const source = locator(detail + ' [data-direct-message-id="' + sourceId + '"]')
        const state = item === direct ? '等待接收' : '已接收'
        const reply = replyId ? `!!${locator(detail + ' [data-direct-message-id="' + replyId + '"]')}` : `${locator(detail)}?.innerText.includes('暂无回报')`
        await waitFor(`${source}?.innerText.includes(${JSON.stringify('资料整理 · ' + state)}) && ${reply}`, 'original assignment audience and exact correlated report')
        const visible = await read(`[...document.querySelectorAll(${JSON.stringify(detail + ' [data-direct-message-id]')})].map(e=>e.dataset.directMessageId)`)
        assert.deepEqual(visible, replyId ? [sourceId, replyId] : [sourceId], 'Only the original assignment and its own report are presented')
        await settleMotion()
        await capture(scheduleId)
        if (item === direct) await click(locator(detail + ' [aria-label="关闭作业详情"]'))
        else key('Escape')
        await waitFor(`!${locator(detail)} && document.activeElement === ${trigger}`, 'dismissal restores the exact published arrangement action')
        const observed = assignmentCalls(await facts()).slice(requestsBefore)
        const occurrence = before.records.find(record => record.loopId === scheduleId)
        assert.ok(occurrence?.lastMotePublication)
        const address = { [target]: conversationId, ...(item === direct ? { mote: occurrence.moteWork.mote } : {}) }
        assert.deepEqual([...new Map(observed.map(call => [JSON.stringify(call), call])).values()], [
          { method, params: { ...address, messageId: sourceId } },
          { method, params: { ...address, replyToMessageId: sourceId, limit: 12 } },
        ])
        result.observations.assignments.push({ scheduleId, publication: occurrence.lastMotePublication, observed, focusRestored: true })
        if (item === direct) {
          win.setContentSize(620, 680)
          await read('window.moteCalendarScene.theme("light")')
        }
      }
      win.setContentSize(1180, 800)
      await view('Month')
      const saved = before.records.find(record => record.loopId === direct.scheduleId).lastMotePublication
      const earlierAt = saved.occurrenceAt - 120_000
      const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(earlierAt)
      await click(locator(`[data-mote-date="${date}"]`))
      const earlierButton = `.mote-calendar__event[data-event-schedule="${direct.scheduleId}"][data-event-occurrence="${earlierAt}"]`
      await click(locator(earlierButton))
      const originalTrigger = control('li:has(' + earlierButton + ') button', '查看作业与回报')
      await waitFor(`!${calendar}.innerText.includes('Reading recorded events…') && !${calendar}.innerText.includes('Recorded events partially available')`,
        'The visible history is confirmed')
      const directCell = locator('[data-calendar-schedule-id="calendar-direct-work"][title*="published"]')
      await waitFor(`${directCell}?.innerText.includes('核对发布手册') && ${directCell}?.innerText.includes('2 published')`,
        'Calendar uses the original assignment title and counts both rounds')
      await settleMotion()
      await capture('calendar-earlier-round')
      await click(originalTrigger)
      const originalDetail = locator('.mote-direct-panel[data-view="assignment"]')
      await waitFor(`${originalDetail}?.querySelector('[data-direct-message-id=original-private-report]')`, 'older round opens its own private report')
      assert.equal(await read(`!!${originalDetail}?.querySelector('[data-direct-message-id=another-private-assignment]')`), false)
      await capture('calendar-earlier-round-details')
      await click(locator('.mote-direct-panel[data-view="assignment"] [aria-label="关闭作业详情"]'))
      const after = await facts()
      assert.deepEqual(after.drafts, before.drafts)
      assert.deepEqual(after.selection, before.selection)
      assert.deepEqual(after.sessions, before.sessions)
      assert.equal(after.calls.some(call => ['schedule.create', 'schedule.pause', 'schedule.resume', 'schedule.cancel'].includes(call.method)), false)
      assert.deepEqual(result.errors, [])
      result.passed = true
      return
    }
    await verifyEventSurface('.mote-calendar__point', 'border-inline-start:3px solid currentColor!important', /one-sided stripe/)
    const heartbeatPoint = locator('.mote-calendar__point[data-heartbeat="true"]')
    await waitFor(`${heartbeatPoint}?.querySelector('[data-semantic-icon="object.heartbeat"]')`, 'original heartbeat symbol')
    await settleMotion()
    await capture('month-event-surfaces')
    const hideHeartbeats = locator('[aria-label="Hide heartbeats"]')
    await click(hideHeartbeats)
    await waitFor(`(${hideHeartbeats})?.getAttribute('aria-pressed')==='true' && !${heartbeatPoint}`, 'confirmed heartbeats hidden')
    assert.ok(await read(`!!${locator('.mote-calendar__point[data-calendar-schedule-id="group-watch"]')}`))
    await capture('month-original-heartbeats-hidden')
    await click(hideHeartbeats)
    await waitFor(`!!${heartbeatPoint}`, 'original heartbeats visible again')
    await view('Week')
    await waitFor('document.querySelectorAll("[data-calendar-hour]").length===168', 'original week grid')
    result.observations.canvas = await dimensions()
    const {canvasWidth,width,bottomGap,scrollHeight} = result.observations.canvas
    assert.ok(canvasWidth > width*.94 && scrollHeight > 450 && bottomGap < 76,'Calendar fills the available Mote content area')
    assert.equal(await read(`document.querySelector('.workspace-files-source')?.getBoundingClientRect().height ?? 0`), 0)
    const dates = await read(`(() => {const today=window.moteCalendarScene.facts().now;
      const civil=offset=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(today+offset*86400000)
      return {yesterday:civil(-1),tomorrow:civil(1),today:civil(0)} })()`)
    if (!await read(`!!${locator('[data-mote-date="'+dates.yesterday+'"]')}`)) await click(locator('[aria-label="Previous week"]'))
    const past = locator(`[data-calendar-hour="${dates.yesterday}:9"]`)
    await waitFor(`(${past})?.textContent.toLowerCase().includes('fail')`, 'recorded failure visible before selecting its hour')
    await verifyEventSurface('.mote-calendar__rate[data-attention="true"]', 'background:transparent!important', /no surface fill/)
    await read(`(${past}).scrollIntoView({block:'center'})`)
    await pause(240)
    await capture('week-recorded-events')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})
    const reader = locator('.mote-calendar__day')
    const armReaderTransition = () => read(`window.readerTransition=null;
      document.addEventListener('transitionrun', function onRun(event) {
        if (!event.target.matches('.mote-calendar__day') || event.propertyName !== 'transform') return;
        document.removeEventListener('transitionrun', onRun, true);
        const animations=event.target.getAnimations();
        for (const animation of animations) {
          animation.pause();
          animation.currentTime=animation.effect.getTiming().duration*.25;
        }
        window.readerTransition=animations;
      },true)`)
    const waitForReaderTransition = async name => {
      await waitFor('window.readerTransition?.some(a=>a.transitionProperty==="transform")', name)
      return read(`(()=>{const style=getComputedStyle(${reader});return {
        opacity:Number(style.opacity),transform:style.transform,display:style.display,hidden:${reader}.hidden
      }})()`)
    }
    const finishReaderTransition = () => read('Promise.allSettled(window.readerTransition.map(animation=>{animation.play();return animation.finished}))')
    await armReaderTransition()
    await click(past)
    const entering = await waitForReaderTransition('actual detail panel entering')
    assert.ok(entering.opacity > 0 && entering.opacity < 1 && entering.transform !== 'none' && !entering.hidden)
    await capture('period-opening-wide')
    await finishReaderTransition()
    const events = locator('[aria-label="Calendar events"]')
    await waitFor(`${events}?.querySelectorAll('[data-event-kind="recorded"]').length===3`, 'three original events in one period')
    assert.equal(await read(`[...${events}.querySelectorAll('[data-event-result="failed"]')].length`),1)
    const highlight = locator('.mote-calendar__highlight')
    const verifyFocusCard = async () => {
      const focus = await read(`(()=>{const card=${highlight},rect=card.getBoundingClientRect();return {text:card.textContent,height:rect.height}})()`)
      assert.ok(focus.height > 44 && focus.text.includes('Needs attention') && focus.text.includes('Agent turn failed'), 'Visible focus card highlights the recorded failure')
    }
    await verifyFocusCard()
    const hiddenCard = await win.webContents.insertCSS('.mote-calendar__highlight { display: none !important; }')
    try { await assert.rejects(verifyFocusCard, /Visible focus card/) }
    finally { await win.webContents.removeInsertedCSS(hiddenCard) }
    await verifyFocusCard()
    result.mutations.push({selector:'.mote-calendar__highlight',rejected:'Missing focus card',restored:true})
    await capture('period-focus-wide')
    await click(highlight)
    await waitFor(`${reader}.querySelector('.mote-calendar__focus .mote-calendar__recap:not([hidden])')?.textContent.includes('Agent turn failed')`, 'focus opens the original failed receipt')
    await click(locator('.mote-calendar__event[data-event-schedule="group-watch"]'))
    await waitFor(`document.querySelector('.mote-calendar__recap')?.textContent.includes('Review the open commitments')`, 'frozen exact event recap')
    await settleMotion()
    await capture('hour-original-recap')
    const canvasDuringReader = (await dimensions()).canvasWidth
    await armReaderTransition()
    key('Escape')
    const exiting = await waitForReaderTransition('actual detail panel exiting')
    assert.ok(exiting.opacity > 0 && exiting.opacity < 1 && exiting.display !== 'none' && exiting.hidden)
    assert.equal((await dimensions()).canvasWidth,canvasDuringReader,'The calendar grid waits until the reader fades before expanding')
    assert.equal(await read(`document.activeElement===${past}`),true,'Focus returns to the exact period trigger during exit')
    await capture('period-closing-wide')
    await finishReaderTransition()
    result.observations.periodMotion = { entering, exiting }

    const repeated = locator(`[data-calendar-hour="${dates.yesterday}:8"]`)
    await click(repeated)
    const group = locator('.mote-calendar__event-group')
    await waitFor(`${group}?.querySelector('button')?.textContent.includes('2 events')`, 'normal repeated events fold into one row')
    await settleMotion()
    await capture('period-heartbeats-collapsed')
    const groupSummary = `${group}.querySelector('button')`
    const armGroupTransition = () => read(`window.groupTransition=null;
      document.addEventListener('transitionrun', function onRun(event) {
        if (!event.target.matches('.mote-calendar__event-group ol') || event.propertyName !== 'opacity') return;
        document.removeEventListener('transitionrun', onRun, true);
        const animations=event.target.getAnimations();
        for (const animation of animations) {
          animation.pause();
          animation.currentTime=animation.effect.getTiming().duration*.19;
        }
        window.groupTransition=animations;
      },true)`)
    const awaitGroupTransition = label => waitFor('window.groupTransition?.some(a=>a.transitionProperty==="opacity")', label)
    const finishGroupTransition = () => read('Promise.allSettled(window.groupTransition.map(animation=>{animation.play();return animation.finished}))')
    await armGroupTransition()
    await click(groupSummary)
    await awaitGroupTransition('original grouped list has a visible opening transition')
    await capture('period-heartbeats-opening')
    await finishGroupTransition()
    await waitFor(`${group}.querySelector('ol:not([hidden])')?.querySelectorAll('li[data-event-kind="recorded"]').length===2`, 'expanded group retains both original receipts')
    await capture('period-heartbeats-expanded')
    await armGroupTransition()
    await click(groupSummary)
    await awaitGroupTransition('original grouped list has a visible closing transition')
    await waitFor(`${group}.querySelector('ol').hidden&&document.activeElement===${groupSummary}`, 'collapse keeps focus on the same group')
    await capture('period-heartbeats-closing')
    await finishGroupTransition()
    key('Escape')
    await settleMotion()
    await click(control('.mote-calendar__toolbar button','Today'))
    await view('3 Days')
    const future = locator(`[data-calendar-hour="${dates.tomorrow}:10"]`)
    await waitFor(`${future}?.dataset.calendarPlanned==='90'`, 'ninety planned occurrences in one hour')
    await click(future)
    await waitFor(`document.querySelector('.mote-calendar__plan-total strong')?.textContent==='90'`, 'dense selected period')
    await click(locator('.mote-calendar__time-details > summary'))
    await waitFor(`document.querySelectorAll('.mote-calendar__time-page li').length===12`, 'bounded concrete times')
    await click(control('.mote-calendar__time-pager button','Next'))
    await waitFor(`document.querySelector('.mote-calendar__time-pager')?.textContent.includes('13–24 / 90')`, 'second original page')
    await capture('dense-intervals')
    key('Escape')

    const slot = `(${future})?.parentElement.querySelector('.mote-calendar__slot')`
    await read(`(${future}).scrollIntoView({block:'center'})`)
    const hover = await read(`(()=>{const r=${future}.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    win.webContents.sendInputEvent({type:'mouseMove',...hover})
    // Park the actual CSS animation when it starts, before a slow CI frame can finish it.
    await read(`document.addEventListener('animationstart',event=>{
      if(!event.target.matches('.schedule-create-popover'))return;
      const anim=event.target.getAnimations().find(a=>a.animationName===event.animationName);
      if(anim){anim.pause();window.openingAnimation=anim;anim.currentTime=Number(anim.effect.getTiming().duration)/2}
    },{capture:true})`)
    await click(slot)
    await waitFor(`!!${dialog}`, 'anchored new arrangement')
    result.observations.editStyle = await read(`(()=>{const p=${dialog},s=getComputedStyle(p);return {display:s.display,name:s.animationName,duration:s.animationDuration,width:p.clientWidth,height:p.clientHeight}})()`)
    await waitFor('window.openingAnimation?.effect.getComputedTiming().progress>0', 'observable opening animation on the actual editor')
    result.observations.editorOpening = await read('window.openingAnimation.effect.getComputedTiming().progress')
    await capture('editor-opening')
    await read('window.openingAnimation.play();window.openingAnimation.finished.then(()=>true)')
    await waitFor(`${dialog}?.querySelector('[aria-label="Arrangement date"]')?.value===${JSON.stringify(dates.tomorrow)}`, 'original slot date inherited')
    await waitFor(`${dialog}?.querySelector('[aria-label="Arrangement local time"]')?.value.startsWith('10:')`, 'original slot time inherited')
    const message = `${dialog}.querySelector('[aria-label="Arranged message"]')`
    await click(message)
    await win.webContents.insertText('Review the open commitments with me.')
    const save = `[...${dialog}.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save arrangement')`
    await reach(save)
    await capture('editor-anchored-wide')
    key('Escape')
    await waitFor(`!${dialog} && document.activeElement===${slot}`, 'return focus to exact slot')
    win.setContentSize(390,615)
    await read(`window.moteCalendarScene.theme('light')`)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await click(locator('button[aria-label="New arrangement"]'))
    await waitFor(`!!${dialog}`, 'reduced motion narrow editor')
    assert.equal(await read(`matchMedia('(prefers-reduced-motion: reduce)').matches`),true)
    await waitFor(`${dialog}.getAnimations().length===0`, 'reduced-motion settled editor')
    assert.equal(await read(`${message}.value`),'Review the open commitments with me.')
    await reach(save)
    await capture('editor-short-narrow-reduced')
    key('Escape')
    await waitFor(`!${dialog}`, 'calendar recovered after narrow editor')
    await click(future)
    await waitFor(`${highlight}?.textContent.includes('Next up')`, 'narrow sheet shows the confirmed next planned event')
    assert.equal(await read(`${reader}.getAnimations({subtree:true}).length`),0,'Reduced motion places the period reader in its settled state')
    await reach(locator('[aria-label="Close period details"]'))
    await capture('period-narrow-reduced')
    key('Escape')
    assert.equal(await read(`getComputedStyle(${reader}).display`),'none')
    await view('Day')
    assert.equal(await read(`${calendar}.scrollWidth<=${calendar}.clientWidth+1`),true)
    await capture('day-narrow-reduced')
    const facts = await read('window.moteCalendarScene.facts()')
    const reads = facts.calls.filter(call => call.method === 'schedule.history')
    assert.ok(reads.some(call => call.params.bucketStarts?.length > 1))
    assert.ok(reads.filter(call => !call.params.bucketStarts).every(call => call.params.to - call.params.from <= 90_000_000))
    assert.ok(reads.some(call => !call.params.bucketStarts && call.params.scheduleId === 'group-watch'))
    assert.equal(facts.calls.filter(call => /schedule\.(create|pause|resume|cancel)/u.test(call.method)).length,0)
    assert.deepEqual(facts.drafts,facts.initialDrafts)
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await waitFor("matchMedia('(pointer: coarse)').matches",'coarse pointer enabled')
    await win.loadFile(html,{query:{workspacePath:join(evidence,'workspace'),scenario:'calendar-density',empty:'1'}})
    win.webContents.focus()
    await read("window.moteCalendarScene.theme('light')")
    await click(control('[role="tab"]','Calendar'))
    await view('3 Days')
    const empty = locator(`[data-calendar-hour="${dates.tomorrow}:15"][aria-label*="prepare arrangement"]`)
    await waitFor(`!!${empty}`, 'empty future hour offers creation')
    const target = await read(`(()=>{const el=${empty};el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await reach(empty)
    const sizes = await read(`[...document.querySelectorAll('.mote-calendar__toolbar button')].map(el=>{const r=el.getBoundingClientRect();return {name:el.getAttribute('aria-label')||el.textContent.trim(),width:r.width,height:r.height}})`)
    assert.ok(sizes.length>=6&&sizes.every(item=>item.width>=44&&item.height>=44),'All coarse toolbar targets have a usable size')
    result.observations.touchTargets = sizes
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[target]})
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await waitFor(`!!${dialog}`,'touch opens the empty hour')
    await reach(save)
    // Let Chromium finish its native tap highlight before recording the settled editor.
    await pause(300)
    await capture('editor-coarse-empty-hour')
    key('Escape')
    await waitFor(`!${dialog}&&document.activeElement===${empty}`, 'touch dismissal restores the selected hour')
    key('Enter')
    await waitFor(`!!${dialog}`, 'keyboard activation of the same empty hour')
    key('Escape')
    assert.equal(await read("window.moteCalendarScene.facts().calls.some(c=>c.method==='schedule.create')"),false)
    assert.deepEqual(result.errors,[])
    result.passed = true
  } catch (error) {
    result.failure = error.stack
    console.error(error)
  } finally {
    await writeFile(join(evidence, 'renderer-result.json'), JSON.stringify(result, null, 2) + '\n')
    app.exit(result.passed ? 0 : 1)
  }
})
