const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.focus-context-card-interaction-actual.v1', passed: false, pid: process.pid, frames: [], rendererConsole: [], operations: [], boundary: 'Actual Global/Store/projection/Row/Menu/Hover/clipboard/CSS, typed preview data. Unrelated PTY/editor paint isolated; no user Runtime, real Run/PID, OS input, restart or installation.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1200, height: 820, useContentSize: true, show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) result.rendererConsole.push(String(message).slice(0, 2000)) })
  const read = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { result.failedEvaluation = code; throw error } }
  const pause = ms => new Promise(done => setTimeout(done, ms))
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await pause(30) } while (Date.now() < end); throw new Error('Scene did not settle: ' + label) }
  const frames = () => read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const stable = async () => {
    await frames()
    await until('text, opacity and finite animation paint', () => read(`(()=>{const overlays=[...document.querySelectorAll('.focus-context-menu,.focus-context-hover')];return overlays.every(e=>{const s=getComputedStyle(e);return s.visibility==='visible'&&Number(s.opacity)>=.999&&e.innerText.trim().length>0&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity)})})()`))
    await pause(80); await frames()
  }
  const row = id => `.global-focus-main .focus-context[data-session-id="${id}"]`
  const rect = selector => {
    const lookup = selector.startsWith('menu:') ? `[...document.querySelectorAll('.focus-context-menu [role=menuitem]')].find(e=>e.innerText.trim()===${JSON.stringify(selector.slice(5))})` : `document.querySelector(${JSON.stringify(selector)})`
    return read(`(()=>{const e=${lookup};if(!e)throw new Error('Missing actual control '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`)
  }
  const dispatchMouse = (type, x, y, extra = {}) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra })
  const move = (x, y, extra) => dispatchMouse('mouseMoved', x, y, extra)
  const mouse = async (selector, button = 'left') => { const r = await rect(selector); assert.equal(r.hit, true, 'Center hit ' + selector); await move(r.x, r.y); for (const type of ['mousePressed', 'mouseReleased']) await dispatchMouse(type, r.x, r.y, { button, clickCount: 1 }); result.operations.push({ type: button === 'right' ? 'contextmenu' : 'click', selector }); return r }
  const key = async (value, modifiers = 0, code = value) => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: value, code, modifiers, ...(type === 'keyDown' && (value === 'Enter' || value === ' ') ? { text: value === 'Enter' ? '\r' : ' ', unmodifiedText: value === 'Enter' ? '\r' : ' ' } : {}), ...(value === 'F10' ? { windowsVirtualKeyCode: 121, nativeVirtualKeyCode: 109 } : value === 'Enter' ? { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 } : value === ' ' ? { windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 49 } : {}) }); result.operations.push({ type: 'key', value, modifiers }) }
  const menuSettled = async () => { await until('actual three-action Agent menu', () => read(`document.querySelector('.focus-context-menu')?.querySelectorAll('[role=menuitem]').length===3`)); await stable() }
  const facts = () => read('window.cardInteractionScene.facts()')
  const noSelection = async () => { const f = await facts(); assert.equal(f.selectedId, null); assert.equal(f.focusOwnerPreserved, true); assert.equal(await read(`!!document.querySelector(${JSON.stringify(row('recap-b'))}+'.is-selected')`), false) }
  const shot = async (file, label) => { await stable(); const paint = await read(`({width:innerWidth,height:innerHeight,focus:document.activeElement?.getAttribute('aria-label'),menuSID:document.querySelector('.focus-context-menu')?.dataset.agentSessionId??null,hover:document.querySelector('.focus-context-hover')?.innerText??null})`); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file, label, ...paint }) }
  const resize = async width => { win.setContentSize(width, 820); await frames(); await move(width - 4, 8); await key('Escape'); await until('resize preview cleanup', () => read('!document.querySelector(".focus-context-hover,.focus-context-menu")')); await stable() }
  const pointerMenu = async () => { await mouse(row('recap-b'), 'right'); await menuSettled(); await noSelection(); assert.equal(await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'), 'recap-b'); assert.deepEqual(await read(`[...document.querySelectorAll('.focus-context-menu [role=menuitem]')].map(e=>e.innerText.trim())`), ['Rename Agent', 'Copy Session Address', 'Stop Agent']) }
  const menuGeometry = async () => { const g = await read(`(()=>{const m=document.querySelector('.focus-context-menu'),n=m.querySelector('.focus-context-menu__identity strong'),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{height:r.height,lineHeight:parseFloat(s.lineHeight),whiteSpace:s.whiteSpace,overflow:s.overflow,textOverflow:s.textOverflow,title:n.title,text:n.textContent,clipped:n.scrollWidth>n.clientWidth,menuHeight:m.getBoundingClientRect().height,metadata:m.querySelector('.focus-context-menu__identity span,.focus-context-menu__identity code')!==null}})()`);assert.equal(g.title,g.text);assert.equal(g.whiteSpace,'nowrap');assert.equal(g.textOverflow,'ellipsis');assert.equal(g.clipped,true);assert.ok(g.height<=g.lineHeight+1);assert.equal(g.metadata,false);assert.ok(g.menuHeight<170);result.operations.push({type:'menuGeometry',...g});return g }
  const rename = async () => { await pointerMenu(); await mouse('menu:Rename Agent'); await until('actual rename input owns focus', () => read('document.activeElement===document.querySelector(".global-focus-main .focus-context__rename")')); await stable() }
  const replaceDraft = async text => { await key('a', 4, 'KeyA'); await win.webContents.debugger.sendCommand('Input.insertText', { text }); await until('real input draft', () => read(`document.querySelector('.global-focus-main .focus-context__rename')?.value===${JSON.stringify(text)}`)); result.operations.push({ type: 'insertText', text }) }
  const closedRename = () => until('rename returns to exact card', () => read(`!document.querySelector('.global-focus-main .focus-context__rename')&&!!document.querySelector(${JSON.stringify(row('recap-b'))})`))
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await read(`window.cardKeyboardEvents=[];document.addEventListener('keydown',event=>{const observed={key:event.key,code:event.code,keyCode:event.keyCode,shift:event.shiftKey,ctrl:event.ctrlKey,meta:event.metaKey,trusted:event.isTrusted,targetSID:event.target?.dataset?.sessionId};queueMicrotask(()=>{observed.prevented=event.defaultPrevented;window.cardKeyboardEvents.push(observed);if(window.cardKeyboardEvents.length>64)window.cardKeyboardEvents.shift()})},true)`)
  await until('actual Global population', () => read('window.cardInteractionScene?.ready&&document.querySelectorAll(".global-focus-main .focus-context").length===6'))
  await read('window.cardInteractionScene.remember()'); result.before = await facts()
  assert.equal(result.before.currentNames['recap-a'], result.before.currentNames['recap-b'])
  for (const width of [1200, 640, 360]) {
    await resize(width); await shot('cards-' + width + '.png', 'Actual long-name cards, two-layer density and retained compact occurrence')
    const r = await rect(row('recap-a')); const priorFocus = await read('document.activeElement?.getAttribute("aria-label")??null')
    await move(r.x, r.y); await pause(100); assert.equal(await read('!!document.querySelector(".focus-context-hover")'), false, '180ms hover intent delay')
    await until('actual complete preview', () => read('document.querySelector(".focus-context-hover")?.textContent.includes(window.cardInteractionScene.longResponse)')); await stable()
    assert.equal(await read('document.activeElement?.getAttribute("aria-label")??null'), priorFocus, 'Hover does not take focus')
    const p = await rect('.focus-context-hover'); assert.ok(p.left >= 0 && p.right <= width + 1)
    // Transfer through the real gap with mousemove, rather than directly firing
    // pointerenter on a tooltip. The 160ms departure grace bridges this path.
    const px = Math.min(Math.max(r.x, p.left + 10), p.right - 10), py = p.top + 18
    for (let step = 1; step <= 5; step++) { await move(r.x + (px - r.x) * step / 5, r.y + (py - r.y) * step / 5); await pause(15) }
    await pause(190); assert.equal(await read('!!document.querySelector(".focus-context-hover")'), true, 'Natural pointer transfer retains preview')
    await shot('hover-' + width + '.png', 'Full long-name read-only preview after natural pointer transfer')
    if (width === 1200) {
      const text = await read(`(()=>{const p=document.querySelector('.focus-context-hover__recap p'),n=p.firstChild,r=document.createRange();r.setStart(n,0);r.setEnd(n,12);const b=r.getClientRects()[0];return{x:b.left+1,y:b.top+b.height/2,end:b.right-1}})()`)
      await move(text.x, text.y); await dispatchMouse('mousePressed', text.x, text.y, { button: 'left', clickCount: 1 })
      for (let step = 1; step <= 6; step++) await move(text.x + (text.end - text.x) * step / 6, text.y, { button: 'left', buttons: 1 })
      await dispatchMouse('mouseReleased', text.end, text.y, { button: 'left', clickCount: 1 })
      result.previewSelection = await read(`(()=>{const s=getSelection(),p=document.querySelector('.focus-context-hover');return{text:s.toString(),inside:p.contains(s.anchorNode),scroll:p.scrollTop,scrollHeight:p.scrollHeight,height:p.clientHeight}})()`)
      assert.ok(result.previewSelection.text.length > 0 && result.previewSelection.inside)
      await shot('hover-selected-1200.png', 'Actual pointer-selected preview text without moving input focus')
      await move(p.x, p.bottom - 35); await dispatchMouse('mouseWheel', p.x, p.bottom - 35, { deltaX: 0, deltaY: 650 })
      await until('internal preview scroll', () => read('document.querySelector(".focus-context-hover")?.scrollTop>0'))
      result.previewScroll = await read(`(()=>{const p=document.querySelector('.focus-context-hover'),f=p.querySelector('footer'),b=f.getBoundingClientRect(),a=p.getBoundingClientRect();return{scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,height:p.clientHeight,footerVisible:b.bottom<=a.bottom+1,text:f.innerText,cardIds:[...document.querySelectorAll('.global-focus-main .focus-context')].map(e=>e.dataset.sessionId)}})()`)
      assert.equal(result.previewScroll.footerVisible, true); assert.ok(result.previewScroll.text.includes('recap-a'))
      await shot('hover-scrolled-1200.png', 'Internal preview scrolling reaches complete workspace and exact SID footer')
    }
    await key('Escape'); await until('preview Escape cleanup', () => read('!document.querySelector(".focus-context-hover")'))
  }
  await resize(1200); await pointerMenu(); await menuGeometry(); await shot('pointer-menu-1200.png', 'Compact Agent menu with separated Stop Agent action and single-line long name at wide window'); await key('Escape')
  await resize(640); await pointerMenu(); await menuGeometry(); await shot('pointer-menu-640.png', 'Compact Agent menu with separated Stop Agent action and single-line long name at medium window'); await key('Escape')
  await resize(360); await pointerMenu(); await menuGeometry(); await shot('pointer-menu-360.png', 'Same-name second SID pointer menu; open state stays distinct from selection')
  await mouse('menu:Copy Session Address'); await until('copy closes menu', () => read('!document.querySelector(".focus-context-menu")'))
  result.afterCopy = await facts(); assert.equal(result.afterCopy.clipboard[0], await read('window.cardInteractionScene.expectedSecondAddress')); await noSelection()
  await read(`document.querySelector(${JSON.stringify('[aria-label="Search contexts"]')}).focus()`)
  for (let index = 0; index < 30; index++) {
    await key('Tab')
    if (await read(`document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`)) break
  }
  assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`), true, 'Real Tab navigation reaches exact second SID')
  await key('F10', 8); result.keyboardEvents = await read('window.cardKeyboardEvents'); await menuSettled(); await noSelection()
  assert.equal(await read('document.querySelector(".focus-context-menu").dataset.agentSessionId'), 'recap-b')
  await shot('keyboard-menu-360.png', 'Real Tab navigation and Shift+F10 act on exact second same-name SID')
  await key('Escape'); await until('menu Escape returns exact trigger', () => read(`!document.querySelector('.focus-context-menu')&&document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`))
  await pause(220); assert.equal(await read('!!document.querySelector(".focus-context-hover")'), false, 'Radix restore focus does not reopen hover')
  result.escape = { exactTrigger: true, noReopenedPreview: true }
  await shot('keyboard-escape-360.png', 'Escape closes menu and restores exact card without immediately reopening preview')
  const cancelled = '取消此草稿：保留原来的同名 Agent'
  await rename(); await replaceDraft(cancelled); await shot('rename-draft-360.png', 'Rename draft belongs to second SID and retains original Agent name until commit')
  assert.equal((await facts()).names['recap-b'], result.before.names['recap-b'])
  await key('Escape'); await closedRename(); assert.equal((await facts()).names['recap-b'], result.before.names['recap-b']); await noSelection()
  await shot('rename-cancel-360.png', 'Escape discards draft and keeps both exact identities and prior names')
  const committed = '阅读锚点 · 精确第二会话的新名字'
  await rename(); await replaceDraft(committed); await key('Enter'); await closedRename()
  result.afterCommit = await facts(); assert.equal(result.afterCommit.names['recap-b'], committed); assert.equal(result.afterCommit.names['recap-a'], result.before.names['recap-a']); await noSelection()
  await shot('rename-commit-360.png', 'Enter updates only exact second SID through actual Store naming owner')
  await rename(); await replaceDraft(''); await key('Enter'); await closedRename()
  result.afterClear = await facts(); assert.equal(result.afterClear.names['recap-b'], undefined); assert.equal(result.afterClear.currentNames['recap-b'], await read('window.cardInteractionScene.derivedSecondName'))
  await shot('rename-derived-360.png', 'Empty name clears the override and restores existing derived Agent identity')
  await resize(640); await rename(); await replaceDraft('稍后输入 · 保存当前 Agent 名字')
  await mouse('[aria-label="Later explicit input"]'); await closedRename()
  await until('later deliberate input owns focus', () => read(`document.activeElement===document.querySelector(${JSON.stringify('[aria-label="Later explicit input"]')})`))
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '后续明确输入仍由此输入框接收。' })
  result.afterBlur = await facts(); assert.equal(result.afterBlur.names['recap-b'], '稍后输入 · 保存当前 Agent 名字'); assert.equal(result.afterBlur.names['recap-a'], result.before.names['recap-a'])
  assert.ok(result.afterBlur.draft.includes('后续明确输入仍由此输入框接收。'))
  await shot('rename-blur-later-input-640.png', 'Blur commits Agent name and later input focus receives trusted text without being stolen')
  for (const flag of ['sessionRefsPreserved', 'timelineRefsPreserved', 'draftOwnerPreserved', 'focusOwnerPreserved', 'originalControls']) assert.equal(result.afterBlur[flag], true, flag)
  assert.deepEqual(result.afterBlur.identityFacts, result.before.identityFacts)
  assert.deepEqual(result.afterBlur.reads, result.before.reads, 'Hover/menu/rename do not fetch additional facts')
  const beforeChurn = await facts(); await read('window.cardInteractionScene.churn()'); await stable(); const afterChurn = await facts()
  assert.deepEqual(afterChurn.reads, beforeChurn.reads); assert.deepEqual(afterChurn.controls, beforeChurn.controls); assert.deepEqual(afterChurn.identityFacts, result.before.identityFacts)
  assert.equal(afterChurn.originalControls, true); assert.equal(afterChurn.draftOwnerPreserved, true); assert.equal(afterChurn.timelineRefsPreserved, true)
  result.cost = { updates: 200, before: beforeChurn, after: afterChurn }
  for (const width of [1200, 360]) {
    await resize(width); await pointerMenu(); await shot('stop-menu-' + width + '.png', 'Explicit Stop Agent action separated from naming and sharing')
    await mouse('menu:Stop Agent'); await until('original stop confirmation', () => read('document.querySelector("[role=dialog]")?.innerText.includes("Stop Agent?")'))
    await frames(); await pause(100)
    assert.equal(await read('document.activeElement===document.querySelector(".confirmation-dialog__cancel")'), true, 'Cancel is the safe initial focus')
    assert.equal((await facts()).controls.stop, 0, 'Opening Stop does not stop anything')
    const geometry = await rect('[role=dialog]'); assert.ok(geometry.left >= 0 && geometry.right <= width + 1)
    await shot('stop-confirm-' + width + '.png', 'Original confirmation names the Agent and retained conversation history')
    await mouse('.confirmation-dialog__cancel'); await until('stop cancellation', () => read('!document.querySelector("[role=dialog]")'))
    await frames(); assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(row('recap-b'))})`), true)
  }
  await resize(1200); await pointerMenu(); await key('Escape'); await until('menu dismissed before card navigation', () => read('!document.querySelector(".focus-context-menu")')); await mouse(row('recap-b'))
  await until('actual exact Session focus action', async () => (await facts()).selectedId === 'recap-b')
  await until('actual selected surface', () => read(`document.querySelector(${JSON.stringify(row('recap-b'))}).classList.contains('is-selected')`))
  await move(1196, 8); await key('Escape'); await shot('card-focus-selected-1200.png', 'Ordinary card click selects exact second SID and whole card surface; typed observation paint only')
  for (const [id, value, code] of [['recap-a', 'Enter', 'Enter'], ['recap-b', ' ', 'Space']]) {
    await read(`document.querySelector(${JSON.stringify(row(id))}).focus()`); await key(value, 0, code)
    result.keyboardCardTrace ??= []; result.keyboardCardTrace.push(await read(`({active:document.activeElement?.outerHTML,events:window.cardKeyboardEvents.slice(-6),selected:window.cardInteractionScene.facts().selectedId})`));
    await until('native button keyboard selection ' + value, async () => (await facts()).selectedId === id)
  }
  result.keyboardCardNavigation = ['Enter', 'Space']
  result.after = await facts(); assert.deepEqual(result.after.identityFacts, result.before.identityFacts); assert.equal(result.after.originalControls, true)
  assert.deepEqual(result.after.controls, { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 })
  assert.equal(result.rendererConsole.filter(message => !message.includes('Electron Security Warning')).length, 0, 'No renderer errors (private unpackaged Electron policy warning retained)')
  result.passed = true
} catch (error) { if(win&&!win.isDestroyed()) result.menuTrace=await win.webContents.executeJavaScript('window.cardMenuTrace').catch(()=>null); result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(result.passed ? 0 : 1) } })
