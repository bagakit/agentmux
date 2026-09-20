const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, boundary: 'Actual Renderer/CSS and preview configuration publication; no Runtime, Native capability, restart or install claim.', frames: [], navigation: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    const read = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => {
      const end = Date.now() + 4000
      do {
        if (await read(expression)) return
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (Date.now() < end)
      throw new Error(`Saved summary did not settle: ${expression}`)
    }
    const settle = async () => {
      await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const hit = expression => read(`(() => {
      const n=${expression}; if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible connected control');
      const r=n.getBoundingClientRect();return {width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2,
        hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>{const p=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return p===n||n.contains(p)})};
    })()`)
    const click = async expression => {
      const geometry = await hit(expression)
      assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.hits.length === 5 && geometry.hits.every(Boolean), 'Control has five actual CSS hits')
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      return geometry
    }
    const section = async title => {
      const wide = `Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).find(n=>n.textContent.trim()===${JSON.stringify(title)}&&n.checkVisibility())`
      if (await read(`!!(${wide})`)) await click(wide)
      else {
        await click(node('.settings-section-picker'))
        await until('document.querySelector(".settings-section-menu[role=menu]")?.dataset.state==="open"')
        await settle()
        await click(`Array.from(document.querySelectorAll('.settings-section-menu [role=menuitemradio]')).find(n=>n.textContent.trim()===${JSON.stringify(title)})`)
      }
      await until(`document.querySelector('.settings-content__header h2').textContent===${JSON.stringify(title)}`)
      await until('document.querySelectorAll(".settings-content__scroll:not([hidden])").length===1')
      await settle()
    }
    const pane = kind => `[data-settings-pane="${kind === 'copy' ? 'copy-paths' : 'browser'}"]:not([hidden])`
    const measure = kind => read(`(() => {
      const pane=document.querySelector(${JSON.stringify(pane(kind))}),group=pane?.querySelector('.settings-group'),header=group?.querySelector('header');
      const rect=n=>n.getBoundingClientRect().toJSON();
      const text=n=>{if(!n?.isConnected||!n.checkVisibility()||!n.textContent.trim())throw Error('Missing nonempty visible text');const range=document.createRange();range.selectNodeContents(n);return{text:n.textContent,lines:Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0).map(r=>r.toJSON())}};
      const input=group?.querySelector('input[type=checkbox]');if(!input?.isConnected||!input.checkVisibility())throw Error('Missing actual checkbox');
      return {pane:rect(pane),header:rect(header),title:text(header.querySelector('span')),summary:text(header.querySelector('small')),
        controlTitle:text(input.closest('label').querySelector('strong')),scope:text(input.closest('label').querySelector('span > small')),
        checked:input.checked,saved:window.__settingsSavedSummary.saved()[${JSON.stringify(kind)}],feedback:pane.querySelector('[role=status]')?.textContent.trim()};
    })()`)
    const assertText = (frame, kind, saved) => {
      assert.equal(frame.title.text, kind === 'copy' ? 'Home directory in copied paths' : 'Agent automation')
      assert.equal(frame.summary.text, `Saved: ${kind === 'copy' ? saved ? 'Absolute' : 'Abbreviated' : saved ? 'On' : 'Off'}`, `${kind} summary identifies the saved fact`)
      const contained = (line, box) => line.x >= box.x - 1 && line.right <= box.right + 1 && line.y >= box.y - 1 && line.bottom <= box.bottom + 1
      for (const text of [frame.title, frame.summary, frame.controlTitle, frame.scope]) {
        assert.ok(text.lines.length > 0, 'Actual text line collection is nonempty')
        for (const line of text.lines) assert.ok(contained(line, frame.pane), 'Complete text stays within the visible content area')
      }
      for (const text of [frame.title, frame.summary]) for (const line of text.lines) assert.ok(contained(line, frame.header), 'Full header text stays within its header')
      for (const title of frame.title.lines) for (const summary of frame.summary.lines) {
        const overlapX = Math.min(title.right, summary.right) - Math.max(title.x, summary.x)
        const overlapY = Math.min(title.bottom, summary.bottom) - Math.max(title.y, summary.y)
        assert.ok(overlapX <= 0.5 || overlapY <= 0.5, 'Title and saved summary do not overlap')
      }
    }
    await until('window.__settingsSearchRefinement?.ready&&window.__settingsSavedSummary&&document.querySelector("[data-settings-pane=copy-paths]")')
    for (const width of [320, 420, 1480]) {
      win.setContentSize(width, 900)
      await until(`innerWidth===${width}`)
      await settle()
      const shell = await read('({brand:document.querySelectorAll(".settings-sidebar__brand").length,status:document.querySelector(".window-status-bar").getBoundingClientRect().toJSON(),page:document.querySelector(".settings-page").getBoundingClientRect().toJSON()})')
      assert.equal(shell.brand, 1)
      assert.equal(shell.status.height, 32)
      assert.ok(shell.page.bottom <= shell.status.y + 1)
      const footer = await read('Array.from(document.querySelectorAll(".window-status-bar button")).map((n,index)=>({index,label:n.getAttribute("aria-label")}))')
      assert.ok(footer.length > 0)
      const footerHits = []
      for (const entry of footer) {
        const geometry = await hit(`document.querySelectorAll('.window-status-bar button')[${entry.index}]`)
        assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.hits.length === 5 && geometry.hits.every(Boolean))
        footerHits.push({ ...entry, geometry })
      }
      for (const kind of ['copy', 'browser']) {
        result.phase = `${width}-${kind}`
        await section(kind === 'copy' ? 'Copy Paths' : 'Browser')
        const before = await measure(kind)
        assertText(before, kind, before.saved)
        assert.equal(before.checked, before.saved)
        const checkbox = await click(node(`${pane(kind)} .settings-group input[type=checkbox]`))
        await until(`${node(`${pane(kind)} .settings-group input[type=checkbox]`)}.checked===${!before.saved}`)
        const dirty = await measure(kind)
        assertText(dirty, kind, before.saved)
        assert.equal(dirty.checked, !before.saved)
        assert.equal(dirty.saved, before.saved)
        assert.equal(dirty.feedback, 'Unsaved changes')
        await settle()
        const image = `${width}-${kind}-dirty.png`
        fs.writeFileSync(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
        const save = await click(node(`${pane(kind)} .settings-pane-actions button`))
        await until(`window.__settingsSavedSummary.saved()[${JSON.stringify(kind)}]===${!before.saved}`)
        await until(`${node(`${pane(kind)} .settings-group header small`)}.textContent===${JSON.stringify(`Saved: ${kind === 'copy' ? !before.saved ? 'Absolute' : 'Abbreviated' : !before.saved ? 'On' : 'Off'}`)}`)
        const published = await measure(kind)
        assertText(published, kind, !before.saved)
        assert.equal(published.checked, !before.saved)
        assert.equal(published.saved, !before.saved)
        await until(`${node(`${pane(kind)} .settings-pane-actions button`)}.disabled`)
        await settle()
        const publishedImage = `${width}-${kind}-published.png`
        fs.writeFileSync(path.join(evidence, publishedImage), (await win.webContents.capturePage()).toPNG())
        result.frames.push({ width, kind, shell, footerHits, checkbox, save, before, dirty, published, image, publishedImage })
      }
      const close = await click(node('[aria-label="Close settings"]'))
      await until('!document.querySelector(".settings-page")')
      const reopenAfterClose = await click(node('.window-status-bar [aria-label="Settings"]'))
      await until('document.querySelector("[data-settings-pane=copy-paths]")')
      const space = await click(node('.window-status-bar [aria-label="Space: show terminal and file workbench"]'))
      await until('!document.querySelector(".settings-page")')
      const reopenAfterSpace = await click(node('.window-status-bar [aria-label="Settings"]'))
      await until('document.querySelector("[data-settings-pane=copy-paths]")')
      result.navigation.push({ width, close, reopenAfterClose, space, reopenAfterSpace })
    }
    result.events = await read('window.__settingsSearchRefinement.events')
    assert.ok(result.events.length > 0 && result.events.every(event => event.trusted))
    for (const [label, count] of [['Save', 3], ['Save browser', 3], ['Close settings', 3], ['Settings', 6], ['Space: show terminal and file workbench', 3]]) {
      assert.equal(result.events.filter(event => event.type === 'click' && event.label === label).length, count, `Exact trusted ${label} operations`)
    }
    assert.equal(result.events.filter(event => event.type === 'input').length, 6, 'One actual checkbox input per Pane and width')
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
