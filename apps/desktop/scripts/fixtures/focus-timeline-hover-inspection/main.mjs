import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, controls: [], frames: [], boundary: 'Current production compiled Timeline/Avatar/Preview/Store and existing public projector with sealed genuine producer inputs and isolated typed I/O. No Runtime, writer/restart/installation or user Run operations.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1440, height: 540, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const evaluate = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { for (let i = 0; i < 160; i++) { const result = await evaluate(expression); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
    const state = () => evaluate('hoverSceneState()')
    const painted = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    const point = selector => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing actual target');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    const move = async selector => { await painted(); const position = await point(selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position }); await painted(); return point(selector) }
    const click = async selector => {
      const position = await move(selector)
      assert.equal(await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),h=document.elementFromPoint(${position.x},${position.y});return !!h&&(n===h||n.contains(h))})()`), true, `Actual target hit ${selector}`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...position, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    }
    const key = async value => {
      const code = value === ' ' ? 'Space' : value, number = value === 'Escape' ? 27 : value === 'Tab' ? 9 : value === ' ' ? 32 : 13
      for (const type of value === 'Enter' || value === ' ' ? ['rawKeyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: number, ...(type === 'char' ? { text: value === 'Enter' ? '\r' : ' ', unmodifiedText: value === 'Enter' ? '\r' : ' ' } : {}) })
    }
    const shot = async name => {
      await painted()
      await until(`(()=>{const p=document.querySelector('.recent-focus__message-preview,.recent-focus__context-preview');return !!p&&getComputedStyle(p).visibility==='visible'&&getComputedStyle(p).opacity==='1'&&!p.getAnimations().some(a=>a.playState==='running')})()`)
      const image = `${name}.png`
      await fs.writeFile(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
      const geometry = await evaluate(`(()=>{const p=document.querySelector('.recent-focus__message-preview,.recent-focus__context-preview'),h=document.querySelector('.recent-focus__header');return{popup:p?.getBoundingClientRect().toJSON(),header:h.getBoundingClientRect().toJSON(),role:p?.getAttribute('role'),text:p?.textContent,animation:p?getComputedStyle(p).animationName:null}})()`)
      actual.frames.push({ image, width: await evaluate('innerWidth'), geometry, state: await state() })
      assert.ok(geometry.popup.bottom <= geometry.header.top - 5, `${name}: actual disclosure stays outside the Timeline header`)
    }
    if(['fold-360','label-fit'].includes(process.env.AGENTMUX_FOCUS_HOVER_SCENE_PHASE)) {
      actual.phase=process.env.AGENTMUX_FOCUS_HOVER_SCENE_PHASE; actual.boundary='Actual repeated-clock ruler pixel annex over current compiled source and delivered name-width controls. No replay of the hover matrix, Runtime, writer or user controls.'
      await until('window.hoverSceneState&&hoverSceneState().markers.length===5')
      // Save a real wider preference through the delivered keyboard resizer;
      // the production narrow clamp, not a helper width, must preserve time space.
      await until('document.querySelector("[aria-label=\\"Resize timeline names\\"]")?.getAttribute("aria-valuemax")==="320"')
      await evaluate('document.querySelector("[aria-label=\\"Resize timeline names\\"]").focus()')
      for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'End',code:'End',windowsVirtualKeyCode:35})
      await until('hoverSceneState().nameWidth.saved===320')
      actual.nameWidth={wide:await state()}
      win.setContentSize(360,420); await until('innerWidth===360')
      await until('hoverSceneState().nameWidth.rendered===176'); actual.nameWidth.narrow=await state()
      for(const name of ['Previous focus window','Next focus window']) {
        await evaluate(`document.querySelector('[aria-label="${name}"]').scrollIntoView({block:'nearest',inline:'nearest'})`)
        await click(`[aria-label="${name}"]`)
      }
      await until('hoverSceneState().counts.page===2')
      actual.cost={start:await state()}
      await evaluate('document.querySelector("[aria-label=\\"Focus timeline settings\\"]").scrollIntoView({block:"nearest",inline:"nearest"})')
      await click('[aria-label="Focus timeline settings"]'); await until('!!document.querySelector(".focus-ruler-settings")')
      await click('input[name="focus-ruler-mode"][value="uniform"]')
      await evaluate(`(()=>{for(const [label,value] of [['Time ruler interval in minutes','30'],['Time ruler clock offset','00:00']]){const n=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))}const n=document.querySelector('[aria-label="Focus timeline time zone"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,'America/New_York');n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await click('.focus-ruler-settings footer > button:last-child'); await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().ruler.timeZone==="America/New_York"')
      await evaluate(`(()=>{const n=document.querySelector('[aria-label="Focus history date and time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'2026-11-01T01:30');n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await until('document.querySelectorAll(".focus-ruler-settings__dates button").length===2')
      actual.fold={choices:await evaluate('[...document.querySelectorAll(".focus-ruler-settings__dates button")].map(n=>n.textContent)')}
      assert.deepEqual(actual.fold.choices.map(text=>text.slice(0,9)),['UTC−04:00','UTC−05:00'])
      await click('.focus-ruler-settings__dates button:nth-child(2)'); await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().start===Date.parse("2026-11-01T03:30Z")')
      await painted()
      const geometry=await evaluate(`(()=>{const s=document.querySelector('.recent-focus__time-scale'),g=document.querySelector('.recent-focus__grid');return{scale:s.getBoundingClientRect().toJSON(),grid:g.getBoundingClientRect().toJSON(),labels:[...s.querySelectorAll('time')].filter(n=>n.getBoundingClientRect().width&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden').map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON()})),candidates:[...s.querySelectorAll('time')].map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON(),instant:+n.parentElement.dataset.tickAt,tier:n.parentElement.dataset.tier,visibility:getComputedStyle(n).visibility,ariaHidden:n.getAttribute('aria-hidden')})),ticks:[...s.querySelectorAll('[data-tick-at]')].map(n=>+n.dataset.tickAt),lane:document.querySelector('.recent-focus__lane')?.getBoundingClientRect().toJSON()??null}})()`)
      const image='ruler-new-york-fold-labels-360.png'; await fs.writeFile(path.join(evidence,image),(await win.webContents.capturePage()).toPNG())
      actual.frames.push({image,width:await evaluate('innerWidth'),geometry,state:await state(),phase:'Root-T004-fold-360-pixel-check'})
      const labels=[...geometry.labels].sort((a,b)=>a.rect.left-b.rect.left)
      actual.fold.geometry=geometry; actual.fold.collisions=labels.flatMap((label,index)=>index&&labels[index-1].rect.right>label.rect.left?[{left:labels[index-1],right:label,overlap:labels[index-1].rect.right-label.rect.left}]:[])
      assert.ok(labels.length>0); assert.ok(geometry.ticks.includes(Date.parse('2026-11-01T05:30Z'))); assert.ok(geometry.ticks.includes(Date.parse('2026-11-01T06:30Z')))
      assert.equal(geometry.scale.width,160); assert.equal((await state()).nameWidth.saved,320)
      actual.cost.end=await state(); assert.deepEqual(actual.cost.start.counts,actual.cost.end.counts); actual.controls=actual.cost.end.controls; assert.deepEqual(actual.controls,[])
      assert.equal(actual.fold.collisions.length,0,'Actual 360px repeated-offset labels overlap; painted PNG/bounds retained')
      if(actual.phase==='label-fit') {
        const fit = (observed, name) => {
          assert.ok(observed.labels.length>0, `${name}: actual labels are nonempty`)
          for(const label of observed.labels) {
            assert.ok(label.rect.left>=observed.scale.left, `${name}: ${label.text} left ${label.rect.left} outside ${observed.scale.left}`)
            assert.ok(label.rect.right<=observed.scale.right, `${name}: ${label.text} right ${label.rect.right} outside ${observed.scale.right}`)
          }
          const ordered=[...observed.labels].sort((a,b)=>a.rect.left-b.rect.left)
          for(let i=1;i<ordered.length;i++) assert.ok(ordered[i-1].rect.right<=ordered[i].rect.left, `${name}: actual labels overlap by ${ordered[i-1].rect.right-ordered[i].rect.left}px`)
        }
        actual.labelFit={first:geometry}; fit(geometry,'360/160')
        await evaluate(`document.querySelector('[aria-label="Resize timeline names"]').focus()`)
        for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Home',code:'Home',windowsVirtualKeyCode:36})
        await until('hoverSceneState().nameWidth.saved===96')
        win.setContentSize(424,420); await until('innerWidth===424&&hoverSceneState().nameWidth.rendered===96'); await painted()
        const second=await evaluate(`(()=>{const s=document.querySelector('.recent-focus__time-scale');return{scale:s.getBoundingClientRect().toJSON(),labels:[...s.querySelectorAll('time')].filter(n=>n.getBoundingClientRect().width&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden').map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON(),transform:getComputedStyle(n).transform})),candidates:[...s.querySelectorAll('time')].map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON(),instant:+n.parentElement.dataset.tickAt,tier:n.parentElement.dataset.tier,visibility:getComputedStyle(n).visibility,ariaHidden:n.getAttribute('aria-hidden')})),ticks:[...s.querySelectorAll('[data-tick-at]')].map(n=>+n.dataset.tickAt)}})()`)
        const secondImage='ruler-new-york-two-offset-labels-424.png'; await fs.writeFile(path.join(evidence,secondImage),(await win.webContents.capturePage()).toPNG())
        actual.frames.push({image:secondImage,width:await evaluate('innerWidth'),geometry:second,state:await state(),phase:'Root-T004-two-long-offset-labels-pixel-check'})
        actual.labelFit.second=second; assert.equal(second.scale.width,304)
        const longLabels=second.candidates.filter(label=>label.text.includes('UTC'))
        assert.ok(longLabels.length>=2,'The real second condition must actually measure two offset candidates')
        assert.ok(longLabels.every(label=>label.rect.width>0),'Hidden offset candidates retain their actual border boxes')
        actual.cost.end=await state(); assert.deepEqual(actual.cost.start.counts,actual.cost.end.counts); assert.deepEqual(actual.cost.end.controls,[])
        fit(second,'424/304 two offset labels')
      }
      actual.passed=true; return
    }
    const avatar = '[data-focus-timeline-id="focus-author-recipient"] .agent-avatar'
    await until('window.hoverSceneState&&hoverSceneState().markers.length===5')
    await evaluate('document.querySelector("#original-draft").focus()')
    await move(avatar)
    await until('!!document.querySelector(".recent-focus__context-preview")')
    actual.currentContext = await evaluate('document.querySelector(".recent-focus__context-preview").textContent')
    assert.ok(actual.currentContext.includes('Author project')); assert.ok(actual.currentContext.includes('Reviewing timeline interactions')); assert.ok(actual.currentContext.includes('Topic summary'))
    assert.equal(await evaluate('document.activeElement.id'), 'original-draft'); await shot('current-context-wide')
    await move('#original-draft'); await until('!document.querySelector(".recent-focus__context-preview")')
    // Read the existing bounded snapshot once; high-frequency viewport changes never create a new reading intent.
    await click('[aria-label="Previous focus window"]'); await click('[aria-label="Next focus window"]')
    await until('hoverSceneState().counts.page===2'); actual.snapshot = await state()
    win.setContentSize(640, 420); await until('innerWidth===640')
    const archived = '[data-focus-timeline-id="retained-unknown-context"] .agent-avatar'
    await evaluate(`document.querySelector(${JSON.stringify(archived)}).scrollIntoView({block:'nearest'})`)
    await move(archived); await until('!!document.querySelector(".recent-focus__context-preview")')
    actual.unknownContext = await evaluate('document.querySelector(".recent-focus__context-preview").textContent')
    assert.ok(actual.unknownContext.includes('Project not recorded')); assert.ok(actual.unknownContext.includes('Current state not recorded')); assert.ok(!actual.unknownContext.includes('Author project'))
    await shot('historical-unknown-narrow'); await move('#original-draft'); await until('!document.querySelector(".recent-focus__context-preview")')
    for (const role of ['human', 'agent', 'unknown']) {
      const selector = `.recent-focus__message[data-message-author="${role}"]`
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`)
      await move(selector)
      await until(`document.querySelector('.recent-focus__message-preview[role="tooltip"]')?.dataset.messageAuthor===${JSON.stringify(role)}`)
      const info = await evaluate(`(()=>{const p=document.querySelector('.recent-focus__message-preview');return{role:p.dataset.messageAuthor,id:p.dataset.previewMessageId,summary:p.querySelector('.recent-focus__message-excerpt').textContent,actions:p.querySelectorAll('button,a,input,[tabindex]').length,time:p.querySelectorAll('time').length}})()`)
      assert.equal(info.role, role); assert.ok(info.summary.includes('Same body')); assert.equal(info.actions, 0); assert.equal(info.time, 1)
      actual[`${role}Quick`] = info; await shot(`${role}-quick-narrow`)
      // Cross marker -> quick surface using a real pointer move. The delayed close must be cancelled.
      await move('.recent-focus__message-excerpt'); await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(await evaluate('document.querySelector(".recent-focus__message-preview")?.dataset.previewMessageId'), info.id)
      await move('#original-draft'); await until('!document.querySelector(".recent-focus__message-preview")')
    }
    const resource = '.recent-focus__message[data-message-raw-id="hover-resource-only"]'
    await move(resource); await until('document.querySelector(".recent-focus__message-excerpt")?.textContent==="Design preview image"')
    assert.equal((await state()).counts.images, 0); await shot('resource-only-quick'); await move('#original-draft'); await until('!document.querySelector(".recent-focus__message-preview")')
    const human = '.recent-focus__message[data-message-author="human"]', agent = '.recent-focus__message[data-message-author="agent"]'
    await click(human); await until('document.querySelector(".recent-focus__message-preview")?.getAttribute("role")==="dialog"')
    actual.pin = await evaluate(`(()=>{window.hoverBody=document.querySelector('.recent-focus__message-body');window.hoverMarker=document.querySelector(${JSON.stringify(human)});const walker=document.createTreeWalker(window.hoverBody,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode())if(text.textContent.includes('Same body'))break;const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);return{id:window.hoverBody.dataset.inputPreviewId,selection:getSelection().toString()}})()`)
    assert.ok(actual.pin.selection.includes('Same body')); await shot('human-pinned-narrow')
    await move(agent); await new Promise(resolve => setTimeout(resolve, 220))
    assert.equal(await evaluate('window.hoverBody===document.querySelector(".recent-focus__message-body")'), true)
    assert.equal(await evaluate('getSelection().toString()'), actual.pin.selection)
    actual.cost = { start: await state(), hoverPasses: 200, viewportUpdates: 200 }
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(agent)});for(let i=0;i<200;i++){node.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));node.dispatchEvent(new MouseEvent('mouseout',{bubbles:true}))}})()`)
    for (let i = 0; i < 200; i++) {
      const before = await state(), label = i % 2 ? 'Previous focus window' : 'Next focus window'
      await click(`[aria-label="${label}"]`); await until(`hoverSceneState().start===${before.start + (i % 2 ? -1 : 1) * 4 * 3600000}`)
    }
    actual.cost.end = await state(); assert.deepEqual(actual.cost.end.counts, actual.cost.start.counts)
    assert.deepEqual(actual.cost.end.controls, []); assert.equal(await evaluate('getSelection().toString()'), actual.pin.selection)
    // A real pan detaches the marker, but the fixed original body and Range stay readable.
    await click('[aria-label="Next focus window"]'); await until('!window.hoverMarker.isConnected')
    actual.detached = await evaluate('({sameBody:window.hoverBody===document.querySelector(".recent-focus__message-body"),selection:getSelection().toString()})')
    assert.equal(actual.detached.sameBody, true); assert.equal(actual.detached.selection, actual.pin.selection)
    await key('Escape'); await until('!document.querySelector(".recent-focus__message-preview")')
    await click('[aria-label="Previous focus window"]')
    win.setContentSize(320, 420); await until('innerWidth===320')
    await evaluate(`document.querySelector(${JSON.stringify(human)}).focus()`); await until('!!document.querySelector(".recent-focus__message-preview[role=tooltip]")')
    await key('Enter'); await until('!!document.querySelector(".recent-focus__message-preview[role=dialog]")')
    actual.keyboard = await evaluate('({role:document.querySelector(".recent-focus__message-preview .log-turn").dataset.speakerRole,body:document.querySelector(".recent-focus__message-body").getBoundingClientRect().toJSON(),popup:document.querySelector(".recent-focus__message-preview").getBoundingClientRect().toJSON()})')
    assert.equal(actual.keyboard.role, 'human'); assert.ok(actual.keyboard.popup.width <= 304); await shot('keyboard-pinned-320')
    const controlPoint = await move('.recent-focus__controls')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...controlPoint, deltaX: 800, deltaY: 0 })
    await until('document.querySelector(".recent-focus__controls").scrollLeft>0')
    actual.narrowHits = await evaluate(`['Next focus window','Return to current focus window'].map(name=>{const n=document.querySelector('[aria-label="'+name+'"]'),r=n.getBoundingClientRect();return{name,hits:[r.top+2,r.y+r.height/2,r.bottom-2].map(y=>{const h=document.elementFromPoint(r.x+r.width/2,y);return !!h&&(h===n||n.contains(h))})}})`)
    assert.deepEqual(actual.narrowHits.map(item => item.hits), [[true,true,true],[true,true,true]])
    await evaluate('document.querySelector("#original-draft").focus()'); await key('Escape')
    assert.equal(await evaluate('document.activeElement.id'), 'original-draft')
    win.setContentSize(640, 420); await until('innerWidth===640')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await evaluate(`document.querySelector(${JSON.stringify(agent)}).focus()`); await until('!!document.querySelector(".recent-focus__message-preview[role=tooltip]")')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".recent-focus__message-preview")).animationName'), 'none')
    await key(' '); await until('!!document.querySelector(".recent-focus__message-preview[role=dialog]")')
    await click('.recent-focus__sender-details > summary'); await shot('agent-pinned-reduced-motion')
    // Root T004 presentation consumption only: keep the same compiled reader and body.
    const axisBefore = await state()
    actual.ruler = { boundary: 'Actual settings UI and the already compiled Root ruler. No new engine, reader, Runtime or restart.', before: axisBefore, frames: [] }
    await evaluate(`(()=>{window.axisBody=document.querySelector('.recent-focus__message-body');window.axisBodyScroll=window.axisBody.scrollTop;window.axisBodyId=window.axisBody.dataset.inputPreviewId})()`)
    const axisGeometry = () => evaluate(`(()=>{const t=document.querySelector('.recent-focus'),s=t.querySelector('.recent-focus__time-scale'),g=t.querySelector('.recent-focus__grid'),l=t.querySelector('.recent-focus__lane');return{mode:t.dataset.rulerMode,zone:t.dataset.timeZone,start:+t.dataset.windowStart,end:+t.dataset.windowEnd,scale:s.getBoundingClientRect().toJSON(),grid:g.getBoundingClientRect().toJSON(),lane:l?.getBoundingClientRect().toJSON()??null,ticks:[...s.querySelectorAll('[data-tick-at]')].map(n=>({instant:+n.dataset.tickAt,tier:n.dataset.tier,rect:n.getBoundingClientRect().toJSON()})),labels:[...s.querySelectorAll('time')].filter(n=>n.getBoundingClientRect().width&&getComputedStyle(n).display!=='none').map(n=>({text:n.textContent,rect:n.getBoundingClientRect().toJSON()}))}})()`)
    const axisShot = async name => {
      await painted()
      const geometry = await axisGeometry(), labels = [...geometry.labels].sort((a,b)=>a.rect.left-b.rect.left)
      assert.ok(labels.length > 0); assert.ok(geometry.ticks.length > 0)
      for(let i=1;i<labels.length;i++) assert.ok(labels[i-1].rect.right<=labels[i].rect.left, `${name}: actual clock labels must not overlap`)
      for(const edge of ['left','right']) { assert.ok(Math.abs(geometry.grid[edge]-geometry.scale[edge])<1, `${name}: grid and ruler ${edge} align`); assert.ok(Math.abs(geometry.lane[edge]-geometry.scale[edge])<1, `${name}: lane and ruler ${edge} align`) }
      const image=`${name}.png`; await fs.writeFile(path.join(evidence,image),(await win.webContents.capturePage()).toPNG())
      const frame={image,width:await evaluate('innerWidth'),geometry,state:await state(),phase:'Root-T004-ruler-presentation'}; actual.frames.push(frame); actual.ruler.frames.push(frame)
    }
    win.setContentSize(1440,540); await until('innerWidth===1440'); await axisShot('ruler-daily-wide')
    const openSettings = async () => {
      await evaluate('document.querySelector("[aria-label=\\"Focus timeline settings\\"]").scrollIntoView({block:"nearest",inline:"nearest"})')
      await click('[aria-label="Focus timeline settings"]'); await until('!!document.querySelector(".focus-ruler-settings")')
    }
    await openSettings(); await click('input[name="focus-ruler-mode"][value="uniform"]')
    await evaluate(`(()=>{const n=document.querySelector('[aria-label="Focus timeline time zone"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,'UTC');n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"Time ruler interval in minutes\\"]").value'), '120')
    assert.equal(await evaluate('document.querySelector("[aria-label=\\"Time ruler clock offset\\"]").value'), '23:00')
    const settingsImage='ruler-settings-modes-zone.png'; await painted(); await fs.writeFile(path.join(evidence,settingsImage),(await win.webContents.capturePage()).toPNG())
    const settingsGeometry=await evaluate(`(()=>{const p=document.querySelector('.focus-ruler-settings');return{dialog:p.getBoundingClientRect().toJSON(),modes:[...p.querySelectorAll('[name="focus-ruler-mode"]')].map(n=>({value:n.value,label:n.parentElement.textContent,checked:n.checked})),zone:p.querySelector('[aria-label="Focus timeline time zone"]').value,interval:p.querySelector('[aria-label="Time ruler interval in minutes"]').value,phase:p.querySelector('[aria-label="Time ruler clock offset"]').value}})()`)
    assert.deepEqual(settingsGeometry.modes.map(m=>m.value),['daily','uniform','free']); assert.equal(settingsGeometry.zone,'UTC')
    actual.frames.push({image:settingsImage,width:await evaluate('innerWidth'),geometry:settingsGeometry,state:await state(),phase:'Root-T004-settings-dialog'})
    actual.ruler.settings=settingsGeometry
    await click('.focus-ruler-settings footer > button:last-child'); await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().ruler.mode==="uniform"')
    win.setContentSize(640,420); await until('innerWidth===640'); await axisShot('ruler-uniform-utc-narrow')
    const uniform=await axisGeometry(); assert.equal(uniform.zone,'UTC'); assert.ok(uniform.ticks.length>0)
    assert.ok(uniform.ticks.every(tick=>new Date(tick.instant).getUTCMinutes()===0&&new Date(tick.instant).getUTCHours()%2===1))
    await openSettings(); await click('input[name="focus-ruler-mode"][value="free"]'); await click('.focus-ruler-settings footer > button:last-child')
    await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().ruler.mode==="free"')
    const free=await axisGeometry(); assert.equal(free.ticks.length,5); actual.ruler.free=free
    actual.ruler.after=await state(); actual.ruler.body=await evaluate('({same:window.axisBody===document.querySelector(".recent-focus__message-body"),id:document.querySelector(".recent-focus__message-body")?.dataset.inputPreviewId,scroll:document.querySelector(".recent-focus__message-body")?.scrollTop,originalScroll:window.axisBodyScroll,selection:getSelection().toString()})')
    assert.equal(actual.ruler.body.same,true); assert.equal(actual.ruler.body.scroll,actual.ruler.body.originalScroll)
    assert.equal(actual.ruler.after.start,axisBefore.start); assert.equal(actual.ruler.after.end,axisBefore.end); assert.equal(actual.ruler.after.draft,axisBefore.draft); assert.deepEqual(actual.ruler.after.counts,axisBefore.counts)
    // A civil clock fold is resolved by the production date input, not a guessed instant.
    await openSettings(); await click('input[name="focus-ruler-mode"][value="uniform"]')
    await evaluate(`(()=>{for(const [label,value] of [['Time ruler interval in minutes','30'],['Time ruler clock offset','00:00']]){const n=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))}const n=document.querySelector('[aria-label="Focus timeline time zone"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(n,'America/New_York');n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await click('.focus-ruler-settings footer > button:last-child'); await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().ruler.timeZone==="America/New_York"')
    await evaluate(`(()=>{const n=document.querySelector('[aria-label="Focus history date and time"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,'2026-11-01T01:30');n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    await until('document.querySelectorAll(".focus-ruler-settings__dates button").length===2')
    actual.ruler.fold={before:await state(),choices:await evaluate('[...document.querySelectorAll(".focus-ruler-settings__dates button")].map(n=>n.textContent)'),boundary:'Two public civil-time candidates. Labels are measured from the actual compiled renderer.'}
    assert.deepEqual(actual.ruler.fold.choices.map(text=>text.slice(0,9)),['UTC−04:00','UTC−05:00'])
    await painted(); const foldChoiceImage='ruler-new-york-fold-choices-narrow.png'; await fs.writeFile(path.join(evidence,foldChoiceImage),(await win.webContents.capturePage()).toPNG())
    actual.frames.push({image:foldChoiceImage,width:await evaluate('innerWidth'),geometry:await evaluate('document.querySelector(".focus-ruler-settings").getBoundingClientRect().toJSON()'),state:await state(),phase:'Root-T004-civil-clock-fold'})
    await click('.focus-ruler-settings__dates button:nth-child(2)'); await until('!document.querySelector(".focus-ruler-settings")&&hoverSceneState().start===Date.parse("2026-11-01T03:30Z")')
    await painted(); const foldGeometry=await axisGeometry(),foldImage='ruler-new-york-fold-labels-narrow.png'; await fs.writeFile(path.join(evidence,foldImage),(await win.webContents.capturePage()).toPNG())
    actual.frames.push({image:foldImage,width:await evaluate('innerWidth'),geometry:foldGeometry,state:await state(),phase:'Root-T004-civil-clock-fold'})
    const foldLabels=[...foldGeometry.labels].sort((a,b)=>a.rect.left-b.rect.left)
    actual.ruler.fold.geometry=foldGeometry; actual.ruler.fold.collisions=foldLabels.flatMap((label,index)=>index&&foldLabels[index-1].rect.right>label.rect.left?[{left:foldLabels[index-1],right:label,overlap:foldLabels[index-1].rect.right-label.rect.left}]:[])
    assert.ok(foldLabels.length>0); assert.equal(actual.ruler.fold.collisions.length,0,'Actual repeated-offset labels overlap; screenshot and measured bounds retained')
    assert.ok(foldGeometry.ticks.some(tick=>tick.instant===Date.parse('2026-11-01T05:30Z'))); assert.ok(foldGeometry.ticks.some(tick=>tick.instant===Date.parse('2026-11-01T06:30Z')))
    assert.deepEqual((await state()).counts,actual.ruler.after.counts); assert.equal(await evaluate('window.axisBody===document.querySelector(".recent-focus__message-body")'),true)
    actual.final = await state(); assert.deepEqual(actual.final.controls, []); assert.equal(actual.final.draft, 'Keep the original draft')
    actual.controls = actual.final.controls; actual.passed = true
  } catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally { await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
