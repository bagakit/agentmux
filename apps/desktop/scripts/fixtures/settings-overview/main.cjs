const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, mode = 'full'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, mode, frames: [], actions: [], boundary: 'Private actual App/public Preview Renderer only; visibilityState is a controlled seam. No user App, Runtime, durable restart or installation.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 900, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const read = expression => win.webContents.executeJavaScript(expression)
    const node = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const until = async expression => {
      const end = Date.now() + 6000
      do {
        if (await read(expression)) return
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (Date.now() < end)
      throw new Error('Renderer preparation did not settle: ' + expression)
    }
    const settle = async () => {
      await read('document.fonts.ready')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    const geometry = expression => read('(()=>{const n=' + expression + ';if(!n?.isConnected||!n.checkVisibility())throw Error("Missing visible control");const r=n.getBoundingClientRect();return{label:n.getAttribute("aria-label")||n.textContent.trim(),rect:r.toJSON(),x:r.x+r.width/2,y:r.y+r.height/2,hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))}})()')
    const click = async expression => {
      const hit = await geometry(expression)
      assert.ok(hit.rect.width > 0 && hit.rect.height > 0)
      assert.deepEqual(hit.hits, [true,true,true,true,true], 'Actual connected control has five CSS hits')
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, x:hit.x, y:hit.y })
      win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:hit.x, y:hit.y })
      result.actions.push(hit)
      await settle()
    }
    const capture = async file => {
      await read('document.querySelectorAll(".settings-overview__sweep").forEach(n=>n.getAnimations().forEach(a=>{if(a.playState==="running")a.finish()}))')
      await settle()
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file)
    }
    const title = () => read('document.querySelector(".settings-content__header h2")?.textContent')
    const nav = async id => {
      const selector = 'nav[aria-label="Settings sections"] [data-settings-target=' + JSON.stringify(id) + ']'
      await click(node(selector))
      await until(id === 'overview' ? '!!document.querySelector(".settings-overview")' : '!!document.querySelector("[data-settings-pane=' + id + ']:not([hidden])")')
    }
    const open = async () => {
      await click(node('.window-status-bar [aria-label="Settings"]'))
      await until('!!document.querySelector(".settings-page")')
      assert.equal(await title(), 'Overview', 'Ordinary Settings opens Overview')
    }
    const footer = async () => {
      const inventory = await read('Array.from(document.querySelectorAll(".window-status-bar button")).map((n,index)=>({index,label:n.getAttribute("aria-label")||n.textContent.trim(),required:!n.closest("[popover]")||n.closest("[popover]").matches(":popover-open")}))')
      assert.ok(inventory.length > 0)
      const required = inventory.filter(n => n.required)
      assert.ok(required.length > 0)
      const hits = []
      for (const entry of required) {
        const hit = await geometry('document.querySelectorAll(".window-status-bar button")[' + entry.index + ']')
        assert.deepEqual(hit.hits, [true,true,true,true,true], 'Every actual footer control remains reachable')
        assert.ok(hit.rect.x >= 0 && hit.rect.right <= await read('innerWidth'))
        hits.push(hit)
      }
      assert.equal(await read('document.querySelector(".window-status-bar").getBoundingClientRect().height'), 32)
      return { inventory, hits }
    }
    const motion = async () => {
      const sweep = node('.settings-overview__sweep')
      const positive = await read(sweep + '.getAnimations().map(a=>({state:a.playState,time:a.currentTime,iterations:a.effect.getTiming().iterations}))')
      assert.equal(positive.length, 1, 'One real finite decorative animation is present')
      assert.equal(positive[0].state, 'running')
      assert.equal(positive[0].iterations, 1)
      await read('window.overviewProbe.setVisibility("hidden")')
      await read('new Promise(resolve=>requestAnimationFrame(resolve))')
      const paused = await read(sweep + '.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))')
      assert.equal(paused.length, 1)
      assert.equal(paused[0].state, 'paused', 'Hidden page pauses the actual decorative animation')
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(await read(sweep + '.getAnimations()[0].currentTime'), paused[0].time)
      await read('window.overviewProbe.setVisibility("visible")')
      await read('new Promise(resolve=>requestAnimationFrame(resolve))')
      assert.equal(await read(sweep + '.getAnimations()[0].playState'), 'running')
      result.motion = { positive, paused, visibilityInput:'controlled document.visibilityState + visibilitychange' }
    }
    const drafts = async () => {
      await nav('general')
      const toggle = node('[data-settings-pane=general] input[type=checkbox]')
      await read('window.originalGeneralToggle=' + toggle)
      const before = await read(toggle + '.checked')
      await click(toggle)
      await read('document.querySelector("[data-settings-pane=general]").scrollTop=73')
      await nav('overview')
      await nav('general')
      assert.equal(await read(toggle + '===window.originalGeneralToggle'), true, 'Visited General preserves original draft control')
      assert.equal(await read(toggle + '.checked'), !before)
      assert.ok(await read('document.querySelector("[data-settings-pane=general] [data-settings-save-bar]").textContent.includes("Unsaved changes")'))
      assert.equal(await read('window.overviewProbe.saves.length'), 0, 'Overview never saves a draft')
      result.draft = { sameControl:true, checked:!before, unsaved:true }
      await nav('overview')
      assert.equal(await read('document.querySelectorAll(".settings-overview__sweep").length'), 1)
      await nav('general')
      assert.equal(await read('document.querySelectorAll(".settings-overview__sweep").length'), 0, 'Leaving Overview unmounts decoration/listener')
      await nav('overview')
    }
    const exactTarget = async () => {
      await click(node('[aria-label="Close settings"]'))
      const avatar = 'Array.from(document.querySelectorAll(".agent-avatar[data-executor-id]")).find(n=>n.checkVisibility())'
      const hit = await geometry(avatar)
      const executorId = await read(avatar + '.dataset.executorId')
      assert.ok(executorId)
      win.webContents.sendInputEvent({ type:'mouseMove', x:hit.x, y:hit.y })
      await until('!!document.querySelector(".agent-identity-popover header button")')
      await click(node('.agent-identity-popover header button'))
      await until('!!document.querySelector(".settings-page")')
      assert.equal(await title(), 'Agents', 'Actual Executor entry bypasses Overview')
      const target = await read('document.getElementById(' + JSON.stringify('executor-settings-' + executorId) + ')?.open')
      assert.equal(target, true, 'Exact actual Executor target is open')
      result.executor = { executorId, open:true, actualCaller:'AgentAvatar -> SettingsNavigation -> App -> SettingsPanel' }
      await click(node('[aria-label="Close settings"]'))
    }
    await until('window.overviewProbe?.ready && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    const initial = await read('window.overviewProbe.beginSurface()')
    if (initial.tabs === 0) {
      await click('Array.from(document.querySelectorAll(".project-activity")).find(n=>n.checkVisibility())')
      await until('!!document.querySelector(".project-activity-group__summary")')
      await click(node('.project-activity-group__summary'))
      await until('window.overviewProbe.beginSurface().tabs>0')
    }
    result.original = await read('window.overviewProbe.beginSurface()')
    assert.ok(result.original.tabs > 0 && result.original.sessions > 0 && result.original.layouts > 0)
    await open()
    if (mode === 'entry') { result.passed=true; return }
    if (mode === 'motion' || mode === 'full') await motion()
    if (mode === 'motion') { result.passed=true; return }
    if (mode === 'draft' || mode === 'full') await drafts()
    if (mode === 'draft') { result.passed=true; return }
    if (mode === 'target') { await exactTarget(); result.passed=true; return }
    assert.equal(mode, 'full')
    const expected = ['appearance','notifications','browser','general','agents','prompts','workspaces','hosts']
    assert.deepEqual(await read('Array.from(document.querySelectorAll(".settings-overview [data-settings-target]")).map(n=>n.dataset.settingsTarget)'), expected)
    assert.equal(await read('document.querySelectorAll("[data-settings-pane]").length'), 1, 'Only the visited General form is mounted')
    result.scene = []
    for (const width of [1480, 320]) {
      win.setContentSize(width, 900)
      await until('innerWidth===' + width)
      for (const theme of ['dark', 'light']) {
        await read('window.overviewProbe.theme(' + JSON.stringify(theme) + ')')
        await settle()
        const first = await geometry(node('.settings-overview [data-settings-target]'))
        const statusTop = await read('document.querySelector(".window-status-bar").getBoundingClientRect().top')
        assert.ok(first.rect.y >= 0 && first.rect.bottom < statusTop, 'A real settings entry is visible in the initial viewport')
        assert.ok(await read('document.querySelector(".settings-overview__art").naturalWidth>0'))
        assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'))
        result.scene.push({ width, theme, first, footer:await footer() })
        await capture(width + '-' + theme + '-overview.png')
      }
    }
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] })
    await settle()
    assert.deepEqual(await read('document.querySelector(".settings-overview__sweep").getAnimations().map(a=>a.playState)'), [], 'Reduced motion has a meaningful static frame without animation')
    await capture('320-light-reduced-motion.png')
    await read('document.querySelector(".settings-overview__art").src="file:///missing-settings-brand-art.png"')
    await until('document.querySelector(".settings-overview__art")?.complete===true || !document.querySelector(".settings-overview__art")')
    assert.equal(await title(), 'Overview')
    assert.equal(await read('document.querySelectorAll(".settings-overview [data-settings-target]").length'), 8)
    await footer()
    await capture('320-light-missing-art.png')
    await click(node('.settings-overview [data-settings-target=appearance]'))
    assert.equal(await title(), 'Appearance')
    await click(node('[aria-label="Search settings"]'))
    await win.webContents.insertText('prompt')
    await until('document.querySelector(".settings-content__header h2")?.textContent==="Prompts"')
    assert.equal(await read('document.querySelector(".settings-overview")'), null, 'Real search goes straight to the matching configuration page')
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
    await until('document.querySelector("[aria-label=\'Search settings\']").value===""')
    assert.equal(await read('document.activeElement===document.querySelector("[aria-label=\'Search settings\']")'), true)
    assert.equal(await title(), 'Prompts', 'Clearing search retains the current configuration page')
    win.setContentSize(1480,900)
    await settle()
    await exactTarget()
    const preserved = await read('window.overviewProbe.surface()')
    assert.equal(preserved.references.length, 8)
    assert.deepEqual(preserved.references.map(n=>n.same), [true,true,true,true,true,true,true,true])
    assert.equal(preserved.exact, true)
    result.preserved = preserved
    result.events = await read('window.overviewProbe.events')
    assert.ok(result.events.length > 0)
    assert.ok(result.events.some(e=>e.type==='click' && e.trusted), 'The real Renderer received trusted pointer input')
    result.passed = true
  } catch (error) {
    result.failure = { name:error.name, message:error.message, stack:error.stack }
    if (win && !win.isDestroyed()) {
      try { fs.writeFileSync(path.join(evidence,'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch {}
    }
  } finally {
    fs.writeFileSync(path.join(evidence,'render.json'), JSON.stringify(result,null,2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
