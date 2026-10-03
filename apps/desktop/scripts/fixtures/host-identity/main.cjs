const {app,BrowserWindow}=require('electron')
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
const scenes=[['focus-wide','focus',0,1280],['focus-narrow','focus',0,640],['sidebar-wide','groups',1,1280],['sidebar-narrow','groups',1,640],['board-local','board',0,1280],['board-ssh','board',1,1280],['board-unconfigured','board',2,1280],['board-long-narrow','board',3,640]]
for(const [name,scene,index,width] of (process.env.AGENTMUX_HOST_IDENTITY_WRAP_MUTANT==='1'?scenes.filter(s=>s[0]==='board-long-narrow'):scenes)){
win.setContentSize(width,800);await read(`window.hostIdentityScene(${JSON.stringify(scene)},${index})`);await new Promise(r=>setTimeout(r,650));await read('document.fonts.ready');await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
if(name==='board-long-narrow'){
const hostTextWidth=await read(`document.querySelector('.board-host-scope > span').getBoundingClientRect().width`)
receipt.layoutProof={hostTextWidth,minimumExclusive:24,mutant:process.env.AGENTMUX_HOST_IDENTITY_WRAP_MUTANT==='1'}
if(hostTextWidth<=24)throw Error('Native layout: host text width must exceed 24 CSS px')
const target=await read(`(() => {const button=[...document.querySelectorAll('.board-toolbar button')].find(b=>b.textContent.includes('Refresh'));if(!button)throw Error('Refresh missing');const r=button.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,box:r.toJSON(),hit:button.contains(document.elementFromPoint(x,y)),enabled:!button.disabled,before:window.hostIdentityBranchReads}})()`)
receipt.layoutProof.refreshTarget=target
if(!target.hit||!target.enabled||target.box.x<0||target.box.x+target.box.width>width||target.box.y+target.box.height>800)throw Error('Refresh not fully reachable')
win.webContents.debugger.attach('1.3')
for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:target.x,y:target.y,button:'left',clickCount:1})
await new Promise(r=>setTimeout(r,200))
const after=await read('({reads:window.hostIdentityBranchReads,runtimeAttempts:window.hostIdentityRuntimeAttempts})')
if(after.reads<=target.before||after.runtimeAttempts!==0)throw Error('Refresh did not reach preview Git API safely')
receipt.layoutProof.passed=true;receipt.refreshClick={nativePointer:true,...target,after};win.webContents.debugger.detach()
}
const file=name+'.png';await fs.writeFile(path.join(out,file),(await win.webContents.capturePage()).toPNG());receipt.images.push({file,scene,index,width,identities:await read(`[...document.querySelectorAll('.host-identity')].map(n=>({text:n.textContent,title:n.title,aria:n.getAttribute('aria-label')}))`)})
}
receipt.captured=true
}catch(e){receipt.error=e.stack;process.exitCode=1}finally{await fs.writeFile(path.join(out,'capture.json'),JSON.stringify(receipt,null,2));app.exit(process.exitCode||0)}})
