const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'userData'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { passed: false, pid: process.pid, images: [], operations: [], errors: [], restartInputs: [] }
app.whenReady().then(async () => {
  let win
  try {
    Menu.setApplicationMenu(null)
    win = new BrowserWindow({ width: 1080, height: 850, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') result.errors.push(details.message) })
    await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace', '.agentmux', 'scratch') } })
    const read = async script => { try { return await win.webContents.executeJavaScript(script) } catch (cause) { throw new Error('Actual Renderer probe failed: ' + script, { cause }) } }
    for (let i=0;i<150 && !(await read('!!window.moteQuick'));i++) await pause(30)
    assert.equal(await read('!!window.moteQuick'), true)
    const click = async selector => {
      const r = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing original control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(r.x * win.webContents.getZoomFactor()), y: Math.round(r.y * win.webContents.getZoomFactor()), button: 'left', clickCount: 1 }); await pause(140)
    }
    const key = async keyCode => { for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({ type, keyCode }); await pause(100) }
    const capture = async name => {
      await pause(120)
      const facts = await read(`({ ...moteQuick.facts(), overflow:document.querySelector('[data-mote-details]').scrollWidth>document.querySelector('[data-mote-details]').clientWidth, text:document.body.textContent, background:getComputedStyle(document.querySelector('.persona-scene')).backgroundColor })`)
      assert.equal(facts.overflow, false); assert.equal(facts.drafts['original-display-session'], 'An original unsent question stays here.'); assert.equal(facts.drafts['analyst-region'], 'Analyst draft.')
      await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG()); result.images.push(name+'.png'); result.operations.push({ name, ...facts })
    }
    const edit = async () => { await click('[aria-label="Edit quick mode"]'); for (let i=0;i<100 && await read('!!document.querySelector(".mote-quick-mode-dialog[aria-busy=true]") || document.body.textContent.includes("Reading MOTE.md")');i++) await pause(30); assert.equal(await read(`document.querySelector('select[aria-label="Default Agent"]').value`), 'fixture') }
    await read('moteQuick.enter()'); await pause(180)
    assert.equal(await read('moteQuick.facts().selection.tabId'), 'original-discussion')
    assert.equal(await read('document.querySelector(".pane-tabbar .workbench-tab")?.dataset.workbenchTabId'), 'original-discussion')
    for (const light of [false,true]) {
      await read(`moteQuick.theme(${light})`)
      win.setContentSize(1080,850); await capture('profile-wide-'+(light?'light':'dark'))
      win.setContentSize(320,820); await capture('profile-narrow-'+(light?'light':'dark'))
      await edit(); await capture('settings-narrow-'+(light?'light':'dark'))
      win.setContentSize(1080,850); await capture('settings-wide-'+(light?'light':'dark'))
      await key('Escape')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'),0)
    }
    await edit(); await read(`(()=>{const n=document.querySelector('select[aria-label="Default Agent"]');n.value='analyst';n.dispatchEvent(new Event('change',{bubbles:true}))})()`); await pause(100)
    // The first focused selector is the original configured Agent choice.
    assert.equal(await read(`document.querySelector('select[aria-label="Default Agent"]').value`), 'analyst')
    await read(`(()=>{const b=[...document.querySelectorAll('.mote-quick-mode-dialog button')].find(n=>n.textContent==='Save');b.dataset.captureSave='true'})()`)
    await read(`document.addEventListener('pointerdown',event=>window.quickClickTarget=event.target.outerHTML,{once:true})`); await click('[data-capture-save]'); result.saveClick={zoom:win.webContents.getZoomFactor(),target:await read('window.quickClickTarget')} 
    for (let i=0;i<100 && await read('!!document.querySelector(".mote-quick-mode-dialog")');i++) await pause(30)
    assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'),1)
    assert.equal(await read('moteQuick.facts().defaults.defaults.executorId'),'analyst')
    assert.equal(await read('Object.values(moteQuick.facts().disk).some(v=>v.includes("# User notes\\nKeep this paragraph."))'),true)
    await capture('saved-profile-original-editor')
    await click('[aria-label="Edit quick mode"]'); await pause(180)
    assert.equal(await read(`document.querySelector('select[aria-label="Default Agent"]').value`),'analyst'); await capture('saved-settings-reopened'); await key('Escape')
    await read('moteQuick.enter()'); await pause(140)
    assert.equal(await read('moteQuick.facts().selection.tabId'),'original-discussion')
    result.restartInputs.push({ name: 'quick-default-retained', state: await read('moteQuick.restartInput()') })
    const pin = '[title="Default conversation · unset in Profile to close"]'
    await click(pin); assert.equal(await read('!!moteQuick.facts().tabs["original-discussion"]'),true); await capture('original-default-close-kept')
    await read('moteQuick.unknown()'); await click('[aria-label="Edit quick mode"]'); await pause(180); await capture('settings-unconfirmed-original-work-kept')
    assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'),1)
    result.passed = true
  } catch (error) { result.error={message:error.message,stack:error.stack}; if(win){result.failedFrame=await win.webContents.executeJavaScript('({text:document.body.textContent,facts:window.moteQuick?.facts()})').catch(()=>null);await fs.writeFile(path.join(evidence,'failed.png'),(await win.webContents.capturePage()).toPNG())} }
  finally { await fs.writeFile(path.join(evidence,'renderer-result.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1) }
})
