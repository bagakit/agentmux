const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, temporary, evidence] = process.argv.slice(2)
const settingsOnly = process.argv.includes('--settings-only')
app.setPath('userData',path.join(temporary,'user-data')); app.setPath('sessionData',path.join(temporary,'session-data'))
const report={passed:false,frames:[],console:[]};let win
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1200,height:820,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=2)report.console.push(String(message).slice(0,1200))})
 const read=code=>win.webContents.executeJavaScript(code)
 const until=async(label,code)=>{const end=Date.now()+12000;do{if(await read(code))return;await new Promise(done=>setTimeout(done,40))}while(Date.now()<end);throw Error('Scene not ready: '+label)}
 const paint=()=>read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
 const click=async selector=>{const p=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control: '+${JSON.stringify(selector)});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await paint()}
 const text=async label=>{await read(`(()=>{document.querySelectorAll('[data-probe-click]').forEach(n=>n.removeAttribute('data-probe-click'));const n=[...document.querySelectorAll('button,[role=menuitem]')].find(n=>n.textContent.trim()===${JSON.stringify(label)});if(!n)throw Error('Missing text: '+${JSON.stringify(label)});n.dataset.probeClick=''})()`);await click('[data-probe-click]')}
 const revealTakeover=async()=>{if(settingsOnly){await paint();await read('document.querySelector("[data-settings-field=agent-transfer]").scrollIntoView({block:"end"})');await until('Takeover explanation is completely visible','(()=>{const n=document.querySelector("[data-settings-field=agent-transfer]"),r=n.getBoundingClientRect();return r.top>=-1&&r.bottom<=innerHeight+1&&n.textContent.includes("original location, membership and Main remain")})()')}}
 const capture=async(file,label)=>{await read('document.querySelectorAll(".settings-concept-intro__art img,.topic-promotion__art").forEach(img=>{img.loading="eager"})');await until('Visible scene images and fonts','document.fonts.status==="loaded"&&[...document.querySelectorAll(".settings-concept-intro__art img,.topic-promotion__art")].every(img=>img.complete&&img.naturalWidth>0)');await paint();await new Promise(done=>setTimeout(done,850));const geometry=await read(`(()=>{const n=document.querySelector('.agent-region-menu,.topic-context-menu');const r=n?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,menu:r?{x:r.x,y:r.y,right:r.right,bottom:r.bottom}:null}})()`);assert.ok(geometry.documentWidth<=geometry.width+1,'No document overflow');if(geometry.menu){assert.ok(geometry.menu.x>=-1&&geometry.menu.right<=geometry.width+1);assert.ok(geometry.menu.y>=-1&&geometry.menu.bottom<=geometry.height+1)}await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());report.frames.push({file,label,geometry})}
 await win.loadFile(html);win.webContents.debugger.attach('1.3')
 await until('Promotion settings','document.querySelector("[aria-label=\\"Allow promotion\\"]")!==null')
 report.before=await read('agentPromotionProbe.facts()')
 await capture('01-settings-wide.png','Promotion settings: saved allowed, independent space, two sources')
 await click('[aria-label="Allow promotion"]');await text('Save Promotion settings')
 await until('Saved off','document.body.textContent.includes("Saved: Off")')
 await revealTakeover()
 await capture('02-settings-off.png','Promotion settings: saved off with existing work explanation')
 win.setContentSize(620,760);await revealTakeover();await capture('03-settings-narrow.png','Narrow Promotion settings with saved off')
 win.setContentSize(1200,820);await read('agentPromotionProbe.theme(true)');await revealTakeover();await capture('11-settings-light.png','Light Promotion settings with saved off');await read('agentPromotionProbe.theme(false)')
 await read('agentPromotionProbe.closeSettings()');await until('Settings closed','document.querySelector(".settings-modal")===null')
 if(settingsOnly){
  report.after=await read('agentPromotionProbe.facts()')
  for(const key of ['sessions','tabs','layouts','drafts','activeWorkspaceId'])assert.deepEqual(report.after[key],report.before[key],'Original '+key+' retained')
  report.passed=true;return
 }
 await click('[aria-label^="More actions for"]');await until('Original Agent menu','document.querySelector("[data-agent-promotion]")!==null')
 win.setContentSize(1000,760);await capture('04-agent-menu.png','Actual Region Header Agent menu')
 assert.equal(await read('document.querySelector("[data-agent-promotion]").textContent'),'Promotion…')
 assert.equal(await read('document.querySelector("[data-agent-promotion] svg").getAttribute("data-semantic-icon")'),'object.promotion')
 await read('agentPromotionProbe.theme(true)');await capture('13-agent-menu-light.png','English Agent menu and shared Promotion icon in light theme');await read('agentPromotionProbe.theme(false)')
 win.setContentSize(620,760);await capture('14-agent-menu-narrow.png','English Agent menu and small Promotion icon in narrow viewport')
 await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
 await click('[aria-label="Actions for A familiar Topic"]');await until('Topic menu','document.querySelector(".topic-context-menu")!==null')
 assert.equal(await read('document.querySelector(".topic-context-menu [role=menuitem]").textContent'),'Promote to Mote Club…')
 assert.equal(await read('document.querySelector(".topic-context-menu [role=menuitem] svg").getAttribute("data-semantic-icon")'),'object.promotion')
 await capture('15-topic-menu-dark.png','Topic menu uses the same English action and Promotion icon')
 await read('agentPromotionProbe.theme(true)');await capture('16-topic-menu-light.png','Topic menu shared Promotion icon in light theme');await read('agentPromotionProbe.theme(false)')
 await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
 win.setContentSize(1000,760)
 report.after=await read('agentPromotionProbe.facts()')
 for(const key of ['sessions','tabs','layouts','drafts','activeWorkspaceId'])assert.deepEqual(report.after[key],report.before[key],'Original '+key+' retained')
 assert.equal(await read('document.querySelector("[aria-label=\\"Original draft\\"]").value'),'Keep the original draft')
 report.passed=true
}catch(error){report.error=error.stack||String(error);if(win)report.failureScene=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight,transfer:document.querySelector("[data-settings-field=agent-transfer]")?.getBoundingClientRect().toJSON()})').catch(()=>null)}finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(report,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(report.passed?0:1)}})
