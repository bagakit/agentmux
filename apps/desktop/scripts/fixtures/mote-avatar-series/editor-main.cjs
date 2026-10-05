const { app, BrowserWindow, Menu, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto')
const [html, directory, originalBuiltin, scope = 'full'] = process.argv.slice(2)
app.setPath('userData', path.join(directory, 'userData'))
const result = { passed: false, scope, pid: process.pid, images: [], operations: [], sourceCalls: [], errors: [], writes: 0 }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash('sha256').update(value).digest('hex')
app.whenReady().then(async () => {
  console.log('editor-main: ready')
  let win, hold = false, releases = []
  try {
    Menu.setApplicationMenu(null)
    const { MoteAvatarSeriesOwner, MoteAvatarControl } = require(path.join(path.dirname(html), 'editor-native.cjs'))
    const builtinRoot = path.join(directory, 'builtin'), userRoot = path.join(directory, 'avatars')
    await fs.cp(originalBuiltin, builtinRoot, { recursive: true })
    await fs.mkdir(path.join(userRoot, 'personal'), { recursive: true })
    await fs.copyFile(path.join(builtinRoot, 'geometry/owl.png'), path.join(userRoot, 'personal/own.png'))
    const workspace = path.join(directory, 'workspace/.agentmux/scratch')
    for (const name of ['topic--launcher--leader', 'topic--launcher--analyst']) {
      await fs.mkdir(path.join(workspace, name), { recursive: true })
      await fs.writeFile(path.join(workspace, name, 'topic.md'), '# Fixture Mote\n')
      await fs.writeFile(path.join(workspace, name, 'SOUL.md'), '# Original fixture Mote\n')
    }
    const control = new MoteAvatarControl(new MoteAvatarSeriesOwner({ userRoot, builtinRoot }))
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
    ipcMain.handle('config:save', () => { result.writes++; throw new Error('T-002 never publishes a configuration.') })
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
    await win.loadFile(html, { query: { workspace } })
    console.log('editor-main: product loaded')
    const read = script => win.webContents.executeJavaScript(script)
    const wait = async script => { for (let index = 0; index < 200; index++) { if (await read(script)) return; await pause(30) } throw new Error('Timed out: ' + script) }
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
    const capture = async (name, bottom = false) => {
      await ready()
      await wait(`!document.querySelector('select[aria-label="Avatar series"]').disabled && !document.querySelector('.mote-series__refresh').disabled`)
      await read(`(()=>{const n=document.querySelector(".space-icon-picker");n.scrollTop=${bottom ? 'n.scrollHeight' : '0'}})()`)
      const settled = await read(`(async()=>{
        const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        await document.fonts.ready;
        await Promise.all([...document.querySelectorAll('.space-icon-picker img')].map(image=>image.decode()));
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
      await fs.writeFile(path.join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png')
      result.operations.push({ action: 'capture', name, settled, facts: await read(`({ target:seriesEditorFixture.facts(),kind:document.querySelector('.mote-series__preview').dataset.seriesPreviewKind,sizes:[...document.querySelectorAll('.mote-series__sizes img')].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height,naturalWidth:n.naturalWidth})),gpu:seriesGPUFacts(),renderer:document.querySelector('.mote-series__preview canvas')?.dataset.seriesRenderFacts??null,selectedMaterials:[...document.querySelectorAll('.mote-series__materials button[aria-pressed=true]')].map(n=>({material:n.dataset.seriesMaterial,hovered:n.matches(':hover'),focused:n.matches(':focus-visible'),boxShadow:getComputedStyle(n).boxShadow,background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color})) })`) })
    }
    await wait('!!window.seriesEditorFixture')
    console.log('editor-main: fixture mounted', await read('typeof window.seriesGPUFacts'))
    await click('#open-avatar'); await wait('!!document.querySelector(".space-icon-picker")')
    assert.equal(await read('document.querySelector("[data-space-icon-choice=rocket]").getAttribute("aria-pressed")'), 'true')
    await click('[data-avatar-source=series]'); await wait('document.querySelectorAll(".mote-series__select option").length>1')
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'geometry']))
    await click('[data-series-entry=expressive]'); await ready()
    const first = await png(), firstImage = nativeImage.createFromDataURL(first)
    assert.deepEqual(firstImage.getSize(), { width: 256, height: 256 }); assert.ok(firstImage.toPNG().length > 1000)
    result.firstFrame = { sha256: sha(firstImage.toPNG()), bytes: firstImage.toPNG().length }
    assert.deepEqual(await read('[...document.querySelectorAll(".mote-series__sizes img")].map(n=>n.getBoundingClientRect().width)'), [24, 34, 48, 104])
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
    await click('[data-series-entry=quiet]'); await ready(); const face = await png(); assert.notEqual(face, first)
    await select('select[aria-label="Series face Eyes"]', 'round'); await ready(); assert.notEqual(await png(), face); await capture('editor-face-dark')
    await read('window.holdNextAvatarDecode=true')
    await select('select[aria-label="Series face Eyes"]', 'oval'); await wait('typeof window.releaseAvatarDecode==="function"')
    await select('select[aria-label="Series face Eyes"]', 'calm'); await ready(); const latestFace = await png()
    await read('window.releaseAvatarDecode()'); await pause(150)
    await sameFrame(latestFace, 'A late original SVG decode must not replace newer parameters')
    result.operations.push({ action: 'late-original-svg-decode-retains-newer-parameters', image: sha(latestFace), boundary: 'The original native SVG image decode callback was held and then delivered; no pixels or draft were fabricated.' })
    await click('[data-series-entry=owl]'); await ready(); const image = await png(); assert.notEqual(image, face)
    await range('[aria-label="Series image zoom"]', 0.5); await ready(); assert.notEqual(await png(), image); await capture('editor-image-dark')
    hold = true; await click('[data-series-entry=owl]'); await waitHeldSource()
    await click('[data-series-entry=quiet]'); await ready(); const newer = await png()
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
    await click('[data-series-entry=quiet]'); await ready(); const newTargetFrame = await png()
    hold = false; releases.splice(0).forEach(resolve => resolve()); await pause(200)
    await sameFrame(newTargetFrame, 'A late source for the old target must not populate the new target')
    result.operations.push({ action: 'replaced-original-target-fences-old-source-and-draft', target: await read('seriesEditorFixture.facts().currentTarget'), image: sha(newTargetFrame) })
    await key('Escape'); await wait('!document.querySelector(".space-icon-picker")')
    assert.equal(result.writes, 0); assert.ok(result.sourceCalls.some(call => call.kind === 'glb')); assert.ok(result.sourceCalls.some(call => call.kind === 'face2d')); assert.ok(result.sourceCalls.some(call => call.kind === 'image'))
    result.gpuAfterClose = await read('seriesGPUFacts()'); assert.equal(result.gpuAfterClose.at(-1).buffers, 0)
    result.passed = true
  } catch (error) {
    result.error = { message: error.message, stack: error.stack }
    if (win) { result.failedFrame = await win.webContents.executeJavaScript('({text:document.body.textContent,html:document.body.innerHTML})').catch(() => null); await fs.writeFile(path.join(directory, 'failed.png'), (await win.webContents.capturePage()).toPNG()) }
  } finally { await fs.writeFile(path.join(directory, 'renderer-result.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
