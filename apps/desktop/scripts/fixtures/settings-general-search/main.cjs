const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, captureOnly: true, aestheticReview: 'not-performed', frames: [], navigation: [],
  boundary: 'Finite actual SettingsPanel/General/CSS/Preview and trusted input; no Runtime, file manager, restart or installation.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    win.webContents.focus()
    const read = expression => win.webContents.executeJavaScript(expression)
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const until = async expression => {
      const end = Date.now() + 4000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error(`General search proof did not settle: ${expression}`)
    }
    const settle = async () => {
      await read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    }
    const hit = expression => read(`(() => {const n=${expression};if(!n?.isConnected||!n.checkVisibility())throw Error('Missing visible connected control');
      const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,
      hits:[[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)))};})()`)
    const assertHit = geometry => assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.hits.length === 5 && geometry.hits.every(Boolean), 'Control has five actual CSS hits')
    const click = async expression => {
      const geometry = await hit(expression); assertHit(geometry)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: geometry.x, y: geometry.y })
      return geometry
    }
    const clear = async () => {
      const geometry = await click(node('[aria-label="Clear settings search"]'))
      await until(`${node('[aria-label="Search settings"]')}.value===""`)
      assert.equal(await read(`document.activeElement===${node('[aria-label="Search settings"]')}`), true, 'Clear restores the original search input focus')
      return geometry
    }
    await until('window.__settingsSearchRefinement?.ready')
    for (const width of [1480, 320]) {
      win.setContentSize(width, 900); await until(`innerWidth===${width}`); await settle()
      const searchHit = await click(node('[aria-label="Search settings"]'))
      for (const query of ['diagnostics', 'crash', 'log', 'recovery']) {
        const clearHit = query === 'diagnostics' ? null : await clear()
        win.webContents.insertText(query)
        await until(`${node('[aria-label="Search settings"]')}.value===${JSON.stringify(query)}`)
        await settle()
        const actual = await read(`(() => {
          const pane=document.querySelector('[data-settings-pane="general"]'),header=document.querySelector('.settings-content__header');
          const rect=n=>n?.getBoundingClientRect().toJSON(),text=n=>{if(!n?.isConnected||!n.checkVisibility()||!n.textContent.trim())return null;
            const range=document.createRange();range.selectNodeContents(n);return{text:n.textContent.trim(),lines:Array.from(range.getClientRects()).filter(r=>r.width>0&&r.height>0).map(r=>r.toJSON())}};
          return{query:document.querySelector('[aria-label="Search settings"]').value,nav:Array.from(document.querySelectorAll('nav[aria-label="Settings sections"] button')).map(n=>n.textContent),
            shownPanes:Array.from(document.querySelectorAll('[data-settings-pane]')).filter(n=>n.checkVisibility()&&!n.hidden&&!n.inert).map(n=>n.dataset.settingsPane),
            pane:rect(pane),header:rect(header),title:text(header.querySelector('h2')),description:text(header.querySelector('p')),
            facts:Array.from(pane.querySelectorAll('dl > div')).map(n=>({term:text(n.querySelector('dt')),body:text(n.querySelector('dd'))})),
            privacy:text(pane.querySelector('.settings-pane-actions > span')),buttons:Array.from(pane.querySelectorAll('button')).map(n=>({text:n.textContent,disabled:n.disabled,connected:n.isConnected,visible:n.checkVisibility(),rect:rect(n)})),
            status:rect(document.querySelector('.window-status-bar')),page:rect(document.querySelector('.settings-page'))};})()`)
        const image = `${width}-${query}.png`
        fs.writeFileSync(path.join(evidence, image), (await win.webContents.capturePage()).toPNG())
        result.frames.push({ width, query, actual, searchHit, clearHit, image })
        assert.deepEqual(actual.nav, ['General'], 'General search reaches the original controls')
        assert.deepEqual(actual.shownPanes, ['general'])
        assert.equal(actual.title.text, 'General'); assert.equal(actual.description.text, 'Local storage, session continuity, and diagnostics.')
        assert.deepEqual(actual.facts.map(fact => fact.term.text), ['Local data', 'Session recovery', 'System SSH'])
        assert.equal(actual.facts[1].body.text, 'Your tabs and layouts are restored when you return. Running agents stay available when the desktop window closes.')
        assert.equal(actual.facts[2].body.text, 'Remote AgentMux Runs are not supported yet. Connection metadata and key file paths stay on this machine; private key contents are never stored.')
        assert.equal(actual.privacy.text, 'Crashes are recorded to a local file and never uploaded.')
        assert.deepEqual(actual.buttons.map(button => button.text), ['Show crash log'])
        assert.equal(actual.buttons[0].disabled, false); assert.equal(actual.buttons[0].connected, true); assert.equal(actual.buttons[0].visible, true)
        assertHit(await hit(node('[data-settings-pane="general"] button')))
        const texts = [actual.title, actual.description, actual.privacy, ...actual.facts.flatMap(fact => [fact.term, fact.body])]
        assert.equal(texts.length, 9)
        for (const text of texts) {
          assert.ok(text.lines.length > 0, 'Complete visible text has a nonempty Range')
          const box = text === actual.title || text === actual.description ? actual.header : actual.pane
          for (const line of text.lines) assert.ok(line.x >= box.x - 1 && line.right <= box.right + 1 && line.y >= box.y - 1 && line.bottom <= box.bottom + 1, 'Complete General text is contained in its actual visible area')
        }
        assert.ok(actual.header.bottom <= actual.pane.y + 1)
        assert.equal(actual.status.height, 32); assert.ok(actual.page.bottom <= actual.status.y + 1)
        const count = await read('document.querySelectorAll(".window-status-bar button").length')
        assert.ok(count > 0)
        const footerHits = []
        for (let i = 0; i < count; i++) { const geometry = await hit(`document.querySelectorAll('.window-status-bar button')[${i}]`); assertHit(geometry); footerHits.push(geometry) }
        result.frames.at(-1).footerHits = footerHits
      }
      const clearHit = await clear(), close = await click(node('[aria-label="Close settings"]'))
      await until('!document.querySelector(".settings-page")')
      const reopen = await click(node('.window-status-bar [aria-label="Settings"]'))
      await until('document.querySelector(".settings-page")'); await settle()
      result.navigation.push({ width, clearHit, close, reopen })
    }
    result.events = await read('window.__settingsSearchRefinement.events')
    const inputs = result.events.filter(event => event.type === 'input' && event.label === 'Search settings')
    assert.equal(inputs.length, 8); assert.ok(inputs.every(event => event.trusted))
    for (const query of ['diagnostics', 'crash', 'log', 'recovery']) assert.equal(inputs.filter(event => event.value === query).length, 2)
    for (const [label, count] of [['Clear settings search', 8], ['Close settings', 2], ['Settings', 2]]) {
      const clicks = result.events.filter(event => event.type === 'click' && event.label?.trim() === label)
      assert.equal(clicks.length, count); assert.ok(clicks.every(event => event.trusted))
    }
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1)
  }
})
