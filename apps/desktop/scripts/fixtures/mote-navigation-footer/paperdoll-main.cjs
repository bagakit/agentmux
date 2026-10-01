const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto'), { pathToFileURL, fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module'), ts = require('typescript')
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const [html, privateRoot, evidence, phase, refinementMode, chooserMode] = process.argv.slice(2)
const refinement = refinementMode === 'refinement'
const fromChooser = chooserMode === 'from-chooser'
assert.ok(['seed', 'restore'].includes(phase), 'Exactly two private paperdoll phases')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const repository = path.resolve(__dirname, '../../../../..'), inputs = {}, compiledMain = {}, calls = []
const privateFaceRoot = path.join(privateRoot, 'mote-home')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { passed: false, phase, pid: process.pid, frames: [], checks: [], inputs, compiledMain,
  scope: 'Actual App/picker/durable writer/current ScratchTopics image owner and live typed events through the original single bridge. Same compilation/profile, two private Electron processes; external Session facts are controlled. No Core Run, native stage, OS or user App claim.' }
const aliases = new Map()
// Public package exports remain the authority. This private probe consumes
// current Source without building Core or depending on its generated dist.
for (const name of ['core', 'demand', 'layout']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'packages', name, 'package.json')))
  const exports = Object.entries(manifest.exports); assert.ok(exports.length > 0)
  for (const [subpath, target] of exports) {
    const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    const file = path.join(repository, 'packages', name, source); assert.ok(fs.existsSync(file), 'Public Source export exists: ' + file)
    aliases.set('@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1)), file)
  }
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (aliases.has(specifier)) return next(pathToFileURL(aliases.get(specifier)).href, context)
    try { return next(specifier, context) } catch (cause) {
      if (!specifier.startsWith('.') && !specifier.startsWith('file:')) throw cause
      const url = specifier.startsWith('file:') ? new URL(specifier) : new URL(specifier, context.parentURL)
      for (const file of [fileURLToPath(url).replace(/\.js$/, '.ts'), fileURLToPath(url) + '.ts'])
        if (fs.existsSync(file)) return next(pathToFileURL(file).href, context)
      throw cause
    }
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return next(url, context)
    const file = fileURLToPath(url), bytes = fs.readFileSync(file), name = path.relative(repository, file)
    const output = ts.transpileModule(bytes.toString(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    inputs[name] = hash(bytes); compiledMain[name] = hash(output)
    for (const [kind, relative, value] of [['main-original-inputs', name, bytes], ['main-transformed', name.replace(/\.ts$/, '.mjs'), output]]) {
      const destination = path.join(evidence, kind, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, value)
    }
    return { format: 'module', source: output, shortCircuit: true }
  }
})
let win, saveFailure = false
const channels = ['bootstrap', 'config', 'list', 'read', 'ensure', 'read-avatar', 'preview-avatar', 'save-avatar', 'flush']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  try {
    const { ScratchTopics } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/main/scratch-topics.ts')))
    const { directoryIdentity } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/shared/space-addresses.ts')))
    const { scratchTopicDirectoryName } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/shared/scratch-topics.ts')))
    const scratchRoot = path.join(privateRoot, 'mote-home'), projectRoot = path.join(privateRoot, 'project')
    const scratch = { id: '__scratch__', hostId: 'local', path: scratchRoot, name: 'Topics', kind: 'folder' }
    const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: { fixture: { label: 'Fixture', providerId: 'fixture', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: true } },
      workspaces: [scratch, { id: 'project', hostId: 'local', path: projectRoot, name: 'Original project', kind: 'folder' }], appearance: { terminalTheme: 'graphite', appAppearance: 'dark' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const topics = new ScratchTopics(), primary = 'launcher:leader', custom = 'launcher:analyst', quiet = 'launcher:quiet', ordinary = 'launcher:ordinary'
    const directory = id => path.join(scratchRoot, scratchTopicDirectoryName(id)), keyFor = id => directoryIdentity('local', directory(id))
    let image
    if (phase === 'seed') {
      fs.mkdirSync(scratchRoot, { recursive: true }); fs.mkdirSync(projectRoot)
      assert.equal(await topics.read(scratch, primary), null, 'Ordinary initialization creates the absent primary')
      for (const [id, title] of [[custom, 'Analyst with a long persistent name'], [quiet, 'Quiet collaborator']]) { await topics.ensureMote(scratch, id); await topics.renameTitle(scratch, id, title) }
      await topics.ensure(scratch, ordinary, 'Ordinary Topic')
      const originalImageFile = path.join(repository, 'apps/desktop/src/renderer/src/assets/pmo-teams-topic-avatar.png')
      const originalPng = fs.readFileSync(originalImageFile), originalImage = nativeImage.createFromBuffer(originalPng)
      assert.ok(originalPng.length > 0 && !originalImage.isEmpty(), 'The original user image is nonempty and decodable')
      const crop = originalImage.resize({ width: 256, height: 256, quality: 'best' }), png = crop.toPNG()
      assert.deepEqual(crop.getSize(), { width: 256, height: 256 }, 'Prepare the real 256 pixel avatar crop')
      assert.ok(png.length > 0, 'The prepared PNG is nonempty')
      assert.equal(hash(fs.readFileSync(originalImageFile)), hash(originalPng), 'Image preparation retains the original user file')
      result.imagePreparation = { source: path.relative(repository, originalImageFile), originalSha256: hash(originalPng), originalSize: originalImage.getSize(), cropSha256: hash(png), cropSize: crop.getSize() }
      image = await topics.saveAvatar(scratch, custom, { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + png.toString('base64') }, keyFor(custom))
      fs.writeFileSync(path.join(privateRoot, 'original-image.json'), JSON.stringify(image))
    } else {
      assert.ok(fs.existsSync(path.join(privateRoot, 'paperdoll-seed-proof.json')), 'The complete first process is required')
      image = JSON.parse(fs.readFileSync(path.join(privateRoot, 'original-image.json')))
      assert.equal((await topics.read(scratch, primary)).id, primary, 'Fresh Main owner reads the same primary')
    }
    const sourceImage = await topics.readAvatar(scratch, custom, image, keyFor(custom))
    result.image = { choice: image, sha256: hash(sourceImage.dataUrl), width: sourceImage.width, height: sourceImage.height }
    const owner = id => { assert.equal(id, scratch.id); return scratch }
    const handle = (name, action) => ipcMain.handle('mote-paperdoll:' + name, (event, ...args) => { assert.equal(event.sender, win.webContents); calls.push({ name, args }); return action(...args) })
    handle('bootstrap', () => ({ config, phase, image })); handle('config', () => config)
    handle('list', id => topics.list(owner(id))); handle('read', (id, topic) => topics.read(owner(id), topic)); handle('ensure', (id, topic) => topics.ensureMote(owner(id), topic))
    handle('read-avatar', (id, topic, choice, key) => topics.readAvatar(owner(id), topic, choice, key))
    handle('preview-avatar', (id, topic, input, key) => topics.previewAvatar(owner(id), topic, input, key))
    handle('save-avatar', (id, topic, input, key) => topics.saveAvatar(owner(id), topic, input, key))
    handle('flush', () => { if (saveFailure) throw new Error('Controlled platform save is unconfirmed.'); win.webContents.session.flushStorageData() })
    win = new BrowserWindow({ width: 980, height: 820, useContentSize: true, show: false, title: 'Private Mote face review', webPreferences: { preload: path.join(__dirname, 'paperdoll-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    win.setMenu(null)
    win.webContents.on('preload-error', (_event, file, error) => { (result.preloadErrors ??= []).push({ file, message: error.message }) })
    await win.loadFile(html); if (!refinement) win.showInactive(); win.webContents.debugger.attach('1.3')
    const read = async expression => {
      const answer = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await(${expression})}}catch(cause){return {error:{name:cause.name,message:cause.message,stack:cause.stack}}}})()`)
      if(answer.error){ const cause=new Error(answer.error.message); cause.name=answer.error.name; cause.stack=answer.error.stack; throw cause }
      return answer.value
    }
    const facts = () => read('window.motePaperdollProof.facts()'), call = (method, ...args) => read(`window.motePaperdollProof[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
    const until = async (expression, label) => { const deadline = Date.now() + 8000; do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline); throw new Error('Paperdoll stage did not settle: ' + label) }
    const input = (method, args) => win.webContents.debugger.sendCommand(method, args)
    let focusEmulationEnabled
    const setFocusEmulation = async enabled => { await input('Emulation.setFocusEmulationEnabled', { enabled }); focusEmulationEnabled = enabled }
    await setFocusEmulation(true)
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const button = label => `Array.from(document.querySelectorAll('button')).find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)})`
    const dialogButton = label => `Array.from(document.querySelector('.space-icon-picker').querySelectorAll('button')).find(n=>n.textContent===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}||(${JSON.stringify(label)}==='Save avatar'&&n.getAttribute('aria-label')==='Save face'))`
    const entry = node('[data-pmo-teams-topic-launcher] button'), panel = node('[data-pmo-teams-topic-floating]')
    const locate = expression => read(`(() => { const n=${expression}; if(!n)throw new Error('Required original control absent');const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y); const p=n.closest('.space-icon-picker')||n.closest('[data-pmo-teams-topic-floating]'),b=p?.getBoundingClientRect();
      if(!(r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&(n===hit||n.contains(hit))&&(!b||(r.x>=b.x&&r.y>=b.y&&r.right<=b.right&&r.bottom<=b.bottom))))throw new Error('Control center/containment unreachable: '+JSON.stringify({control:n.outerHTML.slice(0,600),rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},hit:hit?.outerHTML.slice(0,600),nativeOpen:Array.from(document.querySelectorAll(':popover-open')).map(p=>({id:p.id,host:p.dataset.overlayHost,role:p.getAttribute('role')}))}));return{x,y,label:n.getAttribute('aria-label')||n.textContent} })()`)
    const click = async (expression, which = 'left') => { const point = await locate(expression); result.checks.push({ name: 'control-' + point.label, passed: true, point }); await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }); for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button: which, clickCount: 1, x: point.x, y: point.y }); await pause(70) }
    const key = async value => { for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: value === 'Enter' ? 13 : value === 'Escape' ? 27 : 9, ...(value === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) }); await pause(70) }
    const visible = () => until(`!!(${panel})?.matches(':popover-open')&&(()=>{const r=(${panel}).getBoundingClientRect();return r.width>200&&r.height>100&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`, 'original panel positive and in viewport')
    const open = async () => { if (!(await facts()).ui.visible) await click(entry); await visible() }
    const select = async id => { await open(); await click(node(`[data-mote-topic-id="${id}"]`)); await visible(); await until(`window.motePaperdollProof.facts().ui.topicId===${JSON.stringify(id)}`, 'exact Mote target') }
    const edit = async () => { await click(entry, 'right'); await until(`!!Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='Change avatar…')`, 'original avatar context menu'); await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='Change avatar…')`); await until(`!!document.querySelector('.space-icon-picker[role=dialog]')`, 'original Radix editor'); }
    const capture = async name => { await pause(80); const image = await win.webContents.capturePage(), bytes = image.toPNG(), file = name + '.png'; fs.writeFileSync(path.join(evidence, file), bytes); result.frames.push({ name, file, sha256: hash(bytes), size: image.getSize(), facts: await facts() }) }
    const check = (name, detail) => result.checks.push({ name, passed: true, ...detail })
    const extraFrame = async name => {
      const captureStartedAt = await read('performance.now()')
      const bytes = (await win.webContents.capturePage()).toPNG(), file = name + '.png'
      const captureFinishedAt = await read('performance.now()')
      fs.writeFileSync(path.join(evidence, file), bytes)
      ;(result.refinement ??= { frames: [], gaze: [] }).frames.push({ name, file, sha256: hash(bytes), captureStartedAt, captureFinishedAt, facts: await facts() })
    }
    const gazeFace = async (selector, label, expected = 'identity') => {
      const measure = () => read(`(() => { const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Actual face consumer missing');const r=n.getBoundingClientRect();return { sampledAt:performance.now(),x:r.x,y:r.y,width:r.width,height:r.height,face:n.querySelector('.mote-face').outerHTML,follow:getComputedStyle(n.querySelector('.mote-face__gaze-follow')).transform,neck:getComputedStyle(n.querySelector('.mote-face__neck')).transform,brows:getComputedStyle(n.querySelector('.mote-face__brow-follow')).transform,awake:getComputedStyle(n.querySelector('.mote-face__awake-eyes')).display,expression:n.dataset.moteExpression } })()`)
      const original = await measure(), baseline = await facts()
      const [width, height] = win.getContentSize(), stages = []
      assert.ok(original.width > 0 && original.height > 0, 'Actual face consumer is visible')
      // Small sidebar identities sit next to native drag regions, where Electron does
      // not forward mouse events. Exercise both sides inside their real hit target.
      const inset = original.width < 40 ? 4 : -14
      for (const [name, x] of [['neutral', width - 2], ['near-left', Math.max(2, original.x + inset)], ['near-right', Math.min(width - 2, original.x + original.width - inset)], ['return', width - 2]]) {
        const pointerStartedAt = await read('performance.now()')
        await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: name === 'neutral' || name === 'return' ? height - 2 : original.y + original.height * .48 })
        await pause(70); const intermediate = await measure()
        if (label === 'preview') await extraFrame('avatar-' + label + '-' + name + '-intermediate')
        await pause(Math.max(0, 300 - ((await read('performance.now()')) - pointerStartedAt))); const final = await measure()
        assert.equal(final.face, original.face, 'Native gaze keeps the same saved SVG parts'); assert.equal(final.expression, expected)
        const stage = { name, pointerStartedAt, intermediate, final }; stages.push(stage)
        ;(result.refinement ??= { frames: [], gaze: [] }).gaze.push({ consumer: label, ...stage })
        await extraFrame('avatar-' + label + '-' + name)
      }
      assert.notEqual(stages[1].intermediate.follow, stages[1].final.follow, 'The pointer bone traverses a real natural intermediate transform')
      assert.notEqual(stages[1].final.follow, stages[2].final.follow, 'Near left and right have visibly different eye transforms')
      assert.equal(stages[0].final.follow, stages[3].final.follow, 'Leaving the vicinity returns the eye bone to its original pose')
      if (expected === 'sleep') { assert.equal(stages[0].final.awake, 'none'); assert.equal(stages[1].final.awake, 'block'); assert.equal(stages[3].final.awake, 'none') }
      protectedSame(baseline, await facts()); check('native-pointer-bones-continuous-same-face-' + label, { stages })
    }

    const liquidSwitch = async (label, source) => {
      const measure = () => read(`(() => { const host=document.querySelector('.mote-avatar-source'),n=host.querySelector('[data-liquid-selection]'),target=host.querySelector('[data-avatar-source="${source}"]'),rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {sampledAt:performance.now(),selection:n.dataset.liquidSelection,selected:target.getAttribute('aria-pressed'),axis:n.dataset.liquidAxis,paused:n.dataset.liquidPaused,hidden:n.hidden,transform:getComputedStyle(n).transform,surface:rect(n),target:rect(target),animations:n.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))} })()`)
      const before = await measure(), inputStartedAt = await read('performance.now()')
      await click(dialogButton(label))
      const intermediate = await measure(); await extraFrame('avatar-liquid-' + source + '-intermediate')
      await pause(Math.max(0, 480 - ((await read('performance.now()')) - inputStartedAt)))
      const final = await measure(); await extraFrame('avatar-liquid-' + source + '-settled')
      assert.equal(intermediate.selection,source); assert.equal(intermediate.selected,'true')
      assert.equal(intermediate.axis,'x'); assert.equal(intermediate.paused,'false'); assert.equal(intermediate.hidden,false)
      assert.ok(intermediate.animations.length > 0 && intermediate.animations.some(a=>a.state==='running'), 'Actual horizontal glass traverses a nonempty native animation')
      assert.notEqual(intermediate.transform,final.transform,'The real glass intermediate transform differs from its destination')
      assert.ok(Math.abs(final.surface.x-final.target.x)<1 && Math.abs(final.surface.y-final.target.y)<1 && Math.abs(final.surface.width-final.target.width)<1 && Math.abs(final.surface.height-final.target.height)<1,'Settled glass follows its actual selected source control')
      ;(result.refinement.liquid ??= []).push({source,inputStartedAt,before,intermediate,final})
      check('native-horizontal-liquid-' + source,{before,intermediate,final})
    }

    const activeExpression = async expected => { await until(`window.motePaperdollProof.facts().ui.entry.motion.expression===${JSON.stringify(expected)}`, 'accurate expression ' + expected); return (await facts()).ui.entry.motion }
    const animate = async expected => { await activeExpression(expected); await until(`window.motePaperdollProof.facts().ui.entry.motion.animations.some(a=>a.state==='running')`, 'native animations for ' + expected) }
    const protectedSame = (before, after) => assert.deepEqual(after.protected, before.protected, 'Avatar actions/animation keep nonempty original draft/layout/Run/focus/mode facts')
    const chooserAvatar = async () => {
      const original = node(`[data-pmo-teams-topic-floating] [data-mote-topic-id="${primary}"]`)
      const openFromChooser = async () => {
        await open(); await click(original, 'right')
        await until(`!!Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='Change avatar…')`, 'real floating Mote avatar menu')
        await click(`Array.from(document.querySelectorAll('[role=menuitem]')).find(n=>n.textContent==='Change avatar…')`)
        await until('!!document.querySelector(".space-icon-picker[role=dialog]")', 'real floating Mote avatar Dialog')
        const stack = await read(`(() => { const d=document.querySelector('.space-icon-picker'),p=${panel},h=d.closest('[data-overlay-host="interaction"]');return { panelOpen:p.matches(':popover-open'),hostOpen:!!h?.matches(':popover-open'),nativeAncestor:h?.parentElement===p,faceSelected:d.querySelector('[data-avatar-source="face"]')?.getAttribute('aria-pressed') } })()`)
        assert.deepEqual(stack, { panelOpen:true,hostOpen:true,nativeAncestor:true,faceSelected:'true' })
        await locate(dialogButton('Save face')); await locate(dialogButton('Cancel'))
        return stack
      }
      const focusReturned = async () => {
        await until('!document.querySelector(".space-icon-picker")', 'floating avatar editor closed')
        await until(`(${panel}).matches(':popover-open')&&document.activeElement===${original}`, 'original Mote object focus returned')
        return read(`({panelOpen:(${panel}).matches(':popover-open'),focusedTopic:document.activeElement.dataset.moteTopicId})`)
      }
      const before = await facts(), saveStack = await openFromChooser()
      await click(dialogButton('Mouth · small')); await extraFrame('avatar-from-chooser-top-layer')
      await click(dialogButton('Save face')); const saveFocus = await focusReturned(), saved = await facts()
      assert.deepEqual(saved.icons, { ...before.icons,[keyFor(primary)]:{ ...before.icons[keyFor(primary)],mouth:'small' } }, 'Trusted chooser Save updates only its original Mote face')
      protectedSame(before,saved)
      const cancelStack = await openFromChooser()
      await click(dialogButton('Color · lavender')); await click(dialogButton('Cancel'))
      const cancelFocus = await focusReturned(), cancelled = await facts()
      assert.deepEqual(cancelled.icons,saved.icons,'Trusted chooser Cancel keeps every saved appearance'); protectedSame(saved,cancelled)
      result.refinement.chooser = { saveStack,saveFocus,cancelStack,cancelFocus }
      check('floating-chooser-avatar-save-cancel-original-focus',result.refinement.chooser)
    }
    const paintedEditor = async parts => {
      await pause(180) // Observe the original control's completed 150ms style transition.
      const current = await facts(), editor = current.ui.editor
      assert.ok(editor); assert.equal(editor.groups.length, parts ? 7 : 1)
      assert.equal(editor.groups[0].label, 'Mote avatar style'); assert.equal(editor.groups[0].buttons.length, 2)
      if (parts) assert.deepEqual(editor.groups.slice(1).map(group => group.label), ['Face', 'Color', 'Eyes', 'Brows', 'Mouth', 'Detail'])
      for (const group of editor.groups) {
        assert.ok(group.buttons.length > 1); assert.equal(group.buttons.filter(button => button.selected).length, 1)
        for (const button of group.buttons) {
          assert.ok(button.rect.width > 0 && button.rect.height > 0); assert.equal(button.marks.length, 1)
          const mark = button.marks[0]
          assert.equal(mark.rect.width, 12); assert.equal(mark.rect.height, 12); assert.equal(mark.paths, 1)
          assert.equal(mark.visibility, button.selected ? 'visible' : 'hidden')
          if (button.selected) {
            assert.notEqual(mark.display, 'none'); assert.ok(Number(mark.opacity) > 0)
            if (group !== editor.groups[0]) {
              assert.match(button.shadow, /inset/); assert.match(button.shadow, /1px/)
              assert.ok(group.buttons.filter(other => !other.selected).some(other => other.shadow !== button.shadow), 'The selected contour is distinct from unselected controls')
            }
          }
        }
      }
      assert.equal(editor.save.primary, true); assert.equal(editor.cancel.primary, false)
      // Dialog primary actions use the original matte material; observe real paint, not a gradient requirement.
      const paint = editor.paint = await read(`(() => {
        const dialog = document.querySelector('.space-icon-picker[role="dialog"]')
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d')
        const control = node => {
          const style = getComputedStyle(node), rect = node.getBoundingClientRect()
          context.clearRect(0, 0, 1, 1); context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1)
          return { background: style.backgroundColor, color: style.color, backgroundPixel: Array.from(context.getImageData(0, 0, 1, 1).data), rect: { width: rect.width, height: rect.height } }
        }
        const rules = list => Array.from(list).flatMap(rule => rule.cssRules ? [rule, ...rules(rule.cssRules)] : [rule])
        const primaryRules = Array.from(document.styleSheets).flatMap(sheet => rules(sheet.cssRules))
          .filter(rule => rule.selectorText?.replace(/\\s+/g, ' ').trim() === '.dialog-surface footer .primary-button')
          .map(rule => ({ selector: rule.selectorText, background: rule.style.getPropertyValue('background'), color: rule.style.getPropertyValue('color') }))
        return { save: control(dialog.querySelector('.space-icon-picker__save')), cancel: control(dialog.querySelector('footer button')), primaryRules }
      })()`)
      assert.equal(paint.primaryRules.length, 1, 'Exactly one loaded original Dialog primary rule is observed')
      for (const rule of paint.primaryRules) assert.ok(rule.background.trim() && rule.color.trim(), 'The loaded primary rule contains both paint declarations')
      for (const control of [paint.save, paint.cancel]) { assert.ok(control.rect.width > 0 && control.rect.height > 0); assert.equal(control.backgroundPixel.length, 4); assert.ok(control.background && control.color) }
      assert.ok(paint.save.backgroundPixel[3] > 0, 'Save has actual nontransparent primary paint')
      assert.notEqual(paint.save.background, paint.cancel.background, 'Save and Cancel have distinct actual backgrounds')
      assert.notEqual(paint.save.color, paint.cancel.color, 'Save and Cancel have distinct actual text colors')
      return current
    }
    await until('window.motePaperdollProof?.ready&&document.querySelector("[data-pmo-teams-topic-launcher] button [data-mote-expression]")&&window.motePaperdollProof.facts().ready', 'actual App initialized with its original motion consumer')
    const initial = await facts(); result.initial = initial
    if(fromChooser)await extraFrame('avatar-joint-original-entry')
    assert.ok(Object.keys(initial.protected.tabs).length >= 6 && Object.keys(initial.protected.drafts).length >= 4)
    assert.equal(initial.bridgeSubscriptions, 1, 'The original router has one transport subscription')
    if (phase === 'seed') {
      await open(); const baseline = await facts()
      assert.equal(baseline.ui.entry.source, 'automatic'); assert.match(baseline.ui.entry.image, /pmo-teams-topic-avatar/)
      await capture('paperdoll-primary-default')
      await edit(); await click(dialogButton('Make a face')); await click(dialogButton('Eyes · spark')); await click(dialogButton('Color · peach')); await click(dialogButton('Brows · curious'))
      assert.equal((await facts()).icons[keyFor(primary)], undefined, 'The real editor preview is local until Save')
      const facePreview = await paintedEditor(true)
      if (refinement) await liquidSwitch('Icon or image','alternative'); else await click(dialogButton('Icon or image'))
      const iconMode = await paintedEditor(false); if (refinement) await extraFrame('avatar-icon-or-image')
      if (refinement) await liquidSwitch('Make a face','face'); else await click(dialogButton('Make a face'))
      const faceMode = await paintedEditor(true)
      assert.deepEqual(faceMode.ui.editor.groups, facePreview.ui.editor.groups, 'Returning to face editing preserves all original selection and geometry')
      protectedSame(baseline, faceMode); assert.deepEqual(faceMode.icons, baseline.icons)
      check('actual-editor-painted-selections', { facePreview: facePreview.ui.editor, iconMode: iconMode.ui.editor, faceMode: faceMode.ui.editor })
      await capture('paperdoll-editor-preview')
      if (refinement) {
        await extraFrame('avatar-editor-wide'); await gazeFace('.mote-face-editor__preview [data-mote-expression]', 'preview')
        win.setContentSize(360, 780); await pause(120); await paintedEditor(true); await extraFrame('avatar-editor-narrow')
        await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await pause(100)
        const preview = await read(`(() => { const n=document.querySelector('.mote-face-editor__preview [data-mote-expression]');return { motion:n.dataset.moteMotion, animations:n.getAnimations({subtree:true}).length } })()`)
        assert.deepEqual(preview, { motion:'off', animations:0 }); await extraFrame('avatar-editor-reduced')
        await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); win.setContentSize(980, 820); await pause(120)
      }
      // Real keyboard activation of the original Save button; no script .click or direct store write.
      await locate(dialogButton('Save avatar')); await read(`(${dialogButton('Save avatar')}).focus()`); await key('Enter')
      await until('!document.querySelector(".space-icon-picker")', 'confirmed face Save')
      const saved = await facts(); assert.equal(saved.icons[keyFor(primary)].eyes, 'spark'); assert.equal(saved.icons[keyFor(primary)].palette, 'peach'); protectedSame(baseline, saved)
      await open(); await animate('thinking')
      if(fromChooser) await chooserAvatar()
      const beforeTool = await facts()
      const start = await call('timeline', 'actual-tool', 'start'); await animate('tool')
      const live = await facts(); assert.equal(live.ui.sessionId, 'default-agent'); protectedSame(saved, live)
      result.relevantFaceCost = { before: beforeTool.costs, after: live.costs }
      assert.ok(live.costs.renders['default-agent'] > beforeTool.costs.renders['default-agent'], 'The actual profiler observes the expression subscription owner doing relevant live-tool work')
      result.dynamic = { tool: [] }
      for (let index = 0; index < 3; index++) {
        await pause(220); const fact = (await facts()).ui.entry.motion, r = fact.rect
        const frame = await win.webContents.capturePage({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }), bytes = frame.toPNG(), file = `tool-intermediate-${index}.png`
        fs.writeFileSync(path.join(evidence, file), bytes); result.dynamic.tool.push({ fact, file, sha256: hash(bytes) })
      }
      assert.ok(new Set(result.dynamic.tool.map(row => row.fact.gaze)).size > 1, 'Actual tool gaze changes across native animation time')
      await capture('paperdoll-thinking-tool')
      await call('timeline', 'actual-tool', 'complete', { createdAt: start.createdAt }); await activeExpression('thinking')
      const beforeCost = await facts(); assert.ok(beforeCost.costs.renders['default-agent'] > 0, 'Actual profiling renderer observes real Mote consumer commits')
      await call('timeline', 'unrelated', 'history', { sessionId: 'execution-agent' }); await pause(60)
      await call('timeline', 'own-history', 'history'); await pause(60)
      const afterCost = await facts(); assert.deepEqual(afterCost.costs.renders, beforeCost.costs.renders, 'Unrelated and own-history events do not render a Face')
      assert.ok(afterCost.transported.length > beforeCost.transported.length && afterCost.costs.commits > beforeCost.costs.commits, 'Nonempty actual events update the original App')
      protectedSame(beforeCost, afterCost); check('actual-face-consumer-cost', { before: beforeCost.costs, after: afterCost.costs, eventCount: afterCost.transported.length })
      await call('status', 'done'); await animate('idle')
      const idle = await facts(); assert.equal(idle.ui.entry.motion.expression, 'idle')
      await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await until('window.motePaperdollProof.facts().ui.entry.motion.motion==="off"', 'reduced-motion admission')
      const reduced = await facts(); assert.equal(reduced.ui.entry.motion.animations.length, 0); protectedSame(idle, reduced)
      await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await animate('idle')
      // A real offscreen entry still keeps its expression, but native animations stop.
      await read(`(${entry}).style.transform='translateX(-200px)'`); await until('window.motePaperdollProof.facts().ui.entry.motion.motion==="off"', 'offscreen admission'); const offscreen = await facts(); assert.equal(offscreen.ui.entry.motion.animations.length, 0)
      await read(`(${entry}).style.transform=''`); await animate('idle')
      // Electron keeps Page Visibility visible when background throttling is disabled or focus emulation is enabled.
      // Temporarily admit real native hiding; restore the exact probe settings even on failed observation.
      const visibilitySample = async () => ({ windowVisible: win.isVisible(), backgroundThrottling: win.webContents.getBackgroundThrottling(), focusEmulationEnabled,
        page: await read('({ hidden: document.hidden, visibilityState: document.visibilityState })'), facts: await facts() })
      const visibility = result.visibility = { before: await visibilitySample(), hidden: null, after: null }
      assert.equal(visibility.before.windowVisible, !refinement); assert.equal(visibility.before.page.hidden, false)
      assert.equal(visibility.before.facts.ui.entry.motion.motion, 'on'); assert.ok(visibility.before.facts.ui.entry.motion.animations.length > 0)
      if (!refinement) try {
        win.webContents.setBackgroundThrottling(true); await setFocusEmulation(false)
        win.hide(); assert.equal(win.isVisible(), false)
        visibility.hidden = await visibilitySample()
        await until('document.hidden&&window.motePaperdollProof.facts().ui.entry.motion.motion==="off"', 'document hidden admission')
        visibility.hidden = await visibilitySample()
        assert.equal(visibility.hidden.windowVisible, false); assert.equal(visibility.hidden.page.hidden, true)
        assert.equal(visibility.hidden.facts.ui.entry.motion.motion, 'off'); assert.equal(visibility.hidden.facts.ui.entry.motion.animations.length, 0)
        protectedSame(visibility.before.facts, visibility.hidden.facts)
      } finally {
        if (!refinement) win.showInactive(); win.webContents.setBackgroundThrottling(visibility.before.backgroundThrottling)
        await setFocusEmulation(visibility.before.focusEmulationEnabled); visibility.after = await visibilitySample()
      }
      await animate('idle'); visibility.after = await visibilitySample()
      assert.equal(visibility.after.windowVisible, visibility.before.windowVisible); assert.equal(visibility.after.page.hidden, false)
      assert.equal(visibility.after.backgroundThrottling, visibility.before.backgroundThrottling); assert.equal(visibility.after.focusEmulationEnabled, visibility.before.focusEmulationEnabled)
      protectedSame(visibility.before.facts, visibility.after.facts)
      if (refinement) visibility.scope = 'Background-only private probe never shows a native window; native page-hidden is not claimed. The connected motion owner has separate document-hidden regression evidence.'
      check(refinement ? 'actual-reduced-motion-offscreen-background-probe' : 'actual-reduced-motion-offscreen-document-hidden', { reduced: reduced.ui.entry.motion, offscreen: offscreen.ui.entry.motion, documentHidden: visibility.hidden?.facts.ui.entry.motion ?? null, visibility })
      win.setContentSize(420, 820); await pause(100); await visible(); await click(button('Show Mote avatars only')); await capture('paperdoll-narrow-idle')
      await select(quiet); await edit(); await click(dialogButton('Make a face')); await click(dialogButton('Color · lavender')); await click(dialogButton('Save avatar'))
      await until('!document.querySelector(".space-icon-picker")', 'confirmed sleeping face')
      await open(); await animate('sleep')
      if (refinement) await gazeFace('[data-pmo-teams-topic-launcher] button [data-mote-expression]', 'sleep-entry', 'sleep')
      const flushed = await call('flush'); win.webContents.session.flushStorageData(); fs.writeFileSync(path.join(privateRoot, 'paperdoll-seed-proof.json'), JSON.stringify({ flushed, image: result.image }))
      result.saved = flushed; check('seed-original-work-and-avatar-confirmed', { saved: flushed.facts.icons, protected: flushed.facts.protected })
    } else {
      const seed = JSON.parse(fs.readFileSync(path.join(privateRoot, 'paperdoll-seed-proof.json')))
      assert.equal(initial.initialization.seeded, false); assert.ok(initial.initialization.initialDurable && initial.initialization.initialFloating)
      assert.deepEqual(initial.icons, seed.flushed.facts.icons, 'Fresh process ordinary initialization reads the exact saved choices')
      protectedSame(seed.flushed.facts, initial); assert.deepEqual(result.image, seed.image, 'Same original custom image survives the fresh process')
      win.setContentSize(420, 820); await open(); await animate('sleep'); await capture('paperdoll-restored-sleep')
      const sleep = await facts(); assert.equal(sleep.ui.topicId, quiet); assert.ok(sleep.ui.entry.motion.animations.length > 0)
      await click(button('Close Mote')); await until('!window.motePaperdollProof.facts().ui.visible', 'hidden panel');
      const hidden = await facts(); assert.equal(hidden.ui.faces.filter(face => face.rect?.width > 0 && face.rect?.height > 0).length, 1, 'Only the always-visible entry consumes motion; hidden chooser is unmounted')
      check('fresh-process-and-hidden-face', { initial: initial.initialization, hidden: hidden.ui.faces })
      await select(primary); await call('status', 'unknown'); await activeExpression('unknown')
      const unknown = await facts(); assert.equal(unknown.ui.entry.motion.animations.filter(animation => animation.name !== null).length, 0)
      await edit(); await click(dialogButton('Mouth · grin')); saveFailure = true; await click(dialogButton('Save avatar'))
      await until('!!document.querySelector(".space-icon-picker [role=alert]")', 'explicit unconfirmed notice')
      const failed = await facts(); assert.deepEqual(failed.icons, unknown.icons, 'Unconfirmed Save keeps all original chosen faces'); protectedSame(unknown, failed)
      await locate(dialogButton('Retry saving')); await locate(dialogButton('Close')); await capture('paperdoll-unconfirmed-unknown')
      saveFailure = false; await click(dialogButton('Retry saving')); await until('!document.querySelector(".space-icon-picker")', 'explicit real Retry saves retained draft')
      const confirmed = await facts(); assert.equal(confirmed.icons[keyFor(primary)].mouth, 'grin'); protectedSame(failed, confirmed)
      await select(custom); assert.equal((await facts()).ui.entry.source, 'image', 'Original custom user image retains precedence')
      assert.ok((await facts()).ui.entry.image.startsWith('data:image/png;base64,')); await select(primary)
      await call('exactRestoring'); await activeExpression('unknown'); assert.equal((await facts()).ui.entry.motion.animations.filter(animation => animation.name !== null).length, 0)
      check('save-failure-retry-image-and-restoring', { failed: failed.ui, confirmed: confirmed.icons, final: (await facts()).ui })
    }
    result.final = await facts(); assert.deepEqual(result.final.errors, [])
    assert.equal(result.final.calls.filter(row => ['launchAgent', 'launchTerminal', 'stop', 'write', 'submitPrompt', 'send', 'queue', 'resize'].includes(row.operation)).length, 0, 'Appearance/state changes never control Run or resize')
    result.passed = true
  } catch (cause) { result.failure = { name: cause.name, message: cause.message, stack: cause.stack }; console.error(cause) }
  finally {
    result.calls = calls; fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
    for (const channel of channels) ipcMain.removeHandler('mote-paperdoll:' + channel)
    if (win && !win.isDestroyed()) { try { win.webContents.debugger.detach() } catch {}; win.destroy() }
    hooks.deregister(); app.exit(result.passed ? 0 : 1)
  }
})
