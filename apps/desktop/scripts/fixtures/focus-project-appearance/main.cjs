const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), vm = require('node:vm')
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const [html, privateRoot, evidence, mode] = process.argv.slice(2)
const containerOrder = mode === '--container-order', compactDiscussion = mode === '--group-compact'
const combinedPreferences = mode === '--focus-preferences'
const selectionSettings = mode === '--selection-settings' || combinedPreferences
const groupOrganization = mode === '--group-organization' || combinedPreferences
const groupDiscussion = mode === '--group-discussion' || compactDiscussion || groupOrganization
const neutralSurfaces = mode === '--neutral-surfaces'
const savedInProject = mode === '--saved-in-project'
const takeoverRecipients = mode === '--takeover-recipients'
const savedInputs = mode === '--saved-inputs'
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-project-appearance-actual.v1', passed: false, frames: [], scenarios: [], rendererConsole: [],
  boundary: 'Actual App/GlobalFocusSurface/project preference consumer. Private image transport uses original Main projectAppearance on controlled fixture files; PTY/Monaco painting and Runtime are isolated. No user navigation, Session control, restart or installation proof.' }
let win
app.whenReady().then(async () => { try {
  const imageRoot = path.join(privateRoot, 'project-image'), emptyRoot = path.join(privateRoot, 'project-empty')
  await fs.mkdir(imageRoot); await fs.mkdir(emptyRoot)
  await fs.mkdir(path.join(imageRoot, 'apps/client/resources'), { recursive: true })
  await fs.copyFile(path.join(process.cwd(), 'apps/desktop/resources/icon.png'), path.join(imageRoot, 'apps/client/resources/icon.png'))
  const { projectAppearance } = require(path.join(privateRoot, 'project-appearance.cjs'))
  const imageCalls = []
  ipcMain.handle('project-appearance-proof:read', async (_event, id) => {
    const root = id === 'alpha' ? imageRoot : emptyRoot
    const value = await projectAppearance(root, bytes => nativeImage.createFromBuffer(bytes)); imageCalls.push({ workspaceId: id, realImage: Boolean(value.icon), kind: value.kind }); return value
  })
  const preload = path.join(privateRoot, 'appearance-preload.cjs')
  await fs.writeFile(preload, "const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('projectAppearanceFixture',{read:id=>ipcRenderer.invoke('project-appearance-proof:read',id)});")
  win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 1600)) })
  const read = async code => { new vm.Script(code); try { return await win.webContents.executeJavaScript(code) } catch (error) { throw new Error(error.message + '\nEvaluation: ' + code.slice(0, 1200)) } }
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(40) } while (Date.now() < end); throw Error('Appearance scene did not settle: ' + label) }
  const settle = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const geometry = async target => read(`(()=>{
    const surface=document.querySelector('.global-focus-surface'),proof=window.appearanceProof.facts();
    const selected=${target === 'takeover-recipient' ? 'window.takeoverRecipientTarget' : target === 'saved-history' ? 'window.savedHistoryTarget' : target === 'settings' ? 'document.querySelector("[data-settings-page=focus]")' : target === 'preview' ? 'document.querySelector(".focus-settings-preview [data-focus-agent-selected=true]")' : target === 'focused' ? 'document.activeElement' : target === 'workface' ? 'document.querySelector("[data-owner-tab=original]")' : target === 'recipient' ? 'document.querySelector(".composer-menu")' : target === 'launcher' ? 'document.querySelector(".launch-surface")' : target === 'selected' ? 'document.querySelector(".focus-context.is-selected[data-session-id=alpha-working]")' : target === 'section' ? 'window.containerOrderSection' : target === 'collection' ? "[...document.querySelectorAll('[data-focus-container-key]')].find(e=>e.dataset.focusContainerKey===window.appearanceProof.collectionKey)" : target === 'search' ? "document.querySelector('.focus-search-results')" : target === 'local' ? "document.querySelector('.focus-local-inputs')" : target === 'menu' ? "document.querySelector('[data-focus-project-preferences]')" : "[...document.querySelectorAll('[data-project-group-key]')].find(e=>e.dataset.projectGroupKey===JSON.stringify(['local','alpha']))?.querySelector('.focus-project-frame__heading')"};
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const r=rect(selected),x=r?Math.min(innerWidth-1,Math.max(1,(r.left+r.right)/2)):0,y=r?Math.min(innerHeight-1,Math.max(1,(r.top+r.bottom)/2)):0;
    return{mainSurface:proof.mainSurface,focusView:proof.focusView,appearance:document.documentElement.dataset.appearance,focus:rect(surface),inert:!!surface?.closest('[inert]'),visible:!!surface&&!surface.hidden&&(surface.getAttribute('aria-hidden')!=='true'||${JSON.stringify(target)}==='local')&&getComputedStyle(surface).display!=='none'&&getComputedStyle(surface).visibility!=='hidden',target:rect(selected),targetRole:selected?.closest('[role=dialog]')?.getAttribute('role'),targetHit:!!selected&&selected.contains(document.elementFromPoint(x,y)),hitElement:document.elementFromPoint(x,y)?.outerHTML.slice(0,600),targetPointerEvents:selected?getComputedStyle(selected).pointerEvents:null,hoverPreviews:[...document.querySelectorAll('.focus-context-hover')].map(e=>({rect:rect(e),pointerEvents:getComputedStyle(e).pointerEvents})),viewport:{width:innerWidth,height:innerHeight}};
  })()`)
  const ensureFocus = async () => {
    if (!await read("(()=>{const e=document.querySelector('.global-focus-surface');return !!e&&!e.hidden&&!e.closest('[inert]')&&getComputedStyle(e).display!=='none'})()")) await click('button.surface-navigation__focus')
    await until('actual visible Focus surface', () => read("(()=>{const e=document.querySelector('.global-focus-surface');return window.appearanceProof.facts().mainSurface==='agents'&&!!e&&!e.hidden&&!e.closest('[inert]')&&e.getBoundingClientRect().height>0})()"))
  }
  const frame = async (file, label, target = 'group') => {
    const settingsTarget = ['settings', 'preview'].includes(target)
    if (!settingsTarget && target !== 'local' && target !== 'launcher' && target !== 'workface') await ensureFocus(); await settle()
    if(groupDiscussion){const viewport=await read('({width:innerWidth,height:innerHeight})');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:viewport.width-3,y:viewport.height/2});await settle()}
    const before=await geometry(target)
    if(groupDiscussion||neutralSurfaces||selectionSettings||savedInProject||takeoverRecipients) assert.equal(before.appearance,file.startsWith('light-')?'light':'dark','Actual theme matches the captured scene')
    assert.equal(before.mainSurface,['launcher','workface'].includes(target) ? 'workbench' : 'agents');assert.equal(before.focusView,'list');if(!settingsTarget&&!['launcher','workface'].includes(target))assert.ok(before.visible&&before.focus.width>0&&before.focus.height>0,'Actual Focus or its saved-input modal '+file)
    if (target === 'local') assert.equal(before.targetRole, 'dialog', 'Actual saved-input modal owns its foreground')
    assert.ok(!before.inert || settingsTarget || target === 'local' || ['launcher','workface'].includes(target), 'Only the actual modal may make Focus inert')
    assert.ok(before.target?.width>0&&before.target.height>0&&before.targetHit,'Actual visible/hit target '+file)
    await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG())
    const after=await geometry(target);if(neutralSurfaces){result.frameObservations??=[];result.frameObservations.push({file,before,after})}if(groupDiscussion||neutralSurfaces||selectionSettings)assert.equal(after.appearance,before.appearance,'Theme retained throughout capture');assert.equal(after.mainSurface,before.mainSurface);assert.ok((settingsTarget||['launcher','workface'].includes(target)||after.visible)&&after.targetHit,'Original surface kept throughout capture '+file)
    result.frames.push({file,label,before,after})
  }
  const click = async selector => {
    const inspect = () => read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y),panel=e.closest('[data-focus-project-preferences]'),ancestors=[];for(let p=e.parentElement;p&&ancestors.length<9;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();ancestors.push({tag:p.tagName,className:p.className,scrollTop:p.scrollTop,top:b.top,bottom:b.bottom,position:s.position,transform:s.transform,overflow:s.overflow,contain:s.contain,animationName:s.animationName,animationDuration:s.animationDuration})}return{rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:e.contains(hit),hitElement:hit?.outerHTML.slice(0,500),panelScroll:panel?.scrollTop,panelRect:panel?{top:panel.getBoundingClientRect().top,bottom:panel.getBoundingClientRect().bottom}:null,ancestors}})()`)
    const input = compactDiscussion||neutralSurfaces||groupOrganization||selectionSettings ? { selector, before: await inspect(), dispatched: false } : null
    if(input){result.nativeInputs??=[];result.nativeInputs.push(input)}
    if(!input || !input.before?.hit) { await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`); await settle() }
    if(input)input.afterLocate=await inspect()
    const box = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
    if(input&&!box.hit){await read(`(async()=>{const p=document.querySelector('[data-focus-project-preferences]');await Promise.race([Promise.all((p?.getAnimations()??[]).map(a=>a.finished.catch(()=>{}))),new Promise(done=>setTimeout(done,250))]);await new Promise(requestAnimationFrame)})()`);input.afterNaturalAnimation=await inspect()}
    assert.equal(box.hit, true, 'Exact real click ' + selector)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    if(input)input.dispatched=true
    await settle()
  }
  const key = async value => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: value === 'Escape' ? 27 : 9 }); await settle() }
  await win.loadFile(html, takeoverRecipients || savedInputs ? { query: { fixtureMode: mode } } : undefined); win.webContents.debugger.attach('1.3')
  await until('actual App ready', () => read('Boolean(window.appearanceProof)'))
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  await until('original workface',()=>read('!!document.querySelector("[data-owner-tab=original] textarea")'))
  await read('window.filterProof.enter()');await click('button.surface-navigation__focus');await ensureFocus()
  await read("window.filterProof.theme('dark')")
  await until('one recognized image group', () => read("document.querySelectorAll('.focus-project-frame [data-project-watermark]').length===1"))
  await read('window.appearanceProof.remember()')
  result.initial = await read('window.appearanceProof.facts()')
  const alpha = result.initial.groups.find(group => group.key === JSON.stringify(['local', 'alpha']))
  assert.equal(alpha.entries, 1); assert.equal(alpha.branches, 1); assert.equal(alpha.zones, 3); assert.equal(alpha.watermarks, 1)
  assert.ok(result.initial.groups.every(group => group.entries === 1 && group.watermarks <= 1))
  assert.ok(!result.initial.calls.some(id => id.startsWith('branch-') || id === 'orphan'), 'No branch is probed as a project root')
  if (takeoverRecipients) {
    await require('./takeover-recipients-scene.cjs')({ win, read, click, key, frame, until, settle, result })
    result.final = await read('window.appearanceProof.facts()')
    result.imageCalls = imageCalls
    result.passed = true
    return
  }
  if (savedInProject) {
    await require('./saved-history-scene.cjs')({ win, read, click, key, frame, until, settle, result, evidence })
    result.final = await read('window.appearanceProof.facts()')
    result.imageCalls = imageCalls
    result.passed = true
    return
  }
  if (!savedInputs && !containerOrder && !groupDiscussion && !neutralSurfaces && !selectionSettings) {
  for (const theme of ['dark', 'light']) {
    await read(`window.appearanceProof.theme(${JSON.stringify(theme)})`)
    for (const width of [1440, 640, 360]) { win.setContentSize(width, 900); await ensureFocus();await read("document.querySelector('.focus-project-lanes__rows').scrollTop=0"); await frame(`${theme}-groups-${width}.png`, `${theme} full project grouping at ${width}`) }
    win.setContentSize(1440, 900); await settle()
    await click('[aria-label="Project preferences · AgentMux"]')
    await until('compact original preferences', () => read('Boolean(document.querySelector("[data-focus-project-preferences]"))'))
    const box = await read("(()=>{const r=document.querySelector('[data-focus-project-preferences]').getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,right:r.right,top:r.top,bottom:r.bottom}})()")
    assert.ok(box.width <= 260 && box.height <= 884, 'Compact menu fits the original viewport with its lazy discussion slot')
    assert.ok(box.left >= 0 && box.right <= 1440 && box.top >= 0 && box.bottom <= 900)
    result.scenarios.push({ label: 'Compact original editor ' + theme, box })
    await frame(`${theme}-preferences.png`, `${theme} compact preferences in the full Focus surface`, 'menu')
    await click('[aria-label="Project note"]')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 })
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'My unsaved daily route' })
    await read('window.appearanceProof.failSave(true)')
    await click('[aria-label="Save project preferences"]')
    await until('original save failure', () => read("document.querySelector('[data-focus-project-preferences]')?.textContent.includes('Review current settings')"))
    for (const height of [220,260]) {
      win.setContentSize(360,height);await settle();await ensureFocus()
      assert.equal(await read(`document.querySelector('[aria-label="Project note"]').value`),'My unsaved daily route')
      const errorBox=await read(`(()=>{const p=document.querySelector('[data-focus-project-preferences]'),r=p.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,viewport:innerHeight}})()`)
      result.scenarios.push({label:'Short viewport draft retained '+theme,height,box:errorBox})
      assert.ok(errorBox.left>=8&&errorBox.right<=352&&errorBox.top>=8&&errorBox.bottom<=height-8,'Short editor respects both viewport edges')
      assert.ok(errorBox.scrollHeight>errorBox.clientHeight,'Long error remains internally scrollable')
      for(const selector of ['[aria-label="Review current project preferences"]','[aria-label="Save project preferences"]']) {
        await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);await settle()
        const reachable=await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return r.top>=8&&r.bottom<=innerHeight-8&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
        assert.ok(reachable,'Original recovery action remains reachable '+selector)
      }
      await frame(`${theme}-error-${height}.png`,`${theme} retained draft and recoverable long error at ${height}`, 'menu')
    }
    await key('Escape'); await until('editor dismissed', () => read('!document.querySelector("[data-focus-project-preferences]")'))
    await read('window.appearanceProof.failSave(false)')
  }
  }
  if(savedInputs) await require('./saved-inputs-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else if(combinedPreferences) {
    await require('./group-organization-scene.cjs')({win,read,click,frame,until,settle,result,key})
    win.setContentSize(1440,900); await read("window.appearanceProof.theme('dark')"); await settle()
    await require('./selection-settings-scene.cjs')({win,read,click,frame,until,settle,result,key})
  } else if(selectionSettings) await require('./selection-settings-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else if(groupOrganization) await require('./group-organization-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else if(neutralSurfaces) await require('./neutral-surface-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else if(compactDiscussion) await require('./compact-discussion-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else if(groupDiscussion) await require('./discussion-scene.cjs')({win,read,click,frame,until,settle,result,key})
  else await require('./organization-scene.cjs')({ win, read, click, frame, until, settle, result, containerOrder })
  if (!savedInputs && !containerOrder && !groupDiscussion && !neutralSurfaces && !selectionSettings) await require('./reading-scene.cjs')({ win, read, click, frame, until, settle, result })
  result.final = await read('window.appearanceProof.facts()'); result.imageCalls = imageCalls
  assert.ok(imageCalls.some(call => call.workspaceId === 'alpha' && call.realImage), 'Original Main recognizer actually loaded a project image')
  result.passed = true
} catch (error) { result.failure = { message: error.message, stack: error.stack }; if (win) result.debug = await win.webContents.executeJavaScript('window.appearanceProof?.debug()').catch(() => null); if (win) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()).catch(() => {}) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) } }).catch(error => { console.error(error); app.exit(1) })
