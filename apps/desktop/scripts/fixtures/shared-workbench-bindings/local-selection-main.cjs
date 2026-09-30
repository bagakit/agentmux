const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {app,BrowserWindow}=require('electron'),[html,privateRoot,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const receipt={schema:'agentmux.focus-local-selection-scene-actual.v1',passed:false,pid:process.pid,frames:[],phases:[],userAppRunRuntimeControlled:false,
 boundary:'Actual compiled App/GlobalFocus/Store/original Workbench/Provider/NewTabSurface and browser Panel; maintained typed preview API. PTY and File Editor paint isolated. Trusted CDP controls, not physical mouse, real Runtime/PTY, Native parallel presentation, Writer, ordinary restart or installation.'}
const pause=ms=>new Promise(done=>setTimeout(done,ms));let window
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 const read=code=>window.webContents.executeJavaScript(code),facts=()=>read('window.focusLocalProof.facts()')
 const until=async(label,predicate)=>{const end=Date.now()+12000;do{if(await predicate())return;await pause(30)}while(Date.now()<end);throw new Error('Actual local scene did not settle: '+label)}
 const click=async(selector)=>{const m=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+Math.min(r.height/2,12);return{x,y,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(x,y))}})()`)
  assert.ok(m?.hit&&m.width>0&&m.height>0,'Actual target hit '+selector)
  for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:m.x,y:m.y,button:'left',clickCount:1});return m}
 const shot=async(file,width)=>{await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const image=await window.webContents.capturePage();assert.ok(!image.isEmpty());await fs.writeFile(path.join(evidence,file),image.toPNG());receipt.frames.push({file,width})}
 const base=f=>{for(const k of ['sameHost','connected','sameDraftElement','sameSessions','sameHistory','sameDrafts'])assert.equal(f[k],true,k)
  assert.equal(f.semanticAgent,'session-codex');assert.equal(f.originalRun,'run-codex');assert.equal(f.primary,'workspace-demo');assert.equal(f.draft,'Original unsent draft');assert.deepEqual(f.range,[7,15]);assert.deepEqual(Object.values(f.calls),[0,0,0,0,0]);assert.deepEqual(f.unmounts,[])}
 await window.loadFile(html);window.showInactive();window.webContents.debugger.attach('1.3')
 await until('actual original paint',()=>read('window.focusLocalProof?.ready&&document.querySelectorAll("[data-fixture-session]").length===2'))
 await read('window.focusLocalProof.enter()');await until('original whole Tab',async()=>(await facts()).selectedTab==='explicit-exact-tab')
 const initial=await facts(),target=await click('.focused-tab-workspace [data-workbench-region-id="exact-r1"]')
 await until('file exact local selection',async()=>(await facts()).reference?.regionId==='exact-r1')
 for(const width of [1280,640]){window.setContentSize(width,800);await pause(150);const f=await facts();base(f);assert.equal(f.sameTabs,true);assert.equal(f.sameLayouts,true);assert.equal(f.actualFile,true)
  assert.deepEqual(f.reads,initial.reads);const drawn=await read('(()=>{const e=document.querySelector(".focused-tab-workspace"),r=e.getBoundingClientRect();return {width:r.width,height:r.height,regions:[...e.querySelectorAll("[data-workbench-region-id]")].map(n=>{const q=n.getBoundingClientRect();return {id:n.dataset.workbenchRegionId,width:q.width,height:q.height}})}})()')
  assert.equal(drawn.regions.length,2);assert.ok(drawn.regions.every(r=>r.width>0&&r.height>0));await shot('file-'+width+'.png',width);receipt.phases.push({phase:'file',width,target,facts:f,drawn})}
 const newTab=await click('.focused-tab-workspace button[title="New tab"]')
 await until('one actual Launcher body',async()=>{const f=await facts();return f.created.length===1&&f.selectedTab===f.created[0]&&f.actualLauncher})
 for(const width of [1280,640]){window.setContentSize(width,800);await pause(150);const f=await facts();base(f);assert.equal(f.created.length,1);assert.equal(f.selectedTab,f.created[0]);assert.equal(f.actualLauncher,true)
  assert.deepEqual(f.primarySelection,initial.primarySelection);await shot('launcher-'+width+'.png',width);receipt.phases.push({phase:'launcher',width,target:newTab,facts:f})}
 receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};if(window&&!window.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await window.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(receipt,null,2)+'\n');if(window&&!window.isDestroyed())window.destroy();app.exit(receipt.passed?0:1)}})
