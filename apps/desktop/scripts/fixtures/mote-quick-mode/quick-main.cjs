const { app, BrowserWindow, Menu } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, privateRoot, evidence] = process.argv.slice(2)
const selectFields = process.argv.includes('--select-fields')
const recoveryPolicy = process.argv.includes('--recovery-policy')
const executorPicker = process.argv.includes('--executor-picker')
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
      const r = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing original control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hitTag:document.elementFromPoint(x,y)?.tagName,hitControl:document.elementFromPoint(x,y)?.closest("button,[role=menuitemradio]")?.getAttribute("aria-label")}})()`)
      result.clicks ??= []; result.clicks.push({selector,...r}); for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(r.x * win.webContents.getZoomFactor()), y: Math.round(r.y * win.webContents.getZoomFactor()), button: 'left', clickCount: 1 }); await pause(140)
    }
    const key = async keyCode => { for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({ type, keyCode }); await pause(100) }
    const capture = async name => {
      await pause(120)
      const facts = await read(`({ ...moteQuick.facts(), overflow:document.querySelector('[data-mote-details]').scrollWidth>document.querySelector('[data-mote-details]').clientWidth, text:document.body.textContent, background:getComputedStyle(document.querySelector('.persona-scene')).backgroundColor })`)
      assert.equal(facts.overflow, false); assert.equal(facts.drafts['original-display-session'], 'An original unsent question stays here.'); assert.equal(facts.drafts['analyst-region'], 'Analyst draft.')
      await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG()); result.images.push(name+'.png'); result.operations.push({ name, ...facts })
    }
    const edit = async (expected = 'fixture') => { await click('[aria-label="Edit quick mode"]'); for (let i=0;i<100 && await read('!!document.querySelector(".mote-quick-mode-dialog[aria-busy=true]") || document.body.textContent.includes("Reading MOTE.md")');i++) await pause(30); assert.equal(await read(`document.querySelector('[aria-label="Executor for new chat"]').dataset.value`), expected) }
    await read('moteQuick.enter()'); await pause(180)
    assert.equal(await read('moteQuick.facts().selection.tabId'), 'original-discussion')
    assert.equal(await read('document.querySelector(".pane-tabbar .workbench-tab")?.dataset.workbenchTabId'), 'original-discussion')
    if (recoveryPolicy) {
      await capture('main-profile-startup-dark-wide'); await edit();
      assert.equal(await read('!!document.querySelector("[aria-label=\\\"Reconnect conversation\\\"]")'), false)
      await capture('main-policy-fixed-dark-wide'); await key('Escape')
      await win.loadFile(html, { query: { workspacePath: path.join(privateRoot, 'workspace', '.agentmux', 'scratch'), moteId: 'launcher:research-companion' } })
      await pause(250); await read('moteQuick.enter()'); await pause(180)
      await edit(); assert.equal(await read('document.querySelector("[aria-label=\\\"Reconnect conversation\\\"]").dataset.value'), 'on-open')
      await click('[aria-label="Reconnect conversation"]'); await capture('companion-policy-menu-dark-wide'); await key('Escape'); await key('Escape')
      await read('moteQuick.theme(true)'); win.setContentSize(320,820); await edit()
      await click('[aria-label="Reconnect conversation"]'); await capture('companion-policy-menu-light-narrow')
      await click('[role="menuitemradio"][data-value="startup"]')
      assert.equal(await read('document.querySelector("[aria-label=\\\"Reconnect conversation\\\"]").dataset.value'), 'startup')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 0)
      await read(`(()=>{const b=[...document.querySelectorAll('.mote-quick-mode-dialog button')].find(n=>n.textContent==='Save');b.dataset.captureSave='true'})()`)
      await click('[data-capture-save]'); await pause(180)
      assert.equal(await read('moteQuick.facts().defaults.defaults.recovery'), 'startup'); await capture('companion-policy-saved-profile-light-narrow')
      await edit(); assert.equal(await read('document.querySelector("[aria-label=\\\"Reconnect conversation\\\"]").dataset.value'), 'startup')
      await capture('companion-policy-reopened-light-narrow'); await key('Escape')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 1)
      result.passed = true; return
    }
    if (executorPicker) {
      for (const light of [false, true]) {
        await read(`moteQuick.theme(${light})`)
        const mode = light ? 'light-narrow' : 'dark-wide'
        win.setContentSize(light ? 320 : 1080, light ? 820 : 850)
        await capture('executor-profile-' + mode)
        await edit(); await click('[aria-label="Executor for new chat"]')
        const facts = await read(`({ menu:document.querySelector('[role="menu"]')?.textContent, selected:document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.dataset.value, native:document.querySelectorAll('.mote-quick-mode-dialog select').length })`)
        assert.equal(facts.native, 0); assert.equal(facts.selected, 'fixture')
        for (const text of ['Codex · Available', 'Claude · Check failed', 'Codex · Not installed']) assert.ok(facts.menu.includes(text), facts.menu)
        await capture('executor-menu-' + mode)
        await key('Escape'); assert.equal(await read(`document.activeElement?.getAttribute('aria-label')`), 'Executor for new chat')
        assert.equal(await read(`!!document.querySelector('.mote-quick-mode-dialog')`), true)
        await key('Escape')
      }
      await edit(); await click('[aria-label="Executor for new chat"]'); await key('R')
      assert.ok((await read(`document.activeElement?.textContent`)).startsWith('Research partner'))
      await key('Return'); assert.equal(await read(`document.querySelector('[aria-label="Executor for new chat"]').dataset.value`), 'analyst')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 0)
      await read(`(()=>{const b=[...document.querySelectorAll('.mote-quick-mode-dialog button')].find(n=>n.textContent==='Save');b.dataset.captureSave='true'})()`)
      await click('[data-capture-save]'); await pause(150)
      assert.equal(await read('moteQuick.facts().defaults.defaults.executorId'), 'analyst')
      await edit('analyst'); await capture('executor-saved-reopened-light-narrow'); await key('Escape')
      await read('moteQuick.missingExecutor()'); await edit('saved-unavailable-executor')
      await click('[aria-label="Executor for new chat"]'); await capture('executor-missing-saved-light-narrow')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 1)
      result.passed = true; return
    }
    if (selectFields) {
      for (const light of [false, true]) {
        await read(`moteQuick.theme(${light})`)
        const mode = light ? 'light' : 'dark'
        win.setContentSize(light ? 320 : 1080, light ? 820 : 850)
        await edit(); await read(`document.addEventListener('pointerdown',e=>window.menuPointer=e.target.outerHTML,{once:true})`); await click('[aria-label="Executor for new chat"]'); result.menuDebug = await read(`({target:window.menuPointer,open:document.querySelector('[aria-label="Executor for new chat"]')?.dataset.state,menus:[...document.querySelectorAll('[role="menu"]')].map(n=>({label:n.getAttribute('aria-label'),count:n.querySelectorAll('[role="menuitemradio"]').length})),focused:document.activeElement.getAttribute('role')})`); assert.equal(result.menuDebug.menus.length, 1, JSON.stringify(result.menuDebug)); await capture('agent-menu-' + mode)
        assert.equal(await read(`document.querySelector('[role="menu"]')?.closest('[data-overlay-host]') !== null`), true)
        await key('Escape'); assert.equal(await read(`document.activeElement?.getAttribute('aria-label')`), 'Executor for new chat')
        assert.equal(await read(`!!document.querySelector('.mote-quick-mode-dialog')`), true)
        await click('.mote-quick-mode-dialog [aria-label="Default conversation"]'); result.conversationMenuDebug = await read(`({open:document.querySelector('.mote-quick-mode-dialog [aria-label="Default conversation"]')?.dataset.state,menus:[...document.querySelectorAll('[role="menu"]')].map(n=>({label:n.getAttribute('aria-label'),count:n.querySelectorAll('[role="menuitemradio"]').length})),focused:document.activeElement.getAttribute('role')})`); assert.equal(result.conversationMenuDebug.menus.length,1,JSON.stringify(result.conversationMenuDebug)); await capture('conversation-menu-' + mode); await key('Escape'); await key('Escape')
        assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 0)
        await click('[aria-label="Choose or create a goal"]'); await click('[aria-label="Goal to associate with this Mote"]')
        await capture('goal-menu-' + mode); await click('[role="menuitemradio"][data-value="choice-experiment"]')
        await click('[aria-label="Mote discussion for the goal"]'); await capture('discussion-menu-' + mode)
        await key('Escape'); await click('[aria-label="Choose or create a goal"]')
        await click('[data-mote-goal="choice-experiment"] .mote-current-work__copy')
        await click('[aria-label="Goal continuation Agent"]'); await read(`(()=>{const a=document.querySelector('[aria-label="Goal continuation Agent"]').getBoundingClientRect(),b=document.querySelector('.goals-continuation input[type=number]').getBoundingClientRect();if(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom)throw Error('Executing Agent overlaps interval input')})()`); await capture('execution-agent-menu-' + mode); await key('Escape')
        await click('[data-mote-goal="choice-experiment"] .mote-current-work__copy')
      }
      await edit(); await click('[aria-label="Executor for new chat"]'); await key('R')
      assert.ok((await read(`document.activeElement?.textContent`)).startsWith('Research partner'))
      await key('Return'); assert.equal(await read(`document.querySelector('[aria-label="Executor for new chat"]').dataset.value`), 'analyst')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 0)
      await read(`(()=>{const b=[...document.querySelectorAll('.mote-quick-mode-dialog button')].find(n=>n.textContent==='Save');b.dataset.captureSave='true'})()`)
      await click('[data-capture-save]'); await pause(150)
      assert.equal(await read('moteQuick.facts().defaults.defaults.executorId'), 'analyst')
      await edit('analyst'); await capture('shared-selection-saved-reopened'); await key('Escape')
      await read('moteQuick.unknown()'); await edit('analyst'); await capture('shared-selection-unknown-kept')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'), 1)
      result.passed = true
      return
    }
    for (const light of [false,true]) {
      await read(`moteQuick.theme(${light})`)
      win.setContentSize(1080,850); await capture('profile-wide-'+(light?'light':'dark'))
      win.setContentSize(320,820); await capture('profile-narrow-'+(light?'light':'dark'))
      await edit(); await capture('settings-narrow-'+(light?'light':'dark'))
      win.setContentSize(1080,850); await capture('settings-wide-'+(light?'light':'dark'))
      await key('Escape')
      assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'),0)
    }
    await edit(); await click('[aria-label="Executor for new chat"]'); await click('[role="menuitemradio"][data-value="analyst"]'); await pause(100)
    // The first focused selector is the original configured Agent choice.
    assert.equal(await read(`document.querySelector('[aria-label="Executor for new chat"]').dataset.value`), 'analyst')
    await read(`(()=>{const b=[...document.querySelectorAll('.mote-quick-mode-dialog button')].find(n=>n.textContent==='Save');b.dataset.captureSave='true'})()`)
    await read(`document.addEventListener('pointerdown',event=>window.quickClickTarget=event.target.outerHTML,{once:true})`); await click('[data-capture-save]'); result.saveClick={zoom:win.webContents.getZoomFactor(),target:await read('window.quickClickTarget')} 
    for (let i=0;i<100 && await read('!!document.querySelector(".mote-quick-mode-dialog")');i++) await pause(30)
    assert.equal(await read('moteQuick.facts().calls.filter(c=>c.operation==="write").length'),1)
    assert.equal(await read('moteQuick.facts().defaults.defaults.executorId'),'analyst')
    assert.equal(await read('Object.values(moteQuick.facts().disk).some(v=>v.includes("# User notes\\nKeep this paragraph."))'),true)
    await capture('saved-profile-original-editor')
    await click('[aria-label="Edit quick mode"]'); await pause(180)
    assert.equal(await read(`document.querySelector('[aria-label="Executor for new chat"]').dataset.value`),'analyst'); await capture('saved-settings-reopened'); await key('Escape')
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
