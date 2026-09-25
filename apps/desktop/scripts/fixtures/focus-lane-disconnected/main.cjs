const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, phase, widthsJson] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, phase, pid: process.pid, scenes: [], images: [], boundary: 'Actual compiled Global/Workbench/SessionPane/xterm/style; public web-preview typed facts. Ordinary GUI restores durable Tab/Region/layout/draft and exact Session/Run control values, not live Core Run/PID continuity. User lifecycle controls: 0.' }
let win
app.whenReady().then(async () => {
 try {
  win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  await win.loadFile(html)
  const evaluate = code => win.webContents.executeJavaScript(code)
  const until = async code => {
   const deadline = Date.now()+8000
   do { if(await evaluate(code)) return; await new Promise(resolve=>setTimeout(resolve,20)) } while(Date.now()<deadline)
   throw new Error('Actual lane condition did not settle: '+code)
  }
  await until('window.laneProbeReady && !!document.querySelector("#focus-workspace-slot [data-workbench-region-id=fixture-region]")')
  if(phase==='restore') {
   const saved=JSON.parse(fs.readFileSync(path.join(privateRoot,'durable.json'),'utf8'))
   await evaluate(`window.restoreLaneProbe(${JSON.stringify(saved)})`)
   await until('!!document.querySelector("#focus-workspace-slot [data-workbench-region-id=fixture-region]")')
   result.restored=await evaluate('window.laneProbeState()');assert.deepEqual(result.restored,saved)
  }
  result.original=await evaluate('window.laneProbeState()')
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const hit=async selector=>{
   const actual=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing actual target');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return {selector:${JSON.stringify(selector)},x,y,width:r.width,height:r.height,matched:el.contains(document.elementFromPoint(x,y))}})()`)
   assert.equal(actual.matched,true);assert.ok(actual.width>0&&actual.height>0);return actual
  }
  const click=async selector=>{
   const actual=await hit(selector)
   for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,x:actual.x,y:actual.y})
   await frames();return actual
  }
  await evaluate('window.laneProbeMode("board")');await frames()
  for(const width of JSON.parse(widthsJson)) {
   win.setContentSize(width,900);await until(`Math.abs(window.laneProbeGeometry().containerWidth-${width})<1`);await frames()
   const toggle='[data-project-id="workspace-demo"] section[data-bucket="disconnected"] .focus-recovery-toggle'
   const hits=[]
   if(await evaluate(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-expanded')==='true'`))await click(toggle)
   hits.push(await hit(toggle))
   // Pointer activation opens the real disclosure; Space then closes/reopens
   // that same focused button through Chromium's trusted keyboard dispatch.
   await click(toggle);await until('!!document.querySelector("[data-session-id=offline].focus-context--compact")')
   for(const expanded of [false,true]) {
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32})
    await until(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-expanded')==='${expanded}'`)
   }
   const row='[data-session-id="offline"].focus-context--compact';hits.push(await hit(row))
   const geometry=await evaluate('window.laneProbeGeometry()')
   assert.deepEqual(geometry.columns.map(c=>c.bucket),['attention','working','results','idle','disconnected'])
   assert.equal(geometry.horizontalOverflow,false);assert.equal(geometry.compactHeight,28)
   assert.ok(geometry.columns.every(c=>c.width>0&&c.height>0))
   const scene={width,...geometry,hits};result.scenes.push(scene)
   await evaluate('document.querySelector(".focus-project-lanes__rows").scrollTop=0');await frames()
   const image=`${phase}-${width}.png`;fs.writeFileSync(path.join(privateRoot,image),(await win.webContents.capturePage()).toPNG());result.images.push(image)
  }
  // Return to the original work surface after geometry observations; keep the
  // same original Tab/Region/draft/control values for the ordinary restart.
  win.setContentSize(1440,900);await evaluate('window.laneProbeMode("workspace")');await until('!!document.querySelector("#focus-workspace-slot [data-workbench-region-id=fixture-region]")')
  result.final=await evaluate('window.laneProbeState()');assert.deepEqual(result.final,result.original)
  assert.equal(result.final.tabs['fixture-tab'].layout.activeRegionId,'fixture-region')
  assert.equal(result.final.layouts['workspace-demo'].activeGroupId,'fixture-group')
  assert.equal(result.final.agentComposerDrafts['session-codex'],'不要丢失这份原会话草稿')
  assert.equal(result.final.sessions.find(s=>s.id==='session-codex').control.run.runId,'run-codex')
  await until('!!document.querySelector("#focus-workspace-slot .xterm")')
  result.loadedXterm=true
  if(phase==='seed')fs.writeFileSync(path.join(privateRoot,'durable.json'),JSON.stringify(result.final))
  result.passed=true
 }catch(error){result.error={name:error.name,message:error.message,stack:error.stack}}
 finally {
  fs.writeFileSync(path.join(privateRoot,phase+'-result.json'),JSON.stringify(result,null,2))
  if(win&&!win.isDestroyed())win.destroy()
  app.exit(result.passed?0:1)
 }
})
