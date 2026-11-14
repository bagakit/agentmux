const assert = require('node:assert/strict')

module.exports = async function neutralSurfaces({win,read,click,frame,until,settle,result,key}) {
  const evaluate=(fn,...args)=>read('('+fn.toString()+')(...'+JSON.stringify(args)+')')
  const selected='alpha-working',neighbor='alpha-survey'
  const selector=id=>'.focus-context[data-session-id="'+id+'"]'
  const card=id=>evaluate(id=>{
    const e=document.querySelector('.focus-context[data-session-id="'+id+'"]')
    if(!e)throw Error('Missing original card '+id)
    const outer=e.closest('[data-focus-card-key]'),inner=e.closest('.focus-context-card'),r=e.getBoundingClientRect(),s=getComputedStyle(e),o=getComputedStyle(outer),title=e.querySelector('.focus-context__identity strong,.focus-context__copy > strong')
    return {id,pressed:e.getAttribute('aria-pressed'),selected:e.classList.contains('is-selected'),outerSelected:outer.dataset.focusAgentSelected,outerHover:outer.matches(':hover'),focusVisible:e.matches(':focus-visible'),active:document.activeElement===e,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),rect:{x:r.x,y:r.y,width:r.width,height:r.height},layout:{left:outer.offsetLeft,top:outer.offsetTop,width:outer.offsetWidth,height:outer.offsetHeight},body:{background:s.backgroundColor,shadow:s.boxShadow,outline:s.outline,outlineWidth:s.outlineWidth},outer:{background:o.backgroundColor,shadow:o.boxShadow,outline:o.outline},innerShadow:inner===outer?null:getComputedStyle(inner).boxShadow,titleWeight:title?getComputedStyle(title).fontWeight:null}
  },id)
  const selection=()=>evaluate(()=>[...document.querySelectorAll('.focus-context.is-selected[data-session-id]')].map(e=>e.dataset.sessionId).sort())
  const layout=async()=>Object.fromEntries(await Promise.all([selected,neighbor].map(async id=>[id,(await card(id)).layout])))
  const scrolls=()=>evaluate(()=>[...document.querySelectorAll('.focus-project-lanes__rows,.global-focus-main,.recent-focus__viewport')].map(e=>({className:e.className,top:e.scrollTop,left:e.scrollLeft,height:e.clientHeight,scrollHeight:e.scrollHeight})))
  const unchangedLayout=async(before,label)=>assert.deepEqual(await layout(),before,label)
  const move=async id=>{
    const c=await card(id);assert.ok(c.hit,'Original hover target already visible')
    const x=c.rect.x+c.rect.width/2,y=c.rect.y+c.rect.height/2
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y})
    await settle();result.nativeInputs.push({type:'hover',id,x,y,before:c,after:await card(id)})
  }
  const tab=async shift=>{
    const beforeScroll=await scrolls()
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:shift?8:0})
    await settle()
    const active=await evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.dataset.sessionId,focusVisible:document.activeElement?.matches(':focus-visible')}))
    result.nativeInputs.push({type:shift?'Shift+Tab':'Tab',active,beforeScroll,afterScroll:await scrolls()});return active
  }
  const preserve=async label=>{
    const p=await evaluate(()=>window.appearanceProof.preservation())
    for(const field of ['sameTabs','sameLayouts','sameDrafts','sameQueues','sameRuns'])assert.equal(p[field],true,'Presentation preserves '+field)
    assert.ok(Object.values(p.controls).every(n=>n===0),'No lifecycle or input operation')
    result.scenarios.push({label,preservation:p})
  }
  const open=async()=>{
    await click('[aria-label="Project preferences · AgentMux"]')
    await until('original project menu',()=>read('Boolean(document.querySelector("[data-focus-project-preferences]"))'))
  }
  const close=async()=>{await key('Escape');result.nativeInputs.push({type:'Escape',purpose:'Close original project menu'});await until('original project menu closes',()=>read('!document.querySelector("[data-focus-project-preferences]")'))}
  result.nativeInputs??=[]
  const before=await layout()
  await click(selector(neighbor));assert.ok((await card(neighbor)).selected,'Original neighbor can be selected')
  await click(selector(selected));assert.ok((await card(selected)).selected,'Native click selects the exact original card')
  await unchangedLayout(before,'Native selection changes no card geometry')
  const originalSelection=await selection()
  await open();await move(neighbor)
  assert.deepEqual(await selection(),originalSelection,'Hover never changes selection')
  await unchangedLayout(before,'Hover and menu overlays change no card geometry')
  const wide={selected:await card(selected),hovered:await card(neighbor),menu:await evaluate(()=>{const e=document.querySelector('[data-focus-project-preferences]'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return{width:r.width,height:r.height,outline:s.outline,shadow:s.boxShadow,background:s.backgroundColor,animation:s.animationName}})}
  assert.ok(wide.hovered.outerHover&&!wide.selected.outerHover,'Actual neighboring hover is retained')
  assert.equal(wide.selected.titleWeight,'700')
  result.scenarios.push({label:'Wide selected, actual hover and neutral project menu',...wide})
  const inverse=process.env.AGENTMUX_FOCUS_APPEARANCE_STYLE_MUTANT==='selected-frame'
  await frame(inverse?'dark-old-selected-frame-1440.png':'dark-neutral-selected-hover-menu-1440.png','Actual selected and hovered cards beside the original menu','menu')
  if(inverse){assert.notEqual(wide.selected.body.shadow,'none','Actual previous selected frame is rendered');result.scenarios.push({label:'Visual inverse only',decision:'Counterfactual captured; independent aesthetic comparison pending. This is not a module or geometry assertion failure.'});await preserve('Inverse preserves original work');return}
  assert.equal(wide.selected.body.shadow,'none','Selected texture belongs to the original outer card only')
  assert.ok(wide.selected.innerShadow===null||wide.selected.innerShadow==='none','No second inner shadow')
  await close();win.setContentSize(420,900);await evaluate(()=>window.appearanceProof.theme('light'));await settle()
  await click(selector(selected));const narrowBefore=await layout();await move(neighbor)
  assert.deepEqual(await selection(),originalSelection,'Narrow hover keeps original selection')
  await unchangedLayout(narrowBefore,'Narrow hover changes no card geometry')
  result.scenarios.push({label:'Narrow selected and adjacent hover',selected:await card(selected),hovered:await card(neighbor)})
  await frame('light-neutral-selected-420.png','Light narrow selected card beside original neighboring card','selected')
  await open();await click('[aria-label="Project appearance"]')
  await until('explicit original appearance editor',()=>read('Boolean(document.querySelector("[data-focus-project-appearance]"))'))
  await frame('light-neutral-expanded-menu-420.png','Explicit appearance editor in the original neutral menu','menu')
  await close();win.setContentSize(420,520);await evaluate(()=>window.appearanceProof.theme('dark'));await settle()
  let focused
  for(let i=0;i<24;i++){const a=await tab(false);if(a.id===selected&&a.focusVisible){focused=a.id;break}}
  assert.ok(focused,'Native Tab reaches an original card')
  const focusedBefore=await card(focused),focusLayout=focusedBefore.layout
  assert.ok(focusedBefore.hit&&focusedBefore.active&&focusedBefore.focusVisible,'Focused original card is reachable')
  assert.ok(parseFloat(focusedBefore.body.outlineWidth)>=2,'Keyboard focus has a visible outline')
  assert.deepEqual(await selection(),originalSelection,'Keyboard focus does not become selection')
  result.scenarios.push({label:'Original native keyboard focus',focused:focusedBefore})
  await frame('dark-neutral-keyboard-short.png','Native keyboard focus remains visible in the short original App','focused')
  let forcedTarget
  for(let i=0;i<24;i++){const a=await tab(false);if(a.id===neighbor&&a.focusVisible){forcedTarget=a.id;break}}
  assert.equal(forcedTarget,neighbor,'Native Tab separates focus from the original selection')
  assert.deepEqual(await selection(),originalSelection)
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});await settle()
  assert.equal(await evaluate(()=>matchMedia('(forced-colors: active)').matches),true)
  const forced=await card(forcedTarget),forcedSelected=await card(selected);assert.deepEqual(forcedSelected.layout,focusLayout)
  assert.ok(forced.hit&&forced.focusVisible&&parseFloat(forced.body.outlineWidth)>=2,'Forced-color keyboard focus stays visible')
  assert.ok(forcedSelected.hit&&!forcedSelected.focusVisible&&parseFloat(forcedSelected.body.outlineWidth)>=1,'Nonfocused selected card has its own forced-color cue')
  assert.deepEqual(await selection(),originalSelection)
  result.scenarios.push({label:'Actual forced-colors observation with distinct focus and selection',focused:forced,selected:forcedSelected})
  await frame('dark-neutral-forced-colors.png','Original focus and selection cues survive forced colors','focused')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
  await preserve('Final original work retained')
}
