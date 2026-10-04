const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const [html, ownerFile, preload, privateRoot, evidence, stage, mode = 'capture'] = process.argv.slice(2)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const bounded = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Private GUI observation deadline: ' + label)), 20_000)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})
const raw = { schema: 'agentmux.toolkit-visual-craft-scene.v1', stage, mode, pid: process.pid, completed: false, frames: [], saves: [], inputs: [], errors: [],
  boundary: 'Finite real Toolkit Settings/Monaco/result components and ConfigStore/ConfigOwner configuration only. Private IPC registration; controlled synthetic result DTO. No script execution, Core Runtime, real CLI, Session/Run restoration, user App or installation.' }
for (const key of ['home', 'userData', 'sessionData']) app.setPath(key, path.join(privateRoot, key))
app.on('window-all-closed', () => {})
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
    const { ConfigStore, ConfigOwner, executeToolkitConfig, prepareToolkitConfig, findToolkitTool, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(ownerFile).href)
    const configPath = path.join(privateRoot, 'config.json'), store = new ConfigStore(configPath)
    let current = await store.get()
    const owner = new ConfigOwner({ read: () => current, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}),
      save: async next => { const saved = await store.save(next); raw.saves.push({ definitions: saved.toolkit?.tools ?? [] }); return saved },
      publish: next => { current = next; win.webContents.send('identity:config:changed', next) } })
    const edit = async (operation, toolId, input) => {
      const result = await executeToolkitConfig({ operation, toolId, schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), ...input }, owner)
      return 'definition' in result ? result.definition : result
    }
    ipcMain.handle('identity:config:get', () => owner.current)
    ipcMain.handle('identity:config:tool', (_event, id) => findToolkitTool(owner.current, id))
    ipcMain.handle('identity:config:add', (_event, id, value) => edit('toolkit.add', id, { value }))
    ipcMain.handle('identity:config:update', (_event, id, changes, expected) => edit('toolkit.update', id, { changes, expected }))
    ipcMain.handle('identity:config:remove', (_event, id, expected) => edit('toolkit.remove', id, { expected }))
    ipcMain.handle('identity:config:performance', (_event, performance, expected) => owner.edit(
      { ...owner.current, toolkit: { ...owner.current.toolkit, performance: expected } },
      { ...owner.current, toolkit: { ...owner.current.toolkit, performance } }))
    win = new BrowserWindow({ width: 1480, height: 980, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    win.webContents.on('console-message', details => { if (details.level === 'error') raw.errors.push(details.message) })
    console.log('private-scene=load'); await bounded(win.loadFile(html), 'load'); win.show(); win.focus()
    const read = code => bounded(win.webContents.executeJavaScript(code), code)
    const until = async code => { const deadline = Date.now() + 12_000; while (Date.now() < deadline) { if (await read(code)) return; await pause(30) } throw Error('Scene condition timed out: ' + code) }
    const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await until('window.identityScene?.ready && !!document.querySelector(".toolkit-workbench")')
    raw.ancestry = await read('(()=>{const n=document.querySelector(".toolkit-workbench");return !!(n?.isConnected&&n.closest(".settings-page")?.isConnected)})()')
    assert.equal(raw.ancestry, true, 'Connected real pane consumes the production settings-page scope')
    console.log('private-scene=ready')
    const click = async selector => {
      app.focus({ steal: true }); win.moveTop()
      win.focus(); win.webContents.focus()
      await until('document.hasFocus()')
      const facts = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing real control');n.scrollIntoView({block:'center',inline:'nearest'});const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),width:b.width,height:b.height}})()`)
      await settle(); assert.ok(facts.width > 0 && facts.height > 0, 'Connected visible control geometry')
      assert.equal(await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${facts.x},${facts.y});return n===hit||n.contains(hit)})()`), true, 'Exact actual CSS hit target')
      raw.inputs.push({ type: 'native-click', selector, ...facts })
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: facts.x, y: facts.y, button: 'left', clickCount: 1 })
      await pause(40); await settle()
    }
    const button = async label => {
      const index = await read(`Array.from(document.querySelectorAll('button')).findIndex(n=>n.textContent.trim()===${JSON.stringify(label)})`)
      assert.ok(index >= 0, 'Actual button is present: ' + label)
      await read(`document.querySelectorAll('button')[${index}].setAttribute('data-identity-native-button','current')`)
      await click('[data-identity-native-button="current"]'); await read(`document.querySelector('[data-identity-native-button="current"]')?.removeAttribute('data-identity-native-button')`)
    }
    const key = async (keyCode, modifiers = []) => { raw.inputs.push({ type: 'native-key', keyCode, modifiers }); for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers }); await pause(30) }
    const text = async (selector, value) => {
      await click(selector)
      assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true, 'Native click focuses the exact input')
      await key('A', ['meta'])
      if (!await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return n.selectionStart===0&&n.selectionEnd===n.value.length})()`)) {
        raw.inputs.push({ type: 'native-select-all-command', selector, boundary: 'The trusted Command+A shortcut did not select this input; use the ordinary webContents native Edit command, not a keyboard-pass claim.' })
        win.webContents.selectAll(); await pause(40)
      }
      await until(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return document.activeElement===n&&n.selectionStart===0&&n.selectionEnd===n.value.length})()`)
      raw.inputs.push({ type: 'native-replacement', selector, selection: await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return{start:n.selectionStart,end:n.selectionEnd,length:n.value.length}})()`), boundary: 'Verified native Edit selection preparation and trusted whole-value insertion; not a shortcut or character-by-character typing qualification.' })
      await win.webContents.insertText(value)
      await until(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`)
    }
    const script = async value => {
      await until('document.querySelector(".monaco-editor .view-lines")?.isConnected')
      await click('.monaco-editor .view-lines')
      await until('window.identityScene.scriptFocused()')
      await key('A', ['meta']); await win.webContents.insertText(value)
      await until(`window.identityScene.scriptValue().then(value=>value===${JSON.stringify(value)})`)
    }
    const picture = async (file, width, theme, scene) => {
      const height = scene === 'repurposed-custom-editor' ? 1280 : 980
      win.setContentSize(width, height); await read(`window.identityScene.theme(${JSON.stringify(theme)});document.querySelector('[data-identity-viewport]').scrollTo(0,0)`); await settle(); await pause(120)
      const appearance = await read('({dataset:document.documentElement.dataset.appearance,colorScheme:getComputedStyle(document.documentElement).colorScheme,editor:document.querySelector(".monaco-editor")?.className??null})')
      assert.equal(appearance.dataset, theme); assert.equal(appearance.colorScheme, theme)
      if (appearance.editor) assert.ok(appearance.editor.split(' ').includes(theme === 'light' ? 'vs' : 'vs-dark'), 'Actual selected Monaco uses the same product appearance')
      if (scene === 'custom-empty') { await checks.leading('.toolkit-workbench__empty > .toolkit-workbench__create', 'wide-empty:leading'); await checks.hierarchy('wide-empty') }
      if (scene === 'blank-custom-draft') { for (const t of ['light', 'dark']) await checks.palette('custom', t); await read(`window.identityScene.theme(${JSON.stringify(theme)})`); await settle() }
      if (scene === 'official-performance-readonly') { for (const t of ['light', 'dark']) await checks.palette('builtin', t); await read(`window.identityScene.theme(${JSON.stringify(theme)})`); await settle() }
      const actualCSS = await read('({width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio,documentWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,documentFocused:document.hasFocus()})')
      const contentSize = win.getContentSize()
      assert.equal(actualCSS.width, contentSize[0]); assert.equal(actualCSS.height, contentSize[1])
      assert.ok(actualCSS.scrollWidth <= actualCSS.documentWidth, 'No horizontal document clipping')
      const image = await win.webContents.capturePage(), bytes = image.toPNG(); assert.ok(bytes.length)
      const imageSize = image.getSize(); assert.ok(imageSize.width > 0 && imageSize.height > 0)
      await fs.writeFile(path.join(evidence, file), bytes)
      const pngPixels = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      raw.frames.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), requested: { width, height }, actualCSS, windowFocused: win.isFocused(), contentSize: { width: contentSize[0], height: contentSize[1] }, nativeImagePoints: imageSize, imageSize, imageScaleFactors: image.getScaleFactors(), pngPixels, pngPixelsPerCSSPixel: { x: pngPixels.width / actualCSS.width, y: pngPixels.height / actualCSS.height }, theme, scene, appearance, boundary: 'Static appearance; this PNG does not qualify native focus.' })
    }
    win.webContents.debugger.attach('1.3')
    const hover = async (point, selector) => {
      const previous = await read('window.craftHoverEvents.length')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'mouse', buttons: 0, ...point })
      if (selector) {
        await until(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`)
        const events = await read(`window.craftHoverEvents.slice(${previous})`)
        assert.ok(events.some(event => event.trusted && event.nameInput && event.x === point.x && event.y === point.y), 'CDP hover produced an actual trusted Renderer event at the exact name input')
        raw.inputs.push({ type: 'chromium-cdp-hover', ...point, events, boundary: 'Trusted Renderer input only; not physical compositor or platform pointer qualification.' })
      }
    }
    const checks = require('./checks.cjs')({ read, click, button, text, settle, win, raw, until, hover })
    if (mode !== 'capture') { console.log('private-scene=owning-' + mode); await checks.owning(mode) }
    else if (stage === 'restart') {
      const expected = JSON.parse(await fs.readFile(path.join(evidence, 'saved-custom.json'), 'utf8'))
      assert.deepEqual(findToolkitTool(owner.current, expected.id), expected)
      await until(`document.querySelector('[data-tool-editor]')?.dataset.toolEditor===${JSON.stringify(expected.id)}`)
      await until('window.identityScene.models().then(models=>models.length===1)')
      await until(`window.identityScene.scriptValue().then(value=>value===${JSON.stringify(expected.script)})`)
      assert.equal(await read('document.querySelector(".toolkit-editor__name input").value'), expected.name)
      assert.deepEqual(await store.get(), owner.current)
      raw.restart = { sameId: true, allFields: true, definition: findToolkitTool(owner.current, expected.id), actualConfigStoreReadback: true, executionCalls: await read('window.identityScene.executionCalls') }
      assert.deepEqual(raw.restart.executionCalls, [])
    } else {
      assert.deepEqual(owner.current.toolkit?.tools ?? [], [])
      await picture('1480-dark-custom-empty.png', 1480, 'dark', 'custom-empty')
      win.setContentSize(320, 980); await button('New custom tool')
      await until('window.identityScene.models().then(models=>models.length===1)')
      assert.equal(await read('document.activeElement===document.querySelector(".toolkit-editor__name input")'), true)
      await picture('320-light-custom-create.png', 320, 'light', 'blank-custom-draft')
      await button('Cancel new tool'); await until('window.identityScene.models().then(models=>models.length===0)')
      assert.deepEqual(owner.current.toolkit?.tools ?? [], [])
      win.setContentSize(640, 980); await button('Starting points')
      await picture('640-dark-starting-point.png', 640, 'dark', 'optional-starting-point')
      assert.deepEqual(await read('window.identityScene.models()'), [])
      await button('Use this starting point'); await until('window.identityScene.models().then(models=>models.length===1)')
      const id = await read('document.querySelector("[data-tool-editor]").dataset.toolEditor')
      assert.ok(id.startsWith('tool-'))
      await text('.toolkit-editor__name input', 'Workspace summary')
      await click('.toolkit-icon-picker > summary'); await click('.toolkit-icon-picker label:has(input[value="zap"])'); await key('Escape')
      await script("console.log('Workspace summary')\n")
      const work = path.join(privateRoot, 'workspace'); await fs.mkdir(work)
      await text('.toolkit-editor__fields input:not([type])', work)
      if (!await read('document.querySelector(".toolkit-editor__arguments").open')) await click('.toolkit-editor__arguments > summary')
      await text('.toolkit-argument:nth-of-type(1) input', '--project'); await text('.toolkit-argument:nth-of-type(2) input', 'current')
      await click('.toolkit-editor__result-actions > summary'); await button('Add action')
      await text('.toolkit-editor__action-heading input', 'Open report'); await script("console.log('Report ready')\n")
      if (!await read('document.querySelector(".toolkit-editor__arguments").open')) await click('.toolkit-editor__arguments > summary')
      await button('Add argument'); await text('.toolkit-argument input', 'report.md')
      await button('Main script'); await button('Save tool')
      await until('document.querySelector(".toolkit-editor__status").textContent==="Saved"')
      const saved = findToolkitTool(owner.current, id)
      assert.deepEqual(saved, { id, revision: saved.revision, name: 'Workspace summary', icon: 'zap', enabled: false, statusBar: 'icon', workspacePath: work, script: "console.log('Workspace summary')\n", args: ['--project', 'current'], actions: [{ id: saved.actions[0].id, label: 'Open report', script: "console.log('Report ready')\n", args: ['report.md'] }] })
      assert.deepEqual(await read(`window.identityProof.readTool(${JSON.stringify(id)})`), saved, 'Actual typed owner/current readback, not built CLI')
      await fs.writeFile(path.join(evidence, 'saved-custom.json'), JSON.stringify(saved, null, 2) + '\n')
      await picture('1480-light-custom-editor.png', 1480, 'light', 'repurposed-custom-editor')
      await read(`window.identityScene.result(${JSON.stringify(saved)})`); await until('window.identityScene.models().then(models=>models.length===0)')
      assert.equal(await read('document.querySelector(".toolkit-result__identity small").textContent'), 'Custom tool')
      await picture('320-dark-custom-result.png', 320, 'dark', 'controlled-result-custom-identity')
      await button('Configure'); await until(`document.querySelector('[data-tool-editor]')?.dataset.toolEditor===${JSON.stringify(id)}`)
      assert.deepEqual(await read('window.identityScene.configureTargets'), [id])
      await read('window.identityScene.navigate("performance")'); await until('document.querySelector(".toolkit-settings__identity")?.checkVisibility()')
      assert.deepEqual(await read('window.identityScene.models()'), [])
      await picture('640-light-builtin.png', 640, 'light', 'official-performance-readonly')
      assert.deepEqual(await read('window.identityScene.executionCalls'), [])
      const events = await read('window.identityScene.events'); assert.ok(events.some(event => event.type === 'click' && event.trusted)); assert.ok(events.some(event => event.type === 'input' && event.trusted))
      raw.trustedEvents = events; raw.definition = saved; raw.actualConfigStoreReadback = true
      await read('window.identityScene.active(false)'); await settle()
      assert.deepEqual(await read('window.identityScene.models()'), []); assert.equal(await read('window.identityScene.readers()'), 0)
    }
    raw.completed = true; console.log('private-scene=completed'); await fs.writeFile(path.join(evidence, stage + '-scene.json'), JSON.stringify(raw, null, 2) + '\n')
    win.close(); app.quit()
  } catch (error) {
    if (win && !win.isDestroyed()) raw.failureObservation = await bounded(win.webContents.executeJavaScript('({active:document.activeElement?.outerHTML,name:document.querySelector(".toolkit-editor__name input")?.value,events:window.identityScene?.events,executionCalls:window.identityScene?.executionCalls})'), 'failure-readback').catch(() => null)
    raw.errorName = error?.name; raw.failure = String(error?.stack ?? error); await fs.writeFile(path.join(evidence, stage + '-scene.json'), JSON.stringify(raw, null, 2) + '\n')
    console.error('file_editing_probe_failed=' + raw.failure); app.exit(1)
  }
})
