const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot,evidence]=process.argv.slice(2),hash=value=>crypto.createHash('sha256').update(value).digest('hex')
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const result={schema:'agentmux.focus-empty-state-visibility-actual.v1',passed:false,pid:process.pid,frames:[],scenes:[],stages:[],rendererConsole:[],boundary:'Maintained shared App/Focus/Workbench typed preview and actual Chromium CSS. PTY/Agent and unused Monaco painting isolated; no Core Runtime/Run/PID/restart/Writer/install claim.'}
let win
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:800,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=2)result.rendererConsole.push(String(message).slice(0,2000))})
 const read=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(error){result.failedEvaluation=code;throw error}},pause=ms=>new Promise(done=>setTimeout(done,ms))
 const until=async(label,predicate)=>{const end=Date.now()+12000;do{if(await predicate())return;await pause(30)}while(Date.now()<end);throw new Error('Empty-state scene did not settle: '+label)}
 await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 await until('actual maintained App/three original Regions',()=>read('window.focusPresentationProof?.ready&&document.querySelectorAll("[data-fixture-session]").length===3'))
 result.stages.push('actual-App-ready');await read('window.focusPresentationProof.existingExactEntry()')
 const click=async selector=>{const p=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing exact control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);assert.equal(p.hit,true);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1})}
 await click('button.surface-navigation__focus');await until('actual projection displayed',async()=>Boolean((await read('window.focusPresentationProof.facts()')).selectedTab))
 await click('[aria-label="Close Focus workspace"]');await until('only display closed',async()=>!(await read('window.focusPresentationProof.facts()')).selectedTab)
 result.stages.push('actual-Focus-only-projection-closed');result.before=await read('window.focusPresentationProof.facts()')
 const geometry=()=>read(`(()=>{const container=document.querySelector('.global-focus-main'),lane=document.querySelector('[data-project-id="workspace-demo"]');if(!container||!lane)throw new Error('Positive actual lane required');const groups=[...lane.querySelectorAll('section[data-bucket]')].map(group=>{const header=group.querySelector('.focus-context-group__header'),r=header.getBoundingClientRect();return{bucket:group.dataset.bucket,empty:group.dataset.empty==='true',display:getComputedStyle(group).display,label:header.getAttribute('aria-label'),count:header.querySelector('.focus-context-group__bucket > span')?.textContent,iconCount:header.querySelectorAll('svg').length,width:r.width,height:r.height,x:r.x,y:r.y}});return{containerWidth:container.getBoundingClientRect().width,groups,horizontalOverflow:container.scrollWidth>container.clientWidth+1,agentIds:[...lane.querySelectorAll('.focus-context[data-session-id]')].map(node=>node.dataset.sessionId)}})()`)
 const qualify=value=>{assert.deepEqual(value.groups.map(group=>group.bucket),['attention','working','results','idle','disconnected']);assert.equal(value.groups.filter(group=>group.empty).length,4);assert.deepEqual(value.agentIds,['session-codex']);assert.equal(value.horizontalOverflow,false);for(const group of value.groups){assert.ok(group.width>0&&group.height>0,'Actual visible state header: '+group.bucket);assert.ok(group.iconCount>0,'Actual icon: '+group.bucket);if(group.empty)assert.equal(group.count,'0','Actual empty count: '+group.bucket)}}
 const settle=()=>read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
 const sheetIds=[];win.webContents.debugger.on('message',(_event,method,params)=>{if(method==='CSS.styleSheetAdded')sheetIds.push(params.header)})
 await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable')
 const styles=await until('actual consumed stylesheet',async()=>{const found=sheetIds.find(sheet=>sheet.sourceURL.endsWith('/app.css'));if(found){result.actualSheet=found;return true}return false})
 assert.equal(styles,undefined)
 const original=await win.webContents.debugger.sendCommand('CSS.getStyleSheetText',{styleSheetId:result.actualSheet.styleSheetId})
 const thresholds=[...original.text.matchAll(/@container\s*\(max-width:\s*(\d+)px\)/g)].map(match=>Number(match[1]));assert.ok(thresholds.includes(800),'Actual lane threshold belongs to loaded CSS');result.actualThreshold=800
 for(const width of [640,799,801]){
  win.setContentSize(width,800);await settle();await until('actual container width '+width,async()=>Math.abs((await geometry()).containerWidth-width)<1)
  const actual=await geometry();qualify(actual);result.scenes.push({phase:'green',width,actual})
  const file='empty-'+width+'.png';await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.frames.push({file,width})
 }
 win.setContentSize(640,800);await settle()
 const mutant=original.text+"\n@container (max-width:800px){.focus-context-group[data-empty='true']{display:none}}\n"
 await win.webContents.debugger.sendCommand('CSS.setStyleSheetText',{styleSheetId:result.actualSheet.styleSheetId,text:mutant});await settle()
 const loadedRed=await win.webContents.debugger.sendCommand('CSS.getStyleSheetText',{styleSheetId:result.actualSheet.styleSheetId});assert.equal(loadedRed.text,mutant)
 const red=await geometry();let assertion
 try{qualify(red)}catch(error){assert.equal(error.name,'AssertionError');assertion={name:error.name,message:error.message,stack:error.stack}}
 assert.ok(assertion,'Actual loaded hidden rule must produce a semantic AssertionRED')
 result.mutation={originalSHA256:hash(original.text),loadedSHA256:hash(loadedRed.text),actual:red,assertion}
 await fs.writeFile(path.join(evidence,'loaded-hidden-red.png'),(await win.webContents.capturePage()).toPNG())
 await win.webContents.debugger.sendCommand('CSS.setStyleSheetText',{styleSheetId:result.actualSheet.styleSheetId,text:original.text});await settle()
 const restored=await win.webContents.debugger.sendCommand('CSS.getStyleSheetText',{styleSheetId:result.actualSheet.styleSheetId});assert.equal(restored.text,original.text);qualify(await geometry());result.restoredSHA256=hash(restored.text)
 result.after=await read('window.focusPresentationProof.facts()')
 for(const key of ['sameTabs','sameLayouts','sameSessions','sameDrafts'])assert.equal(result.after[key],true,key)
 assert.deepEqual(result.after.calls,result.before.calls);assert.deepEqual(result.after.range,result.before.range);assert.equal(result.after.draft,result.before.draft)
 result.passed=true
}catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};if(win&&!win.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
