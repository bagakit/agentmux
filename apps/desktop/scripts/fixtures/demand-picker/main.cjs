const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'userData'));app.setPath('sessionData',path.join(privateRoot,'sessionData'))
const receipt={passed:false,frames:[],boundary:'Complete current Source App -> GlobalBoardSurface -> GoalDetail, original client UI, overlays and styles. Original preview transport/data only. No installed App, user Run, filesystem directory/native creation or restart claim.'}
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1280,height:960,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 const read=code=>win.webContents.executeJavaScript(code)
 const until=async code=>{const end=Date.now()+15000;do{if(await read(code))return;await new Promise(resolve=>setTimeout(resolve,30))}while(Date.now()<end);throw new Error('UI did not settle: '+code)}
 const click=async expr=>{await read("Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))");await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const p=await read(`(()=>{const n=${expr};if(!n)throw Error('Missing actual control: '+${JSON.stringify(expr)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,label:n.textContent.slice(0,80),hit:hit?.textContent?.slice(0,80),matched:hit===n||n.contains(hit)}})()`);(receipt.actions??=[]).push(p);assert.equal(p.matched,true,'Actual control coordinate must hit its current element: '+JSON.stringify(p));win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p})}
 const button=text=>`[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)})`
 const frame=async(width,theme,name)=>{
  await read("Promise.all((document.querySelector('.goal-agent-picker')??document.querySelector('.goals-detail')).getAnimations({subtree:true}).filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))")
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
   const geometry=await read(`(()=>{const panel=document.querySelector('.goal-agent-picker')??document.querySelector('.goals-detail'),r=panel.getBoundingClientRect();return {width:innerWidth,height:innerHeight,picker:Boolean(document.querySelector('.goal-agent-picker')),overflow:panel.scrollWidth-panel.clientWidth,left:r.left,right:r.right,bottom:r.bottom,bodyOverflow:document.body.scrollWidth-innerWidth}})()`)
   if(['assignees','mote-new-session','new-agent','supervisor-picker','search-long-name','retained-selection-conflict','retained-creation-check'].includes(name))assert.equal(geometry.picker,true,name+' must capture the actual open picker')
  assert.ok(geometry.overflow<=1,JSON.stringify(geometry));assert.ok(geometry.left>=-1&&geometry.right<=width+1,JSON.stringify(geometry))
  const file=`${width}-${theme}-${name}.png`;fs.writeFileSync(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());receipt.frames.push({width,theme,name,file,geometry})
 }
 try{
  await win.loadFile(html);await until('!!window.collaborationProbe && !!document.querySelector(".goal-collaboration")')
  await read(`window.actualOverlayEvents=[];for(const type of ['dismissableLayer.pointerDownOutside','dismissableLayer.focusOutside','pointerdown','focusin'])document.addEventListener(type,event=>{const target=event.target;window.actualOverlayEvents.push({type,name:target?.getAttribute?.('aria-label')??target?.textContent?.slice(0,120),role:target?.getAttribute?.('role'),class:target?.className,dialog:Boolean(document.querySelector('.goal-agent-picker'))})},true)`)
  for(const width of [1280,420]){
   win.setContentSize(width,960)
   for(const theme of ['light','dark']){
    await read(`window.collaborationProbe.theme(${JSON.stringify(theme)});window.collaborationProbe.supervisor(false);document.querySelector('.goals-detail').scrollTop=0`)
    await until(`document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
    await frame(width,theme,'detail-no-supervisor')
    await click(`document.querySelector('[aria-label="Choose Goal assignees"]')`);await until('!!document.querySelector(".goal-agent-picker")')
    await frame(width,theme,'assignees')
    await click(button('Mote · new Session'))
    for(const label of ['Mote for new Session','New Session Agent configuration']){
     await click(`document.querySelector('[aria-label="${label}"]')`);await until('!!document.querySelector("[role=menuitemradio]")')
     await click(`[...document.querySelectorAll('[role=menuitemradio]')].find(n=>n.dataset.value && n.getAttribute('aria-disabled')!=='true')`)
    }
    await frame(width,theme,'mote-new-session')
    await click(button('New Agent'))
    await click(`document.querySelector('[aria-label="New Agent execution directory"]')`);await until('!!document.querySelector("[role=menuitemradio]")')
    await click(`[...document.querySelectorAll('[role=menuitemradio]')].find(n=>n.dataset.value && n.getAttribute('aria-disabled')!=='true')`)
    await frame(width,theme,'new-agent')
    await click(button('Cancel'));await until('!document.querySelector(".goal-agent-picker")')
    await click(`document.querySelector('[aria-label="Choose Goal Supervisor"]')`);await until('!!document.querySelector(".goal-agent-picker")');await frame(width,theme,'supervisor-picker')
    await click(button('Cancel'));await until('!document.querySelector(".goal-agent-picker")')
    await read('window.collaborationProbe.supervisor(true)');await frame(width,theme,'detail-supervisor')
    await click(`document.querySelector('.goals-properties > summary')`);await until('!!document.querySelector(".goals-properties__groups")')
    await read('document.querySelector(".goals-properties").scrollIntoView({block:"start"})');await frame(width,theme,'more-properties')
    await click(`document.querySelector('.goals-properties > summary')`)
   }
  }
  win.setContentSize(420,960)
  for(const theme of ['light','dark']){
   await read(`window.collaborationProbe.theme(${JSON.stringify(theme)});window.collaborationProbe.resetDrafts();window.collaborationProbe.names(true);window.collaborationProbe.supervisor(true);document.querySelector('.goals-detail').scrollTop=0`)
   await frame(420,theme,'long-names-detail')
   await read('document.querySelector(".goals-supervisor-identity").scrollIntoView({block:"start"})')
   await frame(420,theme,'long-supervisor')
   await click(`document.querySelector('[aria-label="Choose Goal assignees"]')`);await until('!!document.querySelector(".goal-agent-picker")')
   await click(`document.querySelector('[aria-label="Search Agents"]')`);await win.webContents.insertText('Rui')
   await until(`document.querySelector('[aria-label="Search Agents"]').value==='Rui' && document.querySelectorAll('[data-session-id]').length===1`)
   await frame(420,theme,'search-long-name')
   await read('window.collaborationProbe.changeVersion()');await click(button('Save relationships'))
   await until('document.querySelector(".goal-agent-picker").textContent.includes("Relationships are not saved")')
   await frame(420,theme,'retained-selection-conflict')
   await click(button('Cancel'));await until('!document.querySelector(".goal-agent-picker")')
   await read('window.collaborationProbe.resetDrafts();window.collaborationProbe.names(false);window.collaborationProbe.retainedCreation()')
   await click(`document.querySelector('[aria-label="Choose Goal assignees"]')`);await until('document.querySelector(".goal-agent-picker")?.textContent.includes("original creation is not yet observed")')
   await frame(420,theme,'retained-creation-check')
   await click(button('Cancel'));await until('!document.querySelector(".goal-agent-picker")');await read('window.collaborationProbe.resetDrafts()')
  }
  assert.equal(receipt.frames.length,38);receipt.passed=true
 }catch(error){receipt.failure={message:error.message,stack:error.stack};receipt.page=await read('({text:document.body.innerText,events:window.actualOverlayEvents})');fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
 fs.writeFileSync(path.join(evidence,'render.json'),JSON.stringify(receipt,null,2)+'\n');win.destroy();app.exit(receipt.passed?0:1)
})
