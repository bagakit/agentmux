const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,privateRoot]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'user-data'));app.setPath('sessionData',path.join(privateRoot,'session-data'))
const result={schema:'agentmux.focus-agent-membership-actual-gui.v1',passed:false,pid:process.pid,scenes:[],images:[],boundary:'Actual compiled Global/Workbench/SessionPane/xterm with public web-preview typed Sessions. Original Terminal Tab/Region/Run references/draft/history retained. No true Core Run/PID continuity or installed App qualification; user lifecycle controls0.'};let win
app.whenReady().then(async()=>{try{
 win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await win.loadFile(html)
 const evaluate=code=>win.webContents.executeJavaScript(code),until=async code=>{const deadline=Date.now()+8000;do{if(await evaluate(code))return;await new Promise(resolve=>setTimeout(resolve,20))}while(Date.now()<deadline);throw new Error('Actual membership condition did not settle: '+code)}
 await until('window.laneProbeReady && window.membershipProbe().terminalRegion && window.membershipProbe().xterm')
 result.original=await evaluate('window.laneProbeState()')
 for(const width of [640,1440]){
  win.setContentSize(width,900);await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const toggle='[data-project-id="workspace-demo"] section[data-bucket="disconnected"] .focus-recovery-toggle'
  await until(`!!document.querySelector(${JSON.stringify(toggle)})`)
  if(await evaluate(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-expanded')!=='true'`))await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click()`)
  await until('window.membershipProbe().rows.length===6')
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  await new Promise(resolve=>setTimeout(resolve,120))
  await until('window.membershipProbe().rows.length===6')
  const facts=await evaluate('window.membershipProbe()');assert.deepEqual(facts.rows,['attention','healthy-lost','idle','offline','results','session-codex']);assert.equal(facts.slot,'fixture-tab');assert.equal(facts.focus,'ordinary');assert.equal(facts.terminalRegion,true);assert.equal(facts.xterm,true);assert.equal(facts.draft,'不要丢失这份终端草稿');assert.ok(facts.historyTracks.includes('ordinary'));assert.deepEqual(facts.counts,[{key:'working',text:'1'},{key:'attention',text:'1'}])
  const target=await evaluate(`(()=>{const el=document.querySelector('#focus-workspace-slot [data-workbench-region-id="fixture-region"]');const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {width:r.width,height:r.height,hit:el.contains(document.elementFromPoint(x,y))}})()`);assert.ok(target.width>0&&target.height>0&&target.hit)
  result.scenes.push({width,...facts,target});const image='membership-'+width+'.png';fs.writeFileSync(path.join(privateRoot,image),(await win.webContents.capturePage()).toPNG());result.images.push(image)
 }
 result.final=await evaluate('window.laneProbeState()');assert.deepEqual(result.final,result.original);result.passed=true
}catch(error){result.error={name:error.name,message:error.message,stack:error.stack}}finally{fs.writeFileSync(path.join(privateRoot,'seed-result.json'),JSON.stringify(result,null,2));if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
