const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {app,BrowserWindow}=require('electron'),[html,privateRoot,evidence]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const receipt={schema:'agentmux.survey-item-tabs-actions-actual.v1',passed:false,pid:process.pid,frames:[],operations:[],userAppRunRuntimeControlled:false,
 boundary:'Actual compiled App/Survey/Store/Workbench and full CSS; maintained typed preview API. SessionPane/EditorPane/unused diff painting isolated. Trusted CDP events, not physical mouse, Native Browser, real Runtime/PTY, ordinary restart or installation.'}
const pause=ms=>new Promise(done=>setTimeout(done,ms));let window
app.whenReady().then(async()=>{try{
 window=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 const read=code=>window.webContents.executeJavaScript(code),facts=()=>read('window.surveyItemProof.facts()')
 const until=async(label,predicate)=>{const end=Date.now()+12000;do{if(await predicate())return;await pause(30)}while(Date.now()<end);throw new Error('Actual Survey scene did not settle: '+label)}
 const pointer=async(selector,button='left',kind='click',edge='center')=>{const m=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.x+(${JSON.stringify(edge)}==='start'?8:${JSON.stringify(edge)}==='end'?r.width-8:r.width/2),y=r.y+Math.min(r.height/2,12);return{x,y,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(x,y)),label:e.getAttribute('aria-label')}})()`)
  assert.ok(m&&m.width>0&&m.height>0,'Actual target geometry '+selector)
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:m.x,y:m.y})
  await pause(30);m.hit=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return Boolean(e?.contains(document.elementFromPoint(${m.x},${m.y})))})()`);assert.ok(m.hit,'Actual target hit after pointer hover '+selector)
  if(kind!=='hover')for(const type of ['mousePressed','mouseReleased'])await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:m.x,y:m.y,button,clickCount:1})
  receipt.operations.push({action:kind,button,selector,hit:m});return m}
 const key=async(key,modifiers=0)=>{for(const type of ['keyDown','keyUp'])await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key,modifiers});receipt.operations.push({action:'key',key,modifiers});if(key==='Escape')await pause(220)}
 const shot=async(file)=>{const [width,height]=window.getContentSize();await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:width-12,y:height/2});await pause(240);await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const image=await window.webContents.capturePage();assert.ok(!image.isEmpty());await fs.writeFile(path.join(evidence,file),image.toPNG());receipt.frames.push({file,width,facts:await facts()})}
 const base=f=>{assert.equal(f.sameSessions,true);assert.equal(f.sameDrafts,true);assert.equal(f.draft,'Original unsent research draft');assert.equal(f.run,'run-codex');assert.equal(f.primary,f.originalPrimary);assert.ok(f.originalTabs.every(t=>t.preserved),'Original exact Tabs preserved');assert.deepEqual(Object.values(f.calls),[0,0,0,0,0])}
 const menuItem=async(text)=>{const selector=await read(`(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent===${JSON.stringify(text)});if(!e)return null;e.setAttribute('data-survey-proof-action','chosen');return '[data-survey-proof-action="chosen"]'})()`);assert.ok(selector,'Actual action '+text);await pointer(selector)}
 await window.loadFile(html);window.showInactive();window.webContents.debugger.attach('1.3')
 await until('actual Survey rows',()=>read('window.surveyItemProof?.ready&&document.querySelectorAll("[data-survey-zone-id]").length===2'))
 const identity=await read('({zoneA:window.surveyItemProof.zoneA,zoneB:window.surveyItemProof.zoneB})'),rowA=`[data-survey-zone-id=${JSON.stringify(identity.zoneA)}]`,rowB=`[data-survey-zone-id=${JSON.stringify(identity.zoneB)}]`
 const initial=await facts();base(initial);receipt.initial=initial
 assert.equal(initial.rows[0].tabs.length,4,'Actual first item sub-tabs');assert.equal(initial.rows[0].tabs.filter(t=>t.favicons===1).length,2,'Each Browser favicon is visible');assert.equal(initial.rows[0].tabs.find(t=>t.id==='survey-a-agent')?.marks,2,'Mixed original Agent/File Tab keeps both marks')
 await pointer(`${rowA} [data-survey-tab-id="survey-a-source"]`)
 await until('exact Tab selection',async()=>(await facts()).selection?.active?.tabId==='survey-a-source')
 base(await facts());await shot('01-wide-tabs.png')
 await pointer(`${rowA} button[aria-label="Add to Research reading"]`)
 await until('add menu',()=>read('Boolean(document.querySelector(".survey-item-create-menu[role=menu]"))'))
 await shot('02-wide-add-menu.png');await key('Escape')
 await pointer(`${rowA} button[aria-label="Options for Research reading"]`)
 await until('settings menu',()=>read('Boolean(document.querySelector(".survey-item-menu[role=menu]"))'))
 await shot('03-wide-settings-menu.png');await key('Escape')
 window.setContentSize(720,800);await pause(220);base(await facts());await shot('04-narrow-tabs.png')
 await pointer(`${rowA} button[aria-label="Add to Research reading"]`);await until('narrow add menu',()=>read('Boolean(document.querySelector(".survey-item-create-menu[role=menu]"))'));await shot('05-narrow-add-menu.png');await key('Escape')
 window.setContentSize(1280,800);await pause(220)
 const held=(await facts()).selection
 await pointer(rowA,'right','click','end')
 await until('first context',()=>read(`document.querySelector('[data-survey-context-zone-id]')?.dataset.surveyContextZoneId===${JSON.stringify(identity.zoneA)}`))
 await pointer(`${rowB} .survey-item`,'right','click','start')
 await until('second exact context',()=>read(`document.querySelector('[data-survey-context-zone-id]')?.dataset.surveyContextZoneId===${JSON.stringify(identity.zoneB)}`))
 assert.deepEqual((await facts()).selection,held,'Right-click retains selected workface');base(await facts());await shot('06-second-row-context.png');await key('Escape')
 await pointer(`${rowB} button[aria-label="Add to Follow-up research"]`)
 await until('noncurrent add menu',()=>read('Boolean(document.querySelector(".survey-item-create-menu[role=menu]"))'))
 assert.deepEqual((await facts()).selection,held,'Opening noncurrent add does not navigate')
 await menuItem('New tab…')
 await until('one noncurrent Zone Tab',async()=>(await facts()).created.length===1)
 const created=await facts();base(created);assert.equal(created.created[0].zoneId,identity.zoneB);assert.equal(created.created[0].workspaceId,'survey-second-workspace');assert.equal(created.created[0].regions[0].kind,'launcher');await shot('07-created-second-zone-tab.png')
 await pointer('[aria-label="Hide Survey items"]');await until('collapsed',async()=>(await facts()).collapsed);await pause(240)
 for(let attempt=0;attempt<24&&!await read(`document.activeElement===document.querySelector(${JSON.stringify(rowA+' .survey-item')})`);attempt++)await key('Tab')
 assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(rowA+' .survey-item')})`),true,'Collapsed original row is keyboard reachable')
 await key('F10',8)
 await until('collapsed keyboard menu',()=>read(`document.querySelector('[data-survey-context-zone-id]')?.dataset.surveyContextZoneId===${JSON.stringify(identity.zoneA)}`))
 base(await facts());await shot('08-collapsed-keyboard-menu.png');await key('Escape')
 await pointer('[aria-label="Show Survey items"]');await until('expanded',async()=>!(await facts()).collapsed);await pause(240)
 await pointer(`${rowA} .survey-item`);await until('first Zone selected before noncurrent close',async()=>(await facts()).selection?.zoneId===identity.zoneA)
 const beforeClose=(await facts()).selection
 await pointer(`${rowB} button[aria-label="Options for Follow-up research"]`)
 await until('second settings',()=>read('Boolean(document.querySelector(".survey-item-menu[role=menu]"))'))
 await menuItem('Close in Survey')
 await until('only exact Survey reference closed',async()=>!(await facts()).collected[identity.zoneB])
 const closed=await facts();base(closed);assert.deepEqual(closed.selection,beforeClose,'Closing a noncurrent item retains the current selection');assert.equal(closed.collected[identity.zoneA],true);assert.equal(closed.retainedTabIds.length,initial.retainedTabIds.length+1);assert.equal(closed.rows.length,1);assert.ok(closed.retainedTabIds.includes(created.created[0].id));await shot('09-closed-reference-preserved-content.png')
 receipt.final=closed;receipt.passed=true
 }catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};if(window&&!window.isDestroyed())await fs.writeFile(path.join(evidence,'failure.png'),(await window.webContents.capturePage()).toPNG())}
 finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(receipt,null,2)+'\n');if(window&&!window.isDestroyed()&&window.webContents.debugger.isAttached())window.webContents.debugger.detach();app.exit(receipt.passed?0:1)}})
