const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, root, evidence, sceneMode] = process.argv.slice(2)
app.setPath('userData', path.join(root, 'user-data')); app.setPath('sessionData', path.join(root, 'session-data'))
const result = { schema: 'agentmux.focus-stable-routes-scene-actual.v1', passed: false, frames: [], userRuntimeTouched: false }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1200, height: 960, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    const read = expression => win.webContents.executeJavaScript(expression).catch(error=>{throw new Error(error.message+' · expression: '+expression)})
    async function until(label, predicate) {
      const end = Date.now() + 15000
      do { const value = await predicate(); if (value) return value; await new Promise(done => setTimeout(done, 30)) } while (Date.now() < end)
      throw new Error('Stable routes scene did not settle: ' + label)
    }
    const painted = () => read('(async()=>{await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})()')
    async function shot(file, state) {
      await read('document.fonts.ready'); await painted()
      // Capture preparation targets the actual Focus toolbar and its scroll ancestors,
      // preserving the independently scrollable project scan and all business state.
      const chrome = await read(`(async()=>{const header=document.querySelector('.focus-toolbar');if(!header)throw Error('Original Focus toolbar missing');const describe=()=>{const r=header.getBoundingClientRect(),ancestors=[];for(let n=header.parentElement;n;n=n.parentElement)ancestors.push({tag:n.tagName,className:n.className,scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight});return{rect:r.toJSON(),ancestors}};const before=describe();if(before.rect.top<0||before.rect.bottom>innerHeight){header.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))}return{before,after:describe()}})()`)
      assert.ok(chrome.after.rect.top >= -1 && chrome.after.rect.height > 0 && chrome.after.rect.bottom <= 960 + 1, JSON.stringify(chrome))
      await painted(); const bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length); await fs.writeFile(path.join(evidence, file), bytes)
      result.frames.push({ file, state, chrome, viewport: await read('({width:innerWidth,height:innerHeight,scrollX,scrollY})') })
    }
    const resize = async width => { await cdp('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }); await painted() }
    async function point(selector) {
      return read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing exact original control '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('Original control is hidden');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    }
    async function click(selector) { const p = await point(selector); for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await painted() }
    async function key(key, code = key, modifiers = 0) { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: { Backspace: 8, Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13 }[key] }) }
    async function fill(selector, text) { await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing input');n.focus();n.select()})()`); if (text) await cdp('Input.insertText', { text }); else await key('Backspace'); await painted() }
    const row = id => `.focus-project-lanes__row[data-project-id="${id}"]`
    const preferences = id => `${row(id)} [aria-label^="Project preferences"]`
    const rows = () => read('routesProof.facts().rows.map(row=>row.key)')
    await until('actual original projects and controls', () => read('window.routesProof?.ready&&document.querySelectorAll(".focus-project-lanes__row[data-project-key]").length===5&&document.querySelectorAll(".focus-project-preferences__trigger").length===5'))
    result.before = await read('routesProof.facts()')
    assert.equal(result.before.rows.length, 5)
    const originalOrder = await rows()
    for (const theme of ['dark', 'light']) for (const width of [1200, 420]) {
      await resize(width); await read(`routesProof.theme(${JSON.stringify(theme)})`)
      await read('document.querySelector(".focus-project-lanes__rows").scrollTop=0'); await painted()
      assert.deepEqual(await rows(), originalOrder)
      await shot(`board-${theme}-${width}.png`, 'Original Focus project scan, pinned routes, quiet and unknown source members')
    }
    await resize(1200); await read("routesProof.theme('dark')")
    await click(preferences('product')); await until('original project preference draft', () => read('!!document.querySelector("[data-focus-project-preferences]")'))
    await fill('[aria-label="Project note"]', '日常主线 · 保留原工作环境与完整上下文 · 跨设备项目固定寻找路线')
    await click('[aria-label="Project color · green"]')
    await read('routesProof.failSave(true)'); await click('[aria-label="Save project preferences"]')
    await until('failed save retains original draft and status', () => read('document.querySelector("[data-focus-project-preferences] [role=status]")?.textContent.includes("Private settings save failed")'))
    assert.equal(await read('document.querySelector(".focus-project-preferences__note input").value'), '日常主线 · 保留原工作环境与完整上下文 · 跨设备项目固定寻找路线')
    assert.equal(await read('routesProof.facts().projects[0].color'), 'blue')
    await shot('preferences-dark-1200.png', 'Original preference editor retains authored note/color and nonblocking save failure with Retry')
    await read('routesProof.failSave(false)'); await click('[aria-label="Save project preferences"]')
    await until('original project saved feedback', () => read('!document.querySelector("[data-focus-project-preferences]")&&routesProof.facts().projects[0].color==="green"'))
    await shot('saved-project-note.png', 'Saved personal note and color reach the original project without changing workface or Session')
    await resize(420); await read("routesProof.theme('light')")
    await shot('long-note-light-420.png', 'Narrow saved long note retains readable project identity and controls')
    await click(preferences('product'))
    await until('narrow original editor', () => read('!!document.querySelector("[data-focus-project-preferences]")'))
    await shot('preferences-light-420.png', 'Narrow light project preference editor remains readable and keyboard accessible')
    await key('Escape'); await until('exact preference editor closes', () => read('!document.querySelector("[data-focus-project-preferences]")'))
    await resize(1200); await read("routesProof.theme('dark')")
    const handle = '[aria-label="Reorder pinned project · Core runtime"]'
    await read(`document.querySelector(${JSON.stringify(handle)}).focus()`); await key('ArrowUp', 'ArrowUp', 1)
    await until('native keyboard pin order saved', () => read('routesProof.facts().projects.filter(p=>p.pinned)[0].key===JSON.stringify(["local","library"])'))
    result.keyboardOrder = await rows()
    assert.equal(result.keyboardOrder[0], JSON.stringify(['local', 'library']))
    // Intercept the browser's actual native drag data, then deliver that same data to the original drop owner.
    let drag
    const listener = (_event, method, params) => { if (method === 'Input.dragIntercepted') drag = params }
    win.webContents.debugger.on('message', listener); await cdp('Input.setInterceptDrags', { enabled: true })
    const start = await point('[aria-label="Reorder pinned project · AgentMux"]'), target = await point(handle)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start, button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 16, y: start.y - 8, button: 'left', buttons: 1 })
    await until('native original drag intercepted', () => drag)
    await cdp('Input.dispatchDragEvent', { type: 'dragEnter', ...target, data: drag.data })
    await cdp('Input.dispatchDragEvent', { type: 'dragOver', ...target, data: drag.data })
    await until('original visible drop feedback', () => read('!!document.querySelector("[data-project-drop-target]")'))
    await shot('drag-in-progress.png', 'Native drag shows an exact pinned-project destination before committing saved order')
    await cdp('Input.dispatchDragEvent', { type: 'drop', ...target, data: drag.data })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...target, button: 'left', buttons: 0, clickCount: 1 })
    await cdp('Input.setInterceptDrags', { enabled: false }); win.webContents.debugger.off('message', listener)
    await until('native drag pin order saved', () => read('routesProof.facts().projects.filter(p=>p.pinned)[0].key===JSON.stringify(["local","product"])'))
    result.dragOrder = await rows()
    // A second original native drag checks the after-half tail destination.
    drag = null; win.webContents.debugger.on('message', listener); await cdp('Input.setInterceptDrags', { enabled: true })
    const tailStart = await point('[aria-label="Reorder pinned project · AgentMux"]')
    const tailTarget = await read(`(()=>{const n=document.querySelector(${JSON.stringify(row('library'))});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.bottom-3}})()`)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...tailStart, button: 'none' })
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...tailStart, button: 'left', buttons: 1, clickCount: 1 })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tailStart.x + 16, y: tailStart.y + 8, button: 'left', buttons: 1 })
    await until('native tail drag intercepted', () => drag)
    for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, ...tailTarget, data: drag.data })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...tailTarget, button: 'left', buttons: 0, clickCount: 1 })
    await cdp('Input.setInterceptDrags', { enabled: false }); win.webContents.debugger.off('message', listener)
    await until('native after-half tail saved', () => read('routesProof.facts().projects.filter(p=>p.pinned).at(-1).key===JSON.stringify(["local","product"])'))
    result.tailDragOrder = await rows()
    const established = await rows()
    await read('routesProof.activity("research-idle")'); await new Promise(done => setTimeout(done, 3300)); await painted()
    assert.deepEqual(await rows(), established, 'Real activity update does not trigger the former three-second project reorder')
    await read('routesProof.visible(false)'); await painted(); await read('routesProof.visible(true)'); await painted()
    assert.deepEqual(await rows(), established, 'Returning to Focus keeps the established route')
    result.orderStability = { actualActivityUpdated: true, waitedPastFormerReorder: true, preservedOnReturn: true }
    if (sceneMode !== 'stable-routes-only') {
    const old = await read(`(()=>{const n=document.querySelector(${JSON.stringify(row('old'))});return{collapsed:n.dataset.collapsed,text:n.textContent}})()`)
    assert.equal(old.collapsed, 'true', 'Known old quiet project starts compact')
    assert.notEqual(await read(`document.querySelector(${JSON.stringify(row('unknown'))}).dataset.collapsed`), 'true', 'Unknown source never establishes coldness')
    await click('[aria-label="Expand project · Earlier experiments"]')
    await until('exact old project expands', () => read(`document.querySelector(${JSON.stringify(row('old'))}).dataset.collapsed!=='true'`))
    await read('routesProof.activity("old-a")'); await painted(); await read('routesProof.idle("old-a")'); await painted()
    assert.notEqual(await read(`document.querySelector(${JSON.stringify(row('old'))}).dataset.collapsed`), 'true', 'Expanded project stays open after returning quiet')
    await shot('cold-expanded.png', 'Explicit expansion returns the original cards and survives active-to-quiet changes')
    await read('routesProof.failSave(true)'); await click('[aria-label="Collapse project · Earlier experiments"]')
    await until('failed visibility save retains original lane', () => read('!!document.querySelector(".focus-project-order-error")'))
    assert.notEqual(await read(`document.querySelector(${JSON.stringify(row('old'))}).dataset.collapsed`), 'true')
    await read('routesProof.externalProject("old",{note:"Another writer retained this project note"})')
    await shot('cold-save-failure.png', 'Failed collapse retains original cards, requested visibility and a concurrent saved note')
    await read('routesProof.failSave(false)'); await click('.focus-project-order-error button:last-child')
    await until('exact collapse retries using current settings', () => read('routesProof.facts().projects.find(p=>p.key===JSON.stringify(["local","old"]))?.collapsed===true'))
    assert.equal(await read('routesProof.facts().projects.find(p=>p.key===JSON.stringify(["local","old"])).note'), 'Another writer retained this project note')
    await fill('[aria-label="Search contexts"]', '早期布局实验')
    await until('search exact original old member', () => read('document.querySelector("button.focus-context[data-session-id=old-a]")?.getClientRects().length>0'))
    await shot('search-cold.png', 'Original metadata search exposes the exact old Agent without recreating or navigating it')
    result.beforeExplicitReveal = await read('routesProof.facts()'); assert.equal(result.beforeExplicitReveal.sameFocus, true)
    await fill('[aria-label="Search contexts"]', '')
    await until('cleared search restores saved compact choice', () => read(`document.querySelector(${JSON.stringify(row('old'))}).dataset.collapsed==='true'`))
    await read('routesProof.reveal("old-a")')
    await until('exact original Agent is revealed', () => read('document.querySelector("[data-focus-agent-session=canonical-old-a][data-focus-agent-selected=true]")?.getClientRects().length>0'))
    await shot('exact-cold-reveal.png', 'Exact Host/Session reveal expands the original project and selects its card')
    }
    result.after = await read('routesProof.facts()')
    for (const field of ['sameTabs', 'sameLayouts', 'sameDrafts']) assert.equal(result.after[field], true, field)
    if (sceneMode === 'stable-routes-only') assert.equal(result.after.sameFocus, true)
    else assert.equal(result.after.focusedSessionId, 'old-a')
    assert.deepEqual(result.after.calls, { stop: 0, resume: 0, write: 0, launchAgent: 0, interrupt: 0 })
    assert.deepEqual(result.after.controls, result.after.originalControls); assert.deepEqual(result.after.selections, [])
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) { try { result.failureDOM = await win.webContents.executeJavaScript('document.body.innerText.slice(0,22000)'); await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {} }
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
