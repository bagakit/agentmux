const {app,BrowserWindow}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [html,profile,output]=process.argv.slice(2)
app.setPath('userData',profile);app.disableHardwareAcceleration()
const receipt={frames:[],checks:[],passed:false},delay=ms=>new Promise(r=>setTimeout(r,ms))
let window
app.whenReady().then(async()=>{
 try{
  window=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{backgroundThrottling:false,sandbox:false}})
  const evaluate=code=>window.webContents.executeJavaScript(code,true)
  const paint=async()=>{await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await delay(120)}
  const wait=async expression=>{for(let n=0;n<120;n++){if(await evaluate(expression))return;await delay(50)}throw Error('Missing actual consumer: '+expression)}
  const frame=async name=>{await paint();const file=name+'.png';await fs.writeFile(path.join(output,file),(await window.webContents.capturePage()).toPNG());receipt.frames.push(file)}
  const wheel=async(deltaY)=>{const point=await evaluate("(()=>{const r=document.querySelector('.launch-surface').getBoundingClientRect();return{x:r.right-12,y:r.y+r.height/2}})()");await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});await paint()}
  const check=async()=>{await evaluate("Array.from(document.querySelectorAll('.launcher-source-original button')).find(b=>b.textContent==='Check original task').click()");await paint()}
  await window.loadFile(html);window.webContents.debugger.attach('1.3')
  await wait("Boolean(window.sourceFailure && document.querySelector('[aria-label=\"Original creation failures\"]'))")
  for(const [name,width,height,theme]of[['wide-dark',1180,850,'dark'],['narrow-light',460,760,'light'],['short-dark',840,430,'dark']]){
   await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
   await evaluate(`sourceFailure.theme(${JSON.stringify(theme)});document.querySelector('.launch-surface').scrollTop=0`);await paint()
   const geometry=await evaluate("(()=>{const s=document.querySelector('.launch-surface'),e=s.querySelector('[aria-label=\"Original creation failures\"]');return{width:s.clientWidth,scrollWidth:s.scrollWidth,reason:e.textContent,inDetails:Boolean(e.closest('details'))}})()")
   assert.equal(geometry.width,geometry.scrollWidth,'Original Launcher has no horizontal overflow');assert.equal(geometry.inDetails,false);assert(geometry.reason.includes('EXECUTION_OWNER_UNAVAILABLE'));receipt.checks.push({name,geometry});await frame(name)
   if(name==='short-dark'){
    let draft
    for(let step=0;step<8;step++){
     await wheel(180)
     draft=await evaluate("(()=>{const s=document.querySelector('.launch-surface'),d=s.querySelector('[contenteditable=\"true\"]'),r=d.getBoundingClientRect(),v=s.getBoundingClientRect();return{top:s.scrollTop,visible:r.top>=v.top&&r.bottom<=v.bottom,text:d.textContent}})()")
     if(draft.top>0&&draft.visible)break
    }
    assert(draft.top>0&&draft.visible&&draft.text.includes('newer private draft'),'Native wheel reaches original private draft');receipt.checks.push({name:'short-draft',draft});await frame('short-draft')
    await evaluate("document.querySelector('.launcher-source-original summary').click();document.querySelector('.launcher-source-original details').scrollIntoView({block:'start'})");await paint()
    const details=await evaluate("(()=>{const s=document.querySelector('.launch-surface'),d=s.querySelector('.launcher-source-original details'),p=d.querySelector('pre'),r=d.getBoundingClientRect(),v=s.getBoundingClientRect();return{open:d.open,visible:r.top<v.bottom&&r.bottom>v.top,width:s.clientWidth,scrollWidth:s.scrollWidth,text:p.textContent}})()")
    assert(details.open&&details.visible&&details.text.includes('original-creation-operation'));assert.equal(details.width,details.scrollWidth,'Expanded original request wraps its complete content');receipt.checks.push({name:'short-details',details});await frame('short-details')
    await evaluate("document.querySelector('.launcher-source-original summary').click()")
   }
  }
  await window.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:1180,height:850,deviceScaleFactor:1,mobile:false})
  await evaluate("sourceFailure.theme('dark');document.querySelector('.launch-surface').scrollTop=0");await check()
  await wait("document.querySelector('[aria-label=\"Source observation issues\"]')?.textContent.includes('HOST_ROUTE_AUTHORIZATION_REQUIRED')")
  await frame('new-observer-issue')
  await evaluate('sourceFailure.fail()');await check()
  await wait("document.body.textContent.includes('Latest observation: The latest Source read is unavailable')")
  await frame('observation-failed')
  const facts=await evaluate('sourceFailure.facts()');assert.equal(facts.effects,0);assert(facts.prompt.includes('newer private draft'));assert.equal(facts.calls.launches.length,0);assert.equal(facts.calls.submissions.length,0)
  receipt.facts=facts;receipt.passed=true
 }catch(error){receipt.failure={message:error.message,stack:error.stack};process.exitCode=1}
 finally{await fs.writeFile(path.join(output,'ui-receipt.json'),JSON.stringify(receipt,null,2));window?.destroy();app.exit(process.exitCode||0)}
})
