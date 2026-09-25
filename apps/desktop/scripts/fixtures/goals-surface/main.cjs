const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.goals-visual-render.v1', passed: false, frames: [], userRunTouched: false, consoleErrors: [] }
let win
const evaluate = (expression) => win.webContents.executeJavaScript(expression)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(expression) { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) } throw new Error('Timed out: ' + expression) }
async function paint() { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(70) }
const button = (label) => `([...document.querySelectorAll('button')].find(node => node.textContent.trim()===${JSON.stringify(label)} || node.getAttribute('aria-label')===${JSON.stringify(label)}))`
async function click(expression) { const p = await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Missing actual target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1}); await paint() }
async function size(width) { await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false}); await paint() }
async function capture(name, width) { await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1}); await paint(); const bytes=(await win.webContents.capturePage()).toPNG(); const file=name+'.png'; await fs.writeFile(path.join(evidence,file),bytes); result.frames.push({name,width,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}) }
app.whenReady().then(async()=>{
  try {
    await fs.mkdir(evidence,{recursive:true}); win=new BrowserWindow({show:false,width:1280,height:780,webPreferences:{sandbox:false,backgroundThrottling:false}})
    win.webContents.on('console-message',details=>{ if(details.level==='error')result.consoleErrors.push({message:details.message,line:details.lineNumber,source:details.sourceId}) })
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await waitFor('Boolean(window.goalsVisual) && document.querySelectorAll("[data-demand-id]").length===6'); const original=await evaluate('goalsVisual.facts().runs')
    await size(1280); await capture('1280-list',1280)
    await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")'); await waitFor('Boolean(document.querySelector(".goals-detail"))'); await capture('1280-detail',1280)
    await click('document.querySelector(".goals-properties > summary")'); await capture('1280-properties',1280)
    await click('document.querySelector(".goals-properties > summary")'); await click('document.querySelector(".goals-execution > summary")'); await capture('1280-execution',1280)
    await click(button('Back to goals')); await click(button('Board view')); await capture('1280-board',1280)
    const geometry=await evaluate('([...document.querySelectorAll(".goals-board-column")].map(e=>({top:e.getBoundingClientRect().top,left:e.getBoundingClientRect().left})))'); assert.equal(geometry.length,5); assert.equal(new Set(geometry.map(x=>x.top)).size,1,'Real board columns remain on one track')
    await click(button('List view')); await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")'); await size(620); await capture('620-detail',620)
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".goals-index")).display'),'none','Narrow detail has reading priority')
    await click(button('Back to goals')); await capture('620-list',620)
    await click(button('New Goal')); await capture('620-intake',620)
    await evaluate('document.querySelector("[aria-label=\\\"Goal intent\\\"]").focus()'); for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await waitFor('!document.querySelector(".goals-intake")')
    assert.equal(await evaluate('document.activeElement.textContent.trim()'),'New Goal','Escape returns focus to the real entry')
    await size(1280); await evaluate('goalsVisual.seed("empty")'); await capture('1280-empty',1280)
    assert.deepEqual(await evaluate('goalsVisual.facts().runs'),original,'Original preview Run identities remain intact')
    assert.equal(result.frames.length,9);
    for (const mode of ['proposal','questions','confirmed','results','gap','unknown','stale','accepted','accepted-gaps','receipt-failure','done-no-alignment','done-unconfirmed','done-confirmed','no-alignment-report','delivery-failure']) {
      await evaluate(`goalsVisual.seed(${JSON.stringify(mode)})`); await waitFor('Boolean(document.querySelector("[data-goal-id]"))'); await evaluate('document.querySelector(".goals-detail").scrollTop=0')
      if(mode.startsWith('done-') && await evaluate(`${button('Show finished')} !== undefined`)) await click(button('Show finished'))
      if(mode==='delivery-failure') { await click('document.querySelector("[data-goal-grill]")'); await waitFor('Boolean([...document.querySelectorAll(".goals-service")].find(node=>node.textContent.includes("The discussion service is unavailable")))') }
      if(mode==='receipt-failure') { await click('document.querySelector("[data-goal-confirm]")'); await waitFor('Boolean(document.querySelector("[data-goal-acknowledgement-failure]"))') }
      await capture('1280-'+mode,1280)
      if(mode==='unknown'||mode==='stale'){ assert.equal(await evaluate('Boolean(document.querySelector("[data-goal-accept], [data-goal-accept-gaps]"))'),false,'Ineligible results have no acceptance shortcut') }
      if(['proposal','confirmed','results','gap','unknown','stale','accepted-gaps','receipt-failure','done-confirmed','no-alignment-report','delivery-failure'].includes(mode)) { await size(620); await capture('620-'+mode,620); await size(1280) }
      if(mode==='receipt-failure') {
        assert.deepEqual(await evaluate('([...document.querySelectorAll(".goals-detail .goals-button--primary")].map(node=>node.textContent.trim()))'),['Reload current proposal'],'Unknown acknowledgement has one visible primary recovery')
        await click(button('Back to goals')); await waitFor('Boolean(document.querySelector("[data-demand-id]"))')
        assert.equal(await evaluate('document.querySelector("[data-demand-id]").textContent.includes("Reload current proposal")'),true,'The retained failure keeps the same next step in the list')
        await capture('1280-receipt-failure-list',1280); await size(620); await capture('620-receipt-failure-list',620)
        await click('document.querySelector("[data-demand-id]")'); await waitFor('Boolean(document.querySelector("[data-goal-acknowledgement-failure]"))'); await capture('620-receipt-failure-reopened',620); await size(1280)
      }
    }
    assert.equal(result.frames.length,38)
    for (const mode of ['empty','one','many','current','recent']) {
      await evaluate(`goalsVisual.seed(${JSON.stringify(mode)})`)
      for (const width of [1280,620]) {
        await size(width); await waitFor('Boolean(document.querySelector("[data-goals-entry-action=understand]"))')
        const count=await evaluate('document.querySelectorAll("[data-goals-entry-action]").length')
        assert.equal(count, ['current','recent'].includes(mode) ? 3 : 2, 'Only reliable project context adds the third request')
        if(mode==='current') assert.equal(await evaluate('document.querySelector("[data-goals-entry-action=next]").textContent.includes("根据当前项目")'),true)
        await capture(`${width}-entry-${mode}`,width)
      }
    }
    assert.equal(result.frames.length,48); assert.deepEqual(result.consoleErrors,[]); result.passed=true
  } catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack} }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2)); win?.destroy(); app.exit(result.passed?0:1) }
})
