const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, root, evidence, proof] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
let win
const report = { passed: false, frames: [], scenarios: [], userRunTouched: false, console: [], runtime: process.versions }
const evaluate = source => win.webContents.executeJavaScript(source)
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression) {
  const end = Date.now() + 9000
  while (Date.now() < end) { if (await evaluate(expression)) return; await delay(30) }
  assert.fail('Actual Renderer fact absent: ' + expression)
}
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(100) }
async function viewport(width,height) {
  if(proof.startsWith('connector-'))win.setContentSize(width,height)
  else await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
  await paint()
}
async function pointer(expression,button='left',hover=false) {
  const point=await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Actual control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(6,r.height/2)}})()`)
  for(const type of hover?['mouseMoved']:['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:hover?'none':button,clickCount:1})
  await paint()
}
async function escape() { for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await paint() }
async function settle() {
  await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`)
  await paint()
}
async function frame(name,width) {
  // Capture the settled menu/surface, not an intermediate entry transition.
  await settle()
  const file=name+'.png', png=(await win.webContents.capturePage()).toPNG()
  assert.ok(png.length>0);await fs.writeFile(path.join(evidence,file),png);report.frames.push({name,width,file})
}
async function terminalFacts() {
  return evaluate(`(()=>{const s=${surface},t=s.querySelector('.terminal-view__xterm'),b=t.getBoundingClientRect(),m=s.querySelector('.agent-region-header__more'),c=s.closest('.workbench-region').querySelector(':scope > .workbench-region__close');return{terminal:terminalNotice.terminal(),box:{x:b.x,y:b.y,width:b.width,height:b.height},resizes:terminalNotice.facts().resizes.length,state:terminalNotice.facts(),buttons:[m,c].map(e=>{const r=e.getBoundingClientRect(),a=getComputedStyle(e),p=getComputedStyle(e,'::before');return{box:{x:r.x,y:r.y,width:r.width,height:r.height},background:a.backgroundColor,paintHeight:p.height}})}})()`)
}
function stable(before,after) {
  assert.equal(after.terminal.id,before.terminal.id,'The original actual xterm is retained')
  assert.deepEqual(after.box,before.box,'Notice and hover keep the original Terminal viewport')
  assert.equal(after.terminal.rows,before.terminal.rows);assert.equal(after.terminal.cols,before.terminal.cols)
  assert.equal(after.resizes,before.resizes,'Chrome does not issue a Runtime resize')
  for(const key of ['sessions','tab','layout','drafts']) assert.deepEqual(after.state[key],before.state[key],'Original '+key+' retained')
}
async function terminalScene(width) {
  report.stage={proof:'terminal',width}
  await viewport(width*2+1,740); await evaluate(`terminalChrome.workbench();terminalNotice.seed('healthy')`)
  await wait(`Boolean(${surface}?.querySelector('.xterm-helper-textarea')) && !${surface}.querySelector('.terminal-view__xterm--hydrating')`);await delay(350);await paint()
  const before=await terminalFacts()
  assert.equal(before.buttons.length,2); assert.ok(before.terminal.rows>15)
  for(const selector of [`.agent-region-header__more`,`:scope > .workbench-region__close`]) {
    const target=selector.startsWith(':scope')?`${surface}.closest('.workbench-region').querySelector(${JSON.stringify(selector)})`:`${surface}.querySelector(${JSON.stringify(selector)})`
    await pointer(target,'left',true);const hovered=await terminalFacts();stable(before,hovered)
    assert.deepEqual(hovered.buttons.map(b=>b.box),before.buttons.map(b=>b.box),'Hover retains each control hitbox')
    for(const button of hovered.buttons) {assert.equal(button.background,'rgba(0, 0, 0, 0)','Hover preserves the transparent hitbox');assert.equal(button.paintHeight,'16px','Hover paint remains inside the quiet glyph band')}
  }
  await evaluate('terminalNotice.observed(true)');await wait(`Boolean(${surface}.querySelector('.terminal-service-window'))`);await paint()
  const notified=await terminalFacts();stable(before,notified)
  assert.equal(await evaluate(`getComputedStyle(${surface}.querySelector('.terminal-service-window')).position`),'absolute','Notices stay outside vertical flow')
  await frame('terminal-'+width+'-notice',width)
  const trigger=`${surface}.querySelector('.terminal-service-window .service-disclosure__trigger')`
  await pointer(trigger);await wait(`Boolean(${surface}.querySelector('[popover]:popover-open'))`)
  assert.ok(await evaluate(`${surface}.querySelector('[popover]').innerText.length>80`),'Complete original recovery facts remain available')
  await frame('terminal-'+width+'-details',width);await escape();stable(before,await terminalFacts())
  await evaluate('terminalChrome.alternate()');await wait(`terminalNotice.terminal().visibleLines.some(s=>s.includes('Live full-screen application'))`)
  assert.equal(await evaluate(`Boolean(${surface}.querySelector('.terminal-replay-gap--compact'))`),false,'Full-screen history has no permanent central banner')
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`,'right')
  await wait(`Boolean(document.querySelector('.terminal-context-menu [role="note"]'))`)
  const notes=await evaluate(`[...document.querySelectorAll('.terminal-context-menu [role="note"]')].map(e=>e.textContent)`)
  assert.ok(notes.length>0); assert.ok(notes.some(n=>n.includes('The full-screen buffer has no terminal scrollback')),'The actual buffer boundary is available on demand')
  await frame('terminal-'+width+'-buffer-menu',width);await escape()
  const writes=await evaluate('terminalNotice.facts().writes.length')
  await evaluate(`${surface}.querySelector('.xterm-helper-textarea').focus()`)
  for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'q',code:'KeyQ',windowsVirtualKeyCode:81,...(type==='keyDown'?{text:'q'}:{})})
  await wait('terminalNotice.facts().writes.length>'+writes)
  assert.equal(await evaluate('terminalNotice.facts().writes.at(-1).data'),'q','Healthy Terminal still accepts actual trusted input')
  await pointer(`${surface}.querySelector('.agent-region-header__more')`)
  await wait(`Boolean(document.querySelector('.agent-region-menu'))`)
  assert.equal(await evaluate(`[...document.querySelectorAll('.agent-region-menu [role="menuitem"]')].filter(e=>e.textContent==='Conversation history').length`),1,'The original unique history entry remains reachable')
  await escape();report.scenarios.push({width,before,notified,notes,passed:true})
}
async function connectorFacts() {
  const facts = await terminalFacts()
  return { ...facts, ...await evaluate(`(()=>{const s=${surface},b=s.querySelector('.agent-body'),v=s.querySelector('.terminal-view'),screen=s.querySelector('.xterm-screen'),header=s.querySelector('.agent-region-header');const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};return{devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},canvases:[...screen.querySelectorAll('canvas')].map(e=>({box:rect(e),pixels:{width:e.width,height:e.height}})),surface:rect(s),body:rect(b),view:rect(v),screen:rect(screen),header:rect(header),name:rect(header.querySelector('.agent-region-header__name')),headerPaint:getComputedStyle(header,'::before').height,reading:terminalChrome.reading(),connectors:[...s.querySelectorAll('[data-channel-entry]')].map(e=>{const style=getComputedStyle(e),pseudo=getComputedStyle(e,'::before');return{channel:e.dataset.channelEntry,state:e.dataset.channelState,box:rect(e),glyph:rect(e.querySelector('img,svg')),glyphFilter:getComputedStyle(e.querySelector('img,svg')).filter,glyphOpacity:getComputedStyle(e.querySelector('img,svg')).opacity,imageLoaded:e.querySelector('img')?.complete&&e.querySelector('img').naturalWidth>0,marker:e.querySelector('.agent-region-header__connector-marker')?rect(e.querySelector('.agent-region-header__connector-marker')):null,background:style.backgroundColor,focused:e===document.activeElement,focusVisible:e.matches(':focus-visible'),outline:style.outlineStyle,outlineWidth:style.outlineWidth,paint:{content:pseudo.content,background:pseudo.backgroundColor,height:pseudo.height}}}),reads:terminalChrome.connectorReads()}})()`) }
}
function connectorGeometry(facts) {
  const bandBottom=facts.header.y+parseFloat(facts.headerPaint)
  assert.ok(facts.canvases.length>0,'The actual Terminal canvas is nonempty')
  for(const canvas of facts.canvases){assert.equal(canvas.pixels.width,Math.round(canvas.box.width*facts.devicePixelRatio),'The native Terminal canvas and CSS width share the actual device scale');assert.equal(canvas.pixels.height,Math.round(canvas.box.height*facts.devicePixelRatio),'The native Terminal canvas and CSS height share the actual device scale')}
  assert.equal(facts.screen.y,bandBottom,'The first row follows the original quiet band without extra full-width inset')
  assert.ok(facts.name.bottom<=facts.screen.y,'The original name cannot cover first-row cells')
  for(const entry of facts.connectors) {
    assert.equal(entry.box.width,22);assert.equal(entry.box.height,22,'The original connector hit target remains usable')
    assert.equal(entry.glyph.width,12);assert.equal(entry.glyph.height,12,'The visible glyph fits the quiet information band')
    assert.equal(entry.background,'rgba(0, 0, 0, 0)','The connector has no extra hover background box')
    assert.equal(entry.paint.content,'none','There is no stacked connector hover paint layer')
    assert.ok(entry.glyph.bottom<=bandBottom,'The channel glyph stays inside the original paint band')
    if(entry.marker){assert.equal(entry.marker.height,8);assert.equal(entry.marker.width,8);assert.ok(entry.marker.bottom<=bandBottom,'The status marker stays inside the original paint band')}
  }
}
async function connectorScene(width) {
  report.stage={proof:'connector-geometry',width}
  await viewport(width*2+1,740);await evaluate(`terminalChrome.workbench();terminalNotice.seed('healthy');terminalChrome.connectors()`)
  await wait(`Boolean(${surface}?.querySelector('.xterm-helper-textarea')) && !${surface}.querySelector('.terminal-view__xterm--hydrating')`)
  await wait(`${surface}.querySelectorAll('[data-channel-entry]').length===2`);await delay(350);await paint()
  await wait(`${surface}.querySelectorAll('[data-channel-state="unbound"]').length===2`)
  // The retained fixture initially focuses its neighbor. Select the actual owner once
  // before comparing chrome interactions, so a normal first-row click is not a layout failure.
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`)
  const unbound=await connectorFacts()
  await evaluate('terminalChrome.hostingUnavailable()')
  await wait(`${surface}.querySelectorAll('.agent-region-header__connector-marker').length===2`)
  const before=await connectorFacts();assert.equal(before.connectors.length,2);assert.ok(before.terminal.baseY>0,'The actual original xterm has nonempty scrollback')
  const scenario={width,unbound,before,passed:false};report.scenarios.push(scenario)
  if(proof!=='connector-baseline')connectorGeometry(before)
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`,'left',true)
  const hovered=await connectorFacts();stable(before,hovered)
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`)
  await wait(`Boolean(document.querySelector('.connector-header-menu'))`)
  const opened=await connectorFacts();stable(before,opened)
  await escape();const closed=await connectorFacts();stable(before,closed)
  assert.equal(closed.connectors[0].focused,true,'Escape returns focus to the exact original channel')
  assert.equal(closed.connectors[0].focusVisible,true,'Keyboard focus remains visible')
  assert.notEqual(closed.connectors[0].outline,'none');assert.ok(parseFloat(closed.connectors[0].outlineWidth)>0)
  for(const facts of [unbound,hovered,opened,closed]) {
    if(proof!=='connector-baseline')connectorGeometry(facts)
    assert.deepEqual(facts.connectors.map(entry=>entry.box),before.connectors.map(entry=>entry.box),'Hover, focus and open retain the original hit targets')
    assert.deepEqual(facts.header,before.header,'Hover, focus and open do not move the original header')
    assert.deepEqual(facts.buttons.map(button=>button.box),before.buttons.map(button=>button.box),'Adjacent More and X controls do not move')
  }
  const screen=before.screen,cellWidth=screen.width/before.terminal.cols,cellHeight=screen.height/before.terminal.rows
  const firstRow={x:screen.x,y:screen.y,width:screen.width,height:cellHeight,text:before.terminal.visibleLines[0]}
  assert.ok(firstRow.text.startsWith('Original terminal history'),'The first row contains original retained text')
  // Native drag across actual first-row cells; no DOM selection or synthetic xterm selection API.
  const start={x:screen.x+cellWidth*.2,y:screen.y+cellHeight*.5},end={x:screen.x+cellWidth*17.2,y:start.y}
  for(const event of [{type:'mouseMoved',...start,button:'none'},{type:'mousePressed',...start,button:'left',clickCount:1},{type:'mouseMoved',...end,button:'left',buttons:1},{type:'mouseReleased',...end,button:'left',clickCount:1}])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',event)
  await paint();const selected=await connectorFacts();stable(before,selected)
  scenario.selected=selected;scenario.firstRow=firstRow
  assert.ok(selected.reading.selection.startsWith('Original'),'Native first-row drag selects original text')
  assert.ok(firstRow.text.includes(selected.reading.selection.trim()),'The selection belongs to the original first row')
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`,'left',true)
  await wait('Boolean(document.querySelector(".connector-header-menu"))')
  // Pin the disclosure's existing focus owner before sending its keyboard dismissal.
  // A hover alone deliberately leaves the original Terminal keyboard focus intact.
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`)
  await wait('Boolean(document.activeElement?.closest(".connector-header-menu"))')
  await escape()
  await frame('connector-'+width+'-first-row',width)
  const wheelPoint={x:screen.x+screen.width/2,y:screen.y+cellHeight*5}
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...wheelPoint,button:'none'})
  await wait('!document.querySelector(".connector-header-menu")')
  assert.equal(await evaluate(`${surface}.querySelector('.terminal-view__xterm').contains(document.elementFromPoint(${wheelPoint.x},${wheelPoint.y}))`),true,'The native wheel reaches original Terminal cells outside controls and menus')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...wheelPoint,deltaX:0,deltaY:-180})
  await wait('terminalNotice.terminal().viewportY<'+before.terminal.viewportY)
  const scrolled=await connectorFacts();stable(before,scrolled)
  scenario.scrolled=scrolled
  assert.equal(scrolled.reading.buffer,before.reading.buffer,'Native wheel keeps the original buffer')
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`)
  assert.equal(await evaluate(`document.activeElement===${surface}.querySelector('.xterm-helper-textarea')`),true,'An ordinary text-area click still focuses the original Terminal')
  const after=await connectorFacts();stable(before,after)
  scenario.after=after
  assert.deepEqual(after.state.writes,before.state.writes,'Header, selection, wheel and click do not dispatch input bytes')
  assert.ok(after.reads.length>0&&after.reads.every(method=>['connection.ls','connection.binding.ls','connection.service.get'].includes(method)),'The fixture executed only the original bounded connection reads')
  Object.assign(scenario,{hovered,opened,closed,passed:true})
}
async function neutralFacts() {
  return { ...await connectorFacts(), ...await evaluate(`(()=>{const s=${surface},group=s.querySelector('.agent-region-header__channels'),menu=document.querySelector('.connector-header-menu');return{channelGroup:{gap:getComputedStyle(group).gap,width:group.getBoundingClientRect().width},popover:menu?{text:menu.innerText,padding:getComputedStyle(menu).padding,actions:[...menu.querySelectorAll('[role="menuitem"]')].map(node=>node.textContent.trim())}:null}})()`) }
}
function neutralPresentation(facts) {
  connectorGeometry(facts)
  assert.equal(facts.connectors.length,2,'Both real compiled platform contributions remain reachable')
  for(const entry of facts.connectors){assert.equal(entry.imageLoaded,true,'The original platform artwork is loaded');assert.equal(entry.glyphFilter,'grayscale(1)','Platform glyph stays grayscale through original observation and interaction states')}
  assert.equal(facts.channelGroup.gap,'0px','Adjacent channel entries have no redundant group gap')
  assert.equal(facts.channelGroup.width,44,'Two original 22px hit targets remain separate and compact')
  assert.equal(facts.connectors[1].box.x-facts.connectors[0].box.x,22)
  if(facts.popover)assert.equal(facts.popover.padding,'4px','The original popover has one compact outer inset')
}
async function neutralScene(width) {
  report.stage={proof:'connector-neutral',width}
  await viewport(width*2+1,740);await evaluate(`terminalChrome.workbench();terminalNotice.seed('healthy');terminalChrome.connectors(true)`)
  await wait(`${surface}.querySelectorAll('[data-channel-entry]').length===2 && !${surface}.querySelector('.terminal-view__xterm--hydrating')`)
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`)
  const loading=await neutralFacts(),scenario={width,states:[{name:'loading',facts:loading}],passed:false};report.scenarios.push(scenario)
  neutralPresentation(loading);assert.ok(loading.connectors.every(entry=>entry.state==='unknown'),'An original pending read remains unknown')
  await evaluate('terminalChrome.releaseConnectorRead()');await wait(`${surface}.querySelectorAll('[data-channel-state="unbound"]').length===2`)
  const unbound=await neutralFacts();neutralPresentation(unbound);stable(loading,unbound);scenario.states.push({name:'unbound',facts:unbound})
  async function close() {
    await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`)
    await wait('Boolean(document.activeElement?.closest(".connector-header-menu"))');await escape()
    await wait('!document.querySelector(".connector-header-menu")')
  }
  async function observe(name,state) {
    await evaluate('terminalChrome.connectorMode('+JSON.stringify(name)+')')
    await wait(`${surface}.querySelectorAll('[data-channel-state="${state}"]').length===2`)
    await wait(`${surface}.querySelectorAll('.conversation-sharing-notice__audience strong').length===2 && [...${surface}.querySelectorAll('.conversation-sharing-notice__audience strong')].every(node=>node.textContent==='Research discussion')`)
    await paint()
    const facts=await neutralFacts();neutralPresentation(facts)
    assert.equal(facts.terminal.id,unbound.terminal.id,'New observed sharing facts keep the original Terminal')
    for(const key of ['sessions','tab','layout','drafts'])assert.deepEqual(facts.state[key],unbound.state[key],'Original '+key+' remains across observed policies')
    scenario.states.push({name,facts});return facts
  }
  for(const [name,state]of [['linked','linked'],['paused','paused'],['off','off']])await observe(name,state)
  const linked=await observe('linked','linked')
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`,'left',true);await wait('Boolean(document.querySelector(".connector-header-menu"))')
  const linkedHover=await neutralFacts();neutralPresentation(linkedHover);stable(linked,linkedHover)
  assert.ok(linkedHover.popover.text.includes('Research discussion'),'The original named group is preserved in its popover')
  assert.ok(linkedHover.popover.actions.some(text=>text.includes('Manage group')),'The exact original group action remains reachable')
  await frame('neutral-'+width+'-linked',width);await close()
  const focused=await neutralFacts();neutralPresentation(focused);assert.equal(focused.connectors[0].focusVisible,true)
  scenario.states.push({name:'linked-hover',facts:linkedHover},{name:'focused',facts:focused})
  await evaluate('terminalChrome.hostingUnavailable()');await wait(`${surface}.querySelectorAll('[data-channel-state="unknown"]').length===2`)
  await paint()
  const unavailable=await neutralFacts();neutralPresentation(unavailable)
  // Escape suppressed the just-closed hover menu until the real pointer leaves.
  await pointer(`${surface}.querySelector('.terminal-view__xterm')`,'left',true)
  await pointer(`${surface}.querySelector('[data-channel-entry="feishu"]')`,'left',true);await wait('Boolean(document.querySelector(".connector-header-menu"))')
  const issueHover=await neutralFacts();neutralPresentation(issueHover);stable(unavailable,issueHover)
  assert.ok(issueHover.popover.text.includes('Research discussion'),'A failed observation keeps the exact original group')
  await frame('neutral-'+width+'-issue',width);await close()
  const after=await neutralFacts();stable(unavailable,after);assert.deepEqual(after.state.writes,unbound.state.writes,'Presentation and observation do not submit input bytes')
  const reads=['connection.ls','connection.binding.ls','connection.service.get','connection.metadata.get','connection.diagnose']
  assert.ok(after.reads.length>0&&after.reads.every(method=>reads.includes(method)),'No configuration, authority or delivery effect is dispatched')
  scenario.states.push({name:'unavailable',facts:unavailable},{name:'issue-hover',facts:issueHover});scenario.after=after;scenario.passed=true
}
async function loadingFacts() {
  return evaluate("(()=>{const s=document.querySelector('#loading-root .full-page-loading'),stage=s.querySelector('.full-page-loading__stage'),art=s.querySelector('img'),r=s.getBoundingClientRect(),b=stage.getBoundingClientRect(),nodes=[stage,art,s.querySelector('.full-page-loading__light'),...s.querySelectorAll('.full-page-loading__activity i')].filter(Boolean);return{appearance:document.documentElement.dataset.appearance,colorScheme:getComputedStyle(document.documentElement).colorScheme,phase:s.dataset.loadingPhase,busy:s.getAttribute('aria-busy'),role:s.getAttribute('role'),artLoaded:art?art.complete&&art.naturalWidth>0:null,artWidth:art?.getBoundingClientRect().width??null,artTransform:art?getComputedStyle(art).transform:null,hero:!!s.querySelector('.full-page-loading__atmosphere'),stage:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth,clientHeight:stage.clientHeight,scrollHeight:stage.scrollHeight,animations:nodes.map(e=>({name:getComputedStyle(e).animationName,iterations:getComputedStyle(e).animationIterationCount})),activity:s.querySelectorAll('.full-page-loading__activity').length,text:stage.innerText}})()")
}
async function recoveryScenes() {
  for(const [width,height,phase,scope,theme,reduced] of [
    [1440,900,'loading','app','dark',false],[1440,900,'recovering','app','light',false],
    [720,420,'parked','region','dark',false],[320,360,'parked','region','light',false],
    [720,420,'recovering','region','dark',false],[320,360,'recovering','region','light',false],
    [320,230,'failed','region','dark',false],[420,540,'connecting','region','dark',false],
    [720,420,'recovering','region','dark',true],[720,420,'loading','app','dark',true]]) {
    report.stage={width,height,phase,theme,reduced};await viewport(width,height)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]})
    await evaluate('terminalChrome.show('+JSON.stringify(phase)+','+JSON.stringify(scope)+','+JSON.stringify(theme)+')')
    if(scope==='app')await wait("document.querySelector('#loading-root img')?.complete")
    // A native disclosure retains its open state across viewport/theme changes.
    // Start each comparison collapsed through the actual control, not a DOM rewrite.
    if(await evaluate("Boolean(document.querySelector('#loading-root .full-page-loading__details')?.open)"))
      await pointer("document.querySelector('#loading-root .full-page-loading__details summary')")
    // Measure pointer invariants after the intentional finite entry has finished.
    await settle()
    const facts=await loadingFacts();assert.equal(facts.appearance,theme);assert.equal(facts.colorScheme,theme)
    if(scope==='app'){assert.equal(facts.hero,true);assert.equal(facts.artLoaded,true,'The original startup brand image is loaded');assert.ok(facts.artWidth>=width&&facts.artWidth<=width*1.08)}
    else {assert.equal(facts.hero,false,'Region recovery has no brand hero');assert.equal(facts.artLoaded,null)
      const light=await evaluate("(() => { const s=document.querySelector('#loading-root .full-page-loading'), a=getComputedStyle(s,'::before'); return {content:a.content,image:a.backgroundImage,pointer:a.pointerEvents} })()")
      assert.notEqual(light.content,'none','Actual Region light layer is nonempty')
      assert.ok(light.image.includes('radial-gradient'),'Region has quiet local lighting')
      assert.equal(light.pointer,'none','Decorative light cannot intercept recovery controls')
      facts.localLight=light
    }
    assert.ok(facts.text.length>50);assert.ok(facts.stage.top>=0&&facts.stage.bottom<=height+1,'Text stage stays inside the short viewport')
    assert.ok(facts.stage.left>=0&&facts.stage.right<=width+1);assert.equal(facts.scrollWidth,facts.clientWidth,'Long content wraps without horizontal overflow')
    assert.ok(facts.animations.length>0,'Actual content stage is nonempty');assert.ok(facts.animations.every(a=>a.iterations!=='infinite'),'There is no looping decorative motion')
    if(phase==='parked'||phase==='failed'){assert.equal(facts.busy,'false','Parked and failed states are not busy');assert.equal(facts.activity,0)}
    else {assert.equal(facts.busy,'true');assert.equal(facts.activity,1)}
    if(scope==='app'){
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:width*.84,y:height*.28,button:'none'});await delay(240)
      const moved=await loadingFacts();assert.deepEqual(moved.stage,facts.stage,'Mouse interaction never moves startup content')
      if(reduced){assert.equal(moved.artTransform,'none','Reduced motion keeps art static');assert.ok(moved.animations.every(a=>a.name==='none'),'Reduced motion renders a complete static surface')}
      else {assert.notEqual(moved.artTransform,facts.artTransform,'Actual pointer changes decorative depth');await frame('startup-pointer-'+theme,width)}
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:-2,y:-2,button:'none'});await delay(240)
      assert.equal(await evaluate("document.querySelector('#loading-root .full-page-loading').style.getPropertyValue('--startup-offset-x')"),'','Pointer leaving returns startup to its resting light')
    }
    if(phase==='failed'){
      await evaluate("document.querySelector('#loading-root button').scrollIntoView({block:'nearest'})");await paint()
      await pointer("document.querySelector('#loading-root button')");assert.equal(await evaluate('window.recoveryClicks'),1,'Original caller recovery action stays clickable')
    }
    await frame('recovery-'+width+'-'+phase+'-'+theme+(reduced?'-reduced':''),width)
    if(scope==='region'&&phase==='recovering'){
      const details="document.querySelector('#loading-root .full-page-loading__details')"
      await pointer(details+'.querySelector("summary")')
      const retained=await evaluate(details+'.innerText')
      const identity=await evaluate('terminalChrome.identity()')
      assert.ok(retained.includes(identity.label)&&retained.includes(identity.runId),'Restoring details expose controlled original Session and Run facts')
      assert.equal(await evaluate(details+'.open'),true,'Native details opens through its original control')
      await frame('recovery-'+width+'-recovering-'+theme+(reduced?'-reduced':'')+'-details',width)
      report.scenarios.push({width,height,phase,scope,theme,reduced,retained,identity,detailsOpen:true,passed:true})
    }
    report.scenarios.push({width,height,phase,scope,theme,reduced,facts,passed:true})
  }
  await viewport(1281,740);await evaluate("terminalChrome.workbench();terminalNotice.seed('healthy')");await wait('Boolean('+surface+".querySelector('.xterm'))")
  const before=await evaluate('terminalNotice.facts()');await evaluate('terminalChrome.park()');await wait('Boolean('+surface+'.querySelector(\'[data-loading-phase="parked"]\'))');await paint()
  const after=await evaluate('terminalNotice.facts()')
  for(const key of ['tab','layout','drafts'])assert.deepEqual(after[key],before[key],'Real SessionPane retains original '+key)
  assert.equal(await evaluate(surface+'.querySelector(\'[data-loading-phase="parked"]\').getAttribute("aria-busy")'),'false')
  assert.equal(await evaluate(surface+".querySelector('[data-loading-phase=parked] img')!==null"),false)
  await pointer(surface+".querySelector('.full-page-loading__details summary')")
  const detail=await evaluate(surface+".querySelector('.full-page-loading__details').innerText")
  assert.ok(detail.includes('Retained Run')&&detail.includes(before.sessions[0].control.run.runId),'Original retained identity is available on demand')
  await frame('recovery-actual-session-pane',640);report.parkedCaller={passed:true,before,after,detail}
}
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{backgroundThrottling:false,sandbox:false}})
    win.webContents.on('console-message', details => { if(details.level==='error') report.console.push({message:details.message,sourceId:details.sourceId,lineNumber:details.lineNumber}) })
    await win.loadFile(html,{query:proof.startsWith('connector-')?{'connector-geometry':'true'}:{}});win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait('Boolean(window.terminalChrome)')
    if(proof==='recovery') await recoveryScenes();else if(proof==='connector-neutral')for(const width of [640,320])await neutralScene(width);else if(proof.startsWith('connector-'))for(const width of [640,320])await connectorScene(width);else for(const width of [640,320])await terminalScene(width)
    assert.ok(report.scenarios.length>0);report.passed=true
  } catch(error) {report.failure={name:error.name,message:error.message,stack:error.stack,stage:report.stage}}
  finally {await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(report,null,2));win?.destroy();app.exit(report.passed?0:1)}
})
