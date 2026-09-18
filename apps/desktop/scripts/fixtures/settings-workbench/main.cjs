const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, boundary: 'Actual App, Settings panes and styles; public preview API. Separate actual Core/desktop restart proof follows.', frames: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 960, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    const read = expr => win.webContents.executeJavaScript(expr)
    await read(`window.settingsKeyEvents=[];window.addEventListener('keydown',e=>window.settingsKeyEvents.push({key:e.key,code:e.code,prevented:e.defaultPrevented,trusted:e.isTrusted,target:e.target.tagName,role:e.target.getAttribute('role')}),true)`)
    const until = async expr => {
      const end = Date.now() + 10000
      do { if (await read(expr)) return; await new Promise(resolve => setTimeout(resolve, 30)) } while (Date.now() < end)
      throw new Error(`Settings did not settle: ${expr}`)
    }
    const click = async expr => {
      const rect = await read(`(() => { const node = ${expr}; if (!node) throw new Error('Missing control'); const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...rect })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...rect })
    }
    const key = code => { win.webContents.sendInputEvent({type:'keyDown',keyCode:code}); win.webContents.sendInputEvent({type:'keyUp',keyCode:code}); }
    const capture = async file => {
      await read(`Promise.all(Array.from(document.querySelector('.settings-page').getAnimations({subtree:true})).filter(animation=>animation.effect.getTiming().iterations !== Infinity).map(animation=>animation.finished.catch(()=>{})))`)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      fs.writeFileSync(path.join(evidence,file),(await win.webContents.capturePage()).toPNG())
    }
    const category = async pane => {
      await click('document.querySelector(".settings-section-picker")')
      await until('!!document.querySelector(".settings-section-menu[role=menu]")')
      const titles = await read(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).map(n=>n.textContent.trim())`)
      assert.deepEqual(titles,['Workspaces','Hosts','Agents','Appearance','Notifications','Browser','Prompts','Copy Paths','General'])
      if (win.getContentSize()[0] === 420 && !result.menuFrame) {
        await until(`(() => { const menu=document.querySelector('.settings-section-menu[role=menu]'); const r=menu.getBoundingClientRect(); return r.width > 100 && r.height > 200 && getComputedStyle(menu).opacity === '1'; })()`)
        await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const footer = await read(`Array.from(document.querySelectorAll('.window-status-bar button')).filter(n=>n.getBoundingClientRect().width>0).map(n=>{ const r=n.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button') === n })`)
        assert.ok(footer.length >= 5)
        assert.equal(footer.every(hit=>hit),true,'Expanded menu blocks the status bar')
        result.menuFooterHitCount = footer.length
        result.menuFrame = '420-category-menu.png'
        await capture(result.menuFrame)
      }
      const index = titles.indexOf(pane)
      assert.ok(index >= 0)
      key('Home')
      await until(`document.activeElement === document.querySelectorAll('.settings-section-menu [role=menuitemradio]')[0]`)
      for (let i=1;i<=index;i++) { key('Down'); await until(`document.activeElement === document.querySelectorAll('.settings-section-menu [role=menuitemradio]')[${i}]`) }
      key('Return')
      await until('!document.querySelector(".settings-section-menu[role=menu]")')
    }
    await until('!!window.settingsProbe && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    const before = await read('window.settingsProbe.facts()')
    await click('document.querySelector(".window-status-bar [aria-label=Settings]")')
    await until('!!document.querySelector(".settings-page")')
    for (const width of [1480, 760, 560, 420]) {
      win.setContentSize(width, width <= 560 ? 820 : 960)
      for (const theme of ['dark', 'light']) {
        await read(`window.settingsProbe.theme(${JSON.stringify(theme)})`)
        await until(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`)
        for (const pane of ['Workspaces', 'Hosts', 'Agents', 'Appearance', 'Notifications', 'Browser', 'Prompts', 'Copy Paths', 'General']) {
          if (width <= 560) {
            await category(pane)
          } else {
            const control = `Array.from(document.querySelectorAll('.settings-sidebar nav button')).find(n => n.textContent.trim() === ${JSON.stringify(pane)})`
            await read(`(${control}).scrollIntoView({block:'nearest',inline:'nearest'})`)
            await click(control)
          }
          await until(`document.querySelector('.settings-content__header h2')?.textContent === ${JSON.stringify(pane)}`)
          await new Promise(resolve => setTimeout(resolve, 120))
          const geometry = await read(`(() => {
            const rect = selector => { const n = document.querySelector(selector); const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}; };
            const settings = rect('.settings-page'), footer = rect('.window-status-bar'), scroll = document.querySelector('[data-settings-pane]:not([hidden])');
            const controls = [...document.querySelectorAll('.window-status-bar button')].filter(n => n.getBoundingClientRect().width > 0).map(n => { const r=n.getBoundingClientRect(); return {label:n.getAttribute('aria-label') || n.textContent, hit: Boolean(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button') === n)} });
            const bar = scroll.querySelector('.settings-pane-actions'); const action = bar?.getBoundingClientRect();
            return {settings,footer,controls,overflow:scroll.scrollWidth-scroll.clientWidth,workspaceInert:document.querySelector('.app-shell__workspace').inert,footerInert:Boolean(document.querySelector('.window-status-bar').closest('[inert]')),saveVisible: !bar || (action.top >= scroll.getBoundingClientRect().top && action.bottom <= footer.y + 1)};
          })()`)
          assert.equal(geometry.footer.height, 32)
          assert.ok(geometry.settings.bottom <= geometry.footer.y + 1, 'Settings covers the status bar')
          assert.equal(geometry.footerInert, false)
          assert.equal(geometry.workspaceInert, true)
          assert.ok(geometry.controls.length >= 5)
          for (const control of geometry.controls) assert.equal(control.hit, true, `Footer control obscured: ${control.label}`)
          assert.ok(geometry.overflow <= 1, `Pane overflows at ${width}px`)
          assert.equal(geometry.saveVisible, true, 'Save bar is outside the visible reading area')
          const file = `${width}-${theme}-${pane.toLowerCase()}.png`
          await capture(file)
          result.frames.push({width,theme,pane,file,geometry,navigation:width <= 560 ? 'radix-radio-menu-trusted-keyboard' : 'native-button'})
          if (pane === 'Agents' && theme === 'dark') {
            await click('document.querySelector("[data-settings-pane=agents] .agent-settings-card > summary")')
            await until('document.querySelector("[data-settings-pane=agents] .agent-settings-card[open] .agent-settings-fields")?.getBoundingClientRect().height > 100')
            await new Promise(resolve => setTimeout(resolve, 120))
            const expanded = await read(`(() => { const pane=document.querySelector('[data-settings-pane=agents]'); const bar=pane.querySelector('.settings-pane-actions').getBoundingClientRect(); const fields=pane.querySelector('.agent-settings-fields'); return {overflow:pane.scrollWidth-pane.clientWidth,fieldsHeight:fields.getBoundingClientRect().height,fieldsWidth:fields.getBoundingClientRect().width,fieldsOverflow:fields.scrollWidth-fields.clientWidth,saveBottom:bar.bottom,footerTop:document.querySelector('.window-status-bar').getBoundingClientRect().top}; })()`)
            assert.ok(expanded.fieldsHeight > 100 && expanded.fieldsWidth > 100)
            assert.ok(expanded.overflow <= 1 && expanded.fieldsOverflow <= 1)
            assert.ok(expanded.saveBottom <= expanded.footerTop + 1)
            await capture(`${width}-dark-agents-expanded.png`)
            result.frames.at(-1).expanded = expanded
            await click('document.querySelector("[data-settings-pane=agents] .agent-settings-card > summary")')
          }
        }
      }
    }
    await click('document.querySelector(".settings-section-picker")')
    await until('!!document.querySelector(".settings-section-menu[role=menu]")')
    key('Escape')
    await until('!document.querySelector(".settings-section-menu[role=menu]")')
    assert.equal(await read('!!document.querySelector(".settings-page")'),true,'Escape closed Settings while dismissing its category menu')
    await until('document.activeElement === document.querySelector(".settings-section-picker")')
    result.menuEscape = { settingsPreserved: true, triggerFocusReturned: true }
    // Large resource fixtures exercise the same actual panes; these are explicit preview facts.
    await click('document.querySelector(".window-status-bar [aria-label=Settings]")')
    await until('!document.querySelector(".settings-page")')
    assert.equal(await read('window.settingsProbe.facts()'), before)
    result.originalSurfacePreserved = true
    result.scale = await read('window.settingsProbe.scale()')
    await until('JSON.parse(window.settingsProbe.facts()).activeWorkspaceId === "fixture-1"')
    const scaleBefore = await read('window.settingsProbe.facts()')
    await read('window.settingsProbe.theme("dark")')
    await until('document.documentElement.dataset.appearance === "dark"')
    assert.equal(result.scale.workspaces, 51)
    assert.ok(result.scale.providers >= 13)
    assert.equal(result.scale.executors, result.scale.providers + 1)
    await click('document.querySelector(".window-status-bar [aria-label=Settings]")')
    await until('document.querySelectorAll(".workspace-settings-list > div").length === 51')
    const fill = async (selector, value) => {
      await read(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`)
      if (value) await win.webContents.insertText(value)
      else { win.webContents.sendInputEvent({type:'keyDown',keyCode:'Backspace'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Backspace'}); }
    }
    await fill('[aria-label="Filter workspaces"]', 'WORKSPACE-51')
    await until('document.querySelectorAll(".workspace-settings-list > div").length === 1')
    assert.equal(await read('document.querySelector(".workspace-settings-list strong").textContent'), 'Workspace 51')
    await capture('420-dark-workspaces-filtered.png')
    await category('Agents')
    await until(`document.querySelectorAll('.agent-settings-card').length === ${result.scale.executors}`)
    await fill('[aria-label="Filter executors"]', 'review-second')
    await until('document.querySelectorAll(".agent-settings-card:not([hidden])").length === 1')
    await click('document.querySelector("#executor-settings-review-second > summary")')
    await until('document.querySelector("#executor-settings-review-second").open')
    await click('document.querySelector("#executor-settings-review-second .settings-launch-config > summary")')
    await until('document.querySelector("#executor-settings-review-second .settings-launch-config").open')
    for (const width of [420, 1480]) {
      win.setContentSize(width, width === 420 ? 820 : 960)
      await new Promise(resolve => setTimeout(resolve,120))
      const geometry = await read(`(() => { const pane=document.querySelector('[data-settings-pane=agents]'); const fields=pane.querySelector('.agent-settings-card:not([hidden]) .settings-launch-config__fields'); const save=pane.querySelector('.settings-pane-actions').getBoundingClientRect(); return {count:document.querySelectorAll('.agent-settings-card:not([hidden])').length,overflow:pane.scrollWidth-pane.clientWidth,fieldsWidth:fields.getBoundingClientRect().width,fieldsOverflow:fields.scrollWidth-fields.clientWidth,saveBottom:save.bottom,footerTop:document.querySelector('.window-status-bar').getBoundingClientRect().top}; })()`)
      result.scale[`${width}Launch`] = geometry
      assert.equal(geometry.count,1)
      assert.ok(geometry.fieldsWidth > 100 && geometry.overflow <= 1 && geometry.fieldsOverflow <= 1)
      assert.ok(geometry.saveBottom <= geometry.footerTop + 1)
      await capture(`${width}-dark-agents-launch.png`)
    }
    await fill('#executor-settings-review-second [data-executor-name]', 'Edited reviewer')
    await read('window.settingsProbe.failNextSave()')
    await click('document.querySelector("[data-settings-pane=agents] .settings-pane-actions button")')
    await until('document.querySelector("[data-settings-pane=agents] [role=alert]")?.textContent.includes("Try again")')
    assert.equal(await read('document.querySelector("#executor-settings-review-second [data-executor-name]").value'), 'Edited reviewer')
    await capture('1480-dark-save-error.png')
    result.scale.errorDraftPreserved = true
    await click(`document.querySelector(${JSON.stringify('.window-status-bar [aria-label="Space: show terminal and file workbench"]')})`)
    await until('!document.querySelector(".settings-page")')
    assert.equal(await read('window.settingsProbe.facts()'), scaleBefore)
    result.scale.surfacePreserved = true
    result.keyboardEvents = await read('window.settingsKeyEvents.filter(e=>e.role === "menuitemradio")')
    assert.ok(result.keyboardEvents.length > 0, 'No actual menu key events')
    assert.equal(result.keyboardEvents.every(event=>event.trusted),true,'Menu key events were synthetic DOM dispatches')
    result.passed = true
  } catch (error) { result.failure = {message:error.message,stack:error.stack}; if (win) { result.failure.focused=win.isFocused(); result.failure.ui = await win.webContents.executeJavaScript(`({keys:window.settingsKeyEvents,focus:document.activeElement?.outerHTML,selected:document.querySelector('.settings-section-picker')?.selectedIndex,title:document.querySelector('h2')?.textContent,picker:document.querySelector('.settings-section-picker')?.getBoundingClientRect().toJSON()})`).catch(() => null); fs.writeFileSync(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG()); } }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result,null,2)); win?.destroy(); app.quit() }
})
