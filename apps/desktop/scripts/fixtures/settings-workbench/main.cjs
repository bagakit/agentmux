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
    const read = expr => win.webContents.executeJavaScript(expr)
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
    await until('!!window.settingsProbe && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    const before = await read('window.settingsProbe.facts()')
    await click('document.querySelector(".window-status-bar [aria-label=Settings]")')
    await until('!!document.querySelector(".settings-page")')
    for (const width of [1480, 760, 560, 420]) {
      win.setContentSize(width, width <= 560 ? 820 : 960)
      for (const theme of ['dark', 'light']) {
        await read(`window.settingsProbe.theme(${JSON.stringify(theme)})`)
        await until(`document.documentElement.dataset.appearance === ${JSON.stringify(theme)}`)
        for (const pane of (width === 1480 || width === 420 ? ['Workspaces', 'Hosts', 'Agents', 'Appearance', 'Notifications', 'Browser', 'Prompts', 'Copy Paths', 'General'] : ['Workspaces', 'Agents', 'Appearance'])) {
          // Read current semantic navigation, scroll to the chosen control, then send native input.
          const control = `Array.from(document.querySelectorAll('.settings-sidebar nav button')).find(n => n.textContent.trim() === ${JSON.stringify(pane)})`
          await read(`(${control}).scrollIntoView({block:'nearest',inline:'nearest'})`)
          await click(control)
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
          fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
          result.frames.push({width,theme,pane,file,geometry})
          if (pane === 'Agents' && theme === 'dark') {
            await click('document.querySelector("[data-settings-pane=agents] .agent-settings-card > summary")')
            await until('!!document.querySelector("[data-settings-pane=agents] .agent-settings-card[open]")')
            const expanded = await read(`(() => { const pane=document.querySelector('[data-settings-pane=agents]'); const bar=pane.querySelector('.settings-pane-actions').getBoundingClientRect(); const fields=pane.querySelector('.agent-settings-fields'); return {overflow:pane.scrollWidth-pane.clientWidth,fieldsOverflow:fields.scrollWidth-fields.clientWidth,saveBottom:bar.bottom,footerTop:document.querySelector('.window-status-bar').getBoundingClientRect().top}; })()`)
            assert.ok(expanded.overflow <= 1 && expanded.fieldsOverflow <= 1)
            assert.ok(expanded.saveBottom <= expanded.footerTop + 1)
            fs.writeFileSync(path.join(evidence, `${width}-dark-agents-expanded.png`), (await win.webContents.capturePage()).toPNG())
            result.frames.at(-1).expanded = expanded
            await click('document.querySelector("[data-settings-pane=agents] .agent-settings-card > summary")')
          }
        }
      }
    }
    await click(`document.querySelector(${JSON.stringify('.window-status-bar [aria-label="Space: show terminal and file workbench"]')})`)
    await until('!document.querySelector(".settings-page")')
    assert.equal(await read('window.settingsProbe.facts()'), before)
    result.passed = true
  } catch (error) { result.failure = {message:error.message,stack:error.stack} }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result,null,2)); win?.destroy(); app.quit() }
})
