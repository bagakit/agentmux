const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')

// A narrow journey through the original App and ordinary persistence owner.
// Shared native helpers and the controlled public API boundary stay unchanged.
module.exports = async function floatingSpaceShortcut(context) {
  const { result, phase, evidence, win, read, until, facts, input, click, key, capture,
    selector, button, panel, entry, size, visible, chooseMote, chooseSection, forbidden,
    reference, primary, target, custom } = context
  result.scenario = 'floating-space-shortcut'
  const shortcutPointerDiagnostic = process.env.AGENTMUX_SHARED_FRAME_SHORTCUT_POINTER_DIAGNOSTIC === '1'
  const root = 'document'
  const shortcut = selector(panel, 'button[aria-label="Open in Space"]')
  const editor = selector(panel, '[data-workbench-group-id="original-mote-second"][data-workbench-tab-id="mote-primary-tab"] .composer__editor .tiptap')
  const normalized = value => JSON.parse(JSON.stringify(value))
  const protectedFacts = value => ({ tabs: normalized(value.tabs), layouts: value.layouts,
    drafts: value.drafts, runs: value.runs, outbox: value.outbox, viewModes: value.viewModes })
  const settledFrame = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const observeImageMotion = () => read(`(()=>{const n=window.profileMoteMotionNode,i=n?.querySelector('img.space-object-icon__avatar'),rig=n?.querySelector('.mote-image-follow'),a=i?.getAnimations().find(a=>a.animationName==='mote-presence');return{connected:!!n?.isConnected,expression:n?.dataset.moteExpression,visible:n?.dataset.moteVisible,motion:n?.dataset.moteMotion,gaze:n?.dataset.moteGaze,x:n?.style.getPropertyValue('--mote-gaze-x'),y:n?.style.getPropertyValue('--mote-gaze-y'),turn:n?.style.getPropertyValue('--mote-head-turn'),rigTransform:rig?getComputedStyle(rig).transform:null,imageTransform:i?getComputedStyle(i).transform:null,source:i?.getAttribute('src'),sameImage:i===window.profileOriginalDragon,svgCount:n?.querySelectorAll('svg').length,animation:a?{name:a.animationName,playState:a.playState,time:a.currentTime,progress:a.effect.getComputedTiming().progress,duration:a.effect.getTiming().duration}:null}})()`)
  const imagePointer = async side => {
    const point = await read(`(()=>{const e=window.profileMoteMotionNode.querySelector('.mote-image-follow'),r=e.getBoundingClientRect();return{x:${side === 'left' ? 'Math.max(2,r.x+r.width/2-48)' : side === 'right' ? 'Math.min(innerWidth-2,r.x+r.width/2+48)' : 'innerWidth-16'},y:${side === 'far' ? 'innerHeight-16' : 'r.y+r.height/2-4'}}})()`)
    ;(result.moteMotionPointerActions ??= []).push({ side, point })
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 })
    await until(side === 'far' ? 'window.profileMoteMotionNode.dataset.moteGaze==="far"' : 'window.profileMoteMotionNode.dataset.moteGaze==="near"&&parseFloat(window.profileMoteMotionNode.style.getPropertyValue("--mote-gaze-x"))' + (side === 'left' ? '<0' : '>0'))
    await read('(async()=>{const e=window.profileMoteMotionNode.querySelector(".mote-image-follow");await Promise.all(e.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>undefined)))})()')
    const observed = { point, ...await observeImageMotion() }
    assert.equal(observed.sameImage, true); assert.equal(observed.svgCount, 0, 'Original dragon PNG has no added face or eyes')
    if (side !== 'far') assert.notEqual(observed.rigTransform, 'none')
    return observed
  }
  const beginImageMotion = async sampleIdle => {
    await read('window.profileMoteMotionNode=document.querySelector(".surface-tool-dock .mote-details__avatar .mote-identity-motion");window.profileOriginalDragon=window.profileMoteMotionNode.querySelector("img.space-object-icon__avatar");window.sharedFrameProof.setProfileMoteStatus("done")')
    await until('window.profileMoteMotionNode.dataset.moteExpression==="idle"&&window.profileMoteMotionNode.dataset.moteMotion==="on"')
    if (sampleIdle) {
      const first = await observeImageMotion()
      assert.equal(first.animation?.name, 'mote-presence'); assert.equal(first.animation?.playState, 'running')
      assert.equal(first.animation.duration, 14000)
      const progress = first.animation.progress
      assert.ok(typeof progress === 'number' && Number.isFinite(progress))
      const waitMs = Math.max(0, ((progress < .8 ? .8 : progress < .89 ? progress : 1.8) - progress) * first.animation.duration)
      for (let remaining = Math.ceil(waitMs); remaining > 0; remaining -= Math.min(6000, remaining))
        await read('new Promise(resolve=>setTimeout(resolve,' + Math.min(6000, remaining) + '))')
      const active = await observeImageMotion()
      await read('new Promise(resolve=>setTimeout(resolve,360))')
      const later = await observeImageMotion()
      assert.notEqual(later.animation.time, active.animation.time)
      assert.notEqual(later.imageTransform, active.imageTransform, 'The original image has an actual short idle interval, not only animation CSS')
      result.moteMotion = { idle: { initial: first, active, later, waitMs } }
    }
  }
  const observeCaret = () => read(`(()=>{const e=${editor},s=getSelection();let offset=null;if(e&&s?.anchorNode&&e.contains(s.anchorNode)){const r=document.createRange();r.selectNodeContents(e);r.setEnd(s.anchorNode,s.anchorOffset);offset=r.toString().length}const rect=e?.getBoundingClientRect();return{same:e===window.shortcutOriginalInput,connected:!!e?.isConnected,text:e?.textContent,focused:document.activeElement===e,collapsed:s?.isCollapsed,offset,hidden:!!e?.closest('[hidden],[inert]'),rect:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null}})()`)
  const assertSimpleFloating = async (empty = false) => {
    const actual = await read(`(()=>{const p=${panel},visible=e=>!e.closest('[hidden],[inert]')&&e.getClientRects().length>0,actions=[...p.querySelectorAll('button[aria-label="Open in Space"]')].filter(visible),a=actions[0],r=a?.getBoundingClientRect(),hit=r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null;return{count:actions.length,text:a?.textContent.trim(),title:a?.getAttribute('title'),label:a?.getAttribute('aria-label'),actionRow:!!a?.closest('.pane-tabbar__actions'),group:a?.closest('[data-pane-group-id]')?.dataset.paneGroupId??null,hasIcon:!!a?.querySelector('svg'),hit:!!a&&(hit===a||a.contains(hit)),bounds:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,filesPanel:!!p.querySelector('.mote-workface__files,.workspace-tool-explorer,.mote-details'),oldTools:[...p.querySelectorAll('button')].filter(visible).filter(e=>e.getAttribute('aria-label')==='Mote files'||e.textContent.trim()==='Edit persona').map(e=>e.outerHTML),body:!!p.querySelector('.workspace-workbench')}})()`)
    assert.equal(actual.count, 1, 'One real visible compact Open in Space control')
    assert.equal(actual.hasIcon, true); assert.equal(actual.text, '')
    assert.equal(actual.hit, true, 'Actual shortcut center hits the original button')
    assert.equal(actual.filesPanel, false); assert.deepEqual(actual.oldTools, [])
    assert.equal(actual.body, true, 'Original shared workface is still mounted')
    if (!empty) {
      assert.equal(actual.actionRow, true, 'Shortcut belongs to the shared Tab action row')
      assert.equal(actual.group, reference.groupId, 'Shortcut belongs to the actual selected occurrence')
    }
    ;(result.shortcutControls ??= []).push({ empty, ...actual })
  }
  const assertSpaceReference = async expected => {
    const actual = await facts()
    assert.equal(actual.mainSurface, 'workbench')
    assert.equal(actual.activeWorkspaceId, expected.displayWorkspaceId)
    for (const key of ['groupId', 'tabId', 'regionId']) assert.equal(actual.selection?.[key], expected[key], 'Explicit Space navigation retains exact ' + key)
    assert.equal(actual.selection?.workspaceId, expected.displayWorkspaceId)
    assert.equal(actual.selection?.topicId, primary)
    assert.equal(actual.floatingState.open, false)
    return actual
  }
  const showSpaceTools = async () => {
    if (!await read('!!document.querySelector(".surface-tool-dock .mote-details")?.getClientRects().length')) {
      await click(selector(root, 'button[aria-label="Show Space tools"]'))
      await until('!!document.querySelector(".surface-tool-dock .mote-details")?.getClientRects().length')
    }
  }
  const exerciseProfileControls = async () => {
    const details = selector(root, '.surface-tool-dock .mote-details[data-mote-details="' + primary + '"]')
    const avatar = selector(details, 'button[aria-label="Change Mote avatar"]')
    const rename = selector(details, 'button[aria-label="Rename Mote"]')
    const profileTab = selector(details, '[role="tab"][aria-selected="true"]')
    const before = await facts(), metadata = await read('window.sharedFrameProof.profileControlsFacts()')
    await read(`(()=>{window.profileNativeKeys=[];for(const type of ['keydown','keypress','keyup','click'])document.addEventListener(type,event=>{if(window.profileNativeKeys.length>=80)return;const target=event.target,entry={type,key:event.key,charCode:event.charCode,trusted:event.isTrusted,target:target?.getAttribute?.('aria-label')??target?.tagName,defaultPrevented:event.defaultPrevented,active:document.activeElement?.getAttribute('aria-label')??document.activeElement?.tagName};window.profileNativeKeys.push(entry);queueMicrotask(()=>{entry.defaultPreventedAfter=event.defaultPrevented;entry.activeAfter=document.activeElement?.getAttribute('aria-label')??document.activeElement?.tagName})},{capture:true,passive:true})})()`)
    const nativeEnter = async () => {
      // CDP keyDown includes the Enter character, as a real keypress does.
      // Omitting text models only the keydown/up and cannot activate a button.
      await input('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
      await input('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      result.profileNativeKeyEvents = await read('window.profileNativeKeys')
    }
    const captureModal = async (name, modal) => {
      const ready = await read(`(async()=>{const e=${modal},animations=e.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity),observed=animations.map(a=>({name:a.animationName,duration:a.effect.getTiming().duration}));await Promise.all(animations.map(a=>a.finished.catch(()=>undefined)));const r=e.getBoundingClientRect();return{connected:e.isConnected,opacity:getComputedStyle(e).opacity,bounds:{width:r.width,height:r.height},finiteAnimations:observed}})()`)
      assert.equal(ready.connected, true); assert.equal(ready.opacity, '1')
      assert.ok(ready.bounds.width > 0 && ready.bounds.height > 0)
      ;(result.modalReadiness ??= []).push({ name, ...ready })
      await capture(name)
    }
    const appearance = async mode => {
      await read('window.sharedFrameProof.setProfileAppearance(' + JSON.stringify(mode) + ')')
      await until('document.documentElement.dataset.appearance===' + JSON.stringify(mode))
    }
    const inspect = async mode => {
      const actual = await read(`(()=>{const d=${details},a=${avatar},n=${rename},i=a.querySelector('.space-object-icon__avatar'),rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}},hit=e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)};return{appearance:document.documentElement.dataset.appearance,viewport:innerWidth,avatarCount:d.querySelectorAll('button[aria-label="Change Mote avatar"]').length,renameCount:d.querySelectorAll('button[aria-label="Rename Mote"]').length,avatarHit:hit(a),renameHit:hit(n),avatar:rect(a),avatarAsset:rect(i),avatarAssetLogical:{width:i.clientWidth,height:i.clientHeight},rename:rect(n),renameText:n.textContent.trim(),renameIcon:!!n.querySelector('svg'),name:d.querySelector('.mote-details__identity strong')?.textContent,status:d.querySelector('.mote-details__status')?.textContent,tabs:[...d.querySelectorAll('[role=tab]')].map(e=>e.textContent.trim()),selfSetting:d.querySelector('.mote-details__self')?.textContent,recent:[...d.querySelectorAll('.mote-details__recent .mote-details__note')].map(e=>e.textContent.trim()),oldButtons:[...d.querySelectorAll('button')].filter(e=>['Avatar','Rename','Read self setting','Explore notes and ideas'].includes(e.textContent.trim())).map(e=>e.textContent),template:d.textContent.includes('A lasting collaborator. Discussions and notes belong to this Mote.'),background:getComputedStyle(d).backgroundColor,textColor:getComputedStyle(d).color}})()`)
      assert.equal(actual.appearance, mode)
      assert.equal(actual.avatarCount, 1); assert.equal(actual.renameCount, 1)
      assert.equal(actual.avatarHit, true); assert.equal(actual.renameHit, true)
      assert.ok(Math.abs(actual.avatar.width - 64) < .1 && Math.abs(actual.avatar.height - 64) < .1)
      assert.deepEqual(actual.avatarAssetLogical, { width: 64, height: 64 }, 'Original avatar asset fills its real Profile target; the motion layer may articulate it')
      assert.ok(actual.rename.width >= 23 && actual.rename.height >= 23, 'Original shared name icon has its usable 24px target')
      assert.equal(actual.renameText, ''); assert.equal(actual.renameIcon, true)
      assert.deepEqual(actual.oldButtons, []); assert.equal(actual.template, false)
      assert.deepEqual(actual.tabs, ['Profile', 'Ideas'])
      assert.ok(actual.selfSetting.includes('Coordinate this original Topic'))
      assert.deepEqual(actual.recent, ['next-step', 'earlier-idea'], 'Finite FS mtime, including zero, owns recency; unknown entries are excluded only from Recent')
      assert.equal(actual.name, 'Mote'); assert.ok(actual.status.includes('working'))
      ;(result.profileControlPresentations ??= []).push(actual)
    }
    result.step = 'native-Profile-single-avatar-name-icon-and-original-modal-return'
    await until('JSON.stringify([...document.querySelectorAll(".surface-tool-dock .mote-details__recent .mote-details__note")].map(e=>e.textContent.trim()))===JSON.stringify(["next-step","earlier-idea"])')
    await appearance('dark'); await inspect('dark')
    await size(1100, 760); await showSpaceTools(); await inspect('dark')
    await beginImageMotion(true); result.moteMotion.left = await imagePointer('left')
    await capture('wide-dark-Profile-single-avatar-and-name-icon')
    await read('window.sharedFrameProof.setProfileMoteStatus("working")')

    // Use the real pointer and then the native keyboard path. No DOM focus,
    // synthetic click, selection repair or replacement dialog is involved.
    await read('window.profileAvatarTrigger=' + avatar)
    await click(avatar); await until('!!document.querySelector("[role=dialog].space-icon-picker")')
    await captureModal('wide-dark-original-avatar-picker-from-Profile-avatar', 'document.querySelector("[role=dialog].space-icon-picker")')
    await click(button('document.querySelector("[role=dialog].space-icon-picker")', 'Cancel'))
    await until('!document.querySelector("[role=dialog].space-icon-picker")&&document.activeElement===window.profileAvatarTrigger')
    await click(profileTab); await key('Tab', 'Tab', 9)
    assert.equal(await read('document.activeElement===' + avatar), true, 'Native Tab reaches the only avatar trigger')
    await nativeEnter(); await until('!!document.querySelector("[role=dialog].space-icon-picker")')
    await key('Escape', 'Escape', 27)
    await until('!document.querySelector("[role=dialog].space-icon-picker")&&document.activeElement===window.profileAvatarTrigger')
    await key('Tab', 'Tab', 9)
    assert.equal(await read('document.activeElement===' + rename), true, 'Native Tab reaches the name-adjacent rename icon')
    await read('window.profileRenameTrigger=' + rename)
    await nativeEnter()
    await until('document.activeElement===document.querySelector("[role=dialog].mote-rename input")')
    assert.equal(await read('document.querySelector("[role=dialog].mote-rename input").value'), 'Mote')
    await captureModal('wide-dark-original-rename-dialog-from-name-icon', 'document.querySelector("[role=dialog].mote-rename")')
    await key('Escape', 'Escape', 27)
    await until('!document.querySelector("[role=dialog].mote-rename")&&document.activeElement===window.profileRenameTrigger')
    await click(profileTab)
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert.equal(await read('document.activeElement===' + profileTab), true, 'Later explicit original Profile focus stays selected')

    await appearance('light'); await inspect('light')
    await beginImageMotion(false); result.moteMotion.right = await imagePointer('right')
    assert.ok(parseFloat(result.moteMotion.left.x) < 0 && parseFloat(result.moteMotion.right.x) > 0)
    assert.notEqual(result.moteMotion.right.rigTransform, result.moteMotion.left.rigTransform)
    await capture('wide-light-Profile-single-avatar-and-name-icon')
    result.moteMotion.far = await imagePointer('far')
    assert.equal(result.moteMotion.far.x, ''); assert.equal(result.moteMotion.far.turn, '')
    await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await until('window.profileMoteMotionNode.dataset.moteMotion==="off"')
    const reducedPoint = result.moteMotion.left.point
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...reducedPoint, buttons: 0 }); await settledFrame()
    result.moteMotion.reduced = await observeImageMotion()
    assert.equal(result.moteMotion.reduced.gaze, 'far'); assert.equal(result.moteMotion.reduced.x, '')
    assert.equal(result.moteMotion.reduced.animation, null)
    await input('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await until('window.profileMoteMotionNode.dataset.moteMotion==="on"')
    await read('window.sharedFrameProof.setProfileMoteStatus("working")')
    await size(640, 680); await showSpaceTools(); await inspect('light')
    await appearance('dark'); await inspect('dark')
    const after = await facts()
    assert.deepEqual(protectedFacts(after), protectedFacts(before))
    for (const name of ['selection', 'focus', 'floating']) assert.deepEqual(after[name], before[name])
    assert.deepEqual(await read('window.sharedFrameProof.profileControlsFacts()'), metadata, 'Cancelled original dialogs do not write a name or avatar')
    result.profileNativeKeyEvents = await read('window.profileNativeKeys')
    result.checks.push({ name: 'Native-Profile-single-avatar-name-icon-wide-narrow-light-dark-and-original-modal-keyboard-return', passed: true })
  }
  if (phase === 'seed') {
    assert.equal(result.initial.initialization.seedApplied, true)
    result.step = 'native-compact-floating-shortcut-and-original-input'
    await visible(primary, target); await until(editor)
    await read('window.shortcutOriginalInput=' + editor)
    await read('window.shortcutOriginalMotionNode=' + selector(panel, '[data-mote-topic-id="' + primary + '"] .mote-identity-motion'))
    result.privateWindowBeforeClick = { focused: win.isFocused(), webContentsFocused: win.webContents.isFocused() }
    await read(`(()=>{window.shortcutNativeEvents=[];const describe=e=>e instanceof Element?{tag:e.tagName,class:e.className,contenteditable:e.getAttribute('contenteditable'),tab:e.closest('[data-workbench-tab-id]')?.dataset.workbenchTabId,group:e.closest('[data-workbench-group-id]')?.dataset.workbenchGroupId,panel:!!e.closest('#pmo-teams-topic-floating-panel')}:null;for(const type of ['pointerdown','mousedown','mouseup','click','focusin','focusout'])document.addEventListener(type,event=>{if(window.shortcutNativeEvents.length>=120)return;const entry={type,time:performance.now(),detail:event.detail,x:event.clientX,y:event.clientY,defaultPrevented:event.defaultPrevented,target:describe(event.target),active:describe(document.activeElement),stack:new Error().stack?.slice(0,3000)};window.shortcutNativeEvents.push(entry);setTimeout(()=>{entry.defaultPreventedAfter=event.defaultPrevented;entry.activeAfter=describe(document.activeElement)},0);},{capture:true,passive:true});window.shortcutInputBeforeClick={attrs:[...window.shortcutOriginalInput.attributes].map(a=>[a.name,a.value]),hasFocus:document.hasFocus(),active:describe(document.activeElement),pmEditable:window.shortcutOriginalInput.pmViewDesc?.view?.editable}})()`)
    result.inputBeforeClick = await read('window.shortcutInputBeforeClick')
    await read(`(()=>{for(const type of ['pointerdown','mousedown','mouseup','click'])document.addEventListener(type,event=>{window.shortcutNativeEvents.push({type,time:performance.now(),stage:'document-bubble',defaultPrevented:event.defaultPrevented,detail:event.detail,x:event.clientX,y:event.clientY,activeTag:document.activeElement?.tagName});},{passive:true});})()`)
    if (shortcutPointerDiagnostic) await read(`(()=>{const original=Event.prototype.preventDefault;window.shortcutPreventDefaultCalls=[];Event.prototype.preventDefault=function(...args){if(this.type==='pointerdown'&&window.shortcutOriginalInput?.contains(this.target)){window.shortcutPreventDefaultCalls.push({type:this.type,target:this.target?.outerHTML,time:performance.now(),stack:new Error().stack,handles:[...document.querySelectorAll('[data-panel-resize-handle-id]')].map(e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e),popover=e.closest('[popover]');return{attrs:[...e.attributes].map(a=>[a.name,a.value]),class:e.className,rect:{x:r.x,y:r.y,width:r.width,height:r.height},intersectsFine:this.clientX>=r.left-5&&this.clientX<=r.right+5&&this.clientY>=r.top-5&&this.clientY<=r.bottom+5,intersectsCoarse:this.clientX>=r.left-15&&this.clientX<=r.right+15&&this.clientY>=r.top-15&&this.clientY<=r.bottom+15,hidden:!!e.closest('[hidden],[inert]'),visibility:c.visibility,display:c.display,popover:popover?{id:popover.id,open:popover.matches(':popover-open')}:null,ancestorGroup:e.closest('[data-workbench-group-id],[data-pane-group-id]')?.outerHTML.slice(0,220)}})});}return Reflect.apply(original,this,args)};window.restoreShortcutEventDiagnostic=()=>{Event.prototype.preventDefault=original};})()`)
    result.originalResizeHandleAdmission = await read(`(()=>{const p=${panel},e=${editor},r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return [...document.querySelectorAll('.pane-resize-handle[data-panel-resize-handle-id],.workbench-region-resize-handle[data-panel-resize-handle-id]')].map(h=>{const q=h.getBoundingClientRect(),c=getComputedStyle(h);return{attrs:[...h.attributes].map(a=>[a.name,a.value]),enabled:h.dataset.panelResizeHandleEnabled,hidden:!!h.closest('[hidden],[inert]')||c.visibility==='hidden',inFloating:p.contains(h),fineHit:x>=q.left-5&&x<=q.right+5&&y>=q.top-5&&y<=q.bottom+5,rect:{x:q.x,y:q.y,width:q.width,height:q.height}}})})()` )
    if (!shortcutPointerDiagnostic) for(const handle of result.originalResizeHandleAdmission.filter(h=>h.hidden&&h.fineHit)) assert.equal(handle.enabled,'false','The actual hidden original split must not register a hit across the visible input')
    await click(editor)
    result.shortcutCaret = { afterNativeClick: await observeCaret() }
    try { await until('document.activeElement===' + editor) }
    finally {
      result.nativeInputEvents = await read('window.shortcutNativeEvents')
      result.preventDefaultCalls = await read('window.shortcutPreventDefaultCalls??[]')
      await read('window.restoreShortcutEventDiagnostic?.()')
      const stack=result.preventDefaultCalls.map(call=>call.stack).join('\n')
      for(const match of stack.matchAll(/file:\/\/([^\s)]+):(\d+):(\d+)/g)){
        const file=decodeURIComponent(match[1]);try{const bytes=await fs.readFile(file,'utf8'),line=bytes.split('\n')[Number(match[2])-1];(result.preventDefaultSourceExcerpts??=[]).push({file:path.basename(file),line:Number(match[2]),column:Number(match[3]),excerpt:line?.slice(Math.max(0,Number(match[3])-700),Number(match[3])+700)});}catch{}
      }
    }
    await key('End', 'End', 35)
    result.shortcutCaret.afterEnd = await observeCaret()
    for (let i = 0; i < 3; i++) await key('ArrowLeft', 'ArrowLeft', 37)
    const beforeType = await observeCaret()
    result.shortcutCaret.beforeType = beforeType
    assert.ok(beforeType.focused && beforeType.collapsed && beforeType.offset > 0)
    const insertion = ' · shortcut'
    await input('Input.insertText', { text: insertion })
    await until(editor + '.textContent===' + JSON.stringify(beforeType.text.slice(0, beforeType.offset) + insertion + beforeType.text.slice(beforeType.offset)))
    const typed = await observeCaret()
    assert.equal(typed.offset, beforeType.offset + insertion.length)
    result.shortcutCaret.afterTyping = typed
    if (shortcutPointerDiagnostic) {
      result.nativeInputEvents = await read('window.shortcutNativeEvents')
      result.checks.push({ name:'Private-window-native-focus-compatibility-input-counter-only',passed:true })
      result.final=await facts(); assert.deepEqual(forbidden(result.final), []); return
    }
    await assertSimpleFloating(); await capture('wide-floating-compact-Space-shortcut')
    const beforeResize = await facts()
    await size(640, 680)
    const narrow = await observeCaret()
    assert.equal(narrow.same, true); assert.equal(narrow.focused, true)
    assert.equal(narrow.hidden, false); assert.equal(narrow.collapsed, true)
    assert.equal(narrow.offset, typed.offset); assert.equal(narrow.text, typed.text)
    assert.ok(narrow.rect.width > 0 && narrow.rect.height > 0)
    assert.deepEqual(protectedFacts(await facts()), protectedFacts(beforeResize))
    assert.deepEqual((await facts()).floating.reference, reference)
    await assertSimpleFloating(); await capture('narrow-floating-compact-Space-shortcut')
    result.checks.push({ name: 'Native-compact-shared-Tab-action-and-resize-preserve-original-input-caret-and-fulltuple', passed: true })

    result.step = 'native-shortcut-opens-exact-second-Group-in-original-Space'
    const beforeOpen = await facts()
    await click(shortcut); await until('!' + panel + '.matches(":popover-open")')
    const inSpace = await assertSpaceReference(reference)
    assert.deepEqual(protectedFacts(inSpace), protectedFacts(beforeOpen))
    await until('!!document.querySelector(".workspace-workbench-slot[data-visible=true] [data-workbench-group-id=original-mote-second][data-workbench-tab-id=mote-primary-tab] .composer__editor .tiptap")')
    result.openedReference = inSpace.selection
    await until('!window.shortcutOriginalMotionNode.isConnected||window.shortcutOriginalMotionNode.dataset.moteMotion==="off"')
    const hiddenMotionBefore = await read('({connected:window.shortcutOriginalMotionNode.isConnected,motion:window.shortcutOriginalMotionNode.dataset.moteMotion,gaze:window.shortcutOriginalMotionNode.dataset.moteGaze,x:window.shortcutOriginalMotionNode.style.getPropertyValue("--mote-gaze-x"),turn:window.shortcutOriginalMotionNode.style.getPropertyValue("--mote-head-turn"),animations:window.shortcutOriginalMotionNode.getAnimations({subtree:true}).map(a=>a.animationName),liveFloatingChoices:document.querySelectorAll("#pmo-teams-topic-floating-panel [data-mote-topic-id] .mote-identity-motion").length})')
    if (hiddenMotionBefore.connected) assert.equal(hiddenMotionBefore.motion, 'off')
    else assert.equal(hiddenMotionBefore.liveFloatingChoices, 0, 'The original closed floating chooser is unmounted')
    assert.deepEqual(hiddenMotionBefore.animations, [], 'The original hidden or unmounted floating identity has no active animation')
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 40, y: 300, buttons: 0 }); await settledFrame()
    result.hiddenFloatingMotion = await read('({connected:window.shortcutOriginalMotionNode.isConnected,motion:window.shortcutOriginalMotionNode.dataset.moteMotion,gaze:window.shortcutOriginalMotionNode.dataset.moteGaze,x:window.shortcutOriginalMotionNode.style.getPropertyValue("--mote-gaze-x"),turn:window.shortcutOriginalMotionNode.style.getPropertyValue("--mote-head-turn"),animations:window.shortcutOriginalMotionNode.getAnimations({subtree:true}).map(a=>a.animationName),liveFloatingChoices:document.querySelectorAll("#pmo-teams-topic-floating-panel [data-mote-topic-id] .mote-identity-motion").length,outerClosed:!document.getElementById("pmo-teams-topic-floating-panel").matches(":popover-open")})')
    assert.equal(result.hiddenFloatingMotion.outerClosed, true)
    const { outerClosed, ...hiddenMotionAfter } = result.hiddenFloatingMotion
    assert.deepEqual(hiddenMotionAfter, hiddenMotionBefore, 'A hidden or unmounted original floating rig acquires no new pointer pose')
    await showSpaceTools(); await chooseSection(root, 'Profile')
    assert.equal(await read('!!document.querySelector(".surface-tool-dock .workspace-tool-explorer")'), true)
    await exerciseProfileControls()
    await capture('narrow-full-Space-profile-and-original-files')
    await size(1100, 760); await showSpaceTools()
    await chooseSection(root, 'Profile')
    await click(selector('document.querySelector(".surface-tool-dock .mote-details")', 'button[aria-label="Edit self setting"]'))
    await until('Object.values(window.sharedFrameProof.facts().tabs).some(t=>Object.values(t.regions).some(r=>r.kind==="file"&&r.path.endsWith("/SOUL.md")))')
    await until('(()=>{const e=document.querySelector(".workspace-workbench-slot[data-visible=true] .monaco-editor .view-line");return !!e?.textContent.replaceAll("\u00a0"," ").includes("Coordinate this original Topic")})()')
    await capture('wide-full-Space-self-setting-and-original-Editor')
    const recentNote = selector('document.querySelector(".surface-tool-dock .mote-details__recent")', 'button.mote-details__note')
    await click(recentNote)
    const ideasPanel = selector(root, '[role=tabpanel][aria-label="Mote ideas"]')
    await until(selector(ideasPanel, '.mote-details__preview') + '?.textContent.includes("A useful next step")')
    assert.equal(await read('document.querySelector(".mote-details__note[aria-pressed=true]")?.textContent.includes("next-step.md")'), true)
    assert.equal(await read(ideasPanel + '?.textContent.includes("undated-idea")'), true, 'Unknown mtime does not remove the original note from Ideas')
    const detachedBefore = await observeImageMotion(); assert.equal(detachedBefore.connected, false)
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...result.moteMotion.left.point, buttons: 0 }); await settledFrame()
    result.moteMotion.detached = await observeImageMotion()
    assert.deepEqual(result.moteMotion.detached, detachedBefore, 'A detached original Profile rig does not acquire a new pointer pose')
    assert.equal(await read('!!' + button(root, 'New note')), true)
    await capture('wide-full-Space-durable-ideas')
    result.checks.push({ name: 'Native-Space-shortcut-retains-exact-occurrence-and-full-Space-profile-files-self-setting-ideas', passed: true })
    result.checks.push({ name: 'Native-Profile-Self-setting-opens-original-right-Editor-and-Recent-ideas-select-original-mtime-note', passed: true })

    result.step = 'empty-original-Mote-Space-shortcut-does-not-create-a-discussion'
    await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
    await chooseMote(custom, 'custom-mote-tab')
    await click(selector(panel, 'button[data-workbench-tab-id="custom-mote-tab"] .workbench-tab__close'))
    await until(button(root, 'Keep Session & Close')); await click(button(root, 'Keep Session & Close'))
    await visible(custom, null)
    const empty = await facts(); assert.equal(empty.tabs['custom-mote-tab'], undefined)
    const sleepingMotion = selector(panel, '[data-mote-topic-id="' + custom + '"] .mote-identity-motion')
    await until(sleepingMotion + '.dataset.moteExpression==="sleep"')
    const sleepPoint = await read(`(()=>{const e=${sleepingMotion}.querySelector('.mote-face'),r=e.getBoundingClientRect();return{x:r.x+r.width/2+30,y:r.y+r.height/2}})()`)
    await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sleepPoint, buttons: 0 })
    await until(sleepingMotion + '.dataset.moteGaze==="near"')
    result.moteMotion.sleep = await read(`(()=>{const n=${sleepingMotion};return{expression:n.dataset.moteExpression,gaze:n.dataset.moteGaze,awake:getComputedStyle(n.querySelector('.mote-face__awake-eyes')).display,sleep:getComputedStyle(n.querySelector('.mote-face__sleep-eyes')).display}})()`)
    assert.equal(result.moteMotion.sleep.expression, 'sleep'); assert.equal(result.moteMotion.sleep.awake, 'none')
    assert.notEqual(result.moteMotion.sleep.sleep, 'none', 'The original saved sleeping face is not awakened by the pointer')
    await assertSimpleFloating(true); await capture('wide-empty-floating-compact-Space-shortcut')
    await click(shortcut); await until('!' + panel + '.matches(":popover-open")')
    const emptySpace = await facts()
    assert.equal(emptySpace.selection?.topicId, custom)
    assert.equal(emptySpace.activeWorkspaceId, '__scratch__')
    assert.equal(emptySpace.mainSurface, 'workbench')
    assert.ok(!emptySpace.selection?.tabId, 'Empty Space action never invents a discussion Tab')
    assert.deepEqual(protectedFacts(emptySpace), protectedFacts(empty))
    await showSpaceTools(); await chooseSection(root, 'Profile')
    await capture('wide-empty-full-Space-with-original-files-and-profile')
    await size(640, 680)
    await read('window.sharedFrameProof.setProfileAppearance("light")')
    await until('document.documentElement.dataset.appearance==="light"')
    const longProfile = selector(root, '.surface-tool-dock .mote-details[data-mote-details="' + custom + '"]')
    const longName = await read(`(()=>{const d=${longProfile},name=d.querySelector('.mote-details__identity strong'),n=d.querySelector('button[aria-label="Rename Mote"]'),r=n.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{name:name.textContent,renameHit:h===n||n.contains(h),nameBounds:{width:name.getBoundingClientRect().width,height:name.getBoundingClientRect().height},renameBounds:{width:r.width,height:r.height},text:d.textContent}})()`)
    assert.equal(longName.name, 'Review the next step with the original project team')
    assert.equal(longName.renameHit, true, 'The original long-name Profile still exposes its name icon')
    assert.ok(longName.nameBounds.width > 0 && longName.nameBounds.height > 0)
    assert.equal(longName.text.includes('A lasting collaborator. Discussions and notes belong to this Mote.'), false)
    result.longNameProfile = longName
    await capture('narrow-light-long-name-Profile-single-avatar-and-name-icon')
    await read('window.sharedFrameProof.setProfileAppearance("dark")')
    await until('document.documentElement.dataset.appearance==="dark"')
    await size(1100, 760)
    result.checks.push({ name: 'Native-empty-Mote-enters-original-Space-with-no-new-Tab-Session-or-Run', passed: true })
    const treeToggle = selector(root, 'button[data-project-rail-toggle]')
    const treeWasOpen = await read(treeToggle + '.getAttribute("aria-expanded")==="true"')
    if (!treeWasOpen) await click(treeToggle)
    const ordinaryRow = selector(root, '[data-space-nav="topic:launcher:ordinary"]')
    await until(ordinaryRow)
    result.moteMotion.normalTopic = await read(`(()=>{const row=${ordinaryRow},i=row.querySelector('[data-space-icon-kind="topic"]');return{present:!!i,visible:i?.getClientRects().length>0,moteOwner:!!i?.closest('.mote-identity-motion'),moteAnimations:i?.getAnimations({subtree:true}).filter(a=>(a.animationName??'').startsWith('mote-')).map(a=>a.animationName)}})()`)
    assert.equal(result.moteMotion.normalTopic.present, true); assert.equal(result.moteMotion.normalTopic.visible, true)
    assert.equal(result.moteMotion.normalTopic.moteOwner, false); assert.deepEqual(result.moteMotion.normalTopic.moteAnimations, [])
    if (!treeWasOpen) await click(treeToggle)
    result.checks.push({ name: 'Native-default-Mote-image-original-motion-idle-pointer-gaze-and-hidden-reduced-sleep-facts', passed: true })

    // Leave the same exact original discussion address selected by the actual
    // shortcut, so a new process restores it via the original durable owner.
    await read('window.sharedFrameProof.selectOriginal()'); await visible(primary, target)
    await click(shortcut); await until('!' + panel + '.matches(":popover-open")')
    await assertSpaceReference(reference)
    result.step = 'original-visible-Space-split-still-accepts-native-drag'
    const beforeDrag = await facts()
    const handle = selector('document.querySelector(".workspace-workbench-slot[data-visible=true]")','.pane-resize-handle[data-panel-resize-handle-enabled=true]')
    const point = await read(`(()=>{const e=${handle};if(!e)throw new Error('Original visible Space resize handle missing');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:h===e||e.contains(h),hidden:!!e.closest('[hidden],[inert]'),enabled:e.dataset.panelResizeHandleEnabled}})()`)
    assert.equal(point.hit,true);assert.equal(point.hidden,false);assert.equal(point.enabled,'true')
    await input('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,buttons:0})
    await input('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1})
    await input('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+18,y:point.y,button:'left',buttons:1})
    await input('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+18,y:point.y,button:'left',buttons:0,clickCount:1})
    await until('window.sharedFrameProof.facts().layouts.__scratch__.root.ratio!=='+beforeDrag.layouts.__scratch__.root.ratio)
    const afterDrag=await facts()
    assert.deepEqual(afterDrag.tabs,beforeDrag.tabs);assert.deepEqual(afterDrag.drafts,beforeDrag.drafts);assert.deepEqual(afterDrag.runs,beforeDrag.runs)
    const previousLayout=normalized(beforeDrag.layouts.__scratch__),actualLayout=normalized(afterDrag.layouts.__scratch__);actualLayout.root.ratio=previousLayout.root.ratio;assert.deepEqual(actualLayout,previousLayout)
    result.visibleSpaceResize={point,beforeRatio:beforeDrag.layouts.__scratch__.root.ratio,afterRatio:afterDrag.layouts.__scratch__.root.ratio}
    result.checks.push({name:'Native-visible-original-Space-split-remains-interactive-with-identities-and-drafts-preserved',passed:true})
    result.final = afterDrag
    result.profileMetadataFinal = await read('window.sharedFrameProof.profileControlsFacts()')
  } else {
    result.step = 'second-real-PID-original-initialize-restores-Space-tuple-and-draft'
    const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8')).final
    const restored = await facts()
    assert.equal(restored.initialization.seedApplied, false)
    for (const name of ['tabs', 'layouts', 'drafts', 'outbox', 'viewModes', 'activeWorkspaceId', 'mainSurface', 'selection', 'focus', 'floating'])
      assert.deepEqual(normalized(restored[name]), normalized(prior[name]), 'Real restart retains exact durable ' + name)
    assert.deepEqual(restored.runs, prior.runs)
    const seed = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8'))
    assert.deepEqual(await read('window.sharedFrameProof.profileControlsFacts()'), seed.profileMetadataFinal, 'Original saved face and Topic facts survive ordinary restore')
    await assertSpaceReference(reference)
    await click(entry); await visible(primary, target); await until(editor)
    assert.deepEqual((await facts()).floating.reference, reference)
    await until(editor + '.textContent.includes("shortcut")')
    await assertSimpleFloating(); await capture('wide-second-PID-restored-compact-floating-and-original-draft')
    result.final = await facts()
    result.checks.push({ name: 'Real-PID-restart-ordinary-durable-Space-fulltuple-draft-and-original-Run-identities', passed: true })
  }
  assert.deepEqual(forbidden(result.final), [])
  assert.deepEqual(result.final.tabs['original-project-tab'], result.initial.tabs['original-project-tab'])
  assert.equal(result.final.tabs['original-project-tab'].layout.root.ratio, 0.63)
  result.step = 'original-durable-writer-and-private-profile-flush'
  await until('(()=>{const s=JSON.parse(localStorage.getItem("agentmux-workbench-v1"))?.state,c=window.sharedFrameProof.facts(),p=window.sharedFrameProof.persistence();return !!p.workbench?.tabs["original-project-tab"]&&JSON.stringify(Object.keys(p.workbench.tabs).sort())===JSON.stringify(Object.keys(c.tabs).sort())&&JSON.stringify(p.workbench.layouts)===JSON.stringify(c.layouts)&&JSON.stringify(s.agentComposerDrafts)===JSON.stringify(c.drafts)&&JSON.stringify(s.agentFocus)===JSON.stringify(c.focus)&&JSON.stringify(JSON.parse(localStorage.getItem("agentmux.leader-topic-floating.v1")))===JSON.stringify(c.floating)})()')
  win.webContents.session.flushStorageData()
  result.durable = await read('JSON.parse(localStorage.getItem("agentmux-workbench-v1"))')
  result.coreSpatialDurable = await read('window.sharedFrameProof.persistence().spatial')
  assert.equal(result.final.initialization.initializeCalls, 1)
  assert.ok(result.coreSpatialDurable?.revision > 0)
  assert.equal(result.durable.state.restoredWorkbench, undefined)
  result.checks.push({ name: 'Original-public-spatial-port-writer-flush-and-no-extra-Agent-or-terminal-actions', passed: true })
}
