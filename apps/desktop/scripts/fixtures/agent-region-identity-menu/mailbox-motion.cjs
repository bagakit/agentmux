const assert=require('node:assert/strict')

/** Live native animation frames and controlled holds of that same product effect; no equivalent motion implementation. */
module.exports=async function({win,evaluate,waitFor,visible,painted,click,key,seed,capture,result,surface}){
  result.captureOnly=true;result.aestheticReview='not-performed';result.motion=[]
  const composer=`${surface}.querySelector('.composer')`,panel=`${composer}.querySelector('.composer-mailbox')`
  const editor=`${composer}.querySelector('[role="textbox"]')`,more=`document.querySelector('.composer-pending__more')`
  const effect=`${panel}.getAnimations().find(a=>a.effect?.getKeyframes().some(k=>k.clipPath))`
  const ownedEffects=`[...${panel}.getAnimations(),...(document.querySelector('.composer-pending[data-mailbox-returning="true"]')?.getAnimations()??[])]`
  async function settled(){await waitFor(`!${panel}.getAnimations().some(a=>a.playState==='running')`);await painted()}
  async function flushed(){await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')}
  async function frame(width,state){await painted();const file=`${width}-motion-${state}.png`,png=await capture(file.slice(0,-4));result.frames.push({width,state,file,png})}
  async function hold(){await waitFor(`Boolean(${effect})`);await evaluate(`${ownedEffects}.forEach(a=>a.pause())`)}
  async function holdFrames(width,kind){
    await hold()
    for(const fraction of [.15,.5,.85]){
      await evaluate(`${ownedEffects}.forEach(a=>a.currentTime=Number(a.effect.getComputedTiming().duration)*${fraction})`)
      await frame(width,`${kind}-${Math.round(fraction*100)}`)
    }
    await evaluate(`${ownedEffects}.forEach(a=>a.play())`);await settled()
  }
  async function record(){
    await evaluate(`(()=>{const p=${panel};window.motionFrames=[];window.motionFinished=new Promise(done=>{
      const started=performance.now();function sample(time){const r=p.getBoundingClientRect(),s=getComputedStyle(p),matrix=new DOMMatrix(s.transform==='none'?undefined:s.transform);
        motionFrames.push({time,top:r.top,right:r.right,height:r.height,clip:s.clipPath,opacity:Number(s.opacity),dockOpacity:Number(getComputedStyle(document.querySelector('.composer-pending')).opacity),open:p.matches(':popover-open'),state:p.dataset.state,inert:p.inert,scaleX:matrix.a,scaleY:matrix.d,animations:p.getAnimations().map(a=>({time:a.currentTime,state:a.playState,duration:a.effect.getComputedTiming().duration}))});
        if(performance.now()-started>350)done(true);else requestAnimationFrame(sample)}requestAnimationFrame(sample)
    });return true})()`)
  }
  async function verify(label){
    await evaluate('motionFinished');const trace=await evaluate('motionFrames')
    assert.ok(trace.length>=4,'Actual continuous native frames are nonempty')
    const moving=trace.filter(f=>f.animations.some(a=>a.state==='running')&&f.clip!=='none'&&f.opacity>0)
    assert.ok(moving.length>=2,'The original product provides actual continuous intermediate motion frames')
    assert.ok(new Set(moving.map(f=>f.top)).size>=2,'Actual product position changes continuously between legal endpoints')
    assert.ok(trace.every(f=>f.scaleX===1&&f.scaleY===1),'Original typography is never globally scaled')
    if(label.endsWith('opening')) {
      const endpoint=trace.findLast(f=>f.open&&f.opacity===1)
      assert.ok(endpoint,'A fully readable legal opening endpoint is observed')
      assert.ok(trace.filter(f=>f.open&&f.state==='closed').every(f=>f.opacity===0),'Native opening does not expose an unanimated panel before the original reading DOM commit')
      assert.ok(trace.filter(f=>f.open&&f.opacity>0).every(f=>Math.abs(f.height-endpoint.height)<1),'No visible short empty panel flashes before the original full reading DOM is ready')
    } else {
      const full=trace.find(f=>f.opacity>0&&f.height>0)
      assert.ok(full&&trace.filter(f=>f.opacity>0).every(f=>Math.abs(f.height-full.height)<1),'No visible short residual shell flashes after the original exit paint completes')
    }
    result.motion.push({label,trace})
  }
  for(const width of [640,320]){
    await evaluate(`identityMenu.appearance(${JSON.stringify(width===640?'dark':'light')})`);await seed(width)
    await waitFor(visible(editor));await click(editor)
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65})
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'Original long draft.\nKeep this working surface.\nKeep the original message and input.\nThis remains unsent.'})
    await evaluate("identityMenu.messageFeedback('failed')");await waitFor(visible(more));await painted()
    const before=await evaluate(`({drafts:identityMenu.facts().drafts,queues:identityMenu.facts().queues,terminal:identityMenu.terminal()})`)
    await frame(width,'card');await record();await click(more)
    await waitFor(`${panel}.matches(':popover-open')&&${panel}.dataset.state==='open'`);await verify(`${width}-opening`);await settled();await frame(width,'panel')
    // An adversarial event on the original React descendant is deliberately untrusted.
    // It must not borrow the parent's native object authority; it is not a native input claim.
    await evaluate(`${panel}.querySelector('button').dispatchEvent(new ToggleEvent('beforetoggle',{bubbles:true,oldState:'open',newState:'closed'}))`)
    assert.equal(await evaluate(`${panel}.matches(':popover-open')&&!${panel}.inert&&${panel}.dataset.state==='open'`),true,'A foreign descendant beforetoggle cannot withdraw the original native mailbox interaction owner')
    assert.deepEqual(await evaluate(`({drafts:identityMenu.facts().drafts,queues:identityMenu.facts().queues,terminal:identityMenu.terminal()})`),before,'Motion preserves original queue/body/IDs, both drafts and original terminal rows/cursor')
    // Restart the actual original open effect, pause it, and inspect its own browser interpolation.
    await key('Escape','Escape',27);await settled();await waitFor(visible(more))
    await click(more);await holdFrames(width,'open')
    await record();await key('Escape','Escape',27);await verify(`${width}-closing`);await settled();await frame(width,'closed')
    assert.equal(await evaluate(`${panel}.matches(':popover-open')`),false,'The original native panel is closed')
    assert.equal(await evaluate(`${panel}.inert`),true,'Closed panel has no ghost interaction owner')
    assert.deepEqual(await evaluate(`({drafts:identityMenu.facts().drafts,queues:identityMenu.facts().queues,terminal:identityMenu.terminal()})`),before,'The complete original open/close cycle preserves message facts and the original working surface')
    await click(more);await settled();await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`)
    await waitFor(`!${panel}.matches(':popover-open')`);await hold()
    assert.equal(await evaluate(`${panel}.inert`),true,'Native close immediately removes the original panel from keyboard interaction')
    assert.equal(await evaluate(`getComputedStyle(${panel}).pointerEvents`),'none','Native close immediately removes the original panel from pointer interaction')
    const ghost=await evaluate(`(()=>{const p=${panel},r=p.getBoundingClientRect();return document.elementFromPoint(r.right-16,r.top+16)?.closest('.composer-mailbox')===p})()`)
    assert.equal(ghost,false,'The actual top-layer exit paint cannot intercept a pointer')
    await holdFrames(width,'close')
    // A real fast reversal uses the same native trigger; only presentation may be cancelled.
    await click(more);await waitFor(`${panel}.matches(':popover-open')`);await click(`${composer}.querySelector('.composer__mailbox')`)
    await waitFor(`!${panel}.matches(':popover-open')`);await click(`${composer}.querySelector('.composer__mailbox')`)
    await waitFor(`${panel}.matches(':popover-open')&&${panel}.dataset.state==='open'`);await settled();await frame(width,'reversed')
    const buttons=await evaluate(`Array.from(${panel}.querySelectorAll('button')).filter(b=>b.getBoundingClientRect().width>0&&!b.disabled).slice(0,3).map(b=>{const r=b.getBoundingClientRect();return{label:b.getAttribute('aria-label')??b.textContent,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b}})`)
    assert.ok(buttons.length>0&&buttons.every(b=>b.hit),'Final original panel actions retain actual hit targets')
    await key('Escape','Escape',27);await settled()
    // Reverse the same native effect before completion, and compare actual paint at its handoff.
    await click(more);await hold()
    await evaluate(`${ownedEffects}.forEach(a=>a.currentTime=Number(a.effect.getComputedTiming().duration)*.2)`);await flushed()
    const handoff=await evaluate(`(()=>{const p=${panel},s=getComputedStyle(p);return{top:p.getBoundingClientRect().top,clip:s.clipPath,opacity:Number(s.opacity),progress:(${effect})?.effect.getComputedTiming().progress}})()`)
    await click(`${composer}.querySelector('.composer__mailbox')`);await hold()
    await evaluate(`${ownedEffects}.forEach(a=>a.currentTime=0)`);await flushed()
    const reversed=await evaluate(`(()=>{const p=${panel},s=getComputedStyle(p);return{top:p.getBoundingClientRect().top,clip:s.clipPath,opacity:Number(s.opacity)}})()`)
    result.reversals??=[];result.reversals.push({width,handoff,reversed})
    assert.ok(Math.abs(handoff.top-reversed.top)<1,'Fast reversal continues from the actual current native paint position')
    const numbers=value=>(value.match(/[\d.]+/g)??[]).map(Number)
    assert.ok(numbers(handoff.clip).length>0&&numbers(handoff.clip).every((number,index)=>Math.abs(number-numbers(reversed.clip)[index])<1),'Fast reversal preserves the actual native clip boundary at handoff')
    assert.ok(Math.abs(handoff.opacity-reversed.opacity)<.01,'Fast reversal preserves the actual native paint opacity at handoff')
    await evaluate(`${ownedEffects}.forEach(a=>a.play())`);await settled()
    await click(more);await settled();await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`);await hold()
    await evaluate(`${ownedEffects}.forEach(a=>a.currentTime=Number(a.effect.getComputedTiming().duration)*.2)`);await flushed()
    const returning=await evaluate(`(()=>{const p=${panel},s=getComputedStyle(p);return{top:p.getBoundingClientRect().top,clip:s.clipPath,opacity:Number(s.opacity)}})()`)
    await click(more);await hold()
    await evaluate(`${panel}.getAnimations().forEach(a=>a.currentTime=0)`);await flushed()
    const reopened=await evaluate(`(()=>{const p=${panel},s=getComputedStyle(p);return{top:p.getBoundingClientRect().top,clip:s.clipPath,opacity:Number(s.opacity)}})()`)
    result.returnReversals??=[];result.returnReversals.push({width,returning,reopened})
    assert.ok(Math.abs(returning.top-reopened.top)<1&&Math.abs(returning.opacity-reopened.opacity)<.01,'Closing-to-opening reverses the actual original native paint without a transparent gap')
    await evaluate(`${panel}.getAnimations().forEach(a=>a.play())`);await settled()
    // Stress the original Native HTML API, without inventing a second toggle implementation.
    await evaluate(`${panel}.hidePopover();${panel}.showPopover({source:${composer}.querySelector('.composer__mailbox')})`);await flushed()
    assert.equal(await evaluate(`${panel}.matches(':popover-open')&&${panel}.dataset.state==='open'&&!${panel}.inert`),true,'Coalesced native toggles publish the current original reading/interaction owner even when React open boolean is unchanged')
    await settled();await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`);await settled();await waitFor(visible(more))
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await click(more);await waitFor(`${panel}.matches(':popover-open')&&${panel}.dataset.state==='open'`)
    assert.equal(await evaluate(`Boolean(${effect})`),false,'Reduced motion uses the immediate original endpoint')
    await frame(width,'reduced');await key('Escape','Escape',27);await settled()
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})
  }
  // Live disposal/layout cases use the original product tree and isolated snapshot/API only.
  await seed(640);await evaluate("identityMenu.messageFeedback('failed')");await waitFor(visible(more));await painted()
  await evaluate(`window.originalMotionEditor=${editor};window.originalMotionPanel=${panel};window.originalMotionTerminal=${surface}.querySelector('.xterm')`)
  await click(editor)
  await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'继续',selectionStart:2,selectionEnd:2})
  const composing=await evaluate(`({html:${editor}.innerHTML,focused:document.activeElement===${editor},drafts:identityMenu.facts().drafts})`)
  const trigger=`${composer}.querySelector('.composer__mailbox')`
  const point=await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point,buttons:0})
  await waitFor(`${panel}.matches(':popover-open')`);await settled()
  assert.deepEqual(await evaluate(`({html:${editor}.innerHTML,focused:document.activeElement===${editor},drafts:identityMenu.facts().drafts})`),composing,'Actual native composition, editor DOM and focus survive mailbox hover/motion')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:730,buttons:0})
  await waitFor(`!${panel}.matches(':popover-open')`);await settled()
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'继续'})
  await click(more);await hold()
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1001,height:740,deviceScaleFactor:1,mobile:false})
  await flushed();assert.equal(await evaluate(`Boolean(${effect})`),false,'Region resize cancels the original intermediate paint');await frame(500,'resize')
  assert.equal(await evaluate(`${panel}.matches(':popover-open')`),true,'Region resize settles the same native panel at its legal endpoint')
  await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`);await settled()
  // Actual history facts keep the original panel naturally at its bounded height with or
  // without the selected detail. Exact-target cancellation cannot pass just via resize.
  await evaluate("identityMenu.mailbox('motion-scope')");await waitFor(visible(more));await painted()
  await click(more);await hold()
  const targetHeight=await evaluate(`${panel}.offsetHeight`)
  await evaluate("identityMenu.motionOwner('target')")
  await flushed();assert.equal(await evaluate(`Boolean(${effect})`),false,'Exact target change cancels the original intermediate paint')
  assert.equal(await evaluate(`${panel}.offsetHeight`),targetHeight,'Exact-target case has identical natural panel height, independent of resize cancellation')
  assert.equal(await evaluate(`${panel}===originalMotionPanel&&${editor}===originalMotionEditor`),true,'Exact target projection change retains original editor/panel nodes')
  // An exact Run identity change is allowed to bind a different terminal; ordinary motion above
  // already proved the original xterm instance/rows/cursor survive with the same execution identity.
  await evaluate(`window.originalMotionTerminal=${surface}.querySelector('.xterm')`)
  await frame(500,'target-changed');await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`);await settled()
  await click(more);await hold();await evaluate("identityMenu.motionOwner('hide')")
  await flushed();assert.equal(await evaluate("originalMotionPanel.matches(':popover-open')"),false,'Hidden workface closes the original native top-layer panel')
  assert.equal(await evaluate("Boolean(originalMotionPanel.getAnimations().find(a=>a.effect?.getKeyframes().some(k=>k.clipPath)))"),false,'Hidden workface cancels old native motion')
  assert.equal(await evaluate('originalMotionPanel.inert'),true,'Hidden workface leaves no old interactive top-layer owner')
  await evaluate("identityMenu.motionOwner('show')");await waitFor(visible(more));await painted()
  assert.equal(await evaluate(`${editor}===originalMotionEditor&&${surface}.querySelector('.xterm')===originalMotionTerminal`),true,'Hide/show restores original editor and terminal nodes')
  await click(more);await hold();await evaluate(`window.originalMotionEffect=${effect}`);await evaluate("identityMenu.mode('terminal')")
  assert.equal(await evaluate("!originalMotionPanel.isConnected&&originalMotionEffect.playState==='idle'"),true,'Actual product unmount cancels old native motion; no detached effect survives')
  result.lifecycle={nativeComposition:true,resize:true,targetChange:true,hideShow:true,unmount:true}
  result.foreignEvent={route:'adversarial ToggleEvent on original descendant',trusted:false,nativeOperationAttempted:false,parentPreserved:true}
  assert.ok((await evaluate('identityMenu.mailboxInputs()')).some(event=>event.trusted&&event.type==='compositionstart'),'The original editor received an actual native composition')
}
