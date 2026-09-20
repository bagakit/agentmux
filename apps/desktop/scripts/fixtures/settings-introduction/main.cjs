const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, boundary: 'Finite actual renderer/CSS with preview configuration publication; no Runtime, restart or installation claim.', frames: [], navigation: [] }
const descriptions = {
  browser: 'Choose how agents interact with your pages.',
  notifications: 'Choose when and how agents get your attention.',
  prompts: 'Keep your everyday instructions close at hand.'
}
const guidance = {
  notifications: 'Get a notification when an agent finishes, needs your attention or runs into trouble while you are elsewhere.',
  prompts: 'Type / to choose one in the composer, or use its keyword in your draft. You decide what to send.'
}
const scope = 'Off by default. When enabled, agents can read pages, follow links and submit forms using your signed-in accounts, including actions that spend money. This applies to all open browsers.'
const linkScope = 'Your choices apply to each link type across all sites. Forget a choice to be asked again next time.'
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
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error(`Introduction proof did not settle: ${expression}`)
    }
    const settle = async () => {
      await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const hit = expression => read(`(() => { const n=${expression}; if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible connected control');
      const r=n.getBoundingClientRect();return{width:r.width,height:r.height,x:r.x+r.width/2,y:r.y+r.height/2,
      hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>{const p=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return p===n||n.contains(p)})}; })()`)
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
    const pane = id => `[data-settings-pane="${id}"]:not([hidden])`
    const measure = id => read(`(() => {
      const pane=document.querySelector(${JSON.stringify(pane(id))}),header=document.querySelector('.settings-content__header');
      const rect=n=>n.getBoundingClientRect().toJSON(),text=n=>{if(!n?.isConnected||!n.checkVisibility()||!n.textContent.trim())throw Error('Missing nonempty visible text');const range=document.createRange();range.selectNodeContents(n);return{text:n.textContent.trim(),lines:Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0).map(r=>r.toJSON())}};
      const leads=Array.from(pane.querySelectorAll('.settings-lead'));
      return{pane:rect(pane),header:rect(header),title:text(header.querySelector('h2')),description:text(header.querySelector('p')),leads:leads.map(text),
        controlText:text(pane.querySelector(${JSON.stringify(id === 'browser' ? 'label strong' : id === 'notifications' ? '.settings-group header span' : '.settings-pane-toolbar button')})),
        scope:${id === 'browser' ? "text(pane.querySelector('label small'))" : 'null'},linkScope:${id === 'browser' ? "text(pane.querySelector('.settings-group-note'))" : 'null'},
        slash:${id === 'prompts' ? "pane.querySelector('.settings-lead code')?.textContent" : 'null'},
        saved:${id === 'browser' ? "window.__settingsIntroduction.browserSaved()" : 'null'},
        summary:${id === 'browser' ? "text(pane.querySelector('.settings-group header small'))" : 'null'},
        checked:${id === 'browser' ? "pane.querySelector('input[type=checkbox]').checked" : 'null'}};
    })()`)
    const assertFrame = (frame, id, title) => {
      assert.equal(frame.title.text, title)
      assert.equal(frame.description.text, descriptions[id])
      assert.equal(frame.controlText.text, id === 'browser' ? 'Let agents interact with browser pages' : id === 'notifications' ? 'How long it stays' : 'Add prompt')
      if (id === 'browser') {
        assert.equal(frame.leads.length, 0, 'browser uses one section introduction')
        assert.equal(frame.scope.text, scope); assert.equal(frame.linkScope.text, linkScope)
        assert.equal(frame.summary.text, `Saved: ${frame.saved ? 'On' : 'Off'}`)
      } else {
        assert.equal(frame.leads.length, 1)
        assert.equal(frame.leads[0].text, guidance[id], `${id} keeps concrete guidance without its generic prefix`)
        if (id === 'prompts') assert.equal(frame.slash, '/')
      }
      const contained = (line, box) => line.x >= box.x - 1 && line.right <= box.right + 1 && line.y >= box.y - 1 && line.bottom <= box.bottom + 1
      const texts = [frame.title, frame.description, frame.controlText, ...frame.leads, ...[frame.scope, frame.linkScope, frame.summary].filter(Boolean)]
      assert.ok(texts.length >= 3)
      for (const text of texts) {
        assert.ok(text.lines.length > 0, 'Actual complete text line collection is nonempty')
        const box = text === frame.title || text === frame.description ? frame.header : frame.pane
        for (const line of text.lines) assert.ok(contained(line, box), 'Full text is contained in the actual visible area')
      }
      for (const titleLine of frame.title.lines) for (const description of frame.description.lines)
        assert.ok(Math.min(titleLine.right, description.right) <= Math.max(titleLine.x, description.x) + .5 || Math.min(titleLine.bottom, description.bottom) <= Math.max(titleLine.y, description.y) + .5, 'Title and description do not overlap')
      assert.ok(frame.header.bottom <= frame.pane.y + 1, 'Section header and body do not overlap')
    }
    await until('window.__settingsIntroduction?.ready&&window.__settingsSearchRefinement?.ready')
    for (const width of [320, 420, 1480]) {
      win.setContentSize(width, 900); await until(`innerWidth===${width}`); await settle()
      const shell = await read('({brand:document.querySelectorAll(".settings-sidebar__brand").length,status:document.querySelector(".window-status-bar").getBoundingClientRect().toJSON(),page:document.querySelector(".settings-page").getBoundingClientRect().toJSON()})')
      assert.equal(shell.brand, 1); assert.equal(shell.status.height, 32); assert.ok(shell.page.bottom <= shell.status.y + 1)
      const footerCount = await read('document.querySelectorAll(".window-status-bar button").length')
      assert.ok(footerCount > 0)
      const footerHits = []
      for (let i = 0; i < footerCount; i++) {
        const geometry = await hit(`document.querySelectorAll('.window-status-bar button')[${i}]`)
        assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.hits.length === 5 && geometry.hits.every(Boolean)); footerHits.push(geometry)
      }
      for (const [id, title] of [['browser', 'Browser'], ['notifications', 'Notifications'], ['prompts', 'Prompts']]) {
        result.phase = `${width}-${id}`; await section(title)
        const frame = await measure(id); assertFrame(frame, id, title)
        const firstControl = node(`${pane(id)} ${id === 'browser' ? 'input[type=checkbox]' : id === 'notifications' ? 'input[type=range]' : '.settings-pane-toolbar button'}`)
        const geometry = await hit(firstControl)
        assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.hits.length === 5 && geometry.hits.every(Boolean))
        assert.ok(geometry.x - geometry.width / 2 >= frame.pane.x - 1 && geometry.x + geometry.width / 2 <= frame.pane.right + 1 && geometry.y - geometry.height / 2 >= frame.pane.y - 1 && geometry.y + geometry.height / 2 <= frame.pane.bottom + 1, 'Complete first control is within its visible Pane')
        const image = `${width}-${id}.png`; await settle(); fs.writeFileSync(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
        const interaction = await click(firstControl)
        let save, published
        if (id === 'browser') {
          await until(`${node(`${pane(id)} input[type=checkbox]`)}.checked===${!frame.saved}`)
          const dirty = await measure(id); assert.equal(dirty.summary.text, frame.summary.text); assert.equal(dirty.saved, frame.saved)
          save = await click(node(`${pane(id)} .settings-pane-actions button`))
          await until(`window.__settingsIntroduction.browserSaved()===${!frame.saved}`)
          await until(`${node(`${pane(id)} .settings-group header small`)}.textContent===${JSON.stringify(`Saved: ${!frame.saved ? 'On' : 'Off'}`)}`)
          published = await measure(id); assertFrame(published, id, title); assert.equal(published.checked, !frame.saved)
        } else if (id === 'prompts') await until(`${node(pane(id))}.querySelectorAll('.prompt-settings-card').length>1`)
        result.frames.push({ width, id, shell, footerHits, frame, firstControl: geometry, interaction, save, published, image })
      }
      const close = await click(node('[aria-label="Close settings"]')); await until('!document.querySelector(".settings-page")')
      const reopen = await click(node('.window-status-bar [aria-label="Settings"]')); await until('document.querySelector(".settings-page")')
      const space = await click(node('.window-status-bar [aria-label="Space: show terminal and file workbench"]')); await until('!document.querySelector(".settings-page")')
      const reopenAfterSpace = await click(node('.window-status-bar [aria-label="Settings"]')); await until('document.querySelector(".settings-page")')
      result.navigation.push({ width, close, reopen, space, reopenAfterSpace })
    }
    result.events = await read('window.__settingsSearchRefinement.events')
    assert.ok(result.events.length > 0 && result.events.every(event => event.trusted))
    for (const [label, count] of [['Save browser', 3], ['Add prompt', 3], ['Close settings', 3], ['Settings', 6], ['Space: show terminal and file workbench', 3]])
      assert.equal(result.events.filter(event => event.type === 'click' && event.label?.trim() === label).length, count, `Exact trusted ${label} operations`)
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
