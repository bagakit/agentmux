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
  const preserved=f=>{for(const key of ['sameHost','sameDraftElement','connected','sameTabs','sameLayouts','sameSessions','sameDrafts'])assert.equal(f[key],true,key);assert.deepEqual(f.range,[7,15]);assert.equal(f.draft,'Unsent original draft');assert.equal(f.primaryWorkspace,'workspace-demo');assert.equal(f.originalRun,'run-codex');assert.equal(f.mounts.length,3);assert.deepEqual(f.unmounts,[]);assert.deepEqual(Object.values(f.calls),[0,0,0,0,0])}
  await window.loadFile(html);window.showInactive();window.webContents.debugger.attach('1.3')
  await until('actual primary Tab leaves',()=>read('document.querySelectorAll("[data-fixture-session]").length===3&&window.focusPresentationProof?.ready'))
  await read('window.focusPresentationProof.existingExactEntry()')
  const focusControl=await read(`(()=>{const b=[...document.querySelectorAll('.surface-navigation button')].find(b=>b.getAttribute('aria-label')?.includes('Focus'));return b?.getAttribute('aria-label')})()`)
  assert.ok(focusControl);await button('button[aria-label='+JSON.stringify(focusControl)+']')
  await until('exact non-first Focus occurrence',async()=>{const f=await facts();return f.selectedTab==='explicit-exact-tab'&&f.actualHost===f.expectedHost})
  for(const width of [1280,640]){
    window.setContentSize(width,800);await pause(180)
    const f=await facts();preserved(f);assert.deepEqual(f.reference,{displayWorkspaceId:'display-b',groupId:'display-exact-group',tabId:'explicit-exact-tab',regionId:'exact-r2'})
    const geometry=await read(`(()=>{const e=document.querySelector('.focused-tab-workspace'),r=e.getBoundingClientRect();const leaves=[...e.querySelectorAll('[data-fixture-session]')].map(v=>{const q=v.getBoundingClientRect();return {width:q.width,height:q.height}});return {width:r.width,height:r.height,leaves,groups:[...e.querySelectorAll('[data-pane-group-id]')].map(g=>g.dataset.paneGroupId)}})()`)
    assert.deepEqual(geometry.groups,[],'Tab-level content does not render its parent Group chrome');
    assert.equal(await read("document.querySelectorAll('.focused-tab-workspace .pane-tabbar').length"),0,'Focus title band is not duplicated by Group tabs');
    assert.deepEqual(await read("[...document.querySelectorAll('.focused-tab-workspace .workbench-tab-slot')].map(e=>[e.dataset.workbenchGroupId,e.dataset.workbenchTabId])"),[['display-exact-group','explicit-exact-tab']],'One exact original Tab slot');
    assert.ok(geometry.width>0&&geometry.height>0&&geometry.leaves.length===2&&geometry.leaves.every(r=>r.width>0&&r.height>0),'Original whole Tab and two Regions are drawn')
    await shot('exact-'+width+'.png',width);receipt.phases.push({phase:'exact-focus',width,facts:f,geometry})
  }
  const beforeSettings=await facts();await button('button[aria-label="Settings"]');await until('actual Settings overlay',async()=> (await facts()).settings)
  const hidden=await facts();preserved(hidden);assert.equal(hidden.workspaceInert,true);assert.deepEqual(hidden.reads,beforeSettings.reads,'The settled controlled snapshot starts no new reads while Settings covers Focus')
  await button('button[aria-label="Settings"]');await until('return exact original',async()=>!(await facts()).settings&&(await facts()).actualHost===(await facts()).expectedHost)
  preserved(await facts());receipt.phases.push({phase:'settings-return',before:beforeSettings,hidden,after:await facts()})
  await button('button[aria-label="Close Focus workspace"]');await until('local Focus closed',async()=>!(await facts()).selectedTab)
  const closed=await facts();preserved(closed);assert.equal(closed.reference,null)
  await read('window.focusPresentationProof.identityOnly()');await until('real location choices',async()=>(await facts()).choices===7)
  await shot('ambiguous-640.png',640);receipt.phases.push({phase:'ambiguous',facts:await facts()})
  const selector='[aria-label="Choose Focus location"] button[title="display-b / display-exact-group / explicit-exact-tab / exact-r2"]'
  const selectedControl=await button(selector);await until('explicit chosen occurrence',async()=>(await facts()).actualHost===(await facts()).expectedHost)
  const selected=await facts();preserved(selected);await shot('chosen-640.png',640);receipt.phases.push({phase:'choice',control:selectedControl,facts:selected})
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};if(window&&!window.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await window.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(receipt,null,2)+'\n');if(window&&!window.isDestroyed())window.destroy();app.exit(receipt.passed?0:1)}})
