const assert=require('node:assert/strict')
const fs=require('node:fs/promises')
const path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const receipt={schema:'agentmux.shared-focus-presentation-scene-actual.v1',passed:false,pid:process.pid,frames:[],phases:[],
  boundary:'Actual compiled App, GlobalFocusSurface, Store, WorkspaceWorkbench, Stable and original browser Panel primary. Typed preview Session/Run, PTY paint and unused Monaco leaves isolated. Trusted CDP input; not Native simultaneous presentation, real PTY/Runtime, physical mouse, restart or user installation.',userAppRunRuntimeControlled:false}
const pause=ms=>new Promise(done=>setTimeout(done,ms));let window
app.whenReady().then(async()=>{try{
  window=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  const read=value=>window.webContents.executeJavaScript(value)
  const until=async(label,predicate)=>{const end=Date.now()+12000;do{if(await predicate())return;await pause(30)}while(Date.now()<end);throw new Error('Actual Focus scene did not settle: '+label)}
  const button=async selector=>{const metrics=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)?.closest('button')===e,width:r.width,height:r.height}})()`)
    assert.ok(metrics?.hit&&metrics.width>0&&metrics.height>0,'Actual control center hit '+selector)
    for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:metrics.x,y:metrics.y,button:'left',clickCount:1})
    return metrics
  }
  const shot=async(file,width)=>{await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const image=await window.webContents.capturePage();assert.ok(!image.isEmpty());await fs.writeFile(path.join(evidence,file),image.toPNG());receipt.frames.push({file,width})}
  const facts=()=>read('window.focusPresentationProof.facts()')
  const returnVisible=async()=>{
    const geometry=await read(`(()=>{const work=document.querySelector('.focused-tab-workspace'),clip=work.getBoundingClientRect();return ['exact-r1','exact-r2'].map(id=>{const leaf=work.querySelector('[data-owner-region="'+id+'"]'),body=leaf?.querySelector('[data-original-reading]'),range=document.createRange();if(body)range.selectNodeContents(body);const rect=leaf?.getBoundingClientRect(),text=body?range.getBoundingClientRect():null;const box=text&&{x:Math.max(text.x,clip.x,0),y:Math.max(text.y,clip.y,0),right:Math.min(text.right,clip.right,innerWidth),bottom:Math.min(text.bottom,clip.bottom,innerHeight)};const point=box&&document.elementFromPoint((box.x+box.right)/2,(box.y+box.bottom)/2);return {id,leaf:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height},text:body?.textContent,textBox:box,hit:!!leaf&&leaf.contains(point),parents:leaf&&[leaf.parentElement,leaf.parentElement?.parentElement,leaf.parentElement?.parentElement?.parentElement].filter(Boolean).map(e=>({id:e.id,class:e.className,rect:{x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height},display:getComputedStyle(e).display,visibility:getComputedStyle(e).visibility}))}})})()`)
    receipt.returnVisibility=geometry
    if(geometry.length!==2||geometry.some(item=>!item.leaf||item.leaf.width<=0||item.leaf.height<=0||!item.hit||item.text!=='Original selected reading passage'||item.textBox.right<=item.textBox.x||item.textBox.bottom<=item.textBox.y))return false
    const image=await window.webContents.capturePage(),size=image.getSize(),viewport=await read('({width:innerWidth,height:innerHeight})'),sx=size.width/viewport.width,sy=size.height/viewport.height
    receipt.returnCapture={size,viewport,sx,sy}
    const paint=geometry.map(item=>{const b=item.textBox,crop=image.crop({x:Math.ceil(b.x*sx),y:Math.ceil(b.y*sy),width:Math.max(1,Math.floor((b.right-b.x)*sx)),height:Math.max(1,Math.floor((b.bottom-b.y)*sy))}),bitmap=crop.getBitmap();let ink=0;for(let index=0;index<bitmap.length;index+=4)if(bitmap[index+3]>0&&Math.max(bitmap[index],bitmap[index+1],bitmap[index+2])>140)ink++;return{id:item.id,bitmapBytes:bitmap.length,ink}})
    receipt.returnPaint=paint
    return paint.every(item=>item.bitmapBytes>0&&item.ink>10)
  }

  const preserved=f=>{for(const key of ['sameHost','sameDraftElement','connected','sameTabs','sameLayouts','sameSessions','sameDrafts'])assert.equal(f[key],true,key);assert.deepEqual(f.range,[7,15]);assert.equal(f.draft,'Unsent original draft');assert.equal(f.primaryWorkspace,'workspace-demo');assert.equal(f.originalRun,'run-codex');assert.equal(f.mounts.length,3);assert.deepEqual(f.unmounts,[]);assert.deepEqual(Object.values(f.calls),[0,0,0,0,0])}
  await window.loadFile(html);window.showInactive();window.webContents.debugger.attach('1.3')
  await until('actual primary Tab leaves',()=>read('document.querySelectorAll("[data-fixture-session]").length===3&&window.focusPresentationProof?.ready'))
  await read('window.focusPresentationProof.existingExactEntry()')
  const focusControl=await read(`(()=>{const b=[...document.querySelectorAll('.surface-navigation button')].find(b=>b.getAttribute('aria-label')?.includes('Focus'));return b?.getAttribute('aria-label')})()`)
  assert.ok(focusControl);await button('button[aria-label='+JSON.stringify(focusControl)+']')
  await until('exact non-first Focus occurrence',async()=>{const f=await facts();return f.selectedTab==='explicit-exact-tab'&&f.actualHost===f.expectedHost})
  const chooseLevel=async text=>{
    await button('button[aria-label="Focus context actions"]')
    await until('Focus original More menu',()=>read(`!![...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes(${JSON.stringify(text)}))`))
    const point=await read(`(()=>{const e=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes(${JSON.stringify(text)}));const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role=menuitem]')===e}})()`)
    assert.ok(point.hit,'Actual original menuitem center hit')
    for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:'left',clickCount:1})
  }
  const sameLeaf=f=>{for(const key of ['sameDraftElement','connected','sameTabs','sameLayouts','sameSessions','sameDrafts','sameRegionHost','sameReading','siblingConnected'])assert.equal(f[key],true,key);assert.deepEqual(f.range,[7,15]);assert.equal(f.draft,'Unsent original draft');assert.equal(f.mounts.length,3);assert.deepEqual(f.unmounts,[]);assert.deepEqual(Object.values(f.calls),[0,0,0,0,0]);assert.deepEqual(f.reference,{displayWorkspaceId:'display-b',groupId:'display-exact-group',tabId:'explicit-exact-tab',regionId:'exact-r2'})}
  const range=f=>assert.deepEqual(f.textRange,{text:'ginal selected ',sameStart:true,sameEnd:true,start:3,end:18},'Original Chromium reading Range survives DOM presentation')
  const whole=await facts();sameLeaf(whole);range(whole);assert.equal(whole.projectedLeaves,2);await shot('tab-1280.png',1280);receipt.phases.push({phase:'whole-tab',facts:whole})
  await chooseLevel('Show only this Region');await until('exact original Region target',async()=>{const f=await facts();return f.regionHost===f.expectedRegionHost})
  for(const width of [1280,640]){
    window.setContentSize(width,800);await pause(180);const f=await facts();sameLeaf(f);range(f);assert.equal(f.projectedLeaves,1);assert.equal(f.siblingPresented,'false');
    const geometry=await read(`(()=>{const e=document.querySelector('.focused-tab-workspace'),r=e.getBoundingClientRect(),leaf=e.querySelector('[data-fixture-session]').getBoundingClientRect();return {width:r.width,height:r.height,leaf:{width:leaf.width,height:leaf.height},tabbars:e.querySelectorAll('.pane-tabbar').length}})()`)
    assert.ok(geometry.width>0&&geometry.height>0&&geometry.leaf.width>0&&geometry.leaf.height>0);assert.equal(geometry.tabbars,0)
    await shot('region-'+width+'.png',width);receipt.phases.push({phase:'one-region',width,facts:f,geometry})
  }
  const beforeSettings=await facts();await button('button[aria-label="Settings"]');await until('actual Settings overlay',async()=> (await facts()).settings)
  const hidden=await facts();sameLeaf(hidden);assert.equal(hidden.workspaceInert,true);assert.deepEqual(hidden.reads,beforeSettings.reads)
  await button('button[aria-label="Settings"]');await until('return original Region',async()=>!(await facts()).settings&&(await facts()).regionHost===(await facts()).expectedRegionHost)
  sameLeaf(await facts());receipt.phases.push({phase:'settings-return',before:beforeSettings,hidden,after:await facts()})
  // Settings owns its new input focus; this case records its Range state without
  // restoring an older selection over Settings. Start a fresh reading selection
  // for the separate Region -> Tab move qualification.
  await read('window.focusPresentationProof.resetReading()')
  await chooseLevel('Show entire Tab');await until('return original Tab',async()=>(await facts()).projectedLeaves===2)
  await until('both original leaves visible, clipped, hit and painted after return',returnVisible);const returned=await facts();sameLeaf(returned);range(returned);await shot('returned-tab-640.png',640);receipt.phases.push({phase:'return-tab',facts:returned})
  await read('window.focusPresentationProof.laterSelection()');await chooseLevel('Show only this Region');await until('later selection kept',async()=>(await facts()).regionHost===(await facts()).expectedRegionHost);const later=await facts();sameLeaf(later);assert.equal(later.laterActive,true,'Later visible input focus is not stolen');assert.equal(later.laterExpected.length,5);assert.equal(later.textRange.text,later.laterExpected,'Later actual selection is not overwritten by old commit snapshot');receipt.phases.push({phase:'later-selection',facts:later});await read('window.focusPresentationProof.resetReading()');await chooseLevel('Show entire Tab');await until('final original Tab',async()=>(await facts()).projectedLeaves===2);sameLeaf(await facts());range(await facts())
  await read('window.focusPresentationProof.shortenReading()');await chooseLevel('Show only this Region');await until('shortened original text remains readable',async()=>(await facts()).regionHost===(await facts()).expectedRegionHost);const shortened=await facts();sameLeaf(shortened);assert.equal(shortened.readingText,'Short');assert.deepEqual(shortened.restoreErrors,[],'Shrinking the same original Text after snapshot must not throw or destroy the current selection');receipt.phases.push({phase:'shorten-original-text-after-snapshot',facts:shortened});await read('window.focusPresentationProof.originalReading();window.focusPresentationProof.resetReading()');await chooseLevel('Show entire Tab');await until('return after shortened text',async()=>(await facts()).projectedLeaves===2);sameLeaf(await facts());range(await facts())
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};if(window&&!window.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await window.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(receipt,null,2)+'\n');if(window&&!window.isDestroyed())window.destroy();app.exit(receipt.passed?0:1)}})
