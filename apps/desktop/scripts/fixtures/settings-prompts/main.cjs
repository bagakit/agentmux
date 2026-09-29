const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, ownerBundle, privateRoot, evidence, mode] = process.argv.slice(2)
for (const key of ['home', 'userData', 'sessionData']) {
  const directory = path.join(privateRoot, key)
  fs.mkdirSync(directory, { recursive: true }); app.setPath(key, directory)
}
const result = { pid: process.pid, mode, captureOnly: true, aestheticReview: 'not-performed', frames: [], actions: [], commits: [], saves: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    const { ConfigStore, ConfigOwner, DEFAULT_CONFIG } = await import(pathToFileURL(ownerBundle).href)
    const store = new ConfigStore(path.join(privateRoot, 'userData', 'config.json'))
    const initial = !fs.existsSync(store.filePath)
    assert.equal(initial, ['control', 'materials', 'preview', 'liquid-settings', 'liquid-prompts', 'keyboard-shortcuts', 'appearance-preview', 'appearance-preview-glyphs'].includes(mode), 'Restart must reuse durable config, never seed again')
    let current = initial ? await store.save({ ...structuredClone(DEFAULT_CONFIG), composerShortcuts: [
      { id: 'explain', label: 'Explain simply', keyword: 'eli5', body: '用大白话说说这次做了什么，指出关键变化、验证结果与还没确认的部分。', states: ['done', 'error'] },
      { id: 'review', label: 'Review changes', keyword: 'review', providerId: 'codex', states: ['waiting', 'done'], body: Array.from({ length: 10 }, (_, i) => `${i + 1}. Review the current changes for correctness, scope, readability and recovery. Explain concrete risks, cite the relevant code and propose the smallest complete fix.`).join('\n') },
      { id: 'continue', label: 'Continue improving without losing the original work surface', keyword: 'continue', providerId: 'proof-provider', states: ['working'], body: 'Continue improving the current task. Preserve the original workspace, healthy sessions and unsent drafts; report what changed and verify the result.' }
    ] }) : await store.get()
    result.startedConfig = structuredClone(current)
    let holdNext = false, release
    const owner = new ConfigOwner({ read: () => current, save: async next => {
      if (holdNext) { holdNext = false; await new Promise(resolve => { release = resolve }) }
      return store.save(next)
    }, publish: saved => { current = saved; result.commits.push(structuredClone(saved)); win.webContents.send('proof:config:changed', saved) } })
    ipcMain.handle('proof:config:get', () => structuredClone(owner.current))
    ipcMain.handle('proof:config:save', (_event, next, expected) => {
      result.saves.push({ next: structuredClone(next), expected: structuredClone(expected) })
      return owner.edit(expected, next)
    })
    ipcMain.handle('proof:config:external', (_event, id, patch) => owner.update(config => ({ ...config, composerShortcuts: config.composerShortcuts.map(prompt => prompt.id === id ? { ...prompt, ...patch } : prompt) })))
    ipcMain.handle('proof:config:hold', () => { assert.equal(holdNext, false); holdNext = true })
    ipcMain.handle('proof:config:release', () => { assert.ok(release, 'Actual pending Main save exists'); release(); release = undefined })
    win = new BrowserWindow({ width: 1480, height: 900, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: mode.startsWith('liquid-') } })
    win.webContents.on('console-message', (_event, _level, message) => result.errors.push(message))
    await win.loadFile(html)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const read = expression => win.webContents.executeJavaScript(expression)
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`
    const button = text => `[...document.querySelectorAll('.settings-page button')].find(n=>n.checkVisibility()&&n.textContent.trim()===${JSON.stringify(text)})`
    const until = async expression => {
      const end = Date.now() + 8000
      do { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < end)
      throw new Error('Settings did not settle: ' + expression)
    }
    const settle = async () => { await read('document.fonts.ready'); await read('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await new Promise(r => setTimeout(r, 140)) }
    const click = async expression => {
      await read(`(()=>{const n=${expression};if(!n)throw Error('Missing control: '+${JSON.stringify(expression)});n.scrollIntoView({block:'center'})})()`)
      await settle()
      const hit = await read(`(()=>{const n=${expression};const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,label:n.getAttribute('aria-label')||n.textContent.trim(),hit:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
      assert.ok(hit.hit, 'Trusted pointer target must be reachable: ' + hit.label)
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: hit.x, y: hit.y })
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: hit.x, y: hit.y })
      result.actions.push(hit); await settle()
    }
    const field = label => `[...document.querySelectorAll('[data-prompt-editor] label')].find(n=>n.firstElementChild?.textContent===${JSON.stringify(label)}).querySelector('input,textarea,select')`
    const type = async (expression, value) => {
      await click(expression)
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] })
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
      assert.equal(await read(`document.activeElement===${expression} && document.activeElement.selectionStart===0 && document.activeElement.selectionEnd===document.activeElement.value.length`), true, 'Native editor selection must cover the actual focused field')
      await win.webContents.debugger.sendCommand('Input.insertText', { text: value }); await settle()
      assert.equal(await read(`(${expression}).value`), value, 'Trusted editing replaces the complete field, never appends accidentally')
    }
    const scene = async (width, appearance) => {
      win.setContentSize(width, 900)
      await read(`window.promptsProbe.theme(${JSON.stringify(appearance)})`)
      await until(`innerWidth===${width} && document.documentElement.dataset.appearance===${JSON.stringify(appearance)}`); await settle()
    }
    const section = async id => {
      const nav = q(`nav[aria-label="Settings sections"] [data-settings-target="${id}"]`)
      if (await read(nav + '?.checkVisibility()')) await click(nav)
      else {
        await click(q('.settings-section-picker')); await until('!!document.querySelector(".settings-section-menu[role=menu]")')
        await click(`document.querySelector('.settings-section-menu [data-settings-target="${id}"]')||[...document.querySelectorAll('.settings-section-menu [role=menuitemradio]')].find(n=>n.textContent.trim()===${JSON.stringify(id[0].toUpperCase() + id.slice(1))})`)
      }
      await until(`document.querySelector('.settings-content__header h2')?.textContent===${JSON.stringify(id[0].toUpperCase() + id.slice(1))}`); await settle()
    }
    const summaryVisible = () => read(`(()=>{const n=document.querySelector('[data-settings-pane="prompts"] .prompt-save-summary');if(!n)return false;const range=document.createRange();range.setStart(n.lastChild,n.lastChild.length-1);range.setEndAfter(n.lastChild);const r=range.getBoundingClientRect();return r.width>0&&r.height>0&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
    const geometry = () => read(`(()=>{const page=document.querySelector('.settings-page'),pane=document.querySelector('[data-settings-pane]:not([hidden])'),bar=pane?.querySelector('[data-settings-save-bar]'),footer=document.querySelector('.window-status-bar');return{width:innerWidth,height:innerHeight,appearance:document.documentElement.dataset.appearance,documentOverflow:document.documentElement.scrollWidth-innerWidth,paneOverflow:pane?pane.scrollWidth-pane.clientWidth:0,page:page.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),save:bar?.getBoundingClientRect().toJSON(),controls:[...document.querySelectorAll('.settings-page button,.window-status-bar button')].filter(n=>n.checkVisibility()).map(n=>{const r=n.getBoundingClientRect();return{label:n.getAttribute('aria-label')||n.textContent.trim(),rect:r.toJSON(),centerReachable:n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})}})()`)
    const capture = async (file, scenario) => {
      await read('document.querySelectorAll(".settings-overview__sweep").forEach(n=>n.getAnimations().forEach(a=>{if(a.playState==="running")a.finish()}))'); await settle()
      const facts = await geometry(); assert.equal(facts.documentOverflow, 0); assert.equal(facts.paneOverflow, 0)
      assert.ok(facts.page.bottom <= facts.footer.top + 1, 'Settings must leave actual status bar clear')
      if (await read('document.querySelector(".settings-page").dataset.settingsPage==="prompts"')) assert.equal(await summaryVisible(), true, 'The complete whole-library save facts must remain visible beside Save')
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push({ file, scenario, geometry: facts })
    }
    await until('window.promptsProbe?.ready && !!document.querySelector(".window-status-bar [aria-label=Settings]")')
    await read('window.promptsProbe.beginSurface()')
    await click(q('.window-status-bar [aria-label="Settings"]')); await section('prompts')
    if (mode === 'appearance-preview' || mode === 'appearance-preview-glyphs') {
      await require('../settings-appearance-preview/scenario.cjs').run({ win, read, q, button, until, settle, click, scene, capture, section, owner, result, evidence, mode })
      result.completed = true
      result.disk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'))
      assert.deepEqual(result.disk, owner.current)
      result.surface = await read('window.promptsProbe.surface()')
      assert.equal(result.surface.exact, true, 'Appearance preserves the original work surface')
      return
    }
    if (mode === 'keyboard-shortcuts') {
      await require('../settings-keyboard-shortcuts/scenario.cjs').run({ win, read, q, button, until, settle, click, field, type, scene, capture, section, owner, result, evidence, mode })
      result.completed = true
      result.disk = JSON.parse(fs.readFileSync(store.filePath, 'utf8'))
      assert.deepEqual(result.disk, owner.current)
      result.surface = await read('window.promptsProbe.surface()')
      assert.equal(result.surface.exact, true, 'Shortcuts preserve the original work surface')
      return
    }
    const material = async (feature, value) => {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: feature ? [{ name: feature, value }] : [] }); await settle()
      return read(`(()=>{const sidebar=document.querySelector('.settings-sidebar'),bar=document.querySelector('[data-settings-pane="prompts"] [data-settings-save-bar]');if(!sidebar||!bar)throw Error('Material has no actual consumer');return{signal:${feature ? `matchMedia(${JSON.stringify(`(${feature}: ${value})`)}).matches` : 'null'},sidebar:getComputedStyle(sidebar).backdropFilter,save:getComputedStyle(bar).backdropFilter,background:getComputedStyle(sidebar).backgroundImage,animation:getComputedStyle(document.querySelector('[data-settings-pane="prompts"] .settings-pane-stack')).animationName}})()`)
    }
    result.materialNormal = await material(); assert.notEqual(result.materialNormal.sidebar, 'none'); assert.notEqual(result.materialNormal.save, 'none')
    result.materialReduced = await material('prefers-reduced-transparency', 'reduce'); assert.equal(result.materialReduced.signal, true, 'Known emulated CSS signal, not OS fact'); assert.equal(result.materialReduced.sidebar, 'none'); assert.equal(result.materialReduced.save, 'none')
    result.materialContrast = await material('prefers-contrast', 'more'); assert.equal(result.materialContrast.signal, true); assert.equal(result.materialContrast.sidebar, 'none')
    result.materialMotion = await material('prefers-reduced-motion', 'reduce'); assert.equal(result.materialMotion.signal, true); assert.equal(result.materialMotion.animation, 'none')
    await material()
    if (mode === 'liquid-settings' || mode === 'liquid-prompts') {
      await require('../settings-liquid-motion/scenario.cjs').run({ win, read, q, button, until, settle, click, field, type, scene, capture, section, material, owner, result, evidence, mode })
      result.completed = true
    } else if (mode === 'preview') {
      await capture('1480-dark-prompts.png', 'Draft actual Prompt library/editor; not final qualification')
      await click(q('[data-prompt-id="review"]')); await scene(1480, 'light'); await capture('1480-light-prompts-long.png', 'Draft long body and compact instruction reach')
      await scene(640, 'dark'); await capture('640-dark-editor.png', 'Draft narrow editor')
      await click(button('Back to prompts')); await scene(320, 'light'); await capture('320-light-library.png', 'Draft narrow library')
      result.completed = true
    } else if (mode === 'materials') {
      await click(q('[data-prompt-id="review"]')); await scene(320, 'light')
      await read('document.querySelector("[data-settings-pane=prompts]").scrollTop=0'); await settle()
      assert.equal(await summaryVisible(), true, 'Long narrow editor keeps complete library facts in the functional footer')
      result.completed = true
    } else if (mode === 'control') {
      for (const [id, appearance] of [['overview', 'dark'], ['appearance', 'light'], ['agents', 'dark']]) {
        await scene(1480, appearance); await section(id); await capture(`1480-${appearance}-${id}.png`, 'Real App, original section and bounded functional material')
      }
      await section('prompts'); await capture('1480-dark-prompts.png', 'Three legal-state prompts, library and single-object editor')
      await click(q('[data-prompt-id="review"]')); await scene(1480, 'light'); await capture('1480-light-prompts-long.png', 'Long body with Provider scope and state-trigger usage')
      for (const width of [940, 880]) {
        await scene(width, 'light')
        const workbench = await read(`(()=>{const n=document.querySelector('.prompt-workbench');return{width:n.getBoundingClientRect().width,library:document.querySelector('.prompt-library').checkVisibility(),editor:document.querySelector('.prompt-editor').checkVisibility()}})()`)
        assert.equal(workbench.width > 660, width === 940, 'Actual content width must straddle the container breakpoint')
        assert.equal(workbench.library, width === 940); assert.equal(workbench.editor, true)
        result.actions.push({ containerBreakpoint: workbench })
        await capture(`${width}-light-container.png`, 'Actual Prompt content container on each side of 660px, same selected draft')
      }
      await scene(1480, 'light')
      await click(button('Add prompt'))
      const cancelledId = await read('document.querySelector("[data-prompt-editor]").dataset.promptEditor')
      await type(field('Name'), 'Cancelled draft')
      await click(button('Cancel new prompt'))
      assert.equal(await read(`!!document.querySelector('[data-prompt-id="${cancelledId}"]')`), false, 'Cancel removes only its uncommitted new object')
      assert.equal(owner.current.composerShortcuts.length, 3, 'Cancel never saves the draft')
      await click(q('[data-prompt-id="review"]'))
      await type(q('[aria-label="Search prompts"]'), 'no-match-proof'); await capture('1480-light-filtered-selected.png', 'Current selected object remains visible outside search results')
      await click(button('Add prompt')); await until('document.activeElement?.closest("label")?.querySelector("span")?.textContent==="Name"')
      result.newId = await read('document.querySelector("[data-prompt-editor]").dataset.promptEditor')
      await capture('1480-light-new-invalid.png', 'Explicit creation, actual Name focus, required field errors and whole-library Save')
      await type(field('Name'), 'Glass proof')
      await type(field('Keyword'), 'proof')
      await type(field('Prompt'), 'Keep this exact body.\n第二行保留空格  和换行。')
      await read('window.settingsProof.hold()'); await click(button('Save prompts'))
      await until('document.querySelector("[data-settings-save-bar]")?.textContent.includes("Saving")')
      await capture('1480-light-saving.png', 'Real ConfigOwner durable save held before commit; honest in-flight UI')
      await type(field('Name'), 'Later name')
      await read('window.settingsProof.release()'); await until('document.querySelector("[data-settings-save-bar]")?.textContent.includes("Unsaved")')
      assert.equal(owner.current.composerShortcuts.find(p => p.id === result.newId).label, 'Glass proof', 'Pending later edit must not be silently committed')
      await click(button('Save prompts')); await until('document.querySelector("[data-settings-save-bar]")?.textContent.includes("saved")')
      await scene(640, 'dark'); await capture('640-dark-editor.png', 'Single-layer narrow editor with no reduced text size')
      await click(button('Back to prompts')); await capture('640-dark-library.png', 'Narrow Back returns to library, same object and draft')
      await scene(320, 'light'); await capture('320-light-library.png', 'Full narrow Settings and status bar, searchable library')
      await click(q(`[data-prompt-id="${result.newId}"]`)); await capture('320-light-editor.png', 'Actual narrow selection opens editor and Save stays reachable')
      await click(button('Delete prompt'))
      const summary = await read(`(()=>{const n=document.querySelector('.prompt-save-summary');n.scrollIntoView({block:'center'});return{width:n.clientWidth,scroll:n.scrollWidth,text:n.textContent}})()`)
      assert.equal(summary.width, summary.scroll, 'Narrow save scope and nonzero pending-deletion facts must wrap completely')
      assert.ok(summary.text.includes('1 pending deletion')); await capture('320-light-pending-delete.png', 'Local delete clearly pending persistence with Undo')
      await click(button('Undo')); await scene(1480, 'dark')
      await click(q('[data-prompt-id="explain"]')); await type(field('Name'), 'Local edited name')
      await read('window.settingsProof.external("explain", {label:"External edited name"})')
      await click(button('Save prompts')); await until('!!document.querySelector("[data-settings-save-bar] [role=alert]")')
      await capture('1480-dark-conflict.png', 'Real ConfigOwner same-field conflict, local authored draft retained')
      await material('prefers-reduced-transparency', 'reduce'); await capture('1480-dark-reduced-transparency.png', 'Known emulated CSS reduced-transparency; explicitly not an OS bridge test'); await material()
      // Close/reopen discards only unsaved UI state; persisted object stays intact.
      await click(q('[aria-label="Close settings"]')); await click(q('.window-status-bar [aria-label="Settings"]')); await section('prompts')
      result.completed = true
    } else if (mode === 'reread') {
      const saved = owner.current.composerShortcuts.find(p => p.keyword === 'proof')
      assert.ok(saved, 'First process actually committed the new Prompt'); assert.equal(saved.label, 'Later name'); assert.equal(saved.body, 'Keep this exact body.\n第二行保留空格  和换行。')
      await click(q(`[data-prompt-id="${saved.id}"]`)); await capture('1480-dark-restarted.png', 'Different Electron PID reads actual ConfigStore, without reseeding')
      while (await read('!!document.querySelector("[data-prompt-id]")')) {
        await click(q('[data-prompt-id]')); await click(button('Delete prompt'))
      }
      await click(button('Save prompts')); await until('document.querySelector("[data-settings-save-bar]")?.textContent.includes("saved")')
      assert.deepEqual(owner.current.composerShortcuts, []); result.completed = true
    } else {
      assert.equal(mode, 'reread-empty'); assert.deepEqual(owner.current.composerShortcuts, []); assert.equal(await read('document.querySelectorAll("[data-prompt-id]").length'), 0)
      await scene(320, 'light'); await capture('320-light-restarted-empty.png', 'Third PID reads explicit durable empty library, no invented defaults'); result.completed = true
    }
    result.surface = await read('window.promptsProbe.surface()'); assert.equal(result.surface.exact, true, 'Settings workflow must preserve initial Preview work surface')
    result.disk = JSON.parse(fs.readFileSync(store.filePath, 'utf8')); assert.deepEqual(result.disk, owner.current)
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) { try { fs.writeFileSync(path.join(evidence, `${mode}-failure.png`), (await win.webContents.capturePage()).toPNG()) } catch {} }
  } finally {
    fs.writeFileSync(path.join(evidence, `${mode}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.completed ? 0 : 1)
  }
})
