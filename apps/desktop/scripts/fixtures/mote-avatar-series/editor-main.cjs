const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { createHash, randomUUID } = require('node:crypto')
const [html, directory, originalBuiltin, scope = 'full'] = process.argv.slice(2)
app.setPath('userData', path.join(directory, 'userData'))
app.setPath('sessionData', path.join(directory, 'userData'))
app.setPath('home', path.join(directory, 'private-home'))
const result = { passed: false, scope, pid: process.pid, images: [], operations: [], sourceCalls: [], readCalls: [], saveCalls: [], seedCalls: [], pngReads: [], publications: [], requestStorage: [], flushRequests: [], errors: [], writes: 0 }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash('sha256').update(value).digest('hex')
app.whenReady().then(async () => {
  console.log('editor-main: ready')
  let win, hold = false, releases = [], loseAckOnce = false, historicalChoiceOnce = null, holdReadKey = null, heldReads = [], holdSaveKey = null, heldSaves = [], failNativePublicationOnce = false, failFlushOnce = false, failFlushAt = null
  const starter = scope === 'starter'
  try {
    Menu.setApplicationMenu(null)
    await fs.mkdir(path.join(app.getPath('home'), '.agentmux'), { recursive: true })
    const { MoteAvatarSeriesOwner, MoteAvatarControl, createMoteAvatarWriter, ConfigStore, DEFAULT_CONFIG, ConfigOwner, ScratchTopics, directoryIdentity, CONFIG_CHANGED_CHANNEL, observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority, AgentMuxControlServer, senderTrust, assertSenderTrusted } = require(path.join(path.dirname(html), 'editor-native.cjs'))
    const builtinRoot = path.join(directory, 'builtin'), userRoot = starter ? path.join(app.getPath('home'), '.agentmux', 'avatars') : path.join(directory, 'avatars')
    await fs.cp(originalBuiltin, builtinRoot, { recursive: true })
    // Existing face editing probes now use a real declared user collection. The
    // original bundled declaration remains unchanged for saved-choice recovery.
    const geometry = JSON.parse(await fs.readFile(path.join(builtinRoot, 'geometry/series.json'), 'utf8'))
    const originalFace = geometry.entries.find(entry => entry.definition.kind === 'face2d')
    assert.ok(originalFace, 'The actual original bundled face declaration is required')
    const presetRoot = path.join(userRoot, 'fixture-presets')
    const userDeclaration = { schema: 'agentmux.avatar-series.v1', title: 'Personal presets', entries: [
      { id: 'quiet', title: 'Quiet · Your preset', definition: structuredClone(originalFace.definition) },
      { id: 'portrait', title: 'Owl · Your image', definition: { kind: 'image', file: 'portrait.png' } }
    ] }
    if (!starter) {
      await fs.mkdir(path.join(userRoot, 'personal'), { recursive: true })
      await fs.copyFile(path.join(builtinRoot, 'geometry/owl.png'), path.join(userRoot, 'personal/own.png'))
      await fs.mkdir(presetRoot, { recursive: true })
      await fs.copyFile(path.join(builtinRoot, 'geometry/owl.png'), path.join(presetRoot, 'portrait.png'))
      await fs.writeFile(path.join(presetRoot, 'series.json'), JSON.stringify(userDeclaration))
    }
    if (!starter) result.userDeclaration = { path: path.join(presetRoot, 'series.json'), sha256: sha(JSON.stringify(userDeclaration)), declaration: userDeclaration }
    const store = new ConfigStore(path.join(directory, 'config.json'))
    let config = scope === 'durable-reopen' ? await store.get() : await store.save({ ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: '__scratch__', hostId: 'local', path: path.join(app.getPath('home'), '.agentmux/scratch'), name: 'Private Motes', kind: 'folder' }] })
    const workspace = config.workspaces.find(value => value.id === '__scratch__')
    assert.ok(workspace && workspace.path.startsWith(app.getPath('home')), 'The actual scratch configuration must stay inside the private home')
    const topics = new ScratchTopics(), targets = {}
    for (const topicId of ['launcher:leader', 'launcher:analyst', ...(scope === 'request-label-delta' ? ['launcher:blank'] : [])]) {
      const actual = await topics.ensureMote(workspace, topicId)
      assert.ok(actual.identityDirectoryPath)
      const key = directoryIdentity(workspace.hostId, actual.identityDirectoryPath)
      targets[topicId] = { key, kind: 'mote', name: topicId === 'launcher:leader' ? 'Mote' : 'Second Mote', avatarTarget: { workspaceId: workspace.id, topicId, objectKey: key } }
    }
    if (scope !== 'durable-reopen') config = await store.save({ ...config, appearance: { ...config.appearance, spaceObjectIcons: { [targets['launcher:leader'].key]: 'rocket' } } })
    const originalStoreSave = store.save.bind(store)
    store.save = async next => {
      if (failNativePublicationOnce) { failNativePublicationOnce = false; throw new Error('The actual private ConfigStore publication was interrupted by this fixture.') }
      return originalStoreSave(next)
    }
    const owner = new ConfigOwner({ read: () => config, save: next => store.save(next), publish: saved => {
      config = saved; result.publications.push({ choices: structuredClone(saved.appearance.spaceObjectIcons) }); win?.webContents.send(CONFIG_CHANGED_CHANNEL, saved)
    } })
    const originalConfirm = store.confirmSaved.bind(store)
    store.confirmSaved = async saved => {
      await originalConfirm(saved)
      if (historicalChoiceOnce) {
        const change = historicalChoiceOnce; historicalChoiceOnce = null
        await owner.update(current => ({ ...current, appearance: { ...current.appearance, spaceObjectIcons: { ...current.appearance.spaceObjectIcons, [change.key]: change.choice } } }))
      }
    }
    const sources = new MoteAvatarSeriesOwner({ userRoot, builtinRoot })
    const control = new MoteAvatarControl(sources, ['durable', 'durable-reopen', 'request-label-delta', 'face-entry-delta', 'starter'].includes(scope) ? createMoteAvatarWriter(owner, sources, topics, store) : undefined,
      starter ? async exactPath => { result.revealCalls.push({ path: exactPath, outcome: 'requested', boundary: 'Original OS folder port accepted this exact directory; no Finder window or focus claim.' }) } : undefined)
    if (starter) {
      result.createCalls = []; result.revealCalls = []; result.copyCalls = []; result.ipcTrust = []; result.attemptedSaves = 0
      const sourceCall = control.call.bind(control)
      control.call = async (method, input) => {
        if (method !== 'space.mote.avatar.series.create' && method !== 'space.mote.avatar.series.reveal') return sourceCall(method, input)
        const call = { method, input: structuredClone(input) }; result.createCalls.push(call)
        if (method === 'space.mote.avatar.series.create' && result.seedNextCreateConflict) {
          result.seedNextCreateConflict = false
          const exactPath = path.join(userRoot, input.seriesId)
          await fs.mkdir(exactPath)
          await fs.writeFile(path.join(exactPath, 'sentinel.bin'), Buffer.from('Original GUI conflict bytes'))
          result.seededCreateConflict = { seriesId: input.seriesId, path: exactPath,
            bytes: sha(await fs.readFile(path.join(exactPath, 'sentinel.bin'))), boundary: 'Real trusted request identity seeds only the filesystem precondition; original source owner still executes.' }
        }
        try {
          const value = await sourceCall(method, input); call.value = value
          if (method === 'space.mote.avatar.series.create' && result.loseCreateAckOnce) {
            result.loseCreateAckOnce = false
            throw Object.assign(new Error('The original completed creation reply was withheld at the fixture IPC boundary.'), { code: 'FIXTURE_CREATE_REPLY_WITHHELD' })
          }
          return value
        }
        catch (error) { call.error = { code: error.code, message: error.message }; throw error }
      }
      for (const [channel, method] of [['moteAvatars:createSeries', 'space.mote.avatar.series.create'], ['moteAvatars:revealSeries', 'space.mote.avatar.series.reveal']]) {
        ipcMain.handle(channel, async (event, input) => {
          const trust = senderTrust(channel, event.sender, win.webContents)
          result.ipcTrust.push({ channel, trusted: trust.trusted, sender: event.sender.id, original: win.webContents.id })
          assertSenderTrusted(trust)
          return control.call(method, input)
        })
      }
      ipcMain.handle('ui:writeClipboardText', (event, text) => {
        assert.equal(event.sender, win.webContents, 'The fixture clipboard port belongs to the original editor')
        result.copyCalls.push({ text, boundary: 'Exact native clipboard text port request recorded; system clipboard retained.' })
      })
    }
    ipcMain.handle('moteAvatars:list', async () => {
      const value = await control.call('space.mote.avatar.list', {})
      result.sourceCalls.push({ method: 'list', roots: value.roots, series: value.series.map(item => ({ origin: item.origin, seriesId: item.seriesId, entries: item.entries.map(entry => entry.entryId) })) })
      return value
    })
    ipcMain.handle('moteAvatars:preview', async (_event, input) => {
      try {
        const value = await control.call('space.mote.avatar.preview', input)
        result.sourceCalls.push({ method: 'preview', input, source: value.source, kind: value.payload.kind,
          ...(value.payload.kind === 'image' ? { imageSha256: sha(value.payload.image.dataUrl) } : {}) })
        if (hold && input.source.entryId === 'owl') await new Promise(resolve => releases.push(resolve))
        return value
      } catch (error) { result.sourceCalls.push({ method: 'preview', input, error: error.message, code: error.code }); throw error }
    })
    ipcMain.handle('moteAvatars:read', async (_event, input) => {
      const value = await control.call('space.mote.avatar.read', input)
      result.readCalls.push({ input, value })
      if (input.target.objectKey === holdReadKey) await new Promise(resolve => heldReads.push(resolve))
      return value
    })
    ipcMain.handle('moteAvatars:save', async (_event, input) => {
      if (starter) result.attemptedSaves++
      if (!['durable', 'durable-reopen', 'request-label-delta'].includes(scope)) throw new Error('Only the explicit durable product scopes may save.')
      const kept = await win.webContents.executeJavaScript(`seriesEditorFixture.keptRequest(${JSON.stringify(input.target)})`)
      result.requestStorage.push({ operationId: input.operationId, kept, matched: JSON.stringify(kept) === JSON.stringify(input) })
      assert.deepEqual(kept, input, 'The complete original request must be kept before native Save.')
      const value = await control.call('space.mote.avatar.save', input)
      result.saveCalls.push({ input, wireSha256: sha(JSON.stringify(input)), value })
      if (input.target.objectKey === holdSaveKey) await new Promise(resolve => heldSaves.push(resolve))
      if (loseAckOnce) { loseAckOnce = false; throw new Error('The original completed native IPC acknowledgement was withheld by this fixture.') }
      return value
    })
    ipcMain.handle('ui:requestStorageFlush', async () => {
      const authority = await observeWorkbenchStorageAuthority(win.webContents.session, { userData: app.getPath('userData'), sessionData: app.getPath('sessionData') })
      requireWorkbenchStorageAuthority(authority)
      const interrupted = failFlushOnce || result.flushRequests.length + 1 === failFlushAt
      result.flushRequests.push({ authority, requested: !interrupted })
      if (interrupted) { failFlushOnce = false; failFlushAt = null; throw new Error('The real private storage flush request was interrupted by this fixture.') }
      win.webContents.session.flushStorageData()
    })
    ipcMain.handle('config:get', () => structuredClone(config))
    ipcMain.handle('config:save', async (_event, next, before) => {
      result.writes++
      if (scope !== 'durable') throw new Error('T-002 never publishes a configuration.')
      return owner.edit(before, next)
    })
    ipcMain.handle('scratch:readMoteAvatar', async (_event, workspaceId, topicId, ref, objectKey) => {
      assert.equal(workspaceId, workspace.id)
      const value = await topics.readAvatar(workspace, topicId, ref, objectKey)
      result.pngReads.push({ workspaceId, topicId, ref, objectKey, pngSha256: sha(nativeImage.createFromDataURL(value.dataUrl).toPNG()) })
      return value
    })
    ipcMain.handle('scratch:listTopics', async (_event, workspaceId) => {
      assert.equal(workspaceId, workspace.id)
      const actual = await topics.list(workspace)
      return { topics: [...actual], issues: actual.issues ?? [] }
    })
    console.log('editor-main: native owner ready')
    win = new BrowserWindow({ width: 1040, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false,
      sandbox: false, backgroundThrottling: false, preload: path.join(path.dirname(html), 'editor-preload.cjs') } })
    win.webContents.on('console-message', event => { if (event.level === 'error') { result.errors.push(event.message); console.error('renderer:', event.message) } })
    console.log('editor-main: window constructed')
    win.showInactive(); win.focus()
    await win.loadURL('about:blank')
    win.webContents.debugger.attach('1.3')
    console.log('editor-main: debugger attached')
    await win.webContents.debugger.sendCommand('Page.enable')
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const entries=[], lookup=new WeakMap(); const track=gl=>{let f=lookup.get(gl);if(!f){f={gl,id:entries.length+1,draws:0,buffers:new Set(),textures:new Set(),programs:new Set()};lookup.set(gl,f);entries.push(f)}return f};
      for(const owner of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])for(const [name,set]of [['createBuffer','buffers'],['createTexture','textures'],['createProgram','programs']]){const create=owner[name],remove=owner[name.replace('create','delete')];owner[name]=function(...a){const value=create.apply(this,a);track(this)[set].add(value);return value};owner[name.replace('create','delete')]=function(value){track(this)[set].delete(value);return remove.call(this,value)}}
      for(const owner of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){if(!owner[name])continue;const original=owner[name];owner[name]=function(...a){track(this).draws++;return original.apply(this,a)}}
      window.seriesGPUFacts=()=>entries.map(f=>({id:f.id,draws:f.draws,buffers:f.gl.isContextLost()?0:f.buffers.size,textures:f.gl.isContextLost()?0:f.textures.size,programs:f.gl.isContextLost()?0:f.programs.size,contextLost:f.gl.isContextLost()}));
      document.addEventListener('webglcontextlost',event=>{const gl=event.target.getContext('webgl2'),f=lookup.get(gl);if(f&&gl.isContextLost()){f.buffers.clear();f.textures.clear();f.programs.clear()}},true);
      const imageSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      Object.defineProperty(HTMLImageElement.prototype,'src',{...imageSource,set(value){
        if(window.holdNextAvatarDecode&&String(value).startsWith('data:image/svg+xml')){
          window.holdNextAvatarDecode=false;const delivered=this.onload;
          this.onload=event=>{window.releaseAvatarDecode=()=>{window.releaseAvatarDecode=null;delivered?.call(this,event)}};
        }
        imageSource.set.call(this,value);
      }});
    })()` })
    console.log('editor-main: loading product')
    await win.loadFile(html, { query: { targets: JSON.stringify(targets) } })
    console.log('editor-main: product loaded')
    const read = script => { if (starter) new Function(script); return win.webContents.executeJavaScript(script) }
    const wait = async script => { for (let index = 0; index < 200; index++) { assert.ok(result.requestStorage.every(value => value.matched), 'The complete original request must survive storage before native Save.'); if (await read(script)) return; await pause(30) } throw new Error('Timed out: ' + script) }
    const key = async (keyCode, modifiers = []) => {
      win.focus(); win.webContents.focus()
      for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers })
      await pause(50)
      result.operations.push({ action: 'trusted-key', keyCode, modifiers, focus: await read('({hasFocus:document.hasFocus(),tag:document.activeElement?.tagName,material:document.activeElement?.dataset.seriesMaterial,focusVisible:document.activeElement?.matches(":focus-visible")})') })
    }
    const point = async selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing production control');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Production control is covered');return {x,y}})()`)
    const click = async selector => {
      const at = await point(selector)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
      console.log('editor-main: click', selector)
      await pause(90); result.operations.push({ action: 'trusted-click', selector, ...at })
    }
    const select = async (selector, value) => {
      const index = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return [...n.options].findIndex(o=>o.value===${JSON.stringify(value)})})()`)
      assert.ok(index >= 0)
      await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}))})()`)
      await pause(100); result.operations.push({ action: 'select-element-change', selector, value, boundary: 'Actual controlled production select change event; source replies remain original Native owner data.' })
      assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), value)
    }
    const selectFacePreset = async () => {
      await select('select[aria-label="Avatar series"]', JSON.stringify(['user', 'fixture-presets']))
      await click('[data-series-origin=user][data-series-id=fixture-presets][data-series-entry=quiet]')
    }
    const selectGeometry = () => select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    const range = async (selector, fraction) => {
      const at = await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+6+(r.width-12)*${fraction},y:r.y+r.height/2}})()`)
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
      await pause(100)
      result.operations.push({ action: 'trusted-range', selector, value: await read(`document.querySelector(${JSON.stringify(selector)}).value`) })
    }
    const ready = () => wait('document.querySelector(".space-icon-picker")?.dataset.seriesDraftReady==="true" && !!document.querySelector(".mote-series__sizes img")')
    const png = () => read('document.querySelector(".mote-series__sizes img")?.src')
    const waitHeldSource = async () => { for (let index = 0; index < 200 && !releases.length; index++) await pause(30); assert.ok(releases.length > 0, 'The actual native source response must be held') }
    const sameFrame = async (expected, message) => assert.equal(sha(await png() ?? ''), sha(expected ?? ''), message)
    const settleSurface = () => read(`(async()=>{
      const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('img')].map(image=>image.decode()));
      const observed=[],started=performance.now();
      for(let attempt=0;attempt<20;attempt++){
        await frame();
        const finite=document.getAnimations().filter(animation=>{
          const timing=animation.effect?.getComputedTiming();
          return (animation instanceof CSSTransition||animation instanceof CSSAnimation)&&
            animation.playState!=='finished'&&animation.playState!=='idle'&&Number.isFinite(timing?.endTime);
        });
        if(!finite.length)return {elapsedMs:performance.now()-started,finite:observed,remainingFinite:0};
        observed.push(...finite.map(animation=>({type:animation instanceof CSSTransition?'transition':'animation',property:animation.transitionProperty??animation.animationName,endTime:animation.effect.getComputedTiming().endTime})));
        await Promise.allSettled(finite.map(animation=>animation.finished));
      }
      throw Error('Finite CSS motion did not settle before capture');
    })()`)
    const captureIdentity = async name => {
      await wait('document.querySelectorAll("#saved-identities img").length===4 && [...document.querySelectorAll("#saved-identities img")].every(n=>n.complete && n.naturalWidth===256)')
      const settled = await settleSurface()
      await fs.writeFile(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png')
      result.operations.push({ action: 'capture-saved-production-identity', name, settled, facts: await read('({choices:seriesEditorFixture.facts().originalChoices,gpu:seriesGPUFacts(),images:[...document.querySelectorAll("#saved-identities img")].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,naturalWidth:n.naturalWidth,source:n.src}))})') })
    }
    const capture = async (name, bottom = false, requireDraft = true) => {
      if (requireDraft) await ready()
      else await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true" && !!document.querySelector(".mote-series__sizes img")')
      await wait(`!document.querySelector('select[aria-label="Avatar series"]').disabled && !document.querySelector('.mote-series__refresh').disabled`)
      await read(`(()=>{const n=document.querySelector(".space-icon-picker");n.scrollTop=${bottom ? 'n.scrollHeight' : '0'}})()`)
      const settled = await settleSurface()
      await fs.writeFile(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png')
      result.operations.push({ action: 'capture', name, settled, facts: await read(`({ target:seriesEditorFixture.facts(),kind:document.querySelector('.mote-series__preview').dataset.seriesPreviewKind,sizes:[...document.querySelectorAll('.mote-series__sizes img')].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,naturalWidth:n.naturalWidth})),gpu:seriesGPUFacts(),renderer:document.querySelector('.mote-series__preview canvas')?.dataset.seriesRenderFacts??null,selectedMaterials:[...document.querySelectorAll('.mote-series__materials button[aria-pressed=true]')].map(n=>({material:n.dataset.seriesMaterial,hovered:n.matches(':hover'),focused:n.matches(':focus-visible'),boxShadow:getComputedStyle(n).boxShadow,background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color})) })`) })
    }
    await wait('!!window.seriesEditorFixture && window.seriesEditorFixture.facts().ready')
    console.log('editor-main: fixture mounted', await read('typeof window.seriesGPUFacts'))
    if (starter) {
      await require('./starter-main.cjs')({ app, BrowserWindow, fs, path, assert, sha, pause, win, read, wait, key, click, select, range, ready, png, settleSurface,
        directory, html, builtinRoot, userRoot, targets, topics, workspace, store, control, AgentMuxControlServer, result })
      result.passed = true
      return
    }
    if (scope === 'face-entry-delta') {
      await wait('document.querySelectorAll("[data-semantic-icon-sprite]").length===1')
      result.themeFacts = await read(`({spriteCount:document.querySelectorAll('[data-semantic-icon-sprite]').length,
        unresolvedSemanticUses:[...document.querySelectorAll('svg.semantic-icon use')].filter(node=>!document.getElementById(node.getAttribute('href').slice(1))).map(node=>node.getAttribute('href')),
        nativeSelectImage:getComputedStyle(document.documentElement).getPropertyValue('--native-select-open-image')})`)
      assert.equal(result.themeFacts.spriteCount, 1)
      assert.deepEqual(result.themeFacts.unresolvedSemanticUses, [], 'Actual theme icons must resolve through the original shared sprite')
      assert.ok(result.themeFacts.nativeSelectImage.includes('data:image/svg+xml'), 'The original theme must project its native select icon')
      result.facePixelFacts = []
      const assertFacePixels = async name => {
        await ready(); await settleSurface()
        const rect = await read(`(()=>{const node=document.querySelector('.mote-series__face > svg'),r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
        assert.ok(rect.width > 0 && rect.height > 0, 'The original center face preview must be actually visible')
        const bounds = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.x + rect.width) - Math.floor(rect.x), height: Math.ceil(rect.y + rect.height) - Math.floor(rect.y) }
        const center = (await win.webContents.capturePage(bounds)).resize({ width: 256, height: 256, quality: 'best' }).toBitmap()
        const exported = nativeImage.createFromDataURL(await png()).resize({ width: 256, height: 256, quality: 'best' }).toBitmap()
        const masks = (pixels, area) => {
          const coordinates = new Set(), box = { left: 256, top: 256, right: -1, bottom: -1 }
          for (let y = area.top; y < area.bottom; y++) for (let x = area.left; x < area.right; x++) {
            const index = (y * 256 + x) * 4
            if (pixels[index + 3] > 220 && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 105) {
              coordinates.add(y * 256 + x); box.left = Math.min(box.left, x); box.top = Math.min(box.top, y); box.right = Math.max(box.right, x); box.bottom = Math.max(box.bottom, y)
            }
          }
          return { coordinates, count: coordinates.size, box }
        }
        const parts = [
          { part: 'brows', left: 64, right: 192, top: 88, bottom: 124 },
          { part: 'eyes', left: 64, right: 192, top: 120, bottom: 164 },
          { part: 'mouth', left: 96, right: 160, top: 168, bottom: 204 }
        ].map(area => {
          const preview = masks(center, area), frame = masks(exported, area)
          const overlap = [...preview.coordinates].filter(value => frame.coordinates.has(value)).length
          const dice = preview.count + frame.count ? overlap * 2 / (preview.count + frame.count) : 0
          const boxDifference = Math.max(...['left', 'top', 'right', 'bottom'].map(key => Math.abs(preview.box[key] - frame.box[key])))
          return { part: area.part, centerInkPixels: preview.count, exportInkPixels: frame.count,
            centerBounds: preview.box, exportBounds: frame.box, overlapDice: dice, boxDifference,
            geometryMatched: preview.count > 32 && frame.count > 32 && boxDifference <= 3 && dice >= 0.7 }
        })
        result.facePixelFacts.push({ name, originalCenterRect: rect, capturedRect: bounds, normalizedBitmapSize: 256, parts })
        assert.ok(parts.every(part => part.geometryMatched), 'Exported face PNG must retain the center preview eyebrow, eye and mouth ink geometry')
      }
      const capturePicker = async name => {
        await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
        await read('document.querySelector(".space-icon-picker").scrollTop=0')
        const settled = await settleSurface()
        await fs.writeFile(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG())
        result.images.push(name + '.png')
        result.operations.push({ action: 'capture-face-entry-product', name, settled,
          facts: await read('({target:seriesEditorFixture.facts().currentTarget,styles:[...document.querySelectorAll("[data-avatar-source]")].map(n=>({id:n.dataset.avatarSource,selected:n.getAttribute("aria-pressed"),disabled:n.disabled})),entries:[...document.querySelectorAll("[data-series-entry]")].map(n=>({origin:n.dataset.seriesOrigin,seriesId:n.dataset.seriesId,entryId:n.dataset.seriesEntry,selected:n.getAttribute("aria-pressed")})),gpu:seriesGPUFacts()})') })
      }
      const entries = () => read('[...document.querySelectorAll("[data-series-entry]")].map(n=>({origin:n.dataset.seriesOrigin,seriesId:n.dataset.seriesId,entryId:n.dataset.seriesEntry,selected:n.getAttribute("aria-pressed")}))')
      const assertNoGuiWrites = () => {
        assert.equal(result.saveCalls.length, 0, 'Opening, switching styles and Cancel must not send GUI Save')
        assert.equal(result.writes, 0, 'Opening, switching styles and Cancel must not write configuration')
        assert.equal(result.flushRequests.length, 0, 'The readonly editor choices must not request a save flush')
      }
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")')
      await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
      const freshBaseline = await control.call('space.mote.avatar.read', { target: targets['launcher:analyst'].avatarTarget })
      assert.equal(freshBaseline.choice, null)
      assert.equal(await read('document.querySelector("[data-avatar-source=face]").getAttribute("aria-pressed")'), 'true')
      assert.equal(await read('document.querySelector("[data-mote-face-part=eyes][data-mote-face-value=wink]").disabled'), false)
      await click('[data-mote-face-part=eyes][data-mote-face-value=wink]')
      assert.equal(await read('document.querySelector("[data-mote-face-part=eyes][data-mote-face-value=wink]").getAttribute("aria-pressed")'), 'true')
      await capturePicker('face-entry-fresh-make-a-face')
      await click('[data-avatar-source=series]')
      await wait('document.querySelectorAll(".mote-series__select option").length>1 && !document.querySelector(".mote-series__refresh").disabled')
      const rawCatalog = await control.call('space.mote.avatar.list', {})
      for (const series of rawCatalog.series.filter(value => value.origin === 'builtin')) {
        await select('select[aria-label="Avatar series"]', JSON.stringify([series.origin, series.seriesId]))
        const actual = (await entries()).map(value => value.entryId)
        const expected = series.entries.filter(value => value.definition.kind !== 'face2d').map(value => value.entryId)
        assert.deepEqual(actual, expected, 'Fresh Series must hide bundled face2d duplicates while retaining image and GLB choices')
      }
      assert.ok(rawCatalog.series.some(series => series.origin === 'builtin' && series.entries.some(entry => entry.definition.kind === 'face2d')), 'The original Native source catalog must retain its bundled face declaration')
      await selectGeometry()
      await capturePicker('face-entry-fresh-series-curated')
      await selectFacePreset(); await ready()
      await select('select[aria-label="Series face Eyes"]', 'wink'); await ready()
      await assertFacePixels('user-preset')
      const userFaceFrame = await png()
      const userPrepared = result.sourceCalls.findLast(call => call.method === 'preview' && call.source?.origin === 'user' && call.source?.seriesId === 'fixture-presets' && call.kind === 'face2d')
      assert.ok(userPrepared, 'The real declared user face must be prepared by the original Native source owner')
      assert.deepEqual((await entries()).map(value => value.entryId), ['quiet', 'portrait'], 'A mixed user face/image series must remain complete')
      await capture('face-entry-user-preset-mixed-series')
      await click('[data-series-origin=user][data-series-id=fixture-presets][data-series-entry=portrait]'); await ready()
      assert.notEqual(await png(), userFaceFrame)
      assert.equal(await read('document.querySelector(".mote-series__preview").dataset.seriesPreviewKind'), 'image')
      await click('[data-avatar-source=face]'); await click('[data-avatar-source=series]'); await ready()
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      assert.deepEqual(await control.call('space.mote.avatar.read', { target: targets['launcher:analyst'].avatarTarget }), freshBaseline)
      assertNoGuiWrites()

      // A prior saved bundled choice is seeded through the same production
      // writer, using this product's genuine 256 PNG and matching face params.
      // This fixture seed is recorded separately from GUI save consumption.
      const source = { origin: 'builtin', seriesId: 'geometry', entryId: originalFace.id }
      const prepared = await control.call('space.mote.avatar.preview', { source })
      assert.deepEqual(prepared.definition, userDeclaration.entries[0].definition)
      const parameters = { kind: 'face2d', face: { ...prepared.definition.face, eyes: 'wink' } }
      const original = await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget })
      const input = { target: original.target, operationId: randomUUID(), beforeRevision: original.revision,
        source: prepared.source, definition: prepared.definition, parameters, pngDataUrl: userFaceFrame }
      const saved = await control.call('space.mote.avatar.save', input)
      result.seedCalls.push({ input, value: saved, producer: 'Actual production Series face renderer; actual production native writer seed, outside GUI Save' })
      assert.equal(saved.state, 'saved'); assert.equal(saved.operation.durability, 'confirmed')
      const confirmed = await control.call('space.mote.avatar.read', { target: original.target, operationId: input.operationId })
      assert.deepEqual(confirmed.choice.source, prepared.source)
      assert.deepEqual(confirmed.choice.definition, prepared.definition)
      assert.deepEqual(confirmed.choice.parameters, parameters)
      assert.deepEqual(nativeImage.createFromDataURL(confirmed.image.dataUrl).getSize(), { width: 256, height: 256 })
      assert.equal(sha(nativeImage.createFromDataURL(confirmed.image.dataUrl).toBitmap()), sha(nativeImage.createFromDataURL(userFaceFrame).toBitmap()))
      await click('#open-avatar'); await ready()
      await wait('!document.querySelector(".mote-series__refresh").disabled')
      assert.equal(await read('document.querySelector("[data-avatar-source=series]").getAttribute("aria-pressed")'), 'true')
      const exactSaved = (await entries()).find(entry => entry.origin === 'builtin' && entry.seriesId === prepared.source.seriesId && entry.entryId === prepared.source.entryId)
      assert.ok(exactSaved && exactSaved.selected === 'true', 'The exact saved bundled face entry must remain visible and selected after reopening')
      assert.equal(await read(`document.querySelector(${JSON.stringify('select[aria-label="Series face Eyes"]')}).value`), 'wink')
      assert.ok(result.sourceCalls.some(call => call.method === 'preview' && call.input.expectedRevision === prepared.source.revision && call.source?.origin === 'builtin' && call.source.entryId === originalFace.id))
      assert.equal(sha(nativeImage.createFromDataURL(await png()).toBitmap()), sha(nativeImage.createFromDataURL(confirmed.image.dataUrl).toBitmap()))
      await assertFacePixels('saved-bundled-preset')
      await capture('face-entry-saved-bundled-preset-reopened')
      await click('[data-avatar-source=face]'); await click('[data-avatar-source=series]'); await ready()
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      const afterCancel = await control.call('space.mote.avatar.read', { target: original.target })
      assert.deepEqual(afterCancel.choice, confirmed.choice)
      assert.equal(afterCancel.revision, confirmed.revision)
      assert.equal(afterCancel.image.dataUrl, confirmed.image.dataUrl)
      assert.equal(result.seedCalls.length, 1); assert.equal(result.publications.length, 1)
      assertNoGuiWrites()
      result.faceEntry = { freshChoice: freshBaseline.choice, saved: confirmed,
        originalCatalog: rawCatalog, guiSaveCalls: result.saveCalls.length, guiConfigWrites: result.writes,
        seedCalls: result.seedCalls.length, sameSavedAfterCancel: true }
      result.operations.push({ action: 'fresh-curation-user-mixed-and-exact-native-saved-choice-preserved-with-zero-gui-writes' })
      result.passed = true
      return
    }
    if (scope === 'request-label-delta') {
      await read('seriesEditorFixture.replaceTarget("launcher:blank")'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
      assert.equal(await read('document.querySelector("[data-avatar-source=face]").getAttribute("aria-pressed")'), 'true')
      assert.equal((await control.call('space.mote.avatar.read', { target: targets['launcher:blank'].avatarTarget })).choice, null)
      assert.equal(result.sourceCalls.length, 0, 'An uncustomized Mote starts with Make a face without promoting Series')
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      assert.ok(!Object.hasOwn(config.appearance.spaceObjectIcons, targets['launcher:blank'].key)); assert.equal(result.saveCalls.length, 0); assert.equal(result.writes, 0)
      result.operations.push({ action: 'uncustomized-mote-face-first-cancel-keeps-original-default', target: targets['launcher:blank'].avatarTarget })
    }
    if (scope === 'durable-reopen') {
      const original = await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget })
      assert.equal(original.choice.kind, 'series')
      await captureIdentity('saved-series-fresh-process')
      assert.equal((await read('seriesGPUFacts()')).length, 0, 'The ordinary saved identities must not instantiate GLB renderers')
      assert.equal(result.sourceCalls.length, 0, 'The ordinary saved identities must not scan source catalogs or prepare models')
      await click('#open-avatar'); await ready()
      assert.equal(await read('document.querySelector("[data-avatar-source=series]").getAttribute("aria-pressed")'), 'true')
      assert.equal(await read('document.querySelector("[data-series-morph=b]").value'), String(original.choice.parameters.morphs.b))
      await capture('saved-series-fresh-process-editable')
      result.reopened = original
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      const before = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8')).persistedUnknown
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await ready(); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      const kept = await read(`seriesEditorFixture.keptRequest(${JSON.stringify(targets['launcher:analyst'].avatarTarget)})`)
      assert.deepEqual(kept, before.input)
      await sameFrame(before.input.pngDataUrl, 'A fresh GUI must retain the original unknown request PNG and parameters')
      assert.equal(await read('document.querySelector(".space-icon-picker").dataset.avatarOperation'), before.input.operationId)
      assert.equal(result.saveCalls.length, 0, 'Reopening an original unknown request only reads; it never automatically saves')
      assert.ok(result.readCalls.some(call => call.input.operationId === before.input.operationId && call.value.operation?.phase === 'publication-unknown'))
      await capture('unknown-series-fresh-process-original-request')
      await click('[data-avatar-retry-save]'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      assert.equal(result.saveCalls.length, 1); assert.deepEqual(result.saveCalls[0].input, before.input)
      assert.equal(result.saveCalls[0].value.state, 'unknown'); assert.equal(result.publications.length, 0)
      assert.deepEqual(config.appearance.spaceObjectIcons[targets['launcher:analyst'].key], before.current.choice)
      result.unknownReopened = { request: kept, current: result.saveCalls[0].value.current }
      result.operations.push({ action: 'second-process-unknown-read-and-explicit-original-request-retry', operationId: kept.operationId })
      result.passed = true
      return
    }
    await click('#open-avatar'); await wait('!!document.querySelector(".space-icon-picker")')
    assert.equal(await read('document.querySelector("[data-space-icon-choice=rocket]").getAttribute("aria-pressed")'), 'true')
    await click('[data-avatar-source=series]'); await wait('document.querySelectorAll(".mote-series__select option").length>1')
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    await click('[data-series-entry=expressive]'); await ready()
    const first = await png(), firstImage = nativeImage.createFromDataURL(first)
    assert.deepEqual(firstImage.getSize(), { width: 256, height: 256 }); assert.ok(firstImage.toPNG().length > 1000)
    result.firstFrame = { sha256: sha(firstImage.toPNG()), bytes: firstImage.toPNG().length }
    assert.deepEqual(await read('[...document.querySelectorAll(".mote-series__sizes img")].map(n=>n.getBoundingClientRect().width)'), [24, 34, 48, 104])
    if (scope === 'request-label-delta') {
      await selectFacePreset(); await ready(); await select('select[aria-label="Series face Eyes"]', 'wink'); await ready()
      await click('.space-icon-picker__save'); await wait('!document.querySelector(".space-icon-picker")')
      const original = targets['launcher:leader'].avatarTarget
      const keyName = 'agentmux.mote-avatar-save-draft.v1:' + JSON.stringify([original.workspaceId, original.topicId, original.objectKey])
      const bytes = '{"original-unreadable-request"'
      await read(`localStorage.setItem(${JSON.stringify(keyName)},${JSON.stringify(bytes)})`)
      await click('#open-avatar'); await ready(); await wait('document.querySelector("[data-avatar-save-notice]")?.textContent.includes("Kept request is unreadable")')
      assert.equal(await read(`localStorage.getItem(${JSON.stringify(keyName)})`), bytes)
      assert.equal(await read('document.querySelector(".space-icon-picker footer > button").textContent'), 'Close')
      await capture('durable-request-bytes-unreadable-kept-close-delta')
      assert.equal(result.saveCalls.length, 1); assert.equal(result.writes, 0)
      result.passed = true
      return
    }
    if (scope === 'durable') {
      await range('[data-series-morph=b]', 0.25); await ready()
      const submittedPng = await png(), publicationsBefore = result.publications.length
      await capture('durable-series-ready-to-save')
      assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), false)
      await click('.space-icon-picker__save'); await wait('!document.querySelector(".space-icon-picker")')
      assert.equal(result.saveCalls.length, 1); assert.equal(result.saveCalls[0].value.state, 'saved')
      assert.equal(result.publications.length, publicationsBefore + 1); assert.equal(result.writes, 0, 'Series publication must not call the old config:save path a second time')
      const saved = await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget, operationId: result.saveCalls[0].input.operationId })
      assert.equal(saved.choice.kind, 'series'); assert.equal(saved.operation.durability, 'confirmed')
      assert.deepEqual(saved.choice.parameters, result.saveCalls[0].input.parameters)
      assert.equal(sha(nativeImage.createFromDataURL(saved.image.dataUrl).toBitmap()), sha(nativeImage.createFromDataURL(submittedPng).toBitmap()))
      await captureIdentity('durable-series-saved-identity')
      const pngReadsBeforeProjection = result.pngReads.length, sourceCallsBeforeProjection = result.sourceCalls.length
      const mobileMetadata = await read('seriesEditorFixture.mobileAppearance(false)'), mobileDetail = await read('seriesEditorFixture.mobileAppearance(true)')
      assert.equal(mobileMetadata.find(value => value.spaceId === targets['launcher:leader'].key).image.dataUrl, null)
      assert.equal(mobileMetadata.find(value => value.spaceId === targets['launcher:leader'].key).image.revision, saved.choice.image.fileName)
      assert.equal(mobileDetail.find(value => value.spaceId === targets['launcher:leader'].key).image.dataUrl, saved.image.dataUrl)
      assert.equal(result.pngReads.length, pngReadsBeforeProjection + 1, 'Only the original selected Mobile image consumer reads PNG bytes')
      assert.equal(result.sourceCalls.length, sourceCallsBeforeProjection, 'Mobile appearance must not scan or prepare editable sources')
      assert.deepEqual(await read(`seriesEditorFixture.facts().originalChoices[${JSON.stringify(targets['launcher:leader'].key)}]`), saved.choice)
      result.operations.push({ action: 'production-mobile-presentation-consumes-original-png-keeps-full-choice', metadata: mobileMetadata, detail: mobileDetail })
      const dailyCalls = result.sourceCalls.length; await pause(160)
      assert.equal(result.sourceCalls.length, dailyCalls); assert.ok((await read('seriesGPUFacts()')).every(value => value.contextLost))
      await click('#open-avatar'); await ready()
      assert.equal(await read('document.querySelector("[data-series-morph=b]").value'), String(saved.choice.parameters.morphs.b))
      assert.ok(result.sourceCalls.filter(call => call.method === 'preview').every(call => !Object.hasOwn(call.input.source, 'revision')), 'Preview receives a Locator with expectedRevision separate')
      await capture('durable-series-saved-reopened')
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      const model = path.join(builtinRoot, 'geometry/RobotExpressive.glb')
      await fs.rename(model, model + '.kept')
      await click('#open-avatar'); await wait('!!document.querySelector(".mote-series .mote-series__notice")')
      await sameFrame(saved.image.dataUrl, 'Losing the editable source must retain the actual saved PNG')
      assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), true)
      await capture('durable-saved-source-unavailable', false, false)
      assert.equal(config.appearance.spaceObjectIcons[targets['launcher:leader'].key].source.revision, saved.choice.source.revision)
      await fs.rename(model + '.kept', model); await click('.mote-series .mote-series__notice button'); await ready()
      assert.equal(await read('document.querySelector("[data-series-morph=b]").value'), String(saved.choice.parameters.morphs.b))
      await capture('durable-source-restored-original-parameters')
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
      await click('[data-avatar-source=series]'); await wait('document.querySelectorAll(".mote-series__select option").length>1')
      await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
      await selectFacePreset(); await ready()
      loseAckOnce = true
      const retryStart = result.saveCalls.length, beforeRetryPublication = result.publications.length
      await click('.space-icon-picker__save'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      const originalOperation = await read('document.querySelector(".space-icon-picker").dataset.avatarOperation')
      assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), true)
      await capture('durable-lost-ack-keeps-draft')
      win.setContentSize(440, 900); await capture('durable-lost-ack-narrow-top'); await capture('durable-lost-ack-narrow-controls', true); win.setContentSize(1040, 900)
      await click('[data-avatar-retry-save]')
      for (let index = 0; index < 200 && result.saveCalls.length < retryStart + 2; index++) await pause(30)
      assert.equal(result.saveCalls.length, retryStart + 2)
      assert.deepEqual(result.saveCalls[retryStart].input, result.saveCalls[retryStart + 1].input)
      assert.equal(result.saveCalls[retryStart + 1].input.operationId, originalOperation)
      await wait('!document.querySelector(".space-icon-picker")')
      assert.equal(result.publications.length, beforeRetryPublication + 1, 'A confirmed original operation retry must not publish again')
      result.operations.push({ action: 'unknown-retry-keeps-original-complete-request-and-uuid', operationId: originalOperation })
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await ready()
      await select('select[aria-label="Series face Eyes"]', 'oval'); await ready()
      loseAckOnce = true
      await click('.space-icon-picker__save'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      const inspectOperation = await read('document.querySelector(".space-icon-picker").dataset.avatarOperation'), savesBeforeInspect = result.saveCalls.length
      await click('[data-avatar-inspect-save]'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="saved"')
      assert.equal(result.saveCalls.length, savesBeforeInspect)
      assert.ok(result.readCalls.some(call => call.input.operationId === inspectOperation && call.value.operation?.durability === 'confirmed'))
      await capture('durable-original-operation-inspected')
      result.operations.push({ action: 'unknown-inspect-original-ack-without-new-publication', operationId: inspectOperation })
      await select('select[aria-label="Series face Eyes"]', 'wink'); await ready(); loseAckOnce = true
      await click('.space-icon-picker__save'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      const keptOperation = await read('document.querySelector(".space-icon-picker").dataset.avatarOperation'), savesBeforeClose = result.saveCalls.length
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await ready(); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="saved"')
      assert.equal(result.saveCalls.length, savesBeforeClose)
      assert.ok(result.readCalls.some(call => call.input.operationId === keptOperation && call.value.operation?.durability === 'confirmed'))
      result.operations.push({ action: 'closed-unknown-editor-keeps-original-request-for-read-only-reconciliation', operationId: keptOperation })
      historicalChoiceOnce = { key: targets['launcher:analyst'].key, choice: 'gem' }
      await select('select[aria-label="Series face Eyes"]', 'round'); await ready()
      await click('.space-icon-picker__save'); await wait('!document.querySelector(".space-icon-picker")')
      assert.equal(result.saveCalls.at(-1).value.state, 'saved')
      assert.equal(result.saveCalls.at(-1).value.current.choice, 'gem')
      assert.equal(await read(`seriesEditorFixture.facts().originalChoices[${JSON.stringify(targets['launcher:analyst'].key)}]`), 'gem', 'Historical ACK must retain the original config owner later choice')
      result.operations.push({ action: 'historical-saved-ack-retains-later-current-choice', choice: 'gem' })
      holdReadKey = targets['launcher:leader'].key
      await click('#open-avatar')
      for (let index = 0; index < 200 && !heldReads.length; index++) await pause(30)
      assert.ok(heldReads.length)
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
      holdReadKey = null; heldReads.splice(0).forEach(resolve => resolve()); await pause(100)
      assert.equal(await read('document.querySelector("[data-space-icon-choice=gem]").getAttribute("aria-pressed")'), 'true')
      assert.equal(await read('document.querySelector(".mote-series")?.dataset.seriesTarget'), targets['launcher:analyst'].key)
      result.operations.push({ action: 'late-original-baseline-cannot-populate-replaced-target' })
      await click('[data-avatar-source=series]'); await wait('document.querySelectorAll(".mote-series__select option").length>1')
      await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry'])); await selectFacePreset(); await ready()
      holdSaveKey = targets['launcher:analyst'].key
      await click('.space-icon-picker__save')
      for (let index = 0; index < 200 && !heldSaves.length; index++) await pause(30)
      assert.ok(heldSaves.length)
      await read('seriesEditorFixture.replaceTarget("launcher:leader")'); await ready()
      const correctPrimary = await png()
      holdSaveKey = null; heldSaves.splice(0).forEach(resolve => resolve()); await pause(160)
      assert.equal(await read('seriesEditorFixture.facts().currentTarget.key'), targets['launcher:leader'].key)
      assert.ok(await read('!!document.querySelector(".space-icon-picker")'), 'A late saved acknowledgement must not close a different original editor')
      await sameFrame(correctPrimary, 'A late saved acknowledgement must not replace the different target draft')
      assert.equal(result.saveCalls.at(-1).input.target.objectKey, targets['launcher:analyst'].key)
      result.operations.push({ action: 'late-original-save-ack-fences-new-target-draft-and-close' })
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await ready()
      await select('select[aria-label="Series face Eyes"]', 'wink'); await ready()
      const refusedDraft = await png(), beforeRefusedPublication = result.publications.length
      await owner.update(current => ({ ...current, appearance: { ...current.appearance, spaceObjectIcons: { ...current.appearance.spaceObjectIcons, [targets['launcher:analyst'].key]: 'rocket' } } }))
      await click('.space-icon-picker__save'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="refused"')
      const refused = result.saveCalls.at(-1)
      assert.equal(refused.value.state, 'refused'); assert.equal(result.publications.length, beforeRefusedPublication + 1)
      await sameFrame(refusedDraft, 'A real refused save must retain the editable draft')
      assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), true)
      await capture('durable-refused-save-keeps-draft')
      await click('[data-avatar-review-current]'); await wait('!document.querySelector(".space-icon-picker").dataset.avatarSaveState')
      await sameFrame(refusedDraft, 'Reviewing the original current choice must retain the draft')
      const savesBeforeNewIntent = result.saveCalls.length
      await click('.space-icon-picker__save'); await wait('!document.querySelector(".space-icon-picker")')
      assert.equal(result.saveCalls.length, savesBeforeNewIntent + 1); assert.equal(result.saveCalls.at(-1).value.state, 'saved')
      assert.notEqual(result.saveCalls.at(-1).input.operationId, refused.input.operationId)
      assert.notEqual(result.saveCalls.at(-1).input.beforeRevision, refused.input.beforeRevision)
      result.operations.push({ action: 'refused-save-keeps-draft-review-current-then-explicit-new-intent', refusedOperationId: refused.input.operationId, newOperationId: result.saveCalls.at(-1).input.operationId })
      await read('seriesEditorFixture.replaceTarget("launcher:analyst")'); await ready()
      const requestKey = 'agentmux.mote-avatar-save-draft.v1:' + JSON.stringify(Object.values(targets['launcher:analyst'].avatarTarget))
      const damagedRequestBytes = '{"original-unreadable-request"'
      await read(`localStorage.setItem(${JSON.stringify(requestKey)},${JSON.stringify(damagedRequestBytes)})`)
      await read('seriesEditorFixture.mountPicker(false)'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.mountPicker(true)'); await ready(); await wait('document.querySelector("[data-avatar-save-notice]")?.textContent.includes("Kept request is unreadable")')
      assert.equal(await read(`localStorage.getItem(${JSON.stringify(requestKey)})`), damagedRequestBytes, 'An unreadable original request must not be normalized or overwritten')
      assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), true)
      await capture('durable-request-bytes-unreadable-kept')
      await read(`localStorage.removeItem(${JSON.stringify(requestKey)})`)
      await read('seriesEditorFixture.mountPicker(false)'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.mountPicker(true)'); await ready()
      await select('select[aria-label="Series face Eyes"]', 'round'); await ready()
      failFlushAt = result.flushRequests.length + 2
      await click('.space-icon-picker__save'); await wait('document.querySelector("[data-avatar-save-notice]")?.textContent.includes("Request cleanup is unconfirmed")')
      const cleanupRequest = result.saveCalls.at(-1).input, savesBeforeCleanup = result.saveCalls.length
      assert.equal(result.saveCalls.at(-1).value.state, 'saved')
      assert.deepEqual(await read(`seriesEditorFixture.keptRequest(${JSON.stringify(targets['launcher:analyst'].avatarTarget)})`), cleanupRequest, 'A failed retirement flush must restore the same original request')
      await capture('durable-confirmed-request-retirement-unconfirmed')
      await click('[data-avatar-review-current]'); await wait('document.querySelector(".space-icon-picker__save")?.disabled===false')
      assert.equal(await read(`localStorage.getItem(${JSON.stringify(requestKey)})`), null)
      assert.equal(result.saveCalls.length, savesBeforeCleanup, 'Retirement reconciliation only reads the original native operation')
      await select('select[aria-label="Series face Eyes"]', 'oval'); await ready()
      const beforeStorageFailure = result.saveCalls.length, originalCurrent = structuredClone(config.appearance.spaceObjectIcons[targets['launcher:analyst'].key])
      failFlushOnce = true
      await click('.space-icon-picker__save'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unsent"')
      assert.equal(result.saveCalls.length, beforeStorageFailure, 'A failed storage flush request must not send native Save')
      const originalRequest = await read(`seriesEditorFixture.keptRequest(${JSON.stringify(targets['launcher:analyst'].avatarTarget)})`)
      assert.ok(originalRequest); assert.equal(originalRequest.operationId, await read('document.querySelector(".space-icon-picker").dataset.avatarOperation'))
      assert.deepEqual(config.appearance.spaceObjectIcons[targets['launcher:analyst'].key], originalCurrent)
      await capture('durable-request-storage-unconfirmed-keeps-draft')
      await click('[data-avatar-source=alternative]'); assert.equal(await read('document.querySelector(".space-icon-picker__save").disabled'), false, 'A refused request-storage step must keep the legacy icon capability')
      await click('[data-avatar-source=series]'); await ready()
      failNativePublicationOnce = true
      await click('[data-avatar-retry-save]'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      assert.equal(result.saveCalls.length, beforeStorageFailure + 1); assert.deepEqual(result.saveCalls.at(-1).input, originalRequest)
      assert.equal(result.saveCalls.at(-1).value.state, 'unknown'); assert.equal(result.saveCalls.at(-1).value.operation.phase, 'publication-unknown')
      result.persistedUnknown = result.saveCalls.at(-1).value
      result.persistedUnknown.input = originalRequest
      const callsBeforeRemount = result.saveCalls.length
      await read('seriesEditorFixture.mountPicker(false)'); await wait('!document.querySelector(".space-icon-picker")')
      await read('seriesEditorFixture.mountPicker(true)'); await ready(); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarSaveState==="unknown"')
      assert.equal(result.saveCalls.length, callsBeforeRemount, 'A real Picker remount must only inspect the original operation')
      await sameFrame(originalRequest.pngDataUrl, 'A real Picker remount must restore the original unknown draft')
      assert.equal(await read('document.querySelector(".space-icon-picker").dataset.avatarOperation'), originalRequest.operationId)
      await capture('durable-unknown-request-after-picker-remount')
      result.operations.push({ action: 'kept-request-survives-picker-unmount-remount-without-auto-save', operationId: originalRequest.operationId })
      await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
      result.finalPrimary = await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget })
      assert.deepEqual(result.finalPrimary.choice, saved.choice)
      assert.equal(result.writes, 0)
      result.passed = true
      return
    }
    await capture('editor-glb-normal-dark')
    await range('[data-series-morph=b]', 0.25); await ready(); assert.notEqual(await png(), first)
    await click('[data-series-material=toon]'); await ready(); assert.notEqual(await png(), first); await capture('editor-toon-dark')
    if (scope === 'visual-delta') {
      const selected = result.operations.find(operation => operation.name === 'editor-toon-dark').facts.selectedMaterials[0]
      assert.equal(selected.hovered, true, 'Capture the original selected material while the native pointer remains over it')
      assert.ok(selected.boxShadow.includes('inset'), 'Selected material must retain its shape while hovered')
      for (let attempt = 0; attempt < 32; attempt++) {
        await key('Tab')
        if (await read('document.activeElement?.dataset.seriesMaterial==="toon" && document.activeElement.matches(":focus-visible")')) break
      }
      await capture('editor-toon-focused-dark')
      const focused = result.operations.find(operation => operation.name === 'editor-toon-focused-dark').facts.selectedMaterials[0]
      assert.equal(focused.focused, true, 'The selected material must be keyboard focused')
      assert.ok(focused.boxShadow.includes('inset'), 'Selected material must retain its shape while keyboard focused')
    }
    await click('[aria-label="Reset series adjustments"]'); await ready(); assert.equal(await png(), first)
    await read('seriesEditorFixture.theme(true)'); await capture('editor-glb-normal-light')
    win.setContentSize(440, 900); await pause(100); await capture('editor-glb-narrow-light')
    await capture('editor-glb-narrow-light-controls', true)
    await read('seriesEditorFixture.theme(false)'); await capture('editor-glb-narrow-dark')
    await capture('editor-glb-narrow-dark-controls', true)
    if (scope === 'visual-delta') {
      assert.equal(result.writes, 0); assert.ok(result.sourceCalls.some(call => call.kind === 'glb'))
      assert.ok(result.operations.filter(operation => operation.action === 'capture').every(operation => operation.settled.remainingFinite === 0))
      const toonCapture = result.operations.find(operation => operation.name === 'editor-toon-dark')
      assert.equal(toonCapture.facts.selectedMaterials[0].material, 'toon')
      assert.ok(toonCapture.facts.selectedMaterials[0].boxShadow.includes('inset'), 'Selected material must retain its shape while hovered')
      result.passed = true
      return
    }
    win.setContentSize(1040, 900)
    await selectFacePreset(); await ready(); const face = await png(); assert.notEqual(face, first)
    await select('select[aria-label="Series face Eyes"]', 'round'); await ready(); assert.notEqual(await png(), face); await capture('editor-face-dark')
    await read('window.holdNextAvatarDecode=true')
    await select('select[aria-label="Series face Eyes"]', 'oval'); await wait('typeof window.releaseAvatarDecode==="function"')
    await select('select[aria-label="Series face Eyes"]', 'calm'); await ready(); const latestFace = await png()
    await read('window.releaseAvatarDecode()'); await pause(150)
    await sameFrame(latestFace, 'A late original SVG decode must not replace newer parameters')
    result.operations.push({ action: 'late-original-svg-decode-retains-newer-parameters', image: sha(latestFace), boundary: 'The original native SVG image decode callback was held and then delivered; no pixels or draft were fabricated.' })
    await selectGeometry(); await click('[data-series-entry=owl]'); await ready(); const image = await png(); assert.notEqual(image, face)
    await range('[aria-label="Series image zoom"]', 0.5); await ready(); assert.notEqual(await png(), image); await capture('editor-image-dark')
    hold = true; await click('[data-series-entry=owl]'); await waitHeldSource()
    await selectFacePreset(); await ready(); const newer = await png()
    hold = false; releases.splice(0).forEach(resolve => resolve()); await pause(200)
    await sameFrame(newer, 'A late actual native source must not replace the newer draft'); assert.equal(await read('document.querySelector(".mote-series__preview").dataset.seriesPreviewKind'), 'face2d')
    result.operations.push({ action: 'late-original-native-source-retained-newer-draft', image: sha(newer) })
    await fs.copyFile(path.join(builtinRoot, 'geometry/owl.png'), path.join(userRoot, 'personal/new.png'))
    const listsBeforeRefresh = result.sourceCalls.filter(call => call.method === 'list').length
    await click('[aria-label="Refresh avatar series"]'); await wait('!document.querySelector(".mote-series__refresh").disabled')
    assert.ok(result.sourceCalls.filter(call => call.method === 'list').length > listsBeforeRefresh)
    await sameFrame(newer, 'Refreshing the actual catalog must keep the current source and parameters')
    await select('select[aria-label="Avatar series"]', JSON.stringify(['user', 'personal']))
    await wait(`!!document.querySelector('[data-series-entry="new.png"]')`); await sameFrame(newer)
    result.operations.push({ action: 'catalog-refresh-discovers-new-native-file-keeps-current-draft', newEntry: 'new.png' })
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    await wait(`!!document.querySelector('[data-series-entry="owl"] .mote-series__thumbnail img')`)
    hold = true; await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'lowpoly'])); await waitHeldSource()
    assert.equal(await read('document.querySelector("[data-series-entry=owl] .mote-series__thumbnail img")?.src'), undefined, 'A reused entry id must not display the previous series image while native preview is pending')
    hold = false; releases.splice(0).forEach(resolve => resolve())
    await wait(`!!document.querySelector('[data-series-entry="owl"] .mote-series__thumbnail img')`)
    assert.equal(sha(await read('document.querySelector("[data-series-entry=owl] .mote-series__thumbnail img").src')),
      result.sourceCalls.findLast(call => call.source?.seriesId === 'lowpoly' && call.source?.entryId === 'owl').imageSha256)
    await sameFrame(newer, 'Switching source catalog series must keep the edited current source')
    result.operations.push({ action: 'same-entry-id-thumbnail-bound-to-original-series' })
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    const owl = path.join(builtinRoot, 'geometry/owl.png'); await fs.rename(owl, owl + '.kept')
    await click('[data-series-entry=owl]'); await wait('!!document.querySelector(".mote-series__notice")')
    assert.equal(await png(), newer); assert.equal(await read('document.querySelector("[data-avatar-source=face]").disabled'), false)
    await capture('editor-source-failure-keeps-draft')
    await fs.rename(owl + '.kept', owl); await click('.mote-series__notice button'); await ready()
    await click('[data-series-entry=expressive]'); await ready()
    const beforeGPU = await read('seriesGPUFacts()')
    await click('[data-avatar-source=alternative]'); await pause(100)
    const disposedGPU = await read('seriesGPUFacts()')
    assert.equal(disposedGPU.at(-1).buffers, 0); assert.equal(disposedGPU.at(-1).textures, 0); assert.equal(disposedGPU.at(-1).programs, 0)
    await pause(150); assert.deepEqual(await read('seriesGPUFacts()'), disposedGPU)
    result.operations.push({ action: 'inactive-editor-disposes-owned-glb', beforeGPU, disposedGPU })
    assert.equal(await read('document.querySelector("[data-space-icon-choice=rocket]").getAttribute("aria-pressed")'), 'true')
    await click('[data-avatar-source=series]'); await ready()
    await read('document.querySelector(".mote-series__preview canvas").getContext("webgl2").getExtension("WEBGL_lose_context").loseContext()')
    await wait('document.querySelector(".mote-series__notice")?.textContent.includes("3D preview")')
    const kept = await png(); await click('.mote-series__notice button'); await wait('!document.querySelector(".mote-series__preview canvas").getContext("webgl2").isContextLost() && !document.querySelector(".mote-series__notice")'); await ready(); assert.equal(await png(), kept)
    result.operations.push({ action: 'real-context-loss-retry-keeps-original-frame' })
    hold = true; await click('[data-series-entry=owl]'); await waitHeldSource()
    await read('seriesEditorFixture.replaceTarget("launcher:analyst")')
    await wait('document.querySelector(".mote-series")?.dataset.seriesTarget.includes("analyst")')
    await click('[data-avatar-source=series]'); await wait('document.querySelectorAll(".mote-series__select option").length>1')
    assert.equal(await read('document.querySelector(".mote-series__preview").dataset.seriesPreviewKind'), 'empty', 'A different original Mote must receive an empty editor rather than the old draft')
    assert.equal(await png(), undefined)
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    await selectFacePreset(); await ready(); const newTargetFrame = await png()
    hold = false; releases.splice(0).forEach(resolve => resolve()); await pause(200)
    await sameFrame(newTargetFrame, 'A late source for the old target must not populate the new target')
    result.operations.push({ action: 'replaced-original-target-fences-old-source-and-draft', target: await read('seriesEditorFixture.facts().currentTarget'), image: sha(newTargetFrame) })
    await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
    assert.equal(result.writes, 0); assert.ok(result.sourceCalls.some(call => call.kind === 'glb')); assert.ok(result.sourceCalls.some(call => call.kind === 'face2d')); assert.ok(result.sourceCalls.some(call => call.kind === 'image'))
    result.gpuAfterClose = await read('seriesGPUFacts()'); assert.equal(result.gpuAfterClose.at(-1).buffers, 0)
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack, ...(starter && error.code ? { code: error.code } : {}) }
    if (win) { result.failedFrame = await win.webContents.executeJavaScript('({text:document.body.textContent,html:document.body.innerHTML})').catch(() => null); await fs.writeFile(path.join(directory, 'failed.png'), (await win.webContents.capturePage()).toPNG()); if (starter) result.images.push('failed.png') }
  } finally { await fs.writeFile(path.join(directory, scope === 'durable-reopen' ? 'reader-result.json' : 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
