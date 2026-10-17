const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, owned, evidence, mode = 'full', pages = ''] = process.argv.slice(2)
app.setPath('userData', path.join(owned, 'user-data'))
app.setPath('sessionData', path.join(owned, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], interactions: [],
  boundary: 'Actual App, SettingsPanel, original catalog/editors and production CSS with isolated public Preview data and trusted Electron Renderer input. No user App, live Runtime, durability, external service or installation claim.' }
let win
app.whenReady().then(async () => {
  const bounded = (promise, label) => new Promise((resolve, reject) => {
    const timer=setTimeout(()=>reject(new Error('Private Renderer observation stalled: '+label)),8000)
    promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})
  })
  const read = code => bounded(win.webContents.executeJavaScript(code),code)
  const node = selector => `document.querySelector(${JSON.stringify(selector)})`
  const until = async (code, message = code) => {
    const end = Date.now() + 8000
    while (Date.now() < end) { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
    throw new Error('Renderer did not settle: ' + message)
  }
  const settle = async () => {
    await read('document.fonts.ready')
    // A hidden capture target can suspend animation frames between captures.
    // Rendering is verified by the ensuing native geometry read/capture itself.
    await new Promise(resolve=>setTimeout(resolve,40))
  }
  const hit = async (expression, scroll = true) => {
    if (scroll) { await read(`(${expression}).scrollIntoView({behavior:'instant',block:'center',inline:'nearest'})`); await settle() }
    return read(`(() => { const n=${expression}; if(!n?.isConnected||!n.checkVisibility())throw Error('Expected a visible control'); const r=n.getBoundingClientRect(); return {label:n.getAttribute('aria-label')||n.textContent.trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),width:r.width,height:r.height,hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; })()`)
  }
  const click = async expression => {
    const target = await hit(expression)
    assert.ok(target.width > 0 && target.height > 0 && target.hit, 'The actual control has an unobstructed hit')
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:target.x,y:target.y})
    result.interactions.push({kind:'trusted-pointer',label:target.label})
    await settle()
  }
  const key = async keyCode => {
    const nativeCode = {ArrowLeft:'Left',ArrowRight:'Right',ArrowUp:'Up',ArrowDown:'Down'}[keyCode] ?? keyCode
    win.webContents.sendInputEvent({type:'keyDown',keyCode:nativeCode})
    if (keyCode==='Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:nativeCode})
    await settle()
  }
  const fill = async (selector, value) => {
    await click(node(selector)); win.webContents.selectAll(); win.webContents.insertText(value)
    await until(`${node(selector)}?.value===${JSON.stringify(value)}`)
  }
  const choose = selector => click(`${node(selector)}.closest('label')`)
  const button = (scope, label) => `Array.from(${node(scope)}.querySelectorAll('button')).find(n=>n.checkVisibility()&&n.textContent.trim()===${JSON.stringify(label)})`
  const selectValue = async (selector, value) => {
    const index = await read(`Array.from(${node(selector)}.options).findIndex(option=>option.value===${JSON.stringify(value)})`)
    assert.ok(index >= 0, 'The requested option belongs to the original control')
    // Native popup menus are not part of a hidden Renderer. Reach the original
    // select through trusted Tab input, then change its closed selection.
    for (let step=0;step<160&&!await read(`document.activeElement===${node(selector)}`);step++) await key('Tab')
    assert.equal(await read(`document.activeElement===${node(selector)}`),true,'The original select receives keyboard focus')
    const label = await read(`${node(selector)}.options[${index}].text`)
    // Chromium's native select supports trusted type-ahead without a system menu.
    // Let a prior option's search buffer expire before entering the next label.
    await new Promise(resolve=>setTimeout(resolve,1100))
    for (const character of label) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode:character})
      win.webContents.sendInputEvent({type:'char',keyCode:character})
      win.webContents.sendInputEvent({type:'keyUp',keyCode:character})
    }
    result.interactions.push({kind:'native-select-typeahead',selector,value,label})
    await until(`${node(selector)}.value===${JSON.stringify(value)}`)
  }
  const title = () => read('document.querySelector(".settings-content__header h2")?.textContent')
  const resize = async (width, height) => { win.setContentSize(width,height); await until(`innerWidth===${width}&&innerHeight===${height}`); await settle() }
  const capture = async (name, page, theme, position = 'top') => {
    await settle()
    const checks = await read(`(() => { const pane=document.querySelector('[data-settings-overview]')||document.querySelector('[data-settings-pane]:not([hidden])')||document.querySelector('.settings-search-results'); return {viewport:[innerWidth,innerHeight],horizontalOverflow:document.documentElement.scrollWidth>innerWidth,scroll: pane?{top:pane.scrollTop,height:pane.scrollHeight,viewport:pane.clientHeight}:null,innerScrolls:pane?[...pane.querySelectorAll('[data-settings-review-scroll]')].filter(n=>n.checkVisibility()).map(n=>({id:n.dataset.settingsReviewScroll,classes:n.className,top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight})):[]}; })()`)
    assert.equal(checks.horizontalOverflow,false,'Settings has no document horizontal overflow')
    const file = name + '.png'
    fs.writeFileSync(path.join(evidence,file),(await bounded(win.webContents.capturePage(undefined,{stayHidden:true}),'capture '+file)).toPNG())
    result.frames.push({file,page,theme,position,checks})
  }
  const captureSegments = async (prefix, id, color) => {
    const pane = node(`[data-settings-pane="${id}"]`)
    // A retained focused input can scroll its owner back into view after layout.
    // These are passive review frames; authored values and control identity stay intact.
    await read('document.activeElement?.blur()')
    await read(`${pane}.scrollTop=0`)
    const readers = await read(`(() => {let index=0;return [...${pane}.querySelectorAll('*')].filter(n=>n.checkVisibility()&&n.clientHeight>80&&n.scrollHeight>n.clientHeight+24&&['auto','scroll'].includes(getComputedStyle(n).overflowY)).map(n=>{n.dataset.settingsReviewScroll=String(index++);n.scrollTop=0;return {id:n.dataset.settingsReviewScroll,height:n.scrollHeight,viewport:n.clientHeight}})})()`)
    await capture(prefix,id,color)
    const dimensions = await read(`({height:${pane}.scrollHeight,viewport:${pane}.clientHeight})`)
    assert.ok(dimensions.viewport>0,'The actual page has a readable viewport')
    for (let offset=dimensions.viewport*.85,part=1;offset<dimensions.height-dimensions.viewport;offset+=dimensions.viewport*.85,part++) {
      await read(`${pane}.scrollTop=${Math.round(offset)}`)
      await capture(`${prefix}-detail-${part}`,id,color,'continuation')
    }
    if (dimensions.height>dimensions.viewport+24) {
      await read(`${pane}.scrollTop=${pane}.scrollHeight`)
      await capture(prefix+'-end',id,color,'bottom')
    }
    await read(`${pane}.scrollTop=0`)
    for (const reader of readers) {
      const scroll = `${pane}.querySelector('[data-settings-review-scroll="${reader.id}"]')`
      await read(`${scroll}.scrollIntoView({behavior:'instant',block:'nearest'})`)
      for (let offset=reader.viewport*.85,part=1;offset<reader.height;offset+=reader.viewport*.85,part++) {
        await read(`${scroll}.scrollTo({top:${Math.round(offset)},behavior:'instant'})`)
        await settle()
        const actual = await read(`({top:${scroll}.scrollTop,max:${scroll}.scrollHeight-${scroll}.clientHeight})`)
        assert.ok(Math.abs(actual.top-Math.min(Math.round(offset),actual.max))<=1,'The original inner reader reaches the requested review segment')
        await capture(`${prefix}-inner-${reader.id}-${part}`,id,color,'inner continuation')
        assert.ok(Math.abs(result.frames.at(-1).checks.innerScrolls.find(value=>value.id===reader.id).top-actual.top)<=1,'The captured inner reader has not reset its scroll position')
        if (offset>=reader.height-reader.viewport) break
      }
      await read(`${scroll}.scrollTop=0`)
    }
    await read(`${pane}.scrollTop=0`)
  }
  const theme = async value => { await read(`window.settingsHomeProbe.theme(${JSON.stringify(value)})`); await settle() }
  let catalog
  const nav = async id => {
    const entry = id === 'overview' ? {id,title:'Overview'} : catalog.find(item=>item.id===id)
    assert.ok(entry,'Navigation target comes from the actual catalog')
    if (await read('document.querySelector(".settings-section-picker").checkVisibility()')) {
      await click(node('.settings-section-picker'))
      await until('!!document.querySelector("[role=menuitemradio]")')
      await click(`Array.from(document.querySelectorAll('[role=menuitemradio]')).find(n=>n.textContent.trim()===${JSON.stringify(entry.title)})`)
    } else {
      if (entry.group && await read(`${node(`[data-settings-group-toggle="${entry.group}"]`)}?.getAttribute('aria-expanded')==='false'`))
        await click(node(`[data-settings-group-toggle="${entry.group}"]`))
      await click(node(`nav[aria-label="Settings sections"] [data-settings-target="${id}"]`))
    }
    await until(id === 'overview' ? '!!document.querySelector("[data-settings-overview]")' : `!!document.querySelector('[data-settings-pane="${id}"]:not([hidden])')`)
    assert.equal(await title(),entry.title,'The original navigation reaches its original editor')
  }
  const providerScroll = async () => {
    await nav('agents')
    const list = node('[role="listbox"][aria-label="Providers"]')
    const before = await read(`({left:${list}.scrollLeft,selected:${list}.querySelector('[aria-selected="true"]').dataset.resourceRow})`)
    await click(node('[aria-label="More providers"]'))
    const after = await read(`({left:${list}.scrollLeft,selected:${list}.querySelector('[aria-selected="true"]').dataset.resourceRow})`)
    assert.ok(after.left > before.left, 'Provider forward control reveals more entries')
    assert.equal(after.selected,before.selected,'Scrolling does not select or change an Executor')
    result.interactions.push({kind:'provider-scroll',before,after})
    await capture('providers-more','agents','dark','provider navigation')
    await click(node('[aria-label="Previous providers"]'))
    assert.ok(await read(`${list}.scrollLeft`) < after.left,'Provider previous control returns toward the start')
  }
  const takeoverReachability = async () => {
    await nav('browser-agent-control')
    const advanced = '.browser-agent-control__advanced'
    if (!await read(`${node(advanced)}.open`)) await click(node(advanced+' > summary'))
    const range = '[data-settings-pane="browser-agent-control"] [data-settings-field="pointerDurationMs"] input'
    for (const [width,height,label] of [[500,840,'compact'],[900,540,'short']]) {
      await resize(width,height)
      const target = await hit(node(range))
      const geometry = await read(`(() => {const control=${node(range)},preview=${node('.browser-agent-preview')};return {control:control.getBoundingClientRect().toJSON(),preview:preview.getBoundingClientRect().toJSON(),position:getComputedStyle(preview).position}})()`)
      const overlap = Math.min(geometry.control.right,geometry.preview.right)>Math.max(geometry.control.left,geometry.preview.left)&&Math.min(geometry.control.bottom,geometry.preview.bottom)>Math.max(geometry.control.top,geometry.preview.top)
      result.interactions.push({kind:'takeover-control-reachability',label,geometry,overlap,hit:target.hit})
      assert.equal(overlap,false,'Compact takeover preview does not cover the original fine tuning control')
      assert.ok(target.hit,'Compact takeover preview leaves the original fine tuning control unobstructed')
      await click(node(range)); await key('ArrowRight')
      assert.equal(await read(`document.activeElement===${node(range)}`),true,'The original fine tuning range owns keyboard focus')
      await capture('takeover-'+label+'-fine-tuning','browser-agent-control','dark','focused lower control')
    }
    await resize(1440,940)
  }
  const agentEditorGeometry = async label => {
    const editor = '[data-settings-pane="agents"] .settings-agent-templates .settings-resource-editor'
    const textarea = editor+' [aria-label="Executor arguments"]'
    await hit(node(textarea))
    const geometry = await read(`(() => {const e=${node(editor)},t=${node(textarea)},b=[...e.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')?.startsWith('Reset ')&&n.checkVisibility());return {editor:e.getBoundingClientRect().toJSON(),textarea:t.getBoundingClientRect().toJSON(),reset:b?.getBoundingClientRect().toJSON(),padding:parseFloat(getComputedStyle(e).paddingRight)}})()`)
    assert.ok(geometry.padding>0,'Executor detail reserves room for the native scrollbar')
    assert.ok(geometry.editor.right-geometry.textarea.right>=geometry.padding-1,'Executor arguments stay inside the reserved right inset')
    assert.ok(geometry.reset&&geometry.editor.right-geometry.reset.right>=geometry.padding-1,'Avatar Reset stays inside the reserved right inset')
    const reset = `${node(editor)}.querySelector('button[aria-label^="Reset "]')`
    assert.ok((await hit(reset)).hit,'The visible original avatar Reset button has an unobstructed hit')
    result.interactions.push({kind:'executor-detail-inset',label,geometry})
  }
  const agentEditorBottom = async color => {
    const editor = node('[data-settings-pane="agents"] .settings-agent-templates .settings-resource-editor')
    await read(`document.activeElement?.blur();${editor}.scrollTo({top:${editor}.scrollHeight,behavior:'instant'})`)
    await settle()
    const last = `${editor}.querySelector('.settings-executor-remove button')`
    const geometry = await read(`(() => {const e=${editor},b=${last};return {top:e.scrollTop,max:e.scrollHeight-e.clientHeight,editor:e.getBoundingClientRect().toJSON(),last:b.getBoundingClientRect().toJSON()}})()`)
    assert.ok(geometry.max>0&&geometry.top>0,'Compact Executor detail actually scrolls beyond its first segment')
    assert.ok(Math.abs(geometry.top-geometry.max)<=1,'Compact Executor detail reaches its actual bottom')
    assert.ok(geometry.last.top>=geometry.editor.top&&geometry.last.bottom<=geometry.editor.bottom+1,'The lower Executor action is fully inside its original reader')
    assert.ok((await hit(last,false)).hit,'The lower Executor action is visible at the actual bottom')
    result.interactions.push({kind:'executor-detail-bottom',theme:color,geometry})
    await capture('page-agents-compact-detail-bottom-'+color,'agents',color,'verified original editor bottom')
    assert.ok(await read(`${editor}.scrollTop`)>0,'Bottom capture retains the measured editor scroll')
  }
  const pageInteractions = async id => {
    const pane = `[data-settings-pane="${id}"]`
    const saves = await read('window.settingsHomeProbe.saves.length')
    const before = result.interactions.length
    if (id==='profile') {
      await fill('[aria-label="Display name"]','Alex')
      await fill('[aria-label="About you and how you work"]','Prefer concise decisions with one concrete example.')
      await nav('overview'); await nav(id)
      assert.equal(await read(`${node('[aria-label="Display name"]')}.value`),'Alex')
      await capture('profile-draft',id,'dark','edited identity')
      await choose(pane+' [data-settings-field="profile-sharing"] input')
    } else if (id==='appearance') {
      const choice = `${node(pane)}.querySelector('[aria-label="Workspace theme"] input:not(:checked)')`
      const value = await read(`(${choice}).value`)
      await click(`(${choice}).closest('label')`)
      assert.equal(await read(`${node('[data-theme-description]')}.dataset.themeDescription`),value)
      await nav('overview'); await nav(id)
      assert.equal(await read(`${node('[data-theme-description]')}.dataset.themeDescription`),value,'Theme choice survives navigation')
      await click(node('.settings-appearance__help > summary'))
      await capture('appearance-theme-details',id,'dark','theme comparison and scope')
      await click(node('.settings-appearance__help > summary'))
    } else if (id==='notifications') {
      await click(node('[aria-label="Notification dwell"]')); await key('Home')
      await until(`${node('[aria-label="Notification preview"]')}.dataset.notificationMode==='off'`)
      assert.match(await read(`${node('[aria-label="Notification preview"]')}.textContent`),/Unsaved preview/)
      assert.equal(await read(`${node('.notification-sound-toggle input')}.disabled`),true)
      await capture('notifications-off',id,'dark','unsaved off preview')
      await key('ArrowRight')
      await until(`${node('[aria-label="Notification preview"]')}.dataset.notificationMode!=='off'`)
      await capture('notifications-brief',id,'dark','unsaved dwell preview')
    } else if (id==='continuity') {
      const windowInput = '[aria-label="Automatic recovery window"]', unit = '[aria-label="Automatic recovery window unit"]'
      const save = pane+' [data-settings-save-bar] button'
      assert.equal(await read(`${node(windowInput)}.value`),'24')
      assert.equal(await read(`${node(unit)}.value`),'hours')
      assert.equal(await read(`${node(save)}.disabled`),true,'The initial recovery preference is saved')
      const choices=[]
      for (const [choice,expected] of [['minutes','1440'],['seconds','86400'],['hours','24']]) {
        await selectValue(unit,choice)
        assert.equal(await read(`${node(windowInput)}.value`),expected,'Changing duration units preserves the exact recovery window')
        assert.equal(await read(`${node(save)}.disabled`),true,'Unit presentation alone does not dirty the recovery draft')
        choices.push({unit:choice,value:expected,dirty:false})
      }
      result.interactions.push({kind:'recovery-window-units',choices})
      await capture('continuity-window-units',id,'dark','exact recovery window without a dirty draft')
      await fill('[aria-label="Search settings"]','Additional retries')
      await click(node('[data-settings-search-result="continuity:retryMaxAttempts"]'))
      assert.equal(await read(`${node('[data-continuity-retry-settings]')}.open`),true,'Exact search opens the original advanced group')
      await fill('[aria-label="Additional retries"]','7')
      await click(node('[aria-label="Clear settings search"]'))
      assert.equal(await read(`${node('[aria-label="Additional retries"]')}.value`),'7')
      await read(`window.retryDraft=${node('[aria-label="Additional retries"]')}`)
      await click(node('[data-continuity-retry-settings] > summary')); await click(node('[data-continuity-retry-settings] > summary'))
      assert.equal(await read(`${node('[aria-label="Additional retries"]')}===window.retryDraft&&window.retryDraft.value==='7'`),true)
      await capture('continuity-retry-search',id,'dark','searched advanced draft')
    } else if (id==='browser') {
      const automation = pane+' .browser-automation-toggle input', memory = pane+' .browser-resources__policy input'
      const original = await read(`({automation:${node(automation)}.checked,memory:${node(memory)}.checked,summary:${node(pane+' [data-settings-field="agent-automation"] header')}.textContent})`)
      await choose(automation); await choose(memory)
      await nav('overview'); await nav(id)
      assert.equal(await read(`${node(automation)}.checked`),!original.automation)
      assert.equal(await read(`${node(memory)}.checked`),!original.memory)
      assert.equal(await read(`${node(pane+' [data-settings-field="agent-automation"] header')}.textContent`),original.summary)
      await fill(pane+' [aria-label="Find Browser resources"]','review')
      await selectValue(pane+' [aria-label="Browser resource state"]','unknown')
      await capture('browser-local-drafts',id,'dark','independent drafts and resource filter')
      await fill(pane+' [aria-label="Find Browser resources"]',''); await selectValue(pane+' [aria-label="Browser resource state"]','all')
    } else if (id==='browser-agent-control') {
      await choose(pane+' [data-settings-field="showDiscussion"] input')
      const states = await read(`Array.from(${node('[aria-label="Simulation state"]')}.options).map(option=>option.value)`)
      for (const state of states) {
        await selectValue('[aria-label="Simulation state"]',state)
        await capture('takeover-state-'+state,id,'dark','available simulation state')
      }
      result.interactions.push({kind:'takeover-available-states',states})
      await selectValue('[aria-label="Simulation state"]','running')
      await takeoverReachability()
    } else if (id==='general') {
      const field = pane+' [data-settings-field="copy-paths"] input'
      const original = await read(`${node(field)}.checked`)
      await choose(field)
      for (const [label,target] of [['Open Execution','continuity'],['Open Hosts','hosts']]) {
        await click(button(pane,label)); await until(`!!${node(`[data-settings-pane="${target}"]:not([hidden])`)}`)
        await nav(id); assert.equal(await read(`${node(field)}.checked`),!original)
      }
      await capture('general-path-draft',id,'dark','original preference and destination actions')
    } else if (id==='keyboard-shortcuts') {
      await click(button(pane,'Workbench'))
      await fill(pane+' [aria-label="Find a command or shortcut"]','tab')
      await capture('shortcuts-workbench-filter',id,'dark','context and local search')
      await click(node(pane+' [aria-label="Clear shortcut search"]'))
      assert.equal(await read(`document.activeElement===${node(pane+' [aria-label="Find a command or shortcut"]')}`),true)
      assert.deepEqual(await read(`Array.from(${node(pane)}.querySelectorAll('[data-shortcut-group]')).map(n=>n.dataset.shortcutGroup)`),['workbench'])
      await click(button(pane,'All contexts'))
      assert.ok(await read(`${node(pane)}.querySelectorAll('[data-shortcut-group]').length`)>1)
    } else if (id==='message-tool') {
      const radio = pane+' [data-settings-field="initial-layout"] input[value="two-line"]'
      await choose(radio)
      assert.equal(await read(`${node(radio)}.checked`),true)
      await key('ArrowLeft')
      assert.equal(await read(`${node(pane+' [data-settings-field="initial-layout"] input[value="one-line"]')}.checked`),true,'Native radio keyboard input changes the original layout draft')
      await fill(pane+' [aria-label="Commands prefix"]','!')
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-settings-save-bar]').length`),2)
      assert.equal(await read(`${node(pane+' [data-settings-field="message-shortcuts"]')}.querySelector('[aria-label="Shortcut context"]')===null`),true)
      await capture('input-independent-drafts',id,'dark','layout and shortcut scopes')
    } else if (id==='a2a') {
      const radio = pane+' input[value="notify"]'
      await choose(radio); await click(button(pane,'Open Notifications'))
      await until(`!!${node('[data-settings-pane="notifications"]:not([hidden])')}`)
      await nav(id); assert.equal(await read(`${node(radio)}.checked`),true)
      await capture('a2a-notify-draft',id,'dark','retained notification policy draft')
    } else if (id==='automation') {
      for (const [fieldId,query,field,disclosure] of [['activeInterruptionFallback','Use active state when interruption detection is unsupported','[aria-label="Use active state when interruption detection is unsupported"]','.continuation-detection'],['checkInSilenceMs','Minimum silence before follow-up','[aria-label="Minimum silence before follow-up"]','[data-automation-quiet-defaults]']]) {
        await fill('[aria-label="Search settings"]',query)
        await click(node(`[data-settings-search-result="automation:${fieldId}"]`))
        assert.equal(await read(`${node(disclosure)}.open`),true,'Search reveals the original policy disclosure')
        await click(node('[aria-label="Clear settings search"]'))
        if (fieldId==='activeInterruptionFallback') await choose(pane+' '+field)
        else {
          await fill(pane+' '+field,'21')
          await click(node(disclosure+' > summary')); await click(node(disclosure+' > summary'))
          assert.equal(await read(`${node(pane+' '+field)}.value`),'21')
        }
      }
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-settings-save-bar]').length`),2)
      await capture('automation-quiet-draft',id,'dark','separate policy owners and advanced draft')
    } else if (id==='amux-protocols') {
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-protocol-example]').length`),0)
      await click(button(pane,'View first example'))
      await until(`!!${node(pane+' [data-protocol-example]')}`)
      assert.equal(await read(`document.activeElement===${node(pane+' .amux-protocols__row > summary')}`),true)
      await click(node(pane+' .amux-protocols__wire > summary'))
      assert.ok(await read(`${node(pane+' .amux-protocols__wire pre')}.textContent.length`)>0)
      await capture('protocol-original-wire',id,'dark','rendered example and original wire')
    } else if (id==='space') {
      await choose(pane+' input[name="space-rail-density"][value="dense"]')
      const show = pane+' [aria-label="Show commit time"]'
      if (await read(`${node(show)}.checked`)) await choose(show)
      assert.equal(await read(`${node(pane+' [aria-label="Git History display preview"]')}.querySelector('time')===null`),true)
      await click(node('[data-workflows-manage="projects"]')); await until(`!!${node('[data-settings-pane="hosts"]:not([hidden])')}`)
      await nav(id); assert.equal(await read(`${node(show)}.checked`),false)
      await capture('space-dense-draft',id,'dark','density and recorded-time preview')
    } else if (id==='focus') {
      await choose(pane+' input[name="focus-reply-lines"][value="3"]')
      await click(button(pane+' [aria-label="Focus example view"]','Agent preview'))
      await click(node(pane+' .focus-settings-preview__try'))
      await until(`!!${node(pane+' [aria-label="Example Agent reading"]')}`)
      await capture('focus-reading-example',id,'dark','original simulated reader')
      await choose(pane+' input[name="focus-link-destination"][value="tab"]')
      await click(node(pane+' .focus-settings-preview__link'))
      assert.equal(await read(`${node(pane+' .focus-settings-preview__links')}.dataset.destination`),'tab')
      assert.equal(await read(`${node(pane+' .focus-settings-preview__links')}.dataset.open`),'true')
      await capture('focus-link-example',id,'dark','original link destination draft')
    } else if (id==='goals') {
      await click(`${node(pane+' .settings-goals-view [data-view="board"]')}.closest('label')`)
      await choose(pane+' [aria-label="Show finished goals by default"]')
      await choose(pane+' [aria-label="Collapse common actions"]')
      assert.equal(await read(`${node(pane+' .settings-goals-view [data-view="board"]')}.closest('label').querySelector('input').checked`),true)
      await capture('goals-view-draft',id,'dark','starting view and independent choices')
    } else if (id==='notes') {
      await fill(pane+' [aria-label="Notes body text size"]','20')
      await read(`window.notesDraft=${node(pane+' [aria-label="Notes body text size"]')}`)
      await click(`Array.from(${node(pane+' [data-settings-field="notes-width"]')}.querySelectorAll('label')).find(n=>n.querySelector('strong')?.textContent==='Wide')`)
      assert.equal(await read(`getComputedStyle(${node(pane+' [aria-label="Notes reading preview"] > div')}).fontSize`),'20px')
      await nav('overview'); await nav(id)
      assert.equal(await read(`${node(pane+' [aria-label="Notes body text size"]')}===window.notesDraft`),true)
      assert.equal(await read(`${node(pane+' [aria-label="Notes reading preview"]')}.dataset.width`),'wide')
      await capture('recall-reading-draft',id,'dark','original reading preview')
    } else if (id==='survey') {
      const input = pane+' [aria-label="Start page title"]'
      await fill(input,'Review draft')
      const history = pane+' [aria-label="Show recent input cards"]'
      if (await read(`${node(history)}.checked`)) await choose(history)
      assert.equal(await read(`${node(pane+' [aria-label="Start page draft preview"] h3')}.textContent`),'Review draft')
      assert.equal(await read(`${node(pane)}.querySelector('.settings-survey__history')===null`),true)
      await capture('survey-text-draft',id,'dark','text and history preview')
    } else if (id==='mote') {
      await click(node(pane+' [aria-label="32px avatar"]'))
      assert.equal(await read(`${node(pane+' [aria-label="Avatar size"]')}.value`),'32')
      assert.equal(await read(`${node(pane+' [aria-label="Avatar size preview"] > span')}.getBoundingClientRect().width`),32)
      await click(node(pane+' [aria-label="Avatar size"]')); await key('Home'); await key('ArrowRight')
      const value = await read(`${node(pane+' [aria-label="Avatar size"]')}.value`)
      assert.equal(await read(`${node(pane+' [aria-label="Avatar size preview"] > span')}.getBoundingClientRect().width`),Number(value))
      await capture('mote-avatar-draft',id,'dark','single original avatar draft')
    } else if (id==='hosts') {
      const nodes = await read(`Array.from(${node(pane)}.querySelectorAll('[data-host-node]')).map(n=>n.dataset.hostNode)`)
      assert.ok(nodes.length>1,'The fixture supplies distinct original Host identities')
      for (const hostId of nodes.slice(0,2)) {
        await click(node(pane+` [data-host-node="${hostId}"]`))
        assert.equal(await read(`${node(pane+' [data-resource-editor]')}.dataset.resourceEditor`),hostId)
      }
      await click(node(pane+' [aria-label="List"]'))
      const hostId=nodes[1], branch=pane+` [data-host-disclosure="${hostId}"]`
      if (!await read(`${node(branch)}.open`)) await click(node(branch+' > summary'))
      await click(node(branch+' [data-host-panel="connection"]'))
      await fill(pane+' [data-host-name]','Review host draft')
      await click(node(pane+' .remote-detail-tabs [data-host-panel="overview"]'))
      await click(node(pane+' .remote-detail-tabs [data-host-panel="connection"]'))
      assert.equal(await read(`${node(pane+' [data-host-name]')}.value`),'Review host draft')
      await click(node(pane+' .host-edit-disclosure > summary'))
      await capture('hosts-connection-draft',id,'dark','original host and connection options')
    } else if (id==='mobile') {
      const issue=pane+' .device-management__read-issue details'
      await until(`!!${node(issue)}`,'The isolated owner reports its actual device observation boundary')
      await click(node(issue+' > summary'))
      assert.ok(await read(`${node(issue+' p')}.textContent.length`)>0)
      await click(node(pane+' [data-device-records] > summary'))
      await capture('mobile-observation-details',id,'dark','full observation and original device records')
    } else if (id==='inapp-conversation') {
      for (const [label,target] of [['Open User Input','message-tool'],['Open Appearance','appearance'],['Open Keyboard shortcuts','keyboard-shortcuts'],['Open amux Protocols','amux-protocols']]) {
        await click(button(pane,label)); await until(`!!${node(`[data-settings-pane="${target}"]:not([hidden])`)}`)
        result.interactions.push({kind:'original-settings-destination',from:id,to:target})
        await nav(id)
      }
    } else if (id==='agents') { await providerScroll(); await agentEditorGeometry('wide') }
    else if (id==='prompts') {
      await fill('.prompt-editor__name input','Review with care')
      await click(node('.prompt-editor__usage > summary'))
      await captureSegments('prompts-usage',id,'dark')
      await click(node('.prompt-editor__usage > summary'))
    } else if (id==='toolkit') {
      await click(node('[data-tool-id="performance"]'))
      await capture('toolkit-performance',id,'dark','built-in detail')
      await click(node('.toolkit-workbench__toolbar .toolkit-workbench__create'))
      await until(`!!${node(pane+' .toolkit-editor__script .monaco-editor :is(textarea.inputarea,.native-edit-context)')}&&${node(pane+' .toolkit-editor__script .monaco-editor .view-lines')}?.textContent.trim().length>0`,'The original Monaco model and rendered script are ready')
      assert.ok((await hit(node(pane+' .toolkit-editor__script .monaco-editor'))).hit,'The original script editor is visible and unobstructed')
      result.interactions.push({kind:'toolkit-editor-ready',renderedLines:await read(`${node(pane+' .toolkit-editor__script .monaco-editor .view-lines')}.textContent`)})
      await capture('toolkit-new-draft',id,'dark','new custom draft')
    }
    assert.equal(await read('window.settingsHomeProbe.saves.length'),saves,'Page interaction does not implicitly save configuration')
    if (id!=='lark') assert.ok(result.interactions.length>before,'Every reviewed page consumes actual input: '+id)
    result.interactions.push({kind:'page-interactions-complete',page:id,actions:result.interactions.length-before,implicitSaves:0})
  }
  const disclosureGeometry = async () => {
    await nav('agents')
    for (const state of ['collapsed','expanded']) {
      await click(node('[data-settings-group-toggle="preferences"]'))
      await settle()
      const geometry = await read(`(() => {const target=document.querySelector('nav [data-settings-target="agents"]').getBoundingClientRect(),surface=document.querySelector('nav [data-liquid-selection="agents"]').getBoundingClientRect();return {target:target.toJSON(),surface:surface.toJSON()}})()`)
      for (const key of ['x','y','width','height']) assert.ok(Math.abs(geometry.target[key]-geometry.surface[key])<1,'Current selection surface follows disclosure geometry: '+key)
      result.interactions.push({kind:'disclosure-selection-geometry',state,geometry})
      await capture('sidebar-'+state,'agents','dark')
    }
    await nav('overview')
  }
  try {
    win = new BrowserWindow({width:1440,height:940,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
    result.console = []
    win.webContents.on('console-message', details => result.console.push({level:details.level,message:details.message}))
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await until('window.settingsHomeProbe?.ready && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    catalog = await read('window.settingsHomeProbe.catalog')
    assert.ok(catalog.length > 0,'The actual page inventory is nonempty')
    result.catalog = catalog
    const requested = pages ? pages.split(',') : null
    const available = ['overview', ...catalog.map(entry=>entry.id)]
    const selected = requested ?? available
    assert.ok(selected.length > 0 && selected.every(id=>available.includes(id)), 'Every selected page exists in the actual catalog')
    assert.equal(new Set(selected).size, selected.length, 'No duplicate page selection')
    result.scope = {requested, resolved:available.filter(id=>selected.includes(id))}
    const reviewCatalog = catalog.filter(entry=>selected.includes(entry.id))

    result.original = await read('window.settingsHomeProbe.beginSurface()')
    assert.ok(result.original.tabs>0&&result.original.sessions>0&&result.original.layouts>0)
    await click(node('.window-status-bar [aria-label="Settings"]'))
    await until('!!document.querySelector("[data-settings-overview]")')
    assert.equal(await title(),'Overview','Ordinary App Settings opens Overview')
    assert.equal(await read('document.querySelectorAll("[data-settings-pane]").length'),0,'Home does not mount configuration editors')
    assert.deepEqual(await read('Array.from(document.querySelectorAll("[data-settings-directory] [data-settings-section]")).map(n=>n.dataset.settingsSection)'),catalog.map(item=>item.id))
    if (mode==='navigation') { await disclosureGeometry(); result.passed=true; return }
    if (mode==='provider-scroll') { await providerScroll(); result.passed=true; return }
    if (mode==='takeover-scroll') { await theme('dark'); await takeoverReachability(); result.passed=true; return }
    for (const [width,height,label] of [[1440,940,'wide'],[900,620,'short'],[500,840,'compact'],[320,700,'narrow']]) {
      await resize(width,height)
      for (const mode of ['dark','light']) {
        await theme(mode)
        await read('document.querySelector("[data-settings-overview]").scrollTop=0')
        await capture(`home-${label}-${mode}`,'overview',mode)
        const first = await hit(node('[data-settings-shortcut]'),false)
        const footer = await read('document.querySelector(".window-status-bar").getBoundingClientRect().toJSON()')
        assert.ok(first.y>0&&first.y<footer.top,'A priority entry is immediately reachable')
        assert.ok((await hit(node('[aria-label="Close settings"]'))).hit,'Close remains reachable')
        assert.ok((await hit(node('[aria-label="Search settings"]'))).hit,'Search remains reachable')
      }
    }
    await read(`window.originalSettingsArt=${node('.settings-overview__art')}.src;${node('.settings-overview__art')}.src='data:image/png;base64,invalid'`)
    await until(`${node('.settings-overview__art')}.hidden===true`)
    assert.deepEqual(await read('Array.from(document.querySelectorAll("[data-settings-directory] [data-settings-section]")).map(n=>n.dataset.settingsSection)'),catalog.map(item=>item.id),'Missing artwork retains every real destination')
    await capture('home-missing-art','overview','light')
    await read(`${node('.settings-overview__art')}.src=window.originalSettingsArt;${node('.settings-overview__art')}.hidden=false`)
    await resize(1440,940); await theme('dark')
    const home = node('[data-settings-overview]')
    const homeHeight = await read(`({height:${home}.scrollHeight,viewport:${home}.clientHeight})`)
    for (let offset=homeHeight.viewport*.85,part=1;offset<homeHeight.height;offset+=homeHeight.viewport*.85,part++) {
      await read(`${home}.scrollTop=${Math.round(offset)}`)
      await capture(`home-directory-${part}`,'overview','dark','continuation')
      if (offset>=homeHeight.height-homeHeight.viewport) break
    }
    await read(`${home}.scrollTop=0`)
    await click(node('[aria-label="Search settings"]'))
    let focusedShortcut
    for (let step=0;step<60;step++) {
      await key('Tab')
      focusedShortcut=await read('document.activeElement?.dataset.settingsShortcut')
      if (focusedShortcut) break
    }
    assert.ok(focusedShortcut,'Keyboard Tab reaches a priority entry')
    await capture('home-keyboard-focus','overview','dark')
    await key('Enter')
    await until(`!!document.querySelector('[data-settings-pane="${focusedShortcut}"]:not([hidden])')`)
    assert.equal(await title(),catalog.find(entry=>entry.id===focusedShortcut).title,'Keyboard Enter opens the original priority destination')
    result.keyboard={shortcut:focusedShortcut,tab:true,enter:true}
    await resize(320,700)
    await nav('appearance')
    await fill('[aria-label="Terminal font size in pixels"]','19')
    await read(`window.originalSettingsFont=${node('[aria-label="Terminal font size in pixels"]')}`)
    await nav('overview'); await nav('appearance')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}===window.originalSettingsFont`),true,'Visited Appearance keeps the original draft input')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}.value`),'19')
    await fill('[aria-label="Search settings"]','font')
    await until('document.querySelector(".settings-content__header h2")?.textContent==="Search results"')
    await capture('search-narrow','search','dark')
    await click(node('[data-settings-search-section="appearance"]'))
    await key('Escape')
    assert.equal(await read(`${node('[aria-label="Search settings"]')}.value`),'')
    assert.equal(await read(`${node('[aria-label="Terminal font size in pixels"]')}.value`),'19','Clearing search retains the original draft')
    assert.equal(await read(`document.activeElement===${node('[aria-label="Search settings"]')}`),true)
    assert.equal(await read('window.settingsHomeProbe.saves.length'),0,'Navigation does not save configuration')
    await capture('appearance-narrow-draft','appearance','dark')
    await resize(1440,940)
    await theme('dark'); await disclosureGeometry()
    for (const entry of reviewCatalog) {
      await nav(entry.id)
      const pane = node(`[data-settings-pane="${entry.id}"]`)
      await read(`${pane}.scrollTop=0`)
      for (const mode of ['dark','light']) { await theme(mode); await capture(`page-${entry.id}-${mode}`,entry.id,mode) }
      // Read every vertical segment of long pages for independent complete-page review.
      await theme('dark')
      const dimensions = await read(`({height:${pane}.scrollHeight,viewport:${pane}.clientHeight})`)
      for (let offset=dimensions.viewport*.85,part=1;offset<dimensions.height-dimensions.viewport;offset+=dimensions.viewport*.85,part++) {
        await read(`${pane}.scrollTop=${Math.round(offset)}`)
        await capture(`page-${entry.id}-detail-${part}`,entry.id,'dark','continuation')
      }
      if (dimensions.height>dimensions.viewport+24) {
        await read(`${pane}.scrollTop=${pane}.scrollHeight`)
        await capture(`page-${entry.id}-end`,entry.id,'dark','bottom')
      }
      await read(`${pane}.scrollTop=0`)
      const innerReaders = await read(`(() => {let index=0;return [...${pane}.querySelectorAll('*')].filter(n=>n.checkVisibility()&&n.clientHeight>80&&n.scrollHeight>n.clientHeight+24&&['auto','scroll'].includes(getComputedStyle(n).overflowY)).map(n=>{n.dataset.settingsReviewScroll=String(index++);return {id:n.dataset.settingsReviewScroll,height:n.scrollHeight,viewport:n.clientHeight}})})()`)
      for (const reader of innerReaders) {
        const scroll = `${pane}.querySelector('[data-settings-review-scroll="${reader.id}"]')`
        for (let offset=reader.viewport*.85,part=1;offset<reader.height;offset+=reader.viewport*.85,part++) {
          await read(`${scroll}.scrollTop=${Math.round(offset)}`)
          await capture(`page-${entry.id}-inner-${reader.id}-${part}`,entry.id,'dark','inner continuation')
          if (offset>=reader.height-reader.viewport) break
        }
        await read(`${scroll}.scrollTop=0`)
      }
    }
    await theme('dark')
    for (const {id} of reviewCatalog) { await nav(id); await pageInteractions(id) }
    for (const {id} of reviewCatalog) {
      await resize(500,840); await nav(id)
      for (const color of ['dark','light']) {
        await theme(color)
        await captureSegments(`page-${id}-compact-${color}`,id,color)
        if (id==='agents') {
          const row = '[data-settings-pane="agents"] .settings-agent-templates [data-resource-row="codex"]'
          if (await read(`${node(row)}?.checkVisibility()`)) await click(node(row))
          await until('document.querySelector("[data-resource-editor=codex]")?.checkVisibility()')
          await agentEditorGeometry('compact-'+color)
          await captureSegments('page-agents-compact-detail-'+color,id,color)
          await agentEditorBottom(color)
        } else if (id==='hosts') {
          const leaf = `Array.from(${node('[data-settings-pane="hosts"]')}.querySelectorAll('.settings-host-library [data-host-panel="connection"]')).find(n=>n.checkVisibility())`
          if (await read(`!!(${leaf})`)) await click(leaf)
          await captureSegments('page-hosts-compact-detail-'+color,id,color)
          await click(node('[data-settings-pane="hosts"] .settings-resource-back'))
          assert.equal(await read(`${node('[data-settings-pane="hosts"] [data-resource-view]')}.dataset.resourceView`),'library')
          assert.equal(await read(`document.activeElement?.dataset.hostPanel`),'connection')
          await capture('page-hosts-compact-return-'+color,id,color,'return to original Host')
        } else if (id==='prompts') {
          const row = `Array.from(${node('[data-settings-pane="prompts"]')}.querySelectorAll('[data-prompt-id]')).find(n=>n.checkVisibility())`
          if (await read(`!!(${row})`)) await click(row)
          await until(`${node('.prompt-editor__name input')}?.checkVisibility()`)
          const original = await read(`${node('.prompt-editor__name input')}.value`)
          await fill('.prompt-editor__name input','Compact review draft')
          await captureSegments('page-prompts-compact-editor-'+color,id,color)
          await fill('.prompt-editor__name input',original)
          await click(node('[data-settings-pane="prompts"] .prompt-editor__back'))
          await capture('page-prompts-compact-return-'+color,id,color,'return to original prompt list')
        }
      }
    }
    await resize(1440,940); await nav('overview'); await theme('dark')
    await click(node('[aria-label="Close settings"]'))
    const avatar = 'Array.from(document.querySelectorAll(".agent-avatar[data-executor-id]")).find(n=>n.checkVisibility())'
    const executorId = await read(`${avatar}?.dataset.executorId`)
    assert.ok(executorId,'The original workbench has an exact Executor identity')
    const target = await hit(avatar)
    win.webContents.sendInputEvent({type:'mouseMove',x:target.x,y:target.y})
    await until('!!document.querySelector(".agent-identity-popover header button")')
    await click(node('.agent-identity-popover header button'))
    await until('!!document.querySelector("[data-settings-pane=agents]:not([hidden])")')
    assert.equal(await title(),'Agents','Actual Avatar direct entry bypasses Home')
    assert.equal(await read(`${node(`[data-resource-editor="${executorId}"]`)}?.isConnected`),true,'The original exact Executor editor is reached')
    result.exactTarget = {executorId,caller:'AgentAvatar -> SettingsNavigation -> App -> SettingsPanel -> AgentSettingsPane'}
    await capture('executor-direct-entry','agents','dark')
    await click(node('[aria-label="Close settings"]'))
    const preserved = await read('window.settingsHomeProbe.surface()')
    result.preserved = preserved
    assert.ok(preserved.references.length>0)
    assert.equal(preserved.exact,true,'Settings preserves the original work surface')
    result.events = await read('window.settingsHomeProbe.events')
    assert.ok(result.events.length>0)
    assert.ok(result.events.some(event=>event.type==='click'&&event.trusted),'The actual App receives trusted pointer input')
    assert.ok(result.events.some(event=>event.type==='input'&&event.trusted),'The actual editor receives trusted text input')
    assert.deepEqual(await read('window.settingsHomeProbe.errors'),[])
    result.passed = true
  } catch (error) {
    result.failure = {name:error.name,message:error.message,stack:error.stack}
    if (win&&!win.isDestroyed()) {
      try { fs.writeFileSync(path.join(evidence,'failure.png'),(await bounded(win.webContents.capturePage(undefined,{stayHidden:true}),'failure capture')).toPNG()) } catch {}
      result.diagnostic = await read('({errors:window.settingsHomeProbe?.errors,text:document.querySelector(".settings-page")?.innerText})').catch(String)
      result.events = await read('window.settingsHomeProbe?.events').catch(String)
    }
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2))
    win?.destroy(); app.exit(result.passed?0:1)
  }
})
