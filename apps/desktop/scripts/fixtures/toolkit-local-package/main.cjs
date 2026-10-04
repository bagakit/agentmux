const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), { pathToFileURL } = require('node:url')
const { createHash, randomUUID } = require('node:crypto')
const { app, BrowserWindow, ipcMain, Menu } = require('electron')
const [html, ownerFile, preload, privateRoot, evidence, stage] = process.argv.slice(2)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const raw = { schema: 'agentmux.toolkit-local-package-ui.v1', stage, pid: process.pid, completed: false, frames: [], saves: [], inputs: [], errors: [], boundary: 'Real components/full CSS/local manifest and original ConfigOwner/Store. Private ordinary processes; no user App, query execution, Runtime or installation.' }
for (const key of ['home', 'userData', 'sessionData']) app.setPath(key, path.join(privateRoot, key))
app.on('window-all-closed', () => {})
let win
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
    const { ConfigStore, DEFAULT_CONFIG, ConfigOwner, executeToolkitConfig, prepareToolkitConfig, findToolkitTool, readToolkitPackageMetadata, captureToolkitPackage, AGENTMUX_CONTROL_SCHEMA_VERSION } = await import(pathToFileURL(ownerFile).href)
    const configPath = path.join(privateRoot, 'config.json'), packagePath = path.join(privateRoot, 'userData/toolkit/packages/auth')
    if (stage === 'control') {
      await fs.cp(path.resolve('apps/desktop/resources/toolkit/auth'), packagePath, { recursive: true, errorOnExist: true, force: false })
      // This is existing user configuration; fresh-start installation is qualified by auth-gate.
      await fs.writeFile(configPath, JSON.stringify({ ...structuredClone(DEFAULT_CONFIG), toolkit: { tools: [{ kind: 'package', id: 'auth', revision: 'fixture-config', packagePath, workspacePath: app.getPath('home'), enabled: true, statusBar: 'icon', args: ['codexL', '@active'] }] } }))
    }
    const store = new ConfigStore(configPath); let current = await store.get()
    const owner = new ConfigOwner({ read: () => current, prepare: (before, next) => prepareToolkitConfig(before, next, async () => {}), save: async next => { const saved = await store.save(next); raw.saves.push(saved.toolkit?.tools ?? []); return saved }, publish: next => { current = next; win.webContents.send('identity:config:changed', next) } })
    const edit = async (operation, toolId, input) => { const result = await executeToolkitConfig({ operation, toolId, schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), ...input }, owner); return 'definition' in result ? result.definition : result }
    ipcMain.handle('identity:config:get', () => owner.current)
    ipcMain.handle('identity:config:tool', (_event, id) => findToolkitTool(owner.current, id))
    ipcMain.handle('identity:config:add', (_event, id, value) => edit('toolkit.add', id, { value }))
    ipcMain.handle('identity:config:update', (_event, id, changes, expected) => edit('toolkit.update', id, { changes, expected }))
    ipcMain.handle('identity:config:remove', (_event, id, expected) => edit('toolkit.remove', id, { expected }))
    ipcMain.handle('identity:config:performance', (_event, performance, expected) => owner.edit({ ...owner.current, toolkit: { ...owner.current.toolkit, performance: expected } }, { ...owner.current, toolkit: { ...owner.current.toolkit, performance } }))
    ipcMain.handle('identity:toolkit:list', async () => [{ kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true }, ...await Promise.all((owner.current.toolkit?.tools ?? []).map(async tool => {
      if (tool.kind !== 'package') return { kind: 'script', toolId: tool.id, readonly: false, name: tool.name, icon: tool.icon, revision: tool.revision, enabled: tool.enabled, statusBar: tool.statusBar }
      const metadata = await readToolkitPackageMetadata(tool)
      return { kind: 'package', toolId: tool.id, readonly: false, configRevision: tool.revision, path: tool.packagePath, enabled: tool.enabled, statusBar: tool.statusBar, name: metadata.manifest.name, icon: metadata.icon, availability: 'available', reason: metadata.warning }
    }))])
    ipcMain.handle('identity:toolkit:script', async (_event, id) => { const { definition } = await captureToolkitPackage(findToolkitTool(owner.current, id)); return { toolId: id, path: path.join(definition.package.path, definition.package.entry), sha256: createHash('sha256').update(definition.script).digest('hex'), text: definition.script } })
    win = new BrowserWindow({ width: 1480, height: 1300, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })
    win.webContents.on('console-message', details => { if (details.level === 'error') raw.errors.push(details.message) })
    await win.loadFile(html); win.show(); win.focus()
    const read = code => win.webContents.executeJavaScript(code)
    const until = async code => { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (await read(code)) return; await pause(35) } throw Error('Scene condition timed out: ' + code) }
    const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const click = async selector => {
      await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`); await settle()
      const point = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||!n.checkVisibility())throw Error('Missing visible control');const b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),width:b.width,height:b.height}})()`)
      assert.ok(point.width > 0 && point.height > 0)
      assert.equal(await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),hit=document.elementFromPoint(${point.x},${point.y});return n===hit||n.contains(hit)})()`), true, 'Actual CSS target is hit')
      raw.inputs.push({ type: 'native-click', selector, ...point })
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await pause(60); await settle()
    }
    const button = async label => {
      assert.equal(await read(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.checkVisibility()&&n.textContent.trim()===${JSON.stringify(label)});if(!n)return false;n.setAttribute('data-native-button','current');return true})()`), true, 'Visible actual button: ' + label)
      await click('[data-native-button="current"]'); await read("document.querySelector('[data-native-button]')?.removeAttribute('data-native-button')")
    }
    const picture = async (file, width, theme, scene) => {
      win.setContentSize(width, 1300); await read(`window.identityScene.theme(${JSON.stringify(theme)});document.querySelector('[data-identity-viewport]').scrollTo(0,0)`); await settle(); await pause(150)
      const bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes)
      raw.frames.push({ file, width, height: 1300, theme, scene, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    await until('window.identityScene?.ready && !!document.querySelector("[data-tool-package]")')
    await until('document.querySelector("[data-tool-id=auth] strong")?.textContent !== "auth"')
    assert.deepEqual(await read('window.identityScene.executionCalls'), [])
    if (stage === 'restart') {
      const expected = JSON.parse(await fs.readFile(path.join(evidence, 'saved-package.json'), 'utf8'))
      assert.deepEqual(findToolkitTool(owner.current, expected.id), expected)
      await until('document.querySelector("[data-tool-id=auth] strong").textContent === "Workspace report"')
      const manifest = JSON.parse(await fs.readFile(path.join(packagePath, 'manifest.json'), 'utf8'))
      assert.equal(manifest.name, 'Workspace report')
      raw.restart = { sameId: true, allFields: true, executionCalls: await read('window.identityScene.executionCalls'), manifestPreserved: true }
    } else {
      assert.equal(await read('document.querySelector("[data-tool-id=auth] strong").textContent'), 'Auth')
      assert.deepEqual(await read('[...document.querySelectorAll(".toolkit-library__group")].map(n=>n.textContent)'), ['Custom', 'Built-in'])
      await click('[data-tool-id="auth"]')
      await picture('1480-dark-local-package.png', 1480, 'dark', 'ordinary Auth local extension')
      await button('View entry script'); await until(`!!document.querySelector('[aria-label="Current local entry script"]')`)
      await picture('1480-light-package-files.png', 1480, 'light', 'source belongs to editable directory')
      await click('.toolkit-editor__arguments > summary')
      await click('.toolkit-argument input'); win.webContents.selectAll(); await pause(30)
      assert.equal(await read('(()=>{const n=document.querySelector(".toolkit-argument input");return document.activeElement===n&&n.selectionStart===0&&n.selectionEnd===n.value.length})()'), true)
      await win.webContents.insertText('custom-reader'); await button('Save preferences')
      await until('document.querySelector(".toolkit-editor__status").textContent==="Saved"')
      const saved = findToolkitTool(owner.current, 'auth'); assert.equal(saved.args[0], 'custom-reader'); assert.equal('script' in saved, false)
      await fs.writeFile(path.join(evidence, 'saved-package.json'), JSON.stringify(saved, null, 2)+'\n')
      win.setContentSize(640, 1300); await until(`window.innerWidth===640 && document.querySelector('[data-tool-package] .toolkit-editor__back')?.checkVisibility()`); await button('Back to tools')
      await picture('640-light-tool-library.png', 640, 'light', 'Custom and Built-in peers')
      await click('[data-tool-id="auth"]'); await picture('320-dark-local-package.png', 320, 'dark', 'narrow local extension detail')
      const manifestPath = path.join(packagePath, 'manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: 'Workspace report', icon: 'zap' }))
      await fs.writeFile(path.join(packagePath, manifest.entry), "console.log('Independent user package')\n")
      win.setContentSize(1480, 1300); await settle(); await button('Refresh files')
      await until('document.querySelector("[data-tool-id=auth] strong").textContent==="Workspace report"')
      await button('View entry script')
      await until(`document.querySelector('[aria-label="Current local entry script"]').value.includes('Independent user package')`)
      await picture('1480-dark-repurposed-package.png', 1480, 'dark', 'unrelated content comes from edited files')
      await click('[data-tool-id="performance"]'); await picture('640-dark-built-in.png', 640, 'dark', 'Performance same layer, source read only')
      await read('window.identityScene.active(false)'); await settle()
      assert.equal(await read(`!!document.querySelector('[aria-label="Current local entry script"]')`), false)
      assert.deepEqual(await read('window.identityScene.executionCalls'), [])
      raw.trustedEvents = await read('window.identityScene.events'); assert.ok(raw.trustedEvents.some(event => event.trusted && event.type === 'click'))
    }
    raw.completed = true
  } catch (cause) { raw.errorName = cause.name; raw.failure = String(cause.stack ?? cause) }
  finally { await fs.writeFile(path.join(evidence, stage + '-scene.json'), JSON.stringify(raw, null, 2)+'\n'); win?.destroy(); app.exit(raw.completed ? 0 : 1) }
})
