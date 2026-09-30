const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module')
const ts = require('typescript')
const { ipcMain, nativeImage } = require('electron')
module.exports = async function identityReview({ app, BrowserWindow, html, privateRoot, evidence, frames }) {
  const repository = path.resolve(__dirname, '../../../../..'), inputs = {}, compiledMain = {}, calls = []
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const sourceHook = registerHooks({
    resolve(specifier, context, next) {
      try { return next(specifier, context) } catch (cause) {
        if (!specifier.startsWith('.') && !specifier.startsWith('file:')) throw cause
        const url = specifier.startsWith('file:') ? new URL(specifier) : new URL(specifier, context.parentURL)
        for (const file of [fileURLToPath(url).replace(/\.js$/, '.ts'), fileURLToPath(url) + '.ts']) if (fs.existsSync(file)) return next(pathToFileURL(file).href, context)
        throw cause
      }
    },
    load(url, context, next) {
      if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return next(url, context)
      const file = fileURLToPath(url), source = fs.readFileSync(file), relative = path.relative(repository, file)
      inputs[relative] = hash(source)
      const compiled = ts.transpileModule(source.toString(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
      compiledMain[relative] = hash(compiled)
      const original = path.join(evidence, 'main-original-inputs', relative), output = path.join(evidence, 'main-transformed', relative.replace(/\.ts$/, '.mjs'))
      fs.mkdirSync(path.dirname(original), { recursive: true }); fs.writeFileSync(original, source)
      fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, compiled)
      return { format: 'module', source: compiled, shortCircuit: true }
    }
  })
  let win, failure = false
  const result = { passed: false, pid: process.pid, frames: [], checks: [], replayedFrames: [],
    scope: 'One private production Renderer and real current ScratchTopics/WorkspaceFiles Source owners, controlled external Session facts, six full frames and same-profile Renderer reload; no user App/Core Run/native-stage claim.', reload: { passed: false } }
  try {
    const { ScratchTopics } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/main/scratch-topics.ts')))
    const { WorkspaceFiles } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/main/workspace-files.ts')))
    const { imagePng } = await import(pathToFileURL(path.join(repository, 'apps/desktop/test/fixtures/mote-identity-image.ts')))
    const root = path.join(privateRoot, 'mote-home'), project = path.join(privateRoot, 'project')
    fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(project)
    const scratch = { id: '__scratch__', hostId: 'local', path: root, name: 'Space', kind: 'folder' }
    const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }], executors: { fixture: { label: 'Fixture', providerId: 'fixture', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: true } },
      workspaces: [scratch, { id: 'project', hostId: 'local', path: project, name: 'Project', kind: 'folder' }], appearance: { terminalTheme: 'graphite', appAppearance: 'dark' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const topics = new ScratchTopics(), primaryId = 'launcher:leader', customId = 'launcher:analyst'
    assert.equal(await topics.read(scratch, primaryId), null, 'Primary is genuinely absent before ordinary Renderer initialization')
    for (const [id, title] of [[customId, 'Analyst with a persistent identity'], ['launcher:quiet', 'Quiet collaborator']]) {
      await topics.ensureMote(scratch, id); await topics.renameTitle(scratch, id, title)
    }
    const service = new WorkspaceFiles(() => ({ id: 'local', kind: 'local' }), { primaryMoteWorkspace: async () => config.workspaces.find(one => one.id === '__scratch__') })
    const owner = id => { assert.equal(id, scratch.id); return config.workspaces.find(one => one.id === id) }
    const handle = (name, fn) => ipcMain.handle('mote-identity:' + name, (_event, ...args) => { calls.push({ name, args: name.includes('avatar') ? args.map((arg, index) => index === 2 && arg?.dataUrl ? { mimeType: arg.mimeType, dataSha256: hash(arg.dataUrl), dataBytes: arg.dataUrl.length } : arg) : args }); return fn(...args) })
    handle('bootstrap', async () => ({ config, topics: await topics.list(scratch) })); handle('config', () => config)
    handle('list', id => topics.list(owner(id))); handle('read', (id, topic) => topics.read(owner(id), topic))
    handle('ensure', (id, topic) => topics.ensureMote(owner(id), topic))
    handle('preview-avatar', (id, topic, input, objectKey) => topics.previewAvatar(owner(id), topic, input, objectKey))
    handle('save-avatar', (id, topic, input, objectKey) => topics.saveAvatar(owner(id), topic, input, objectKey))
    handle('read-avatar', (id, topic, ref, objectKey) => topics.readAvatar(owner(id), topic, ref, objectKey))
    handle('flush', () => { if (failure) throw new Error('Controlled platform storage request is unconfirmed'); win.webContents.session.flushStorageData() })
    win = new BrowserWindow({ width: 980, height: 820, show: true, title: 'Private Mote identity review', webPreferences: { preload: path.join(__dirname, 'identity-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    win.setMenu(null)
    win.webContents.on('preload-error', (_event, preload, error) => { (result.preloadErrors ??= []).push({ preload, message: error.message }); process.stderr.write('Private preload: ' + error.message + '\n') })
    win.webContents.on('console-message', (event, level, message) => { const detail = typeof level === 'undefined' ? event : { level, message }; (result.console ??= []).push({ level: detail.level, message: detail.message }); if (detail.level === 'error' || detail.level >= 2) process.stderr.write('Private Renderer: ' + detail.message + '\n') })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    const read = expression => win.webContents.executeJavaScript(expression)
    const facts = () => read('window.motePresentationReview.facts()')
    const call = (method, ...args) => read(`window.motePresentationReview[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
    const until = async (expression, label) => { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (await read(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) }; throw new Error('Identity stage did not settle: ' + label) }
    const input = (method, args) => win.webContents.debugger.sendCommand(method, args)
    const locate = selector => read(`(() => { const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(n=>n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0); if(nodes.length!==1)throw new Error('Expected one visible control: '+${JSON.stringify(selector)});const r=nodes[0].getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!(hit===nodes[0]||nodes[0].contains(hit)))throw new Error('Control center not reachable: '+${JSON.stringify(selector)});return {x,y} })()`)
    const click = async (selector, button = 'left') => { const point = await locate(selector); await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...point }) }
    const key = async (value, code) => { for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: code }) }
    const entry = '[data-pmo-teams-topic-launcher] button', panel = '[data-pmo-teams-topic-floating]', picker = '.space-icon-picker[role="dialog"]'
    const image = path.join(privateRoot, 'picked-primary.jpg'), customImage = path.join(privateRoot, 'picked-custom.png')
    const jpeg = nativeImage.createFromBuffer(imagePng(400, 256, [62, 148, 121])).toJPEG(90)
    assert.ok(jpeg.length > 0 && jpeg[0] === 255 && jpeg[1] === 216 && jpeg[2] === 255)
    fs.writeFileSync(image, jpeg); fs.writeFileSync(customImage, imagePng(256, 400, [75, 112, 203]))
    result.inputFormats = [{ mimeType: 'image/jpeg', sha256: hash(jpeg), bytes: jpeg.length }, { mimeType: 'image/png', sha256: hash(fs.readFileSync(customImage)), bytes: fs.statSync(customImage).size }]
    const chooseFile = async file => {
      const { root } = await input('DOM.getDocument', {})
      const { nodeId } = await input('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[aria-label="Choose Mote image"]' })
      assert.ok(nodeId > 0); await input('DOM.setFileInputFiles', { nodeId, files: [file] })
      await until(`document.querySelector(${JSON.stringify(picker + ' .space-icon-picker__save')})?.disabled===false&&document.querySelector('canvas[aria-label="Circular avatar preview"]')`, 'actual file preview decoded and ready')
    }
    const edit = async () => {
      await click(entry, 'right'); await until(`!!document.querySelector('[role="menuitem"]')`, 'original Footer context menu')
      await click('[role="menuitem"]'); await until(`!!document.querySelector(${JSON.stringify(picker)})`, 'original picker')
      assert.equal((await facts()).ui.visible, false, 'Original auto-popover leaves top layer before the Dialog')
      await locate(picker + ' .mote-avatar-file input'); await locate(picker + ' .space-icon-picker__save')
    }
    const save = async () => { await click(picker + ' .space-icon-picker__save'); await until(`!document.querySelector(${JSON.stringify(picker)})`, 'save and return original entry') }
    const open = async () => { if (!(await facts()).ui.visible) await click(entry); await until(`document.querySelector(${JSON.stringify(panel)})?.matches(':popover-open')`, 'original Mote entry') }
    const choose = async id => { await open(); await click(`${panel} [data-mote-topic-id="${id}"]`); await until(`document.querySelector(${JSON.stringify(entry)})?.dataset.moteTargetTopic===${JSON.stringify(id)}`, 'same original selected Mote') }
    const protectedFacts = current => ({ tabs: current.protected.tabs, drafts: current.protected.drafts, execution: current.protected.execution, outbox: current.protected.outbox })
    const geometry = async () => read(`(() => {
      const panel=document.querySelector(${JSON.stringify(panel)}), rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      if(!panel?.matches(':popover-open'))throw new Error('Original panel absent');
      const controls={ input:panel.querySelector('[aria-label="Message Agent"]'), newTab:panel.querySelector('button[title="New tab"]'), rail:panel.querySelector('[aria-label="Show Mote avatars only"]'), space:panel.querySelector('[aria-label="Open Mote Space"]'), close:panel.querySelector('[aria-label="Close Mote"]') };
      const outer=rect(panel), inside=r=>r.x>=outer.x-1&&r.y>=outer.y-1&&r.right<=outer.right+1&&r.bottom<=outer.bottom+1;
      const values=Object.fromEntries(Object.entries(controls).map(([name,node])=>{if(!node)throw new Error('Missing independent '+name);const r=rect(node),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!(r.width>0&&r.height>0&&inside(r)&&(node===hit||node.contains(hit))))throw new Error('Unreachable '+name);return [name,r]}));
      const buttons=['newTab','rail','space','close'];for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=values[buttons[i]],b=values[buttons[j]];if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)throw new Error('Overlapping controls');}
      const primary=panel.querySelector('[data-mote-topic-id="launcher:leader"]');if(!primary?.getAttribute('aria-label').includes(' · Primary · '))throw new Error('Primary identity is not discernible');
      const images=[...panel.querySelectorAll('.mote-chooser__name img')];if(images.length<2)throw new Error('Distinct Mote images absent');for(const image of images){const r=rect(image);if(r.width!==24||r.height!==24)throw new Error('Mote avatar has wrong original slot size');}
      return {outer,controls:values,images:images.map(node=>({src:node.src,rect:rect(node)}))};
    })()`)
    const capture = async (name, detail = null) => {
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const png = (await win.webContents.capturePage()).toPNG(), file = name + '.png'; fs.writeFileSync(path.join(evidence, file), png)
      result.frames.push({ name, file, sha256: hash(png), detail, facts: await facts() }); result.replayedFrames.push(name)
    }
    await until('window.motePresentationReview?.facts().ready===true', 'ordinary real initialize')
    await until(`window.motePresentationReview.facts().identity.snapshot.__scratch__?.topics?.some(t=>t.id===${JSON.stringify(primaryId)})`, 'primary ensure publication')
    const primary = await topics.read(scratch, primaryId); assert.ok(primary?.soul?.content.length > 0)
    result.checks.push({ name: 'ordinary-initialize-real-cold-primary', passed: true, ensureCalls: calls.filter(one => one.name === 'ensure' && one.args[1] === primaryId).length })
    const primaryDirectory = path.join(root, primary.directoryPath), soulBefore = hash(fs.readFileSync(path.join(primaryDirectory, 'SOUL.md')))
    await assert.rejects(service.delete(scratch, primary.directoryPath), error => error.code === 'PRIMARY_MOTE_PROTECTED')
    await assert.rejects(service.delete({ ...scratch, id: 'parent', path: privateRoot }, 'mote-home'), error => error.code === 'PRIMARY_MOTE_PROTECTED')
    assert.equal(hash(fs.readFileSync(path.join(primaryDirectory, 'SOUL.md'))), soulBefore)
    result.checks.push({ name: 'real-final-service-primary-and-ancestor-retained', passed: true, soulSha256: soulBefore })
    await open(); const original = await facts(), initialInput = original.ui.input
    assert.ok(initialInput?.token > 0 && initialInput.text.length > 0, 'A real nonempty original input is present')
    await edit(); await chooseFile(image)
    const firstDocument = await input('DOM.getDocument', {}), firstCrop = await input('DOM.querySelector', { nodeId: firstDocument.root.nodeId, selector: 'canvas[aria-label="Circular avatar preview"]' })
    assert.ok(firstCrop.nodeId > 0); await chooseFile(image)
    const secondDocument = await input('DOM.getDocument', {}), secondCrop = await input('DOM.querySelector', { nodeId: secondDocument.root.nodeId, selector: 'canvas[aria-label="Circular avatar preview"]' })
    assert.ok(secondCrop.nodeId > 0); assert.notEqual(secondCrop.nodeId, firstCrop.nodeId, 'Repeated same-file selection remounts the real original crop and Save is ready')
    result.checks.push({ name: 'same-real-image-second-selection-ready', passed: true, firstCropNodeId: firstCrop.nodeId, secondCropNodeId: secondCrop.nodeId })
    await click(picker + ' .mote-avatar-crop__zoom input')
    await key('ArrowRight', 39)
    assert.ok(Number(await read(`document.querySelector('[aria-label="Avatar zoom"]').value`)) > 1, 'Actual crop zoom responds')
    await save(); await open()
    const first = await facts(); assert.deepEqual(protectedFacts(first), protectedFacts(original)); assert.equal(first.ui.input.token, initialInput.token)
    const primaryAvatar = first.identity.entryAvatar; assert.ok(primaryAvatar?.startsWith('data:image/png;base64,'))
    result.checks.push({ name: 'original-file-picker-circle-zoom-save-and-return', passed: true, input: first.ui.input })
    await choose(customId); const customBefore = await facts()
    await edit(); await chooseFile(customImage); await save(); await open()
    const customAfter = await facts(); assert.deepEqual(protectedFacts(customAfter), protectedFacts(customBefore)); assert.equal(customAfter.ui.input.token, customBefore.ui.input.token)
    assert.notEqual(customAfter.identity.entryAvatar, primaryAvatar)
    result.checks.push({ name: 'custom-asset-same-original-target', passed: true })
    const previewFormats = [...new Set(calls.filter(one => one.name === 'preview-avatar').map(one => one.args[2].mimeType))].sort()
    assert.deepEqual(previewFormats, ['image/jpeg', 'image/png'])
    result.checks.push({ name: 'real-JPEG-and-PNG-preview-original-native-owner', passed: true, formats: previewFormats })
    // Cancellation uses the real picker and leaves the original confirmed choice and asset set intact.
    const confirmed = customAfter.identity.choices, assetCalls = calls.filter(one => one.name === 'save-avatar').length
    await edit(); await chooseFile(image); await click(picker + ' footer button:first-child'); await until(`!document.querySelector(${JSON.stringify(picker)})`, 'cancel original image draft')
    assert.deepEqual((await facts()).identity.choices, confirmed); assert.equal(calls.filter(one => one.name === 'save-avatar').length, assetCalls)
    await open(); result.checks.push({ name: 'real-preview-cancel-no-choice-or-asset-write', passed: true })
    const toggle = `${panel} [aria-label="Show Mote avatars only"]`
    for (const [width, mode, name] of [[980,'cards',frames[0]], [980,'avatars',frames[1]], [420,'cards',frames[2]], [420,'avatars',frames[3]]]) {
      win.setSize(width, 820); await new Promise(resolve => setTimeout(resolve, 100))
      if ((await facts()).ui.rail !== mode) await click(toggle)
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const detail = await geometry(); const current = await facts()
      assert.equal(current.ui.topicId, customId); assert.equal(current.ui.tabId, customBefore.ui.tabId); assert.equal(current.ui.input.token, customBefore.ui.input.token)
      assert.deepEqual(protectedFacts(current), protectedFacts(customBefore))
      result.checks.push({ name, passed: true, geometry: detail }); await capture(name, detail)
    }
    win.setSize(980, 820); await new Promise(resolve => setTimeout(resolve, 100)); await edit(); await chooseFile(image); failure = true
    await click(picker + ' .space-icon-picker__save'); await until(`document.querySelector(${JSON.stringify(picker + ' [role="alert"]')})?.textContent.includes('Saving is unconfirmed')`, 'visible storage step failure')
    const failed = await facts(); assert.deepEqual(failed.identity.choices, confirmed); assert.equal(failed.identity.entryAvatar, customAfter.identity.entryAvatar)
    await locate(picker + ' .space-icon-picker__save'); await locate(picker + ' footer button:first-child')
    result.checks.push({ name: 'failed-choice-retains-old-confirmed-and-crop-draft', passed: true }); await capture(frames[4])
    failure = false; await save(); await open(); assert.ok((await facts()).identity.choices)
    // Return to the original distinct custom asset before demonstrating Space and durable readback.
    await edit(); await chooseFile(customImage); await save(); await open()
    await call('fullSpace'); await click(`${panel} [aria-label="Open Mote Space"]`); await until('!window.motePresentationReview.facts().ui.visible', 'original Space action')
    const tree = `[data-space-nav="topic:${customId}"]`; await locate(tree)
    const spaceImage = await read(`document.querySelector(${JSON.stringify(tree + ' img')})?.src`)
    assert.equal(spaceImage, (await facts()).identity.entryAvatar); assert.ok(spaceImage.startsWith('data:image/png;base64,'))
    result.checks.push({ name: 'actual-full-Space-same-Mote-asset', passed: true }); await capture(frames[5])
    // Explicitly restoring automatic uses the same original owner, then reselect the image for reload proof.
    await edit(); await click(picker + ' .space-icon-picker__automatic'); await save()
    assert.equal(await read(`document.querySelector(${JSON.stringify(entry + ' [data-space-icon-source="automatic"]')})!==null`), true)
    assert.equal(await read(`document.querySelector(${JSON.stringify(tree + ' [data-space-icon-source="automatic"]')})!==null`), true)
    result.checks.push({ name: 'actual-restore-automatic-across-entry-and-tree', passed: true })
    await edit(); await chooseFile(customImage); await save()
    const beforeReload = await facts(); await call('flushIdentity')
    win.webContents.session.flushStorageData(); win.reload(); await until('window.motePresentationReview?.facts().ready===true', 'private same-profile Renderer reload')
    await until(`document.querySelector(${JSON.stringify(entry + ' img')})?.src?.startsWith('data:image/png;base64,')`, 'actual restored original asset')
    const restored = await facts(); assert.deepEqual(restored.identity.choices, beforeReload.identity.choices); assert.equal(restored.identity.entryAvatar, beforeReload.identity.entryAvatar)
    result.reload = { passed: true, scope: 'Same private Chromium profile, actual persisted Workbench choice and actual directory assets; no user App/process/Run recovery claim.', before: beforeReload.identity.choices, after: restored.identity.choices, imageSha256: hash(restored.identity.entryAvatar) }
    result.checks.push({ name: 'actual-choice-assets-restored-same-private-profile', passed: true })
    assert.equal(calls.filter(one => one.name === 'ensure' && one.args[1] === primaryId).length >= 2, true)
    const final = await facts(); assert.ok(final.calls.length > 0); assert.equal(final.calls.filter(one => /^(launch|apiLaunch|apiLaunchTerminal|stop|write|submit|send|queue)$/.test(one.operation)).length, 0)
    result.final = final; result.nativeCalls = calls; result.inputs = inputs; result.compiledMain = compiledMain
    result.assets = []
    for (const topic of await topics.list(scratch)) {
      const assets = path.join(root, topic.directoryPath, '.agentmux', 'avatars')
      if (!fs.existsSync(assets)) continue
      for (const name of fs.readdirSync(assets)) {
        const bytes = fs.readFileSync(path.join(assets, name)), file = path.join('assets', topic.directoryPath, name)
        fs.mkdirSync(path.dirname(path.join(evidence, file)), { recursive: true }); fs.writeFileSync(path.join(evidence, file), bytes)
        result.assets.push({ topicId: topic.id, file, sha256: hash(bytes), bytes: bytes.length })
      }
    }
    assert.ok(result.assets.length >= 2); assert.equal(result.frames.length, frames.length); result.passed = true
  } catch (cause) {
    result.failure = { name: cause.name, message: cause.message, stack: cause.stack }; result.inputs = inputs; result.nativeCalls = calls
    if (win && !win.isDestroyed()) result.windowAtFailure = await win.webContents.executeJavaScript(`({ bridge: typeof window.moteIdentityNative, review: typeof window.motePresentationReview, facts: window.motePresentationReview?.facts(), body: document.body.innerText, scripts: [...document.scripts].map(one => one.src) })`).catch(error => ({ observationFailure: error.message }))
  }
  finally {
    if (win && !win.isDestroyed()) win.destroy()
    sourceHook.deregister()
    for (const channel of ['bootstrap','config','list','read','ensure','preview-avatar','save-avatar','read-avatar','flush']) ipcMain.removeHandler('mote-identity:' + channel)
    fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
  }
  app.exit(result.passed ? 0 : 1)
}
