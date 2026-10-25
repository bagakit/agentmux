const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, owned, evidence, mode = 'full', pages = ''] = process.argv.slice(2)
app.setPath('userData', path.join(owned, 'user-data'))
app.setPath('sessionData', path.join(owned, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], interactions: [],
  boundary: 'Actual App, SettingsPanel, original catalog/editors and production CSS with isolated public Preview data and trusted Electron Renderer input. No user App, live Runtime, durability, external service or installation claim.' }
// A diagnostic journal preserves completed original inputs if the OS blocks a
// later native capture. It never represents a successful whole-run receipt.
const checkpoint = stage => {
  const target = path.join(evidence, 'render-progress.json')
  fs.writeFileSync(target + '.pending', JSON.stringify({...result, passed:false, stage, incomplete:true}, null, 2))
  fs.renameSync(target + '.pending', target)
}
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
    if (scroll) {
      // Scroll the real readers only. scrollIntoView also moves overflow:hidden
      // App ancestors and can manufacture a shifted frame unrelated to this click.
      await read(`(() => {const n=${expression};for(let p=n?.parentElement;p&&p!==document.body;p=p.parentElement){const style=getComputedStyle(p);if(!['auto','scroll'].includes(style.overflowY)||p.scrollHeight<=p.clientHeight)continue;const r=n.getBoundingClientRect(),b=p.getBoundingClientRect();p.scrollTop+=(r.top+r.bottom-b.top-b.bottom)/2;}})()`)
      await settle()
    }
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
  const chooseImageFile = async selector => {
    // Chromium's file-input protocol supplies a real private fixture file; the
    // production change handler and FileReader perform the actual read.
    const alreadyAttached = win.webContents.debugger.isAttached()
    if (!alreadyAttached) win.webContents.debugger.attach('1.3')
    try {
      const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
      const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector })
      assert.ok(nodeId, 'The original image file input exists')
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [path.resolve(__dirname, '../../../resources/icon-512.png')] })
      result.interactions.push({kind:'native-file-selection',selector,fixture:'product icon PNG'})
      await settle()
    } finally { if (!alreadyAttached) win.webContents.debugger.detach() }
  }
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
    const checks = await read(`(() => { const pane=document.querySelector('[data-settings-overview]')||document.querySelector('[data-settings-pane]:not([hidden])')||document.querySelector('.settings-search-results'); return {viewport:[innerWidth,innerHeight],horizontalOverflow:document.documentElement.scrollWidth>innerWidth,frameScrolls:(()=>{const values=[];for(let p=pane?.parentElement;p;p=p.parentElement)values.push({classes:p.className,top:p.scrollTop,left:p.scrollLeft});return values})(),scroll: pane?{top:pane.scrollTop,height:pane.scrollHeight,viewport:pane.clientHeight}:null,innerScrolls:pane?[...pane.querySelectorAll('[data-settings-review-scroll]')].filter(n=>n.checkVisibility()).map(n=>({id:n.dataset.settingsReviewScroll,classes:n.className,top:n.scrollTop,height:n.scrollHeight,viewport:n.clientHeight})):[]}; })()`)
    assert.equal(checks.horizontalOverflow,false,'Settings has no document horizontal overflow')
    assert.ok(checks.frameScrolls.every(owner=>owner.top===0&&owner.left===0),'Settings frame ancestors remain anchored around the original reader')
    const file = name + '.png'
    fs.writeFileSync(path.join(evidence,file),(await bounded(win.webContents.capturePage(undefined,{stayHidden:true}),'capture '+file)).toPNG())
    result.frames.push({file,page,theme,position,checks})
    checkpoint('captured:' + file)
  }
  const captureSegments = async (prefix, id, color) => {
    const pane = node(`[data-settings-pane="${id}"]`)
    // A retained focused input can scroll its owner back into view after layout.
    // These are passive review frames; authored values and control identity stay intact.
    await read('document.activeElement?.blur()')
    await read(`${pane}.scrollTop=0`)
    const readers = await read(`(() => {for(const n of ${pane}.querySelectorAll('[data-settings-review-scroll]'))delete n.dataset.settingsReviewScroll;let index=0;return [...${pane}.querySelectorAll('*')].filter(n=>n.checkVisibility()&&n.clientHeight>80&&n.scrollHeight>n.clientHeight+24&&['auto','scroll'].includes(getComputedStyle(n).overflowY)).map(n=>{n.dataset.settingsReviewScroll=String(index++);n.scrollTop=0;return {id:n.dataset.settingsReviewScroll,height:n.scrollHeight,viewport:n.clientHeight}})})()`)
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
      await hit(scroll)
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
  const moteStoryScenes = async (prefix, color) => {
    const story = node('[data-settings-pane="mote"] .mote-origin')
    const saves = await read('window.settingsHomeProbe.saves.length')
    await click(`${story}.querySelectorAll('button')[0]`)
    for (let chapter = 0; chapter < 3; chapter++) {
      if (chapter === 1) { await key('Tab'); await key('Enter') }
      if (chapter === 2) await click(`${story}.querySelectorAll('button')[2]`)
      await until(`${story}.querySelectorAll('button')[${chapter}].getAttribute('aria-pressed')==='true'`)
      await until(`${story}.querySelector('img').complete&&${story}.querySelector('img').naturalWidth>0`)
      // Keep the first button focused for the trusted Tab/Enter transition.
      if (chapter === 0) await capture(`${prefix}-story-${chapter}`, 'mote', color)
      else await captureSegments(`${prefix}-story-${chapter}`, 'mote', color)
    }
    assert.equal(await read('window.settingsHomeProbe.saves.length'), saves, 'Story navigation never saves configuration')
    await click(`${story}.querySelectorAll('button')[0]`)
  }
  const conceptIntroductions = async () => {
    const pane = id => `[data-settings-pane="${id}"]`
    const capsuleRoot = pane('capsule')+' [aria-label="New Capsule content root"]'
    const goalsFinished = pane('goals')+' [aria-label="Show finished goals by default"]'
    const savesBefore = await read('window.settingsHomeProbe.saves.length')
    const capsuleWrites = () => read('window.settingsHomeProbe.conceptProbe.calls.filter(call=>call.method==="capsule.config.update")')
    for (const [width,height,size] of [[1440,940,'wide'],[500,840,'compact']]) {
      await resize(width,height)
      for (const id of ['capsule','goals']) {
        await nav(id)
        const intro = node(pane(id)+` .settings-concept-intro[data-concept="${id}"]`)
        assert.equal(await read(`!!${intro}`),true,`The production ${id==='capsule'?'Capsule':'Goals'} introduction is present in its original pane`)
        assert.equal(await read(`${intro}.parentElement.firstElementChild===${intro}`),true,'Introduction is the first content of its original editor')
        assert.equal(await read(`${intro}.querySelectorAll('button,input,select,textarea,[role="button"]').length`),0,'Introduction does not invent an interaction or setting')
        assert.ok(await read(`${intro}.querySelector('h3')?.textContent.trim().length`)>0,'Introduction has a visible product heading')
        if (id==='capsule') {
          await until(`${intro}.querySelector('img')?.complete&&${intro}.querySelector('img').naturalWidth>0`,'The actual Capsule art is decoded')
          await until(`${node(capsuleRoot)}?.checkVisibility()`)
        }
        for (const color of ['dark','light']) {
          await theme(color)
          await read(`${node(pane(id))}.scrollTop=0`)
          const geometry=await read(`(() => {const n=${intro},r=n.getBoundingClientRect(),p=${node(pane(id))}.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,paneLeft:p.left,paneRight:p.right,heading:n.querySelector('h3').textContent}})()`)
          assert.ok(geometry.width>0&&geometry.height>0&&geometry.left>=geometry.paneLeft-1&&geometry.right<=geometry.paneRight+1,'Introduction fits the original reader')
          result.interactions.push({kind:'concept-intro-geometry',page:id,theme:color,size,...geometry})
          await captureSegments(`page-${id}${size==='compact'?'-compact':''}-${color}`,id,color)
        }
      }
    }
    assert.equal(await read('window.settingsHomeProbe.saves.length'),savesBefore,'Reading introductions and original navigation never saves configuration')
    assert.deepEqual(await capsuleWrites(),[],'Reading introductions never writes Capsule defaults')
    await resize(1440,940); await theme('dark'); await nav('capsule')
    const capsuleDraft='/private/concept-intros/edited-content'
    await fill(capsuleRoot,capsuleDraft)
    await read(`window.originalConceptCapsuleRoot=${node(capsuleRoot)}`)
    await nav('goals')
    const originalFinished=await read(`${node(goalsFinished)}.checked`)
    await choose(goalsFinished)
    await read(`window.originalConceptGoalsFinished=${node(goalsFinished)}`)
    await nav('capsule')
    assert.equal(await read(`${node(capsuleRoot)}===window.originalConceptCapsuleRoot`),true,'The original Capsule draft input survives cross-page navigation')
    assert.equal(await read(`${node(capsuleRoot)}.value`),capsuleDraft,'Capsule introduction preserves its original unsaved content location')
    await nav('goals')
    assert.equal(await read(`${node(goalsFinished)}===window.originalConceptGoalsFinished`),true,'The original Goals draft input survives cross-page navigation')
    assert.equal(await read(`${node(goalsFinished)}.checked`),!originalFinished,'Goals introduction preserves its original unsaved preference')
    assert.equal(await read('window.settingsHomeProbe.saves.length'),savesBefore,'Draft navigation does not implicitly save')
    assert.deepEqual(await capsuleWrites(),[],'Draft navigation does not implicitly save Capsule defaults')
    await click(node(pane('goals')+' [data-settings-save-bar] button'))
    await until(`window.settingsHomeProbe.saves.length===${savesBefore+1}&&${node(pane('goals')+' [data-settings-save-bar] button')}.disabled`)
    const goalsSave=await read(`window.settingsHomeProbe.saves[${savesBefore}]`)
    assert.equal(goalsSave.next.goals.showFinished,!originalFinished,'Explicit Goals save keeps the original edited preference')
    assert.equal(goalsSave.expected.goals.showFinished,originalFinished,'Explicit Goals save keeps the original expected preference')
    const {showFinished:nextFinished,...nextOther}=goalsSave.next.goals
    const {showFinished:expectedFinished,...expectedOther}=goalsSave.expected.goals
    assert.deepEqual(nextOther,expectedOther,'The introduction adds no Goals configuration fields')
    assert.deepEqual(goalsSave.next.goalsCommonActions,goalsSave.expected.goalsCommonActions)
    await nav('capsule')
    await click(button(pane('capsule'),'Save defaults'))
    await until(`${button(pane('capsule'),'Save defaults')}.disabled&&${node(pane('capsule')+' .capsule-settings__defaults')}.textContent.includes('Confirmed by the Capsule owner.')`)
    const writes=await capsuleWrites()
    assert.equal(writes.length,1,'Only the explicit Capsule save reaches its original mutation port')
    assert.equal(writes[0].params.expectedRevision,1)
    assert.deepEqual(writes[0].params.changes,{contentRoot:capsuleDraft},'Explicit Capsule save preserves the original edit payload')
    assert.ok(writes[0].params.operationId)
    const calls=await read('window.settingsHomeProbe.conceptProbe.calls')
    assert.ok(calls.every(call=>['capsule.runtime.inspect','capsule.config.inspect','capsule.ls','capsule.config.update'].includes(call.method)),'Introduction review never starts a service or creates or opens a page')
    for(const id of ['capsule','goals']) result.interactions.push({kind:'page-interactions-complete',page:id,actions:1,implicitSaves:0,explicitSaves:1,originalInputRetained:true})
    result.conceptIntros={boundary:await read('window.settingsHomeProbe.conceptProbe.boundary'),calls,goalsSave,draftsRetained:true,implicitSaves:0,explicitSaves:2}
    await click(node('[aria-label="Close settings"]'))
    result.preserved=await read('window.settingsHomeProbe.surface()')
    assert.equal(result.preserved.exact,true,'Introduction review preserves the original work surface')
    result.events=await read('window.settingsHomeProbe.events')
    assert.ok(result.events.some(event=>event.type==='click'&&event.trusted))
    assert.ok(result.events.some(event=>event.type==='input'&&event.trusted))
    assert.deepEqual(await read('window.settingsHomeProbe.errors'),[])
  }
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
  const previewRoundTrip = async (id, group, controlSelector) => {
    const pane = `[data-settings-pane="${id}"]`, preview = id==='focus' ? '.focus-settings-preview' : '.browser-agent-preview'
    for (const [width,height,label] of [[500,840,'compact'],[900,540,'short']]) {
      await resize(width,height)
      const details = pane+' .browser-agent-control__advanced'
      if (id==='browser-agent-control') await read(`${node(details)}.open=true`)
      for (let repeat=0;repeat<2;repeat++) {
        // Begin partway through the real reader so returning to zero cannot pass.
        await read(`${node(pane)}.scrollTop=96`)
        await click(node(pane+' '+controlSelector))
        if (id==='browser-agent-control') await key('ArrowRight')
        await read(`window.settingsPreviewOrigin={control:${node(pane+' '+controlSelector)},value:${node(pane+' '+controlSelector)}.value,scrollTop:${node(pane)}.scrollTop,ancestors:(()=>{const values=[];for(let p=${node(pane)}.parentElement;p;p=p.parentElement)values.push({node:p,top:p.scrollTop,left:p.scrollLeft});return values})()}`)
        assert.ok(await read('window.settingsPreviewOrigin.scrollTop')>0,'Preview comparison starts from a real nonzero reading position')
        await click(node(pane+` [data-settings-preview-open="${group}"]`))
        const geometry=await read(`(()=>{const r=${node(pane+' '+preview)}.getBoundingClientRect(),p=${node(pane)}.getBoundingClientRect();return {top:r.top,paneTop:p.top,visible:r.top>=p.top-1&&r.top<innerHeight-80}})()`)
        assert.equal(geometry.visible,true,'Preview navigation brings the original example into view')
        const returnLabel=await read(`(()=>{const button=${node(pane+' [data-settings-preview-return]')},label=button.querySelector('span'),range=document.createRange();range.selectNodeContents(label);const bounds=button.getBoundingClientRect();return {text:label.textContent,name:button.getAttribute('aria-label'),bounds:bounds.toJSON(),lines:[...range.getClientRects()].map(r=>r.toJSON())}})()`)
        assert.equal(returnLabel.name,'Back to '+returnLabel.text,'Preview return names the complete original field')
        assert.ok(returnLabel.lines.length>0&&returnLabel.lines.every(line=>line.left>=returnLabel.bounds.left&&line.right<=returnLabel.bounds.right+1&&line.top>=returnLabel.bounds.top&&line.bottom<=returnLabel.bounds.bottom+1),'Preview return displays its complete field label without clipping')
        await capture(`${id}-${label}-preview-${repeat}`,id,'dark','explicit comparison from original control')
        await click(node(pane+' [data-settings-preview-return]'))
        assert.equal(await read(`document.activeElement===window.settingsPreviewOrigin.control&&window.settingsPreviewOrigin.control===${node(pane+' '+controlSelector)}&&${node(pane+' '+controlSelector)}.value===window.settingsPreviewOrigin.value`),true,'Preview return preserves the original control, value and focus')
        assert.ok(await read(`Math.abs(${node(pane)}.scrollTop-window.settingsPreviewOrigin.scrollTop)<=1`),'Preview return restores original reading position')
        assert.equal(await read(`window.settingsPreviewOrigin.ancestors.every(p=>p.node.scrollTop===p.top&&p.node.scrollLeft===p.left)`),true,'Preview return preserves every App ancestor reading position')
        result.interactions.push({kind:'preview-round-trip',page:id,group,viewport:[width,height],repeat,geometry,returnLabel,identity:true,draft:true,focus:true,readingPosition:true,ancestorPositions:true})
        await capture(`${id}-${label}-return-${repeat}`,id,'dark','original editing control and reading position restored')
      }
    }
    await resize(1440,940)
  }
  const larkInteractions = async (mutation = false) => {
    const pane = '[data-settings-pane="lark"]', bot = '[data-connection="settings-preview-bot"] .connector-record__open'
    const calls = () => read('window.settingsHomeProbe.larkPreview.calls')
    const noWrites = async (start, label) => {
      const recent = (await calls()).slice(start)
      assert.equal(recent.some(call=>call.effect||['connection.setup.advance','connection.setup.begin','connection.enrollment.begin','connection.enrollment.advance'].includes(call.method)),false,'Lark navigation preserves a read-only connector boundary: '+label)
      assert.equal(await read('window.settingsHomeProbe.larkPreview.credentialWrites.length'),0,'Lark navigation never stores a credential')
      result.interactions.push({kind:'lark-read-only-navigation',label,calls:recent.length,implicitConnectorWrites:0})
    }
    const openSetup = async () => {
      await click(node(bot)); await until(`${node('[data-management-open]')}?.checkVisibility()`)
      await click(node('[data-management-open]'))
      await until(`${node('[data-management-original="settings-preview-setup"]')}?.checkVisibility()||${node('[data-management-setup]')}?.dataset.managementStage==='confirmed'`)
      if (await read(`${node('[data-management-original="settings-preview-setup"]')}?.checkVisibility()??false`)) await click(node('[data-management-original="settings-preview-setup"]'))
      await until(`${node('[data-management-setup]')}?.dataset.managementStage==='confirmed'&&!!${node('[data-guided-management]')}`)
    }
    const openIndividual = async () => {
      if (!await read(`${node('[data-guided-management]')}.open`)) await click(node('[data-guided-management] > summary'))
      await until(`${node('[data-surface-mode="add-application-permissions"]')}?.checkVisibility()`)
    }
    for (const [width,height] of mutation?[[1440,940]]:[[1440,940],[500,840],[900,540]]) for (const color of mutation||width===900?['dark']:['dark','light']) {
      await resize(width,height); await nav('lark'); await theme(color)
      const start=(await calls()).length,label=`${width}-${height}-${color}`
      await until(`${node(bot)}?.checkVisibility()`)
      await captureSegments('lark-library-'+label,'lark',color)
      await click(node('[data-enrollment-existing]'))
      await fill('[aria-label="Connection app ID"]','cli_preview_draft')
      await fill('[aria-label="Connection app secret"]','controlled-preview-secret')
      const options=`${node(pane+' [aria-label="Connection name"]')}.closest('details')`
      if (!await read(`${options}.open`)) await click(`${options}.querySelector('summary')`)
      await fill('[aria-label="Connection name"]','Research assistant draft')
      await nav('overview'); await nav('lark')
      assert.equal(await read(`${node('[aria-label="Connection app ID"]')}.value`),'cli_preview_draft','Lark credential draft survives normal navigation')
      assert.equal(await read(`${node('[aria-label="Connection name"]')}.value`),'Research assistant draft')
      await captureSegments('lark-credentials-'+label,'lark',color)
      await click(node(pane+' [data-connection-editor] .connector-back'))
      await click(node(bot)); await captureSegments('lark-saved-'+label,'lark',color)
      await click(node(pane+' [data-connection-editor] .connector-back'))
      await openSetup(); await captureSegments('lark-setup-'+label,'lark',color)
      await click(node('[data-configuration-progress] > summary'))
      await captureSegments('lark-setup-progress-'+label,'lark',color)
      await click(node('[data-configuration-progress] > summary'))
      await openIndividual()
      await click(node('[data-surface-mode="add-application-permissions"]'))
      await noWrites(start,'select permissions')
      await until(`${node('[data-management-permissions]')}?.checkVisibility()`)
      await captureSegments('lark-permissions-'+label,'lark',color)
      const exact=`${node('[data-management-permissions]')}.querySelector('details')`
      if (!await read(`${exact}.open`)) await click(`${exact}.querySelector('summary')`)
      await captureSegments('lark-permissions-detail-'+label,'lark',color)
      await click(node('[data-surface-mode="enable-messaging"]'))
      await click(node('[data-management-publication-open]'))
      await until(`${node('[data-management-publication]')}?.checkVisibility()`)
      await fill('[aria-label="Publication release notes"]','Enable conversations for the research team.')
      await captureSegments('lark-publication-'+label,'lark',color)
      await click(node('[data-publication-review-details] > summary'))
      await captureSegments('lark-publication-detail-'+label,'lark',color)
      await click(node('[data-management-back]'))
      await until(`${node(pane+' [data-connection-editor]')}?.checkVisibility()`)
      assert.ok(await read(`${node('[data-connection-editor]')}.textContent.includes('cli_preview_conversations')`),'Lark return preserves the exact saved application')
      await click(node(pane+' [data-connection-editor] .connector-back'))
      await noWrites(start,'return to original bot library')
      await captureSegments('lark-return-'+label,'lark',color)
    }
    await resize(1440,940); await theme('dark'); await nav('lark')
    const beforeService=(await calls()).filter(call=>call.method==='connection.service.configure').length
    await choose('[aria-label="Enable external chat sync"]')
    assert.equal((await calls()).filter(call=>call.method==='connection.service.configure').length,beforeService,'Lark service draft does not save')
    await captureSegments('lark-service-draft','lark','dark')
    await click(node('[data-connector-service-save]'))
    await until(`${node('[data-connector-service-state]')}?.dataset.connectorServiceState==='on'`)
    assert.equal((await calls()).filter(call=>call.method==='connection.service.configure').length,beforeService+1,'Only explicit service Save configures the controlled service')
    assert.equal((await calls()).filter(call=>call.method==='connection.configure').length,0,'Global sync does not rewrite individual bots')
    await captureSegments('lark-service-saved','lark','dark')
    await openSetup(); await openIndividual(); await click(node('[data-surface-mode="add-application-permissions"]'))
    const beforeReview=(await calls()).filter(call=>call.effect).length
    await click(node('[data-permission-review]'))
    await until(`${node('[data-permission-review]')}?.disabled===false&&!!${node('[data-permission-add]')}`)
    assert.equal((await calls()).filter(call=>call.effect).length,beforeReview,'Permission review reads without requesting permissions')
    const reviewed=(await calls()).filter(call=>call.method==='connection.setup.advance').slice(-2)
    assert.deepEqual(reviewed.map(call=>call.actionKind),['read-permission-catalog','read-application-permissions'])
    await click(node('[data-permission-add]'))
    await until(`!${node('[data-permission-add]')}&&${node('[data-permission-review]')}?.disabled===false`)
    const added=(await calls()).filter(call=>call.effect).at(-1)
    assert.equal(added.actionKind,'add-application-permissions');assert.equal(added.input.operationId,'settings-preview-setup')
    await captureSegments('lark-permissions-requested','lark','dark')
    await click(node('[data-surface-mode="enable-messaging"]'));await click(node('[data-management-publication-open]'))
    await fill('[aria-label="Publication release notes"]','Enable conversations for the research team.')
    const beforePublication=(await calls()).filter(call=>call.effect).length
    await click(node('[data-publication-review]'))
    await until(`${node('[data-publication-confirm]')}?.disabled===false`)
    assert.equal((await calls()).filter(call=>call.effect).length,beforePublication,'Publication review does not create or submit a version')
    await captureSegments('lark-publication-reviewed','lark','dark')
    await click(node('[data-publication-confirm]'))
    await until(`${node('[data-publication-review-created]')}?.checkVisibility()`)
    const created=(await calls()).filter(call=>call.effect).at(-1)
    assert.equal(created.actionKind,'create-application-version');assert.equal(created.input.operationId,'settings-preview-setup')
    assert.equal((await calls()).some(call=>call.actionKind==='submit-application-version'),false,'Creating a version does not submit it')
    await captureSegments('lark-publication-created','lark','dark')
    await click(node('[data-management-back]'));await click(node(pane+' [data-connection-editor] .connector-back'))
    await click(node('[data-enrollment-existing]'))
    await fill('[aria-label="Connection app ID"]','cli_preview_explicit_save')
    await fill('[aria-label="Connection app secret"]','controlled-preview-secret')
    await click(node('[data-connection-save]'))
    await until(`${node('[data-management-open]')}?.checkVisibility()&&${node('[data-connection-editor]')}.textContent.includes('cli_preview_explicit_save')`)
    const configured=(await calls()).filter(call=>call.method==='connection.configure')
    assert.equal(configured.length,1,'Only explicit bot Save configures a connection')
    const credentialWrites=await read('window.settingsHomeProbe.larkPreview.credentialWrites')
    assert.equal(credentialWrites.length,1,'Explicit bot Save stores one controlled credential')
    assert.equal(credentialWrites[0].operationId,configured[0].input.operationId+':credential','Credential save keeps the exact original configure intent')
    assert.equal(configured[0].input.connection.application.appId,'cli_preview_explicit_save')
    assert.equal((await calls()).filter(call=>call.effect).length,4,'Only the four explicitly confirmed controlled effects were requested')
    const savedStages=await read(`Array.from(${node('[data-connection-editor]')}.querySelectorAll('[data-connection-stage]')).map(stage=>stage.dataset.state)`)
    assert.deepEqual(savedStages,['unknown','unknown','unknown','unknown'],'Saving bot credentials does not confirm connection or delivery')
    await captureSegments('lark-bot-saved','lark','dark')
    await click(node(pane+' [data-connection-editor] .connector-back'))
    result.lark={boundary:await read('window.settingsHomeProbe.larkPreview.boundary'),calls:await calls(),credentialWrites:await read('window.settingsHomeProbe.larkPreview.credentialWrites'),
      untested:['external sign-in','real platform effects','keychain persistence','external message delivery','version submission','Mote association writes','local bot removal']}
    result.interactions.push({kind:'lark-explicit-actions',serviceSaves:1,botSaves:1,permissionRequests:1,versionCreations:1,implicitConnectorWrites:0})
  }
  const focusContentSize = async () => {
    const pane='[data-settings-pane="focus"]'
    for (const [scene,label] of [['reading','Agent preview'],['links','Links']]) {
      await click(button(pane+' [aria-label="Focus example view"]',label))
      const geometry=await read(`(() => {const canvas=${node(pane+' .focus-settings-preview__canvas')},content=canvas.lastElementChild,style=getComputedStyle(canvas);return {scene:canvas.dataset.scene,height:canvas.getBoundingClientRect().height,unused:canvas.getBoundingClientRect().bottom-content.getBoundingClientRect().bottom-parseFloat(style.paddingBottom),populated:!!canvas.querySelector('.focus-settings-preview__peek,.focus-settings-preview__workface')}})()`)
      assert.equal(geometry.scene,scene)
      assert.equal(geometry.populated,false,'The compact example is the original idle scene')
      assert.ok(geometry.height>0&&geometry.unused<=2,'Focus short examples fit their content without a padded empty canvas')
      result.interactions.push({kind:'focus-content-geometry',...geometry})
      await capture('focus-content-'+scene,'focus','dark','content-sized original example')
    }
  }
  const pageInteractions = async id => {
    const pane = `[data-settings-pane="${id}"]`
    const saves = await read('window.settingsHomeProbe.saves.length')
    const before = result.interactions.length
    if (id==='lark') {
      await larkInteractions()
    } else if (id==='profile') {
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
      const slider='[aria-label="Desktop banner duration"]', preview='[aria-label="Desktop banner preview"]'
      const sound=pane+' .notification-sound-toggle input'
      await click(node(slider)); await key('Home')
      await until(`${node(preview)}.dataset.notificationMode==='off'`)
      assert.match(await read(`${node(preview)}.textContent`),/Unsaved preview/)
      assert.equal(await read(`${node(sound)}.disabled`),false,'Sound remains an independent preference for enabled A2A alerts')
      const originalSound=await read(`${node(sound)}.checked`)
      await choose(sound)
      assert.equal(await read(`${node(sound)}.checked`),!originalSound,'The original sound draft remains editable while Agent status banners are off')
      assert.equal(await read(`${node(preview)}.dataset.notificationMode`),'off')
      await capture('notifications-off',id,'dark','unsaved off preview and independent sound')
      await click(node(slider)); await key('Home'); await key('ArrowRight')
      await until(`${node(preview)}.dataset.notificationMode!=='off'`)
      await capture('notifications-brief',id,'dark','unsaved dwell preview')
      await key('End')
      await until(`${node(preview+' .notification-preview__dwell')}.dataset.persist==='true'`)
      await capture('notifications-persistent',id,'dark','until-dismissed draft with independent sound')
    } else if (id==='continuity') {
      const windowInput = '[aria-label="Automatic recovery window"]', unit = '[aria-label="Automatic recovery window unit"]'
      const save = pane+' [data-settings-save-bar] button'
      assert.equal(await read(`${node(windowInput)}.value`),'24')
      assert.equal(await read(`${node(unit)}.value`),'hours')
      assert.equal(await read(`${node(save)}.disabled`),true,'The initial recovery preference is saved')
      await click(`${node('.recovery-mode input[value="manual"]')}.closest('label')`)
      assert.equal(await read(`${node('.recovery-mode input[value="manual"]')}.checked`),true)
      assert.match(await read(`${node('.recovery-mode-effect')}.textContent`),/Recovery waits for you/)
      assert.equal(await read(`${node(save)}.disabled`),false,'Changing the recovery mode requires an explicit save')
      await nav('overview'); await nav(id)
      assert.equal(await read(`${node('.recovery-mode input[value="manual"]')}.checked`),true,'The original mode draft survives navigation')
      await capture('continuity-on-demand',id,'dark','explicit recovery mode draft')
      await click(`${node('.recovery-mode input[value="automatic"]')}.closest('label')`)
      assert.equal(await read(`${node(save)}.disabled`),true,'Returning to the saved mode restores the clean draft')
      result.interactions.push({kind:'recovery-mode-draft',selected:'manual',retainedAfterNavigation:true,restored:'automatic'})
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
      await fill('[aria-label="Maximum retry base delay"]','5')
      assert.deepEqual(await read(`Array.from(${node('[aria-label="Recovery retry example"]')}.querySelectorAll('li strong')).map(n=>n.textContent)`),['1 second','2 seconds','4 seconds','5 seconds','5 seconds','5 seconds'])
      assert.match(await read(`${node('[aria-label="Recovery retry example"]')}.textContent`),/First 6 of 7/)
      await capture('continuity-retry-search',id,'dark','searched advanced draft')
      const recheck = pane+' details:has([data-settings-field="recheckMaxAttempts"])'
      await click(node(recheck+' > summary'))
      await fill(pane+' [aria-label="Recheck count"]','4')
      await fill(pane+' [aria-label="Recheck interval"]','2')
      assert.match(await read(`${node(pane+' [aria-label="Recovery recheck example"]')}.textContent`),/4 follow-up checks, 2 seconds apart/)
      for (const [width,height,label] of [[1440,940,'wide'],[500,840,'compact']]) {
        await resize(width,height)
        for (const color of ['dark','light']) {
          await theme(color)
          await hit(node(pane+' [aria-label="Recovery recheck example"]'))
          await capture('continuity-recheck-'+label+'-'+color,id,color,'same-operation recheck draft')
        }
      }
      await theme('dark'); await resize(1440,940)

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
      await previewRoundTrip(id,'fine-tuning','[data-settings-field="pointerDurationMs"] input')
    } else if (id==='general') {
      const field = pane+' [data-settings-field="copy-paths"] input'
      const original = await read(`${node(field)}.checked`)
      await choose(field)
      assert.equal(await read(`${node('[aria-label="Project path draft preview"]')}.dataset.pathFormat`),original?'abbreviated':'absolute','The path example follows the unsaved original preference')
      for (const [label,target] of [['Open Session recovery','continuity'],['Open Hosts','hosts']]) {
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
      await resize(500,840)
      const chordGeometry = await read(`(() => { const row=${node(pane)}.querySelector('[data-binding-id]'); const label=row.querySelector('.keyboard-shortcuts__label').getBoundingClientRect(),chord=row.querySelector('.keyboard-shortcuts__chord').getBoundingClientRect(); return {label:{right:label.right,bottom:label.bottom},chord:{left:chord.left,top:chord.top}} })()`)
      assert.ok(chordGeometry.chord.left>chordGeometry.label.right&&chordGeometry.chord.top<chordGeometry.label.bottom,'A narrow command and its key chord share one readable row')
      result.interactions.push({kind:'shortcut-row-geometry',page:id,...chordGeometry})
      await capture('shortcuts-compact-rows',id,'dark','command and key chord alignment')
      await resize(1440,940)
    } else if (id==='message-tool') {
      const radio = pane+' [data-settings-field="initial-layout"] input[value="two-line"]'
      await choose(radio)
      assert.equal(await read(`${node(radio)}.checked`),true)
      assert.equal(await read(`${node(pane+' .message-tool-preview__composer')}.dataset.layout`),'two-line')
      await capture('input-two-lines-wide',id,'dark','two-line draft and its live preview')
      await resize(500,840)
      await capture('input-two-lines-compact',id,'dark','two-line draft in a compact window')
      await resize(1440,940)
      await click(node(radio))
      await key('ArrowLeft')
      assert.equal(await read(`${node(pane+' [data-settings-field="initial-layout"] input[value="one-line"]')}.checked`),true,'Native radio keyboard input changes the original layout draft')
      await fill(pane+' [aria-label="Commands prefix"]','!')
      assert.equal(await read(`${node(pane+' [data-preview-prefix="command"] kbd')}.textContent`),'!','The preview uses the literal current prefix draft')
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-settings-save-bar]').length`),2)
      assert.equal(await read(`${node(pane+' [data-settings-field="message-shortcuts"]')}.querySelector('[aria-label="Shortcut context"]')===null`),true)
      await resize(500,840)
      const longPrefix='!'.repeat(80)
      await fill(pane+' [aria-label="Commands prefix"]',longPrefix)
      assert.equal(await read(`${node(pane+' [data-preview-prefix="command"] kbd')}.textContent`),longPrefix)
      assert.equal(await read(`(() => { const preview=${node(pane+' .message-tool-preview')}; return preview.scrollWidth<=preview.clientWidth })()`),true,'Long literal prefixes do not overflow the original preview')
      await capture('input-long-prefix',id,'dark','complete prefix draft with bounded preview')
      await fill(pane+' [aria-label="Commands prefix"]','!')
      await resize(1440,940)
      await capture('input-independent-drafts',id,'dark','layout and shortcut scopes')
      await click(node(pane+' .message-tool-shortcuts > summary'))
      await fill(pane+' [aria-label="Find a command or shortcut"]','send')
      await capture('input-sending-shortcuts',id,'dark','original registry in its explicit disclosure')
      await click(node(pane+' [aria-label="Clear shortcut search"]'))
      await click(node(pane+' .message-tool-shortcuts > summary'))
    } else if (id==='a2a') {
      const radio = pane+' input[value="notify"]'
      await choose(radio); await click(button(pane,'Open Notifications'))
      await until(`!!${node('[data-settings-pane="notifications"]:not([hidden])')}`)
      await nav(id); assert.equal(await read(`${node(radio)}.checked`),true)
      assert.notEqual(await read(`${node(pane+' [data-a2a-preview]')}.dataset.a2aPreview`),'off')
      await choose(pane+' input[value="silent"]')
      assert.equal(await read(`${node(pane+' [data-a2a-preview]')}.dataset.a2aPreview`),'off')
      await capture('a2a-silent-preview',id,'dark','same message with no system banner')
      await choose(radio)
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
      await fill(pane+' [aria-label="Minimum follow-up interval"]','25')
      await fill(pane+' [aria-label="Daily follow-up budget"]','2')
      const effect=await read(`${node(pane+' [aria-label="Quiet follow-up example"]')}.textContent`)
      assert.match(effect,/21 hours/); assert.match(effect,/25 hours/); assert.match(effect,/2 attempts per local day/)
      await capture('automation-quiet-draft',id,'dark','separate policy owners and advanced draft')
    } else if (id==='amux-protocols') {
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-protocol-example]').length`),0)
      await click(button(pane,'View first example'))
      await until(`!!${node(pane+' [data-protocol-example]')}`)
      assert.equal(await read(`document.activeElement===${node(pane+' .amux-protocols__row > summary')}`),true)
      assert.ok(await read(`${node(pane+' .amux-protocols__wire pre')}.textContent.length`)>0)
      assert.equal(await read(`${node(pane+' .amux-protocols__comparison')}.querySelector('[data-protocol-example] .log-turn')!==null`),true)
      assert.equal(await read(`${node(pane)}.querySelector('details.amux-protocols__wire')===null`),true,'Wire and rendering can be compared without a second disclosure')
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
      await focusContentSize()
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
      await previewRoundTrip(id,'agent-reading','input[name="focus-recent-inputs"][value="6"]')
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
      await chooseImageFile(pane+' [aria-label="Select icon image file"]')
      await until(`${node('.settings-survey__icon')}?.naturalWidth>0`)
      assert.equal(await read(`Array.from(${node(pane)}.querySelectorAll('input[type="text"],textarea')).some(n=>n.value.startsWith('data:'))`),false,'Inline image bytes stay out of normal text fields')
      await capture('survey-image-draft',id,'dark','local image draft through original file input')
      await chooseImageFile(pane+' [aria-label="Select background image file"]')
      await until(`${node('.settings-survey__background')}?.naturalWidth>0&&${node('.settings-survey__icon')}?.naturalWidth>0`)
      await click(node(pane+' [aria-label="Preview icon and background images"]'))
      await until(`${node('.settings-survey__background')}?.naturalWidth>0&&${node('.settings-survey__icon')}?.naturalWidth>0`)
      await capture('survey-background-draft',id,'dark','explicit draft icon and background')
      await click(node(pane+' [aria-label="Clear icon image"]'))
      assert.equal(await read(`${node(pane)}.querySelector('.settings-survey__icon')===null`),true)
      await chooseImageFile(pane+' [aria-label="Select icon image file"]')
      await until(`${node('.settings-survey__icon')}?.naturalWidth>0`)
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
      await click(node(pane+' [data-device-action="scan"]'))
      await until(`!!${node(pane+' .connection-link-code svg')}`)
      assert.equal(await read('window.settingsHomeProbe.mobileConnectionProbe.copied.length'),0,'Scanning never writes the clipboard')
      const linkReads = await read('window.settingsHomeProbe.mobileConnectionProbe.linkReads')
      await click(node(pane+' [data-device-action="copy"]'))
      assert.equal(await read('window.settingsHomeProbe.mobileConnectionProbe.linkReads'),linkReads,'Copy uses the displayed original offer')
      assert.deepEqual(await read('window.settingsHomeProbe.mobileConnectionProbe.copied'),[await read(`${node(pane+' [aria-label="Phone connection link"]')}.value`)],'Copy and QR share one exact URL')
      await capture('mobile-scan-and-copy',id,'dark','direct QR with separate copy feedback; isolated typed offer and clipboard ports')
      const issue=pane+' .device-management__read-issue details'
      await until(`!!${node(issue)}`,'The isolated owner reports its actual device observation boundary')
      await click(node(issue+' > summary'))
      assert.ok(await read(`${node(issue+' p')}.textContent.length`)>0)
      await click(node(pane+' [data-device-records] > summary'))
      await capture('mobile-observation-details',id,'dark','full observation and original device records')
    } else if (id==='inapp-conversation') {
      assert.equal(await read(`${node(pane)}.querySelectorAll('[data-example-view="activity"] .log-turn').length`),2)
      assert.ok(await read(`${node(pane+' [data-inapp-input-summary]')}.textContent.length`)>0)
      const messageSpacing = await read(`(() => { const turns=Array.from(${node(pane)}.querySelectorAll('[data-example-view="activity"] .log-turn')); const first=turns[0].getBoundingClientRect(),second=turns[1].getBoundingClientRect(),head=turns[0].querySelector('.log-turn__head').getBoundingClientRect(),body=turns[0].querySelector('.log-turn__body').getBoundingClientRect(); return {within:body.top-head.bottom,between:second.top-first.bottom} })()`)
      result.interactions.push({kind:'inapp-example-grouping',page:id,...messageSpacing})
      assert.ok(messageSpacing.within>=0&&messageSpacing.within<=4&&messageSpacing.between>=8,'Each example keeps its own heading closer than the next message: '+JSON.stringify(messageSpacing))
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
      // Only this unsaved fixture tool is edited. The original Monaco keyboard
      // owner receives every character; changing type never runs or saves it.
      const scriptOwner = pane+' .toolkit-editor__script .monaco-editor'
      const scriptText = () => read(`${node(scriptOwner+' .view-lines')}.textContent.replace(/\\u00a0/g,' ').replace(/\\u200b/g,'').trim()`)
      const originalScript = "console.log('Hello from your toolkit')\n"
      assert.equal(await scriptText(),originalScript.trim(),'The untouched new-tool script is the production default')
      const originalToolId = await read('window.settingsHomeProbe.toolkitDraft.id')
      const originalModelCount = await read('window.__agentmuxMonacoModelCount()')
      const originalModelUri = await read('window.settingsHomeProbe.toolkitEditor.uri()')
      const inspectDraft = async (expectedMode, value) => {
        await until(`window.settingsHomeProbe.toolkitDraft.mode===${JSON.stringify(expectedMode)}&&window.settingsHomeProbe.toolkitDraft.value===${JSON.stringify(value)}`,'The committed original settings draft retains the complete text')
        assert.equal(await read('window.settingsHomeProbe.toolkitDraft.id'),originalToolId)
        assert.equal(await read(`${node(scriptOwner)}===window.settingsHomeProbe.toolkitEditor.node()`),true,'The observed model belongs to the exact Toolkit editor')
        assert.equal(await read('window.settingsHomeProbe.toolkitEditor.value()'),value,'The actual Monaco model matches the original settings draft')
        assert.equal(await read('window.settingsHomeProbe.toolkitEditor.uri()'),originalModelUri,'Language changes retain the original document identity')
        assert.equal(await read('window.__agentmuxMonacoModelCount()'),originalModelCount,'Mode changes do not retain additional models')
      }
      const originalFields = await read(`Array.from(${node(pane+' .toolkit-editor')}.querySelectorAll('input:not([type=radio])')).map(n=>({type:n.type,value:n.value,checked:n.checked}))`)
      const editScript = async value => {
        await click(node(scriptOwner))
        assert.equal(await read(`${node(scriptOwner)}.contains(document.activeElement)`),true,'The original Monaco input owns keyboard focus')
        await until('window.settingsHomeProbe.toolkitEditor.focused()','The original Monaco text input is focused')
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['meta']})
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['meta']})
        await until('window.settingsHomeProbe.toolkitEditor.selectedAll()','Trusted Select All covers the current model before replacement')
        await win.webContents.insertText(value)
        await settle()
        const observed = await read('({draft:window.settingsHomeProbe.toolkitDraft,model:window.settingsHomeProbe.toolkitEditor.value(),uri:window.settingsHomeProbe.toolkitEditor.uri()})')
        result.interactions.push({kind:'toolkit-draft-observation',...observed})
        assert.equal(observed.model,value,'The original Monaco editor accepts the complete draft')
        assert.equal(observed.draft.value,value,'The original settings draft receives the complete editor text')
      }
      await choose(pane+' .toolkit-editor__mode input[value="tui"]')
      await until(`!!${node(pane+' .toolkit-editor__script[aria-label="Shell command"] .view-lines')}`)
      assert.equal(await read(`${node(pane+' .toolkit-editor__mode input[value="tui"]')}.checked`),true)
      assert.equal(await read(`${node(pane+' .toolkit-editor__run')}===null`),true,'An unsaved TUI draft cannot run from the script action')
      assert.equal(await read(`${node(pane+' .toolkit-editor__result-actions')}===null&&${node(pane+' .toolkit-editor__display')}===null`),true,'TUI uses its own command rather than script result/display actions')
      assert.match(await read(`${node(pane+' .toolkit-editor')}.textContent`),/Saving changes does not restart the current terminal/)
      await until(`${node(scriptOwner+' .view-lines')}?.textContent.replace(/\\u00a0/g,' ').replace(/\\u200b/g,'').trim()==='exec /bin/sh'`,'The original new-tool TUI conversion supplies its shell default')
      const shellDraft = "printf 'Settings preview\\n'\n"
      await editScript(shellDraft)
      if(mode!=='toolkit-model') await inspectDraft('tui',shellDraft)
      await click(node(pane+' .toolkit-editor__scope > summary'))
      assert.match(await read(`${node(pane+' .toolkit-editor__scope')}.textContent`),/not sandboxed/)
      await click(node(pane+' .toolkit-editor__arguments > summary'))
      assert.match(await read(`${node(pane+' .toolkit-editor__arguments')}.textContent`),/separate shell positional arguments/)
      for (const [width,height,size] of mode==='toolkit-model'?[]:[[1440,940,'wide'],[500,840,'compact']]) {
        await resize(width,height)
        for (const color of ['dark','light']) {
          await theme(color)
          await captureSegments(`toolkit-tui-draft-${size}-${color}`,id,color)
        }
      }
      await resize(1440,940); await theme('dark')
      await choose(pane+' .toolkit-editor__mode input[value="script"]')
      await until(`!!${node(pane+' .toolkit-editor__script[aria-label="JavaScript script"] .view-lines')}`)
      await until(`window.settingsHomeProbe.toolkitDraft.mode==='script'&&window.settingsHomeProbe.toolkitEditor.node()?.isConnected`)
      await settle()
      assert.equal(await read('window.settingsHomeProbe.toolkitEditor.value()'),shellDraft,'Changing the type preserves the command draft until explicitly edited')
      await inspectDraft('script',shellDraft)
      for(let round=0;round<2;round++) {
        await choose(pane+' .toolkit-editor__mode input[value="tui"]'); await inspectDraft('tui',shellDraft)
        await choose(pane+' .toolkit-editor__mode input[value="script"]'); await inspectDraft('script',shellDraft)
      }
      const continuedDraft = shellDraft+"// draft retained\n"
      await editScript(continuedDraft); await inspectDraft('script',continuedDraft)
      await click(node('[data-tool-id="performance"]'))
      await click(node(`[data-tool-id="${originalToolId}"]`))
      await until(`!!window.settingsHomeProbe.toolkitEditor.node()?.isConnected`)
      await inspectDraft('script',continuedDraft)
      await editScript(originalScript)
      await inspectDraft('script',originalScript)
      await click(node(pane+' .toolkit-editor__scope > summary'))
      await click(node(pane+' .toolkit-editor__arguments > summary'))
      assert.equal(await read(`${node(pane+' .toolkit-editor__mode input[value="script"]')}.checked`),true)
      assert.deepEqual(await read(`Array.from(${node(pane+' .toolkit-editor')}.querySelectorAll('input:not([type=radio])')).map(n=>({type:n.type,value:n.value,checked:n.checked}))`),originalFields,'Type review preserves the other original fields')
      assert.equal(await read('window.settingsHomeProbe.saves.length'),saves,'TUI draft review never saves configuration')
      assert.deepEqual(await read('window.settingsHomeProbe.toolkitOperations'),[],'Reviewing a Toolkit draft does not execute or persist it')
      result.interactions.push({kind:'toolkit-tui-draft-roundtrip',typedThrough:'original Monaco trusted keyboard',tuiDraft:shellDraft,restoredScript:originalScript,restoredMode:'script',implicitSaves:0,toolkitOperations:await read('window.settingsHomeProbe.toolkitOperations'),modelCount:originalModelCount,documentUri:originalModelUri,execution:'no run action; unsaved new tool'})
    }
    assert.equal(await read('window.settingsHomeProbe.saves.length'),saves,'Page interaction does not implicitly save configuration')
    assert.ok(result.interactions.length>before,'Every reviewed page consumes actual input: '+id)
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
    await win.loadFile(html,mode==='concept-intros'?{query:{conceptIntros:'true'}}:undefined)
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
    if (mode==='concept-intros') { await conceptIntroductions(); result.passed=true; return }
    if (mode==='navigation') { await disclosureGeometry(); result.passed=true; return }
    if (mode==='lark-navigation') { await nav('lark'); await larkInteractions(true); result.passed=true; return }
    if (mode==='provider-scroll') { await providerScroll(); result.passed=true; return }
    if (mode==='takeover-scroll') { await theme('dark'); await takeoverReachability(); result.passed=true; return }
    if (mode==='preview-return') {
      const id=selected.find(id=>id==='focus'||id==='browser-agent-control')
      assert.ok(id,'A preview mutation selects an original preview page')
      await nav(id); await theme('dark')
      await previewRoundTrip(id,id==='focus'?'agent-reading':'fine-tuning',id==='focus'?'input[name="focus-recent-inputs"][value="6"]':'[data-settings-field="pointerDurationMs"] input')
      result.passed=true; return
    }
    if (mode==='toolkit-model') { await nav('toolkit'); await theme('dark'); await pageInteractions('toolkit'); result.passed=true; return }
    if (mode==='focus-content') { await nav('focus'); await theme('dark'); await focusContentSize(); result.passed=true; return }
    if(selected.includes('agents')&&selected.includes('continuity')) {
      const initialSaves=await read('window.settingsHomeProbe.saves.length')
      await resize(1440,940);await theme('dark')
      assert.deepEqual(await read(`Array.from(document.querySelectorAll('[data-settings-group-toggle]')).slice(0,2).map(n=>n.textContent.trim())`),['Preferences','Agents'],'Agent setup is a normal group after Preferences')
      assert.deepEqual(await read(`Array.from(document.querySelectorAll('#settings-nav-agents [data-settings-target]')).map(n=>({id:n.dataset.settingsTarget,title:n.textContent.trim()}))`),[{id:'agents',title:'Agent CLIs'},{id:'continuity',title:'Session recovery'}],'The Agent group names its original CLI and recovery editors')
      assert.equal(await read(`${node('[data-settings-directory] [data-settings-group="agents"] header h3')}.textContent`),'Agents')
      for(const color of ['dark','light']) { await theme(color);await capture('agents-navigation-expanded-'+color,'overview',color,'Agent group expanded') }
      await theme('dark');await nav('continuity')
      const pane='[data-settings-pane="continuity"]'
      const summary=pane+' [data-continuity-retry-settings] > summary'
      if(!await read(`${node(pane+' [data-continuity-retry-settings]')}.open`)) await click(node(summary))
      const field='[aria-label="Additional retries"]'
      const before=await read(`${node(field)}.value`), draft=before==='7'?'8':'7'
      await fill(field,draft);await read(`window.originalAgentRecoveryField=${node(field)}`)
      await click(node('[data-settings-group-toggle="agents"]'))
      assert.equal(await read(`${node('[data-settings-group-toggle="agents"]')}.getAttribute('aria-expanded')`),'false')
      await capture('agents-navigation-collapsed','continuity','dark','Collapsed group retains the active recovery editor')
      await fill('[aria-label="Search settings"]','execution')
      await until(`!!${node('[data-settings-search-section="continuity"]')}`)
      assert.equal(await read(`${node('[data-settings-search-section="continuity"] strong')}.textContent`),'Session recovery')
      await capture('agents-navigation-recovery-search','search','dark','Original execution search finds Session recovery')
      await click(node('[data-settings-search-section="continuity"]'))
      await click(node('[aria-label="Clear settings search"]'))
      assert.equal(await read(`${node(field)}===window.originalAgentRecoveryField`),true,'Navigation retains the original recovery field')
      assert.equal(await read(`${node(field)}.value`),draft,'Navigation retains the original recovery draft')
      await fill(field,before)
      await fill('[aria-label="Search settings"]','agents')
      await until(`!!${node('[data-settings-search-section="agents"]')}`)
      assert.equal(await read(`${node('[data-settings-search-section="agents"] strong')}.textContent`),'Agent CLIs')
      await click(node('[data-settings-search-section="agents"]'))
      assert.equal(await title(),'Agent CLIs')
      await click(node('[aria-label="Clear settings search"]'))
      await resize(500,840);await nav('agents')
      for(const color of ['dark','light']) {
        await theme(color);await click(node('.settings-section-picker'))
        await until(`!!${node('[role="menuitemradio"]')}`)
        assert.ok(await read(`Array.from(document.querySelectorAll('.settings-section-menu__label')).some(n=>n.textContent==='Agents')`),'Compact navigation includes the same Agent group heading')
        for(const label of ['Agent CLIs','Session recovery'])assert.ok(await read(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).some(n=>n.textContent.trim()===${JSON.stringify(label)})`))
        await capture('agents-navigation-menu-'+color,'agents',color,'Compact Agent group')
        await key('Escape')
      }
      assert.equal(await read('window.settingsHomeProbe.saves.length'),initialSaves,'Regrouping navigation never saves configuration')
      result.interactions.push({kind:'agent-navigation-group',items:['agents','continuity'],labels:['Agent CLIs','Session recovery'],aliases:['agents','execution'],sameRecoveryField:true,recoveryDraftPreserved:true,implicitSaves:0})
      await resize(1440,940);await theme('dark');await nav('overview')
    }
    await until(`${node('.settings-overview__art')}.complete&&${node('.settings-overview__art')}.naturalWidth>0`,'The actual Overview artwork is decoded before its normal visual baseline')
    for (const [width,height,label] of [[1440,940,'wide'],[900,620,'short'],[500,840,'compact'],[320,700,'narrow']]) {
      await resize(width,height)
      for (const mode of ['dark','light']) {
        await theme(mode)
        await read('document.querySelector("[data-settings-overview]").scrollTop=0')
        await capture(`home-${label}-${mode}`,'overview',mode)
        const first = await hit(node('[data-settings-shortcut]'),false)
        if (width<=500) {
          const tops = await read(`Array.from(document.querySelectorAll('[data-settings-shortcut] strong')).map(n=>n.getBoundingClientRect().top)`)
          assert.ok(Math.max(...tops)-Math.min(...tops)<=1,'Compact shortcut titles share one baseline')
        }
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
      for (const mode of ['dark','light']) {
        await theme(mode)
        await captureSegments(`page-${entry.id}-${mode}`,entry.id,mode)
        if (entry.id === 'mote') await moteStoryScenes(`page-mote-${mode}`, mode)
      }
    }
    await theme('dark')
    for (const {id} of reviewCatalog) {
      await nav(id); await pageInteractions(id)
      result.events = await read('window.settingsHomeProbe.events')
      result.completedInputPages ??= []
      result.completedInputPages.push(id)
      checkpoint('original-inputs-complete:' + id)
    }
    for (const {id} of reviewCatalog) {
      await resize(500,840); await nav(id)
      for (const color of ['dark','light']) {
        await theme(color)
        await captureSegments(`page-${id}-compact-${color}`,id,color)
        if (id === 'mote') await moteStoryScenes(`page-mote-compact-${color}`, color)
        if (id==='appearance') {
          const palette = await read(`Array.from(document.querySelectorAll('.terminal-theme-choice')).map(n=>n.getBoundingClientRect().toJSON())`)
          assert.ok(palette.length>1&&Math.abs(palette[0].top-palette[1].top)<=1&&palette[1].left>palette[0].right,'Compact terminal palettes remain comparable in two columns')
          const sample = await read(`(() => { const s=getComputedStyle(document.querySelector('.terminal-theme-preview__composer')); return {foreground:s.color,background:s.backgroundColor} })()`)
          const luminance = value => {
            const channels = value.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{const c=n/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4})
            return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722
          }
          const l=[luminance(sample.foreground),luminance(sample.background)].sort((a,b)=>a-b)
          assert.ok((l[1]+.05)/(l[0]+.05)>=4.5,'Workspace terminal sample text keeps readable contrast in either brightness')
          result.interactions.push({kind:'terminal-palette-contrast',theme:color,...sample,contrast:(l[1]+.05)/(l[0]+.05)})
        }
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
          const tabs = await read(`Array.from(${node('[data-settings-pane="hosts"] .remote-detail-tabs')}.children).map(item => { const r = item.getBoundingClientRect(); return {top:r.top, bottom:r.bottom} })`)
          assert.equal(tabs.length,4,'The compact Host keeps every original section')
          assert.ok(tabs.every(tab=>Math.abs(tab.top-tabs[0].top)<1),'Compact Host sections stay on one row')
          await captureSegments('page-hosts-compact-detail-'+color,id,color)
          await click(node('[data-settings-pane="hosts"] .settings-resource-back'))
          assert.equal(await read(`${node('[data-settings-pane="hosts"] [data-resource-view]')}.dataset.resourceView`),'library')
          assert.equal(await read(`${node('[data-settings-pane="hosts"] .settings-resource-back')} === null`),true,'The Host library has no redundant return action')
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
    // Audit the original progressive disclosures after the normal task flow.
    // Only real summary clicks are used; no setting is saved or external action invoked.
    for (const {id} of reviewCatalog) {
      await resize(1440,940); await nav(id); await theme('dark')
      const pane=node(`[data-settings-pane="${id}"]`), opened=[]
      const saves=await read('window.settingsHomeProbe.saves.length')
      for (let step=0;step<80;step++) {
        const summary=`Array.from(${pane}.querySelectorAll('details:not([open]) > summary')).find(n=>n.checkVisibility())`
        if (!await read(`!!(${summary})`)) break
        const label=await read(`(${summary}).textContent.trim()`)
        await click(summary)
        opened.push(label)
        assert.ok(step<79,'Every applicable original disclosure is reached without an unbounded loop')
      }
      result.interactions.push({kind:'page-disclosure-audit',page:id,opened,actions:opened.length,implicitSaves:0})
      assert.equal(await read('window.settingsHomeProbe.saves.length'),saves,'Reviewing disclosures never saves configuration')
      if (opened.length) for (const [width,height,size] of mode==='toolkit-model'?[]:[[1440,940,'wide'],[500,840,'compact']]) {
        await resize(width,height)
        for (const color of ['dark','light']) {
          await theme(color)
          await captureSegments(`page-${id}-expanded-${size}-${color}`,id,color)
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
    assert.equal(await title(),'Agent CLIs','Actual Avatar direct entry bypasses Home')
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
      result.lark = await read('({boundary:window.settingsHomeProbe?.larkPreview?.boundary,calls:window.settingsHomeProbe?.larkPreview?.calls,credentialWrites:window.settingsHomeProbe?.larkPreview?.credentialWrites})').catch(String)
    }
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(result,null,2))
    win?.destroy(); app.exit(result.passed?0:1)
  }
})
