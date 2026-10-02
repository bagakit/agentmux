const { fixturePath: _hygiene_fixturePath } = require("../../lib/fixture-values.mjs")
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu } = require('electron')
const [html, privateRoot, evidence, section] = process.argv.slice(2)
assert.ok(section === 'agents' || section === 'hosts')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
app.setName('Owned Settings Resource Preview')
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
    const press = async key => {
      const before = await read('window.__resourceTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      if (key === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
      await settle()
      const expected = key === 'Down' ? 'ArrowDown' : key
      const events = await read(`window.__resourceTrustedEvents.slice(${before})`)
      assert.ok(events.some(event => event.type === 'keydown' && event.key === expected && event.trusted), 'Actual native key reaches the Renderer with its exact DOM key')
      if (key === 'Enter') assert.ok(events.some(event => event.type === 'click' && event.trusted), 'Complete native Enter sequence activates the original button')
      result.interactions.push({ kind: 'native-renderer-key', electronKey: key, expectedDOMKey: expected, events })
    }
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
    async function type(selector, value) {
      await click(selector)
      await until(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, 'Exact input focus')
      win.webContents.selectAll()
      await until(`(() => {const n=document.querySelector(${JSON.stringify(selector)});return n.selectionStart===0&&n.selectionEnd===n.value.length})()`, 'Native Edit selectAll prepares the entire actual value')
      const beforeInsert = await read('window.__resourceTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, 'Actual input value after native insertText')
      const events = await read(`window.__resourceTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native text entry creates a trusted input event')
      result.interactions.push({ kind: 'native-edit-selectAll-and-insertText', selector, value, events })
    }
    async function typeField(label, value) {
      const index = await read(`(() => {const nodes=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] input,' + pane + ' [data-resource-editor] textarea')})];const input=[...document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-editor] label')})].find(n=>n.querySelector('span')?.textContent?.startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea');return nodes.indexOf(input)})()`)
      assert.ok(index >= 0, 'Actual editor field exists: ' + label)
      const selector = `${pane} [data-resource-editor] :is(input,textarea)`
      await read(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].scrollIntoView({block:'nearest'})`)
      await settle()
      const position = await read(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}],r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,visible:n.checkVisibility(),hit:n.contains(document.elementFromPoint(x,y)),connected:n.isConnected}})()`)
      assert.ok(position.connected && position.visible && position.hit, 'Actual exact field hit: ' + label)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(position.x), y: Math.round(position.y) })
      await until(`document.activeElement===document.querySelectorAll(${JSON.stringify(selector)})[${index}]`)
      win.webContents.selectAll(); await until(`(() => {const n=document.querySelectorAll(${JSON.stringify(selector)})[${index}];return n.selectionStart===0&&n.selectionEnd===n.value.length})()`)
      const beforeInsert = await read('window.__resourceTrustedEvents.length')
      await win.webContents.insertText(value)
      await until(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].value===${JSON.stringify(value)}`)
      const events = await read(`window.__resourceTrustedEvents.slice(${beforeInsert})`)
      assert.ok(events.some(event => event.type === 'input' && event.trusted), 'Actual native field entry creates a trusted input event')
      result.interactions.push({ kind: 'native-edit-selectAll-and-insertText', field: label, value, position, events })
    }
    await until('window.resourceLibraryProof?.ready && document.querySelector(".settings-page")')
    await read(`window.__resourceTrustedEvents=[]; for(const type of ['click','keydown','keypress','keyup','input'])document.addEventListener(type,event=>window.__resourceTrustedEvents.push({type,trusted:event.isTrusted,key:event.key,code:event.code,keyCode:event.keyCode,target:event.target.closest?.('[data-resource-row]')?.dataset.resourceRow??event.target.tagName}),true)`)
    win.showInactive(); win.focus(); win.webContents.focus()
    await read(`window.resourceLibraryProof.select(${JSON.stringify(section)})`)
    await until(`document.querySelector(${JSON.stringify(pane)}) && !document.querySelector(${JSON.stringify(pane)}).hidden`)
    for (const width of [320, 640, 1480]) for (const theme of ['light', 'dark']) {
      await read('window.resourceLibraryProof.reset()')
      await read(`window.resourceLibraryProof.reopen(${JSON.stringify(section)})`)
      await until(`document.querySelector(${JSON.stringify(pane + ' [data-resource-row="' + target + '"]')})`)
      await read(`window.resourceLibraryProof.theme(${JSON.stringify(theme)})`)
      win.setContentSize(width, 980)
      await until(`innerWidth===${width} && document.documentElement.dataset.appearance===${JSON.stringify(theme)}`)
      win.focus(); win.webContents.focus()
      await until('document.hasFocus()', 'Actual owned Renderer has native focus before input')
      await settle()
      if (width === 320 && theme === 'light') {
        const first = section === 'agents' ? 'executor-001' : 'local', second = section === 'agents' ? 'executor-002' : 'host-01'
        await read(`document.querySelector(${JSON.stringify(pane + ' [data-resource-row="' + first + '"]')}).focus()`)
        await press('Down')
        const keyboard = await read(`({focus:document.activeElement?.dataset.resourceRow,selected:document.querySelector(${JSON.stringify(pane + ' [data-resource-row="' + first + '"]')}).getAttribute('aria-selected'),tab:document.activeElement?.tabIndex})`)
        assert.deepEqual(keyboard, { focus: second, selected: 'true', tab: 0 }, 'Actual native arrow moves the manual-selection tab stop without opening an editor')
        await press('Enter')
        await until(`document.querySelector(${JSON.stringify(nameSelector)})?.checkVisibility() && document.activeElement===document.querySelector(${JSON.stringify(nameSelector)})`)
        result.interactions.push({ kind: 'native-renderer-keyboard-manual-selection', keys: ['ArrowDown', 'Enter'], keyboard, target: second })
        await click(`${pane} .settings-resource-back`)
        await click(`${pane} .settings-pane-toolbar > .small-button`)
        const created = await read(`document.querySelector(${JSON.stringify(pane + ' [data-resource-editor]')}).dataset.resourceEditor`)
        const createdFocus = await read(factsOf(nameSelector))
        assert.ok(createdFocus.focused && createdFocus.connected && createdFocus.visible, 'New resource focuses its exact connected visible Name')
        assert.notEqual(created, target)
        assert.equal(await read(`(() => {const n=document.querySelector(${JSON.stringify(nameSelector)});return n.selectionStart===0&&n.selectionEnd===n.value.length})()`), true)
        result.interactions.push({ kind: 'native-renderer-create', created, createdFocus })
        if (section === 'agents') await click(`${pane} .settings-executor-remove button`)
        else {
          await click(`${pane} [data-resource-editor] .icon-button--danger`)
          await until('document.querySelector("[role=dialog]")')
          assert.ok((await read('document.querySelector("[role=dialog]").textContent')).includes('0 linked workspace registrations'))
          await click('[data-confirm-label="Remove Host"]')
          await until('!document.querySelector("[role=dialog]")')
        }
        await until(`document.querySelectorAll(${JSON.stringify(pane + ' [data-resource-row]')}).length===${section === 'agents' ? 128 : 24}`)
      }
      await click(`${pane} [data-resource-row="${target}"]`)
      await until(`document.querySelector(${JSON.stringify(nameSelector)})?.checkVisibility()`)
      const selectedFocus = await read(factsOf(nameSelector))
      assert.equal(selectedFocus.focused, true, 'Selected resource moves focus to its accurate visible Name')
      assert.equal(selectedFocus.pseudoFocus, true); assert.equal(selectedFocus.documentHasFocus, true)
      assert.equal(selectedFocus.connected, true)
      if (section === 'agents') {
        await type(nameSelector, 'Workspace review')
        await click(`${pane} .settings-launch-config > summary`)
        await until(`document.querySelector(${JSON.stringify(pane + ' .settings-launch-config')}).open`)
        await typeField('Arguments', '--model "literal updated"')
        await typeField('Environment', '{"LITERAL":"$HOME"}')
      } else {
        await type(nameSelector, 'Remote workspace')
        await typeField('Host or SSH alias', 'development-alias')
        await click(`${pane} .host-edit-disclosure > summary`)
        await until(`document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open`)
        const input = await read(`document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure input')}).value`)
        await typeField('User', input + '-authored')
        const field = `${pane} .host-edit-disclosure input`
        await read(`window.__resourcePerCharacterInput=document.querySelector(${JSON.stringify(field)})`)
        await click(field)
        for (const char of ['x', 'y', 'z']) {
          await win.webContents.insertText(char)
          const facts = await read(`({same:document.querySelector(${JSON.stringify(field)})===window.__resourcePerCharacterInput,connected:window.__resourcePerCharacterInput.isConnected,visible:window.__resourcePerCharacterInput.checkVisibility(),focused:document.activeElement===window.__resourcePerCharacterInput,open:document.querySelector(${JSON.stringify(pane + ' .host-edit-disclosure')}).open})`)
          assert.deepEqual(facts, { same: true, connected: true, visible: true, focused: true, open: true }, 'Each advanced input character retains the same visible focused field')
          result.interactions.push({ kind: 'native-insertText-character', char, facts })
        }
        await click(`${pane} [data-resource-editor] header .small-button`)
        await until(`document.querySelector(${JSON.stringify(pane + ' .host-check-detail')})?.textContent.includes('Original diagnostic')`)
      }
      const beforeSave = await read(`document.querySelector(${JSON.stringify(pane + ' [data-settings-save-bar] button')}).disabled`)
      assert.equal(beforeSave, false, 'Actual Save is enabled by a real authored draft')
      await click(`${pane} [data-settings-save-bar] button`)
      await until(`document.querySelector(${JSON.stringify(pane + ' [data-settings-save-bar] button')}).disabled`)
      const saved = await read('window.resourceLibraryProof.current()')
      if (section === 'agents') {
        assert.equal(saved.executors[target].label, 'Workspace review'); assert.deepEqual(saved.executors[target].args, ['--model', 'literal updated'])
        assert.deepEqual(saved.executors[target].env, { LITERAL: '$HOME' })
      } else {
        const host = saved.hosts.find(host => host.id === target)
        assert.equal(host.label, 'Remote workspace'); assert.equal(host.hostname, 'development-alias')
        assert.equal(host.runtimeId, 'controlled-bound-runtime'); assert.equal(host.remoteSocketPath, _hygiene_fixturePath("srv/literal.sock"))
        if (width === 320 && theme === 'light') {
          await click(`${pane} [data-resource-editor] .icon-button--danger`)
          await until('document.querySelector("[role=dialog]")')
          const confirmation = await read(`(() => {const dialog=document.querySelector('[role=dialog]'),r=dialog.getBoundingClientRect();return {text:dialog.textContent,bounds:r.toJSON(),buttons:[...dialog.querySelectorAll('button')].map(n=>({text:n.textContent,bounds:n.getBoundingClientRect().toJSON(),visible:n.checkVisibility()}))}})()`)
          assert.ok(confirmation.text.includes('2 linked workspace registrations'), 'Original Host removal discloses every affected workspace')
          assert.ok(confirmation.bounds.left >= -.5 && confirmation.bounds.right <= width + .5, 'Actual confirmation fits the narrow viewport')
          assert.ok(confirmation.buttons.every(button => button.visible && button.bounds.left >= -.5 && button.bounds.right <= width + .5))
          result.interactions.push({ kind: 'native-renderer-original-host-confirmation', confirmation })
          await click('.confirmation-dialog__cancel')
          await until('!document.querySelector("[role=dialog]")')
          assert.equal((await read('window.resourceLibraryProof.current()')).hosts.some(host => host.id === target), true, 'Cancel preserves the original controlled saved Host')
        }
      }
      if (width < 720) {
        await click(`${pane} .settings-resource-back`)
        const row = `${pane} [data-resource-row="${target}"]`
        const back = await read(factsOf(row)); assert.equal(back.focused, true, 'Narrow Back returns focus to the accurate connected resource row')
        assert.equal(back.visible, true)
        await click(row)
      }
      await read(`document.querySelector(${JSON.stringify(pane + ' .settings-resource-editor')}).scrollTop=0`)
      await settle()
      const facts = await read(`(() => {
        const pane=document.querySelector(${JSON.stringify(pane)}),rect=n=>n.getBoundingClientRect().toJSON(),visible=n=>n.isConnected&&n.checkVisibility();
        const editors=[...pane.querySelectorAll('[data-resource-editor]')],rows=[...pane.querySelectorAll('[data-resource-row]')];
        const workbench=pane.querySelector('.settings-resource-workbench'),library=pane.querySelector('.settings-resource-library'),editor=pane.querySelector('.settings-resource-editor');
        const controls=[...pane.querySelectorAll('button,input,select,textarea,summary')].filter(visible);
        const close=document.querySelector('[aria-label="Close settings"]'),save=pane.querySelector('[data-settings-save-bar] button');
        return { theme:document.documentElement.dataset.appearance,colorScheme:getComputedStyle(document.documentElement).colorScheme,
          viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},settingsAncestor:!!pane.closest('.settings-page'),documentHasFocus:document.hasFocus(),
          pane:{bounds:rect(pane),clientWidth:pane.clientWidth,scrollWidth:pane.scrollWidth,clientHeight:pane.clientHeight},
          library:{visible:visible(library),bounds:rect(library)},editor:{visible:visible(editor),bounds:rect(editor)},view:workbench.dataset.resourceView,
          statusText:visible(library)?rows.flatMap(row=>{const status=row.querySelector('.settings-resource-row__check');if(!status||!status.textContent.trim())return [];const range=document.createRange();range.selectNodeContents(status);return [{text:status.textContent.trim(),bounds:range.getBoundingClientRect().toJSON(),rowBounds:rect(row),statusBounds:rect(status)}]}):[],
          editors:editors.map(n=>({id:n.dataset.resourceEditor,bounds:rect(n)})),rows:{mounted:rows.length,visible:rows.filter(visible).length},
          fields:pane.querySelectorAll('.agent-settings-fields input,.agent-settings-fields textarea,.agent-settings-fields select,.host-edit-grid input').length,
          close:{connected:close.isConnected,visible:visible(close),bounds:rect(close)},save:{disabled:save.disabled,visible:visible(save),bounds:rect(save)},
          clippedControls:controls.filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&(r.left<-.5||r.right>innerWidth+.5)}).map(n=>({tag:n.tagName,text:n.textContent?.slice(0,60),bounds:rect(n)})),
          errors:window.resourceLibraryProof.errors.slice(),calls:window.resourceLibraryProof.calls.slice(),sessions:0};
      })()`)
      assert.equal(facts.settingsAncestor, true); assert.equal(facts.theme, theme); assert.equal(facts.colorScheme, theme)
      assert.equal(facts.rows.mounted, section === 'agents' ? 128 : 24)
      assert.deepEqual(facts.editors.map(n => n.id), [target], 'Only the accurate current editor is mounted')
      assert.equal(facts.editor.visible, true); assert.equal(facts.library.visible, width === 1480)
      assert.equal(facts.close.visible, true); assert.equal(facts.save.visible, true)
      if (section === 'agents' && facts.library.visible) assert.ok(facts.statusText.length > 0, 'Actual nonempty library status text painted')
      assert.ok(facts.statusText.every(status => status.bounds.left >= status.rowBounds.left - .5 && status.bounds.right <= status.rowBounds.right + .5), 'Every actual library status text Range fits its row without clipping')
      assert.deepEqual(facts.clippedControls, [], 'Complete resource controls are not horizontally cropped')
      assert.deepEqual(facts.errors, [])
      const image = `${section}-${width}-${theme}.png`, png = (await win.webContents.capturePage()).toPNG()
      fs.writeFileSync(path.join(evidence, image), png)
      result.frames.push({ section, width, theme, image, requestedContentSize: { width, height: 980 }, actualContentSize: win.getContentSize(),
        pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, facts })
      await click('[aria-label="Close settings"]')
      await until('!document.querySelector(".settings-page")')
      assert.equal(await read('document.querySelectorAll("[data-resource-editor]").length'), 0, 'Production Close unmounts the private SettingsPanel only')
    }
    assert.equal(result.frames.length, 6)
    assert.equal(await read('window.resourceLibraryProof.closeCount'), 6)
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
