const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.ok(section === 'agents' || section === 'hosts')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Executor Provider Preview')
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
const result = { completed: false, section, frames: [], interactions: [],
  boundary: 'Actual SettingsPanel/modules/Panes, original Preview config-edit/save and Store checks, full production CSS in an owned Renderer. Controlled 128 executors/24 Hosts; native Electron Renderer input and selection command. No registered Main durability, real SSH, physical compositor qualification, Runtime/Run, user App or installation claim.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1480, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html)
    const read = code => win.webContents.executeJavaScript(code)
    const until = async (code, label = code) => {
      const end = Date.now() + 6000
      do { if (await read(code)) return; await new Promise(resolve => setTimeout(resolve, 20)) } while (Date.now() < end)
      throw new Error('Renderer setup did not settle: ' + label)
    }
    const settle = () => read('Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    const pane = `[data-settings-pane="${section}"]`
    const target = section === 'agents' ? 'executor-001' : 'host-01'
    const nameSelector = pane + (section === 'agents' ? ' [data-executor-name]' : ' [data-host-name]')
    const factsOf = selector => `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)return null; const r=node.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return {connected:node.isConnected,visible:node.checkVisibility(),bounds:r.toJSON(),value:node.value,disabled:node.disabled,focused:document.activeElement===node,pseudoFocus:node.matches(':focus'),documentHasFocus:document.hasFocus(),cssHit:!!hit&&(hit===node||node.contains(hit)),x,y}; })()`
    async function click(selector) {
      await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`)
      await settle()
      const facts = await read(factsOf(selector))
      assert.ok(facts && facts.connected && facts.visible && facts.bounds.width > 0 && facts.bounds.height > 0, 'Actual connected visible target: ' + selector)
      assert.equal(facts.cssHit, true, 'Actual CSS hit is the exact target: ' + selector)
      assert.notEqual(facts.disabled, true, 'Target is operable: ' + selector)
      const before = await read('window.__resourceTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(facts.x), y: Math.round(facts.y) })
      await settle()
      const events = await read(`window.__resourceTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Actual native click creates a trusted Renderer event')
      result.interactions.push({ kind: 'native-renderer-click', selector, facts, events })
    }
    await until('window.resourceLibraryProof?.ready && document.querySelector(".settings-page")')
    await read(`window.__resourceTrustedEvents=[]; for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__resourceTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,code:event.code,keyCode:event.keyCode,target:event.target.closest?.('[data-resource-row]')?.dataset.resourceRow??event.target.tagName}),true)`)
    win.showInactive(); win.focus(); win.webContents.focus()
    await read(`window.resourceLibraryProof.select(${JSON.stringify(section)})`)
    await until(`document.querySelector(${JSON.stringify(pane)}) && !document.querySelector(${JSON.stringify(pane)}).hidden`)
    for (const width of [320, 640, 1480]) for (const theme of ['light', 'dark']) {
      await read('window.resourceLibraryProof.reset()')
      await read("window.resourceLibraryProof.reopen('agents')")
      await read(`window.resourceLibraryProof.theme(${JSON.stringify(theme)})`)
      win.setContentSize(width, 980)
      await until(`innerWidth===${width} && document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
      win.focus(); win.webContents.focus(); await until('document.hasFocus()')
      await settle()
      await click('.settings-providers-toggle')
      await until("document.querySelectorAll('[data-provider-entry]').length===13")
      async function capture(scene) {
        await settle()
        const facts = await read(`({ scene: ${JSON.stringify(scene)}, width:innerWidth, horizontal:document.documentElement.scrollWidth,
          entries:document.querySelectorAll('[data-provider-entry]').length, editor:document.querySelector('[data-resource-editor]')?.dataset.resourceEditor??null,
          error:document.querySelector('[role=alert]')?.textContent??null, errors:window.resourceLibraryProof.errors,
          save:!!document.querySelector('[data-settings-save-bar] button')?.checkVisibility(),close:!!document.querySelector('[aria-label="Close settings"]')?.checkVisibility() })`)
        assert.ok(facts.horizontal <= facts.width, 'Full production cascade keeps content inside this actual viewport')
        assert.equal(facts.save, true); assert.equal(facts.close, true); assert.deepEqual(facts.errors, [])
        const image = `${scene}-${width}-${theme}.png`, png = (await win.webContents.capturePage()).toPNG()
        fs.writeFileSync(path.join(evidence, image), png)
        result.frames.push({ section, scene, width, theme, image, pngPixels: { width:png.readUInt32BE(16),height:png.readUInt32BE(20) },facts })
      }
      await capture('catalog')
      await click('[data-provider-entry="claude"] button')
      const created = await read("document.querySelector('[data-resource-editor]').dataset.resourceEditor")
      assert.match(created, /^claude-[0-9a-f]{8}$/)
      const focus = await read(factsOf('[data-executor-name]'))
      assert.ok(focus.focused && focus.visible && focus.connected, 'Exact selected Provider creates a focused editor')
      await capture('created')
      await read("window.resourceLibraryProof.catalogMode('error');window.resourceLibraryProof.reopen('agents')")
      await until("document.querySelector('.settings-providers-toggle')&&!document.querySelector('[aria-label=\"Provider catalog\"]')")
      await click('.settings-pane-toolbar > .small-button:last-child')
      await until("document.querySelector('[role=alert]')?.textContent.includes('Runtime identity')")
      assert.equal(await read("document.querySelectorAll('[data-provider-entry]').length"), 0)
      await capture('error')
      const callsBefore = await read('window.resourceLibraryProof.calls.length')
      await read("window.resourceLibraryProof.catalogMode('ready')")
      await click('.settings-provider-catalog__header button:last-child')
      await until("document.querySelectorAll('[data-provider-entry]').length===13")
      const retryCalls = await read(`window.resourceLibraryProof.calls.slice(${callsBefore})`)
      assert.deepEqual(retryCalls.map(call=>call.kind), ['controlled-provider-read'], 'One explicit Retry only reads the original Provider API')
      await click('[data-provider-entry="claude"] button')
      const recovered = await read("document.querySelector('[data-resource-editor]').dataset.resourceEditor")
      assert.match(recovered, /^claude-[0-9a-f]{8}$/); assert.notEqual(recovered, created)
      assert.equal(await read("document.activeElement===document.querySelector('[data-executor-name]')"), true)
      const actualFields = await read("({provider:[...document.querySelectorAll('[data-resource-editor] select')].find(node=>node.closest('label')?.querySelector('span')?.textContent==='Provider')?.value,name:document.querySelector('[data-executor-name]').value})")
      assert.equal(actualFields.provider, 'claude')
      await click('[data-settings-save-bar] button')
      await until("document.querySelector('[data-settings-save-bar]')?.textContent.includes('Changes saved')")
      const saved = await read('window.resourceLibraryProof.current()')
      assert.equal(saved.executors[recovered].providerId, 'claude')
      assert.equal(saved.executors[recovered].command, 'claude')
      assert.equal(Object.keys(saved.executors).length, 129)
      result.interactions.push({kind:'actual-failure-retry-create-save',width,theme,created,recovered,focus,retryCalls,actualFields})
      await click('[aria-label="Close settings"]'); await until('!document.querySelector(".settings-page")')
    }
    assert.equal(result.frames.length, 18)
    result.completed = true

  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.failureObserved = await win.webContents.executeJavaScript('({errors:window.resourceLibraryProof?.errors,text:document.body.innerText.slice(0,2400),active:document.activeElement?.outerHTML,appearance:document.documentElement.dataset.appearance})').catch(() => null)
      fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
    }
  } finally {
    fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2))
    win?.destroy(); app.exit(result.completed ? 0 : 1)
  }
})
