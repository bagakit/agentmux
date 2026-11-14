const {app,BrowserWindow}=require('electron')
const assert=require('node:assert/strict')
const fs=require('node:fs/promises'),path=require('node:path')
const [html,out]=process.argv.slice(2)
app.setPath('userData',path.join(out,'private-profile'));app.setPath('sessionData',path.join(out,'private-session'))
app.whenReady().then(async()=>{let win;const receipt={captureOnly:true,aestheticReview:'not-performed',images:[],errors:[],boundary:'Private Electron; production Renderer components and CSS; controlled web preview API. No real SSH, CLI, PTY, user App or Run.'};try{
win=new BrowserWindow({width:1280,height:800,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
win.webContents.on('console-message',(_e,_l,m)=>{receipt.errors.push(m);console.error(m)})
await win.loadFile(html)
const read=s=>win.webContents.executeJavaScript(s)
for(let i=0;i<200&&!await read('Boolean(window.hostIdentityReady)');i++)await new Promise(r=>setTimeout(r,50))
if(!await read('Boolean(window.hostIdentityReady)'))throw Error('Renderer not ready')
const scenes=[['focus-wide','focus',0,1280],['focus-narrow','focus',0,640],['sidebar-wide','groups',1,1280],['sidebar-narrow','groups',1,640],['breadcrumb-local','breadcrumb',0,1280],['breadcrumb-ssh','breadcrumb',1,1280],['breadcrumb-unconfigured','breadcrumb',2,1280],['breadcrumb-long-narrow','breadcrumb',3,640]]
for(const [name,scene,index,width] of scenes){
win.setContentSize(width,800);await read(`window.hostIdentityScene(${JSON.stringify(scene)},${index})`);await new Promise(r=>setTimeout(r,650));await read('document.fonts.ready');await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
const identities=await read(`[...document.querySelectorAll('.host-identity')].map(n=>({hostId:n.dataset.hostId,kind:n.dataset.hostKind,text:n.textContent,title:n.title,aria:n.getAttribute('aria-label')}))`)
assert.equal(await read('window.hostIdentityRuntimeAttempts'),0,'Capture must not mutate a Runtime')
if(scene==='breadcrumb'){
assert.equal(await read(`document.querySelector('.breadcrumbs > strong')?.textContent`),index===3?'feature/remote-host-identity-long-branch':'main')
if(index===0)assert.deepEqual(identities,[],'Local breadcrumb does not repeat the machine identity')
else{
assert.equal(identities.length,1)
const hostId=['local','ssh-studio','missing-host','ssh-long'][index]
assert.equal(identities[0].hostId,hostId)
assert.ok(identities[0].aria.includes(hostId),'The original Host ID remains accessible')
assert.equal(identities[0].kind,index===2?'unknown':'ssh')
assert.equal(identities[0].text,index===1?'Studio':index===2?'missing-host':'Production Research Workstation Singapore')
}
}
const file=name+'.png';await fs.writeFile(path.join(out,file),(await win.webContents.capturePage()).toPNG());receipt.images.push({file,scene,index,width,identities})
}
receipt.captured=true
}catch(e){receipt.error=e.stack;process.exitCode=1}finally{await fs.writeFile(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));app.exit(process.exitCode||0)}})
