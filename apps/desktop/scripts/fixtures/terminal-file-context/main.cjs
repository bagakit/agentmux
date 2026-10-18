const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, temporaryRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(temporaryRoot, 'user-data')); app.setPath('sessionData', path.join(temporaryRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], userRunTouched: false, boundary: 'Actual Electron + production WorkspaceWorkbench/SessionPane/TerminalView/Region menu; preview session I/O; typed files.reveal host port recorded, no Finder side effect.' }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(done => setTimeout(done, ms))
const menu = 'document.querySelector(\'[role="menu"][data-state="open"]\')'
const reveal = `([...(${menu}?.querySelectorAll('[role="menuitem"]')??[])].find(node=>(node.getAttribute('aria-label')??node.querySelector('span')?.textContent??node.textContent).trim()==='Reveal in Finder'))`
async function wait(expression) {
  for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(25)}
  throw Error('Timed out: '+expression)
}
async function input(point, button) {
  for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button,clickCount:1})
}
async function close() {
  if(!await evaluate(`Boolean(${menu})`))return
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await wait(`!${menu}`)
}
app.whenReady().then(async()=>{
  try{
    await fs.mkdir(evidence,{recursive:true})
    win=new BrowserWindow({show:false,width:1281,height:780,webPreferences:{backgroundThrottling:false,sandbox:false}})
    await win.loadFile(html);win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await wait('Boolean(window.fileContext)')
    for(const [width,appearance] of [[640,'dark'],[320,'light']]){
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:width*2+1,height:780,deviceScaleFactor:1,mobile:false})
      await evaluate(`identityMenu.appearance(${JSON.stringify(appearance)});terminalMenu.seed()`)
      await wait(`Boolean(document.querySelector('[data-workbench-region-id="region-actions-target"] .xterm-screen'))&&!document.querySelector('[data-workbench-region-id="region-actions-target"] .terminal-view__xterm--hydrating')`)
      for(const kind of ['declared','bare','http']){
        const expected=await evaluate(`fileContext.prepare(${JSON.stringify(kind)})`)
        const before=await evaluate('fileContext.facts().terminal.terminal')
        await input(await evaluate('fileContext.point()'),'right')
        await wait(`Boolean(${menu})`)
        if(kind==='http'){
          assert.equal(await evaluate(`Boolean(${reveal})`),false,'Declared HTTP target never borrows its file-shaped label')
        }else{
          assert.equal(await evaluate(`Boolean(${reveal})`),true,'Original context menu reveals declared file target')
          assert.equal(await evaluate(`${reveal}.title.includes(${JSON.stringify(expected.path)})`),true,'Original path menu owns the actual declared target')
          if(kind==='declared'){
            await evaluate(`(async()=>{const popup=${menu};await Promise.all(popup.getAnimations().map(animation=>animation.finished.catch(()=>{})));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})()`)
            const file=`${width}-${appearance}-declared.png`
            await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());result.frames.push(file)
          }
          const facts=await evaluate('fileContext.facts()')
          assert.deepEqual(facts.calls,[],'Right click alone never opens or reveals an artifact')
          assert.deepEqual(facts.terminal.inputs,[],'The original right click never writes to PTY')
          const point=await evaluate(`(()=>{const r=${reveal}.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
          await input(point,'left');await wait(`!${menu}`)
          assert.deepEqual((await evaluate('fileContext.facts()')).calls,[{kind:'reveal',args:[expected.workspaceId,expected.path]}],'The production menu calls original typed reveal exactly once with the accurate Workspace and path')
        }
        const after=await evaluate('fileContext.facts()')
        assert.deepEqual(after.terminal.terminal,before,'The same original Terminal/Session/Run stays mounted')
        result.scenes.push({width,appearance,kind,expected,calls:after.calls})
        await close()
      }
    }
    result.passed=true
  }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};result.failureFacts=await evaluate(`({facts:window.fileContext?.facts(),menu:document.querySelector('[role=menu][data-state=open]')?.outerHTML})`).catch(String);await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}
  finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
