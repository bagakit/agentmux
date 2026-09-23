const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, testCase] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, boundary: 'Actual Settings/SurfaceSwitch/CSS; controlled empty workbench; no Runtime, App initialization, restart or install claim.', testCase, frames: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    const read = async expr => { try { return await win.webContents.executeJavaScript(expr) } catch (error) { throw new Error(`Renderer read failed: ${expr}`, { cause: error }) } }
    const until = async expr => {
      const end = Date.now() + 4000
      do { if (await read(expr)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error(`Settings did not settle: ${expr}`)
    }
    const hit = async expr => read(`(() => {
      const n=${expr}; if (!n || !n.isConnected) throw new Error('Missing connected control');
      const r=n.getBoundingClientRect(); return {width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2,
        hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>{const p=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return p===n||n.contains(p)})};
    })()`)
    const click = async expr => {
      const r = await hit(expr)
      assert.ok(r.width > 0 && r.height > 0 && r.hits.length === 5 && r.hits.every(Boolean), 'Control must have five real CSS hits')
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: r.x, y: r.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: r.x, y: r.y })
    }
    const key = async name => {
      const key = name === 'Return' ? 'Enter' : name
      const windowsVirtualKeyCode = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27 }[key]
      assert.ok(windowsVirtualKeyCode, 'Only explicit fixture navigation keys are supported')
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key, code: key, windowsVirtualKeyCode,
        ...(type === 'keyDown' && key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {})
      })
    }
    const type = async value => { for (const char of value) await win.webContents.insertText(char) }
    const fill = async (expr, value) => {
      await click(expr)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
      await key('Backspace'); await until(`(${expr}).value===''`)
      await type(value); await until(`(${expr}).value===${JSON.stringify(value)}`)
    }
    const settle = async () => {
      await read(`Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const search = node('[aria-label="Search settings"]')
    const clear = node('[aria-label="Clear settings search"]')
    const section = async title => {
      result.phase = `select-${title}`
      await until(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).some(n=>n.textContent.trim()===${JSON.stringify(title)})`)
      const visibleNav = `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find(n=>n.textContent.trim()===${JSON.stringify(title)} && n.getBoundingClientRect().width>0)`
      if (await read(`!!(${visibleNav})`)) await click(visibleNav)
      else {
        await click('document.querySelector(".settings-section-picker")')
        await until('document.querySelector(".settings-section-menu[role=menu]")?.dataset.state === "open"')
        await settle()
        await click(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).find(n=>n.textContent.trim()===${JSON.stringify(title)})`)
      }
      await until(`document.querySelector('.settings-content__header h2').textContent===${JSON.stringify(title)}`)
      await until('document.querySelectorAll(".settings-content__scroll:not([hidden])").length === 1')
    }
    await until('window.__settingsSearchRefinement.ready && !!document.querySelector("[data-settings-pane=general]")')
    for (const width of [320, 420, 1480]) {
      win.setContentSize(width, 900)
      win.webContents.focus()
      await until(`innerWidth===${width}`)
      await settle()
      const frame = { width, controls: {}, clearMethods: [] }
      frame.geometry = await read(`({width:innerWidth,brand:document.querySelectorAll('.settings-sidebar__brand').length,status:document.querySelector('.window-status-bar').getBoundingClientRect().toJSON(),page:document.querySelector('.settings-page').getBoundingClientRect().toJSON()})`)
      assert.equal(frame.geometry.brand, 1)
      assert.equal(frame.geometry.status.height, 32)
      assert.ok(frame.geometry.page.bottom <= frame.geometry.status.y + 1)
      frame.controls.search = await hit(search)
      frame.controls.close = await hit(node('[aria-label="Close settings"]'))
      const footer = await read(`Array.from(document.querySelectorAll('.window-status-bar button')).map((n,index)=>({label:n.getAttribute('aria-label'),index}))`)
      assert.ok(footer.length > 0)
      for (const { label, index } of footer) {
        const h = await hit(`document.querySelectorAll('.window-status-bar button')[${index}]`)
        assert.ok(h.width > 0 && h.hits.length === 5 && h.hits.every(Boolean)); frame.controls[label] = h
      }
      // Current sections are derived from the real owning nav, then matched against the real narrow menu.
      const titles = await read(`Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).map(n=>n.textContent.trim())`)
      assert.ok(titles.length > 0 && new Set(titles).size === titles.length)
      frame.sections = titles
      if (width < 700) {
        await click('document.querySelector(".settings-section-picker")')
        await until('document.querySelector(".settings-section-menu[role=menu]")?.dataset.state === "open"'); await settle()
        const menu = await read(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).map(n=>n.textContent.trim())`)
        assert.deepEqual(menu, titles)
        for (const title of menu) {
          const h = await hit(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).find(n=>n.textContent.trim()===${JSON.stringify(title)})`)
          assert.ok(h.width > 0 && h.hits.length === 5 && h.hits.every(Boolean))
        }
        for (const { index } of footer) assert.ok((await hit(`document.querySelectorAll('.window-status-bar button')[${index}]`)).hits.every(Boolean))
        await key('Escape'); await until('!document.querySelector(".settings-section-menu")'); await settle()
      }
      await section('Appearance')
      const font = node('[aria-label="Terminal font size in pixels"]')
      await fill(font, '18'); await fill(font, '')
      await section('General')
      const toggle = 'document.querySelector("[data-settings-pane=general] input[type=checkbox]")'
      if (!(await read(`(${toggle}).checked`))) await click(toggle)
      await until(`(${toggle}).checked`)
      frame.copyIntro = await read(`(() => {const p=document.querySelector('[data-settings-pane=general]'),group=p.querySelector('.settings-group');return {connected:p.isConnected,visible:!p.hidden,title:document.querySelector('.settings-content__header h2').textContent,description:document.querySelector('.settings-content__header p').textContent,groupConnected:group.isConnected,groupTitle:group.querySelector('header span').textContent,leadCount:group.querySelectorAll('.settings-lead').length,text:group.textContent,dirty:!p.querySelector('[data-settings-save-bar] button').disabled}})()`)
      assert.equal(frame.copyIntro.connected, true); assert.equal(frame.copyIntro.visible, true)
      assert.equal(frame.copyIntro.title, 'General'); assert.equal(frame.copyIntro.description, 'Copied paths, local data, and diagnostics.'); assert.equal(frame.copyIntro.groupConnected, true); assert.equal(frame.copyIntro.groupTitle, 'Home directory in copied paths')
      if (testCase === 'copy-intro') assert.equal(frame.copyIntro.leadCount, 0, 'Copy Paths has one introduction')
      for (const text of ['~', 'proj/app', 'your own home directory', 'Remote paths and paths belonging to another user always stay complete', 'Applies to every Copy Path action']) assert.ok(frame.copyIntro.text.includes(text))
      assert.equal(frame.copyIntro.dirty, true)
      for (const method of ['mouse', 'keyboard']) {
        result.phase = `${width}-${method}-clear`
        await fill(search, 'copy')
        frame.controls.clear = await hit(clear)
        await read(`window.__originalSettingsSearch=${search}`)
        if (method === 'mouse') await click(clear)
        else {
          await key('Tab'); await until(`document.activeElement===${clear}`)
          await key('Return')
        }
        await until(`(${search}).value===''`)
        const focus = await read(`({exact:document.activeElement===window.__originalSettingsSearch,connected:window.__originalSettingsSearch.isConnected,visible:window.__originalSettingsSearch.getBoundingClientRect().width>0,tag:document.activeElement.tagName})`)
        assert.deepEqual(focus, { exact: true, connected: true, visible: true, tag: 'INPUT' }, 'Clear returns focus to the original visible search input')
        // No focus/click occurs between the Clear result and the next native characters.
        await type('host'); await until(`(${search}).value==='host'`)
        assert.equal(await read("document.querySelector('.settings-content__header h2').textContent"), 'Hosts')
        frame.clearMethods.push({ method, focus, nextQuery: await read(`(${search}).value`) })
        await click(clear); await until(`(${search}).value===''`)
      }
      await section('Appearance'); assert.equal(await read(`(${font}).value`), '', 'Incomplete numeric draft survives searching and clearing')
      await section('General'); assert.equal(await read(`(${toggle}).checked`), true, 'Dirty Copy Paths draft survives searching and clearing')
      await settle(); const image = `${width}-${testCase}.png`; fs.writeFileSync(path.join(evidence, image), (await win.webContents.capturePage()).toPNG()); frame.image = image
      await click(node('[aria-label="Close settings"]')); await until('!document.querySelector(".settings-page")')
      await click('document.querySelector(".window-status-bar [aria-label=Settings]")'); await until('!!document.querySelector("[data-settings-pane=general]")')
      await click(node('.window-status-bar [aria-label="Space: show terminal and file workbench"]')); await until('!document.querySelector(".settings-page")')
      await click('document.querySelector(".window-status-bar [aria-label=Settings]")'); await until('!!document.querySelector("[data-settings-pane=general]")')
      result.frames.push(frame)
    }
    result.events = await read('window.__settingsSearchRefinement.events')
    assert.ok(result.events.length > 0 && result.events.every(event => event.trusted))
    assert.ok(result.events.some(event => event.type === 'input' && event.label === 'Search settings'))
    assert.ok(result.events.some(event => event.type === 'click' && event.label === 'Clear settings search'))
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) {
      result.failure.ui = await win.webContents.executeJavaScript(`({focus:document.activeElement?.outerHTML,query:document.querySelector('[aria-label="Search settings"]')?.value,title:document.querySelector('h2')?.textContent,events:window.__settingsSearchRefinement?.events})`).catch(() => null)
      fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
