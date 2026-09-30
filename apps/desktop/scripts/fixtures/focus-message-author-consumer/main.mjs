import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence, variant = 'authors', mode = 'authors'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'profile')); app.setPath('sessionData', path.join(privateRoot, 'session'))
const actual = { passed: false, pid: process.pid, controls: [], variant, mode, frames: [], boundary: 'Compiled production Timeline/API/Store with isolated typed I/O. No Runtime, public Reader qualification, ordinary App restart or installation.' }
let win
// Use the existing Electron fixture lifecycle: do not hold ESM module
// evaluation open while waiting for the application's ready event.
app.whenReady().then(async () => {
try {
  win = new BrowserWindow({ width: 1440, height: 540, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  await win.loadFile(html, { query: { variant } }); win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const until = async expression => { for (let i = 0; i < 200; i++) { const result = await win.webContents.executeJavaScript(expression); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error(`Did not settle: ${expression}`) }
  const state = () => win.webContents.executeJavaScript('navigationSceneState()')
  const point = selector => win.webContents.executeJavaScript(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw new Error('Missing actual target');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const painted = () => win.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  const settledPopup = async bodyName => await win.webContents.executeJavaScript(`(async()=>{const p=document.querySelector('.recent-focus__message-preview[role="dialog"]');if(!p)throw new Error('Actual pinned popup required');const animations=p.getAnimations(),before=animations.map(a=>({type:a.constructor.name,playState:a.playState,currentTime:a.currentTime}));await Promise.all(animations.map(a=>a.finished));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return{count:animations.length,before,after:animations.map(a=>({type:a.constructor.name,playState:a.playState,currentTime:a.currentTime})),popup:p.getBoundingClientRect().toJSON(),sameBody:window[${JSON.stringify(bodyName)}]===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString()}})()`)
  const moveTo = async selector => { await painted(); const position = await point(selector); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position }); await painted(); return point(selector) }
  const click = async selector => { const position = await moveTo(selector); const hit = await win.webContents.executeJavaScript(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),h=document.elementFromPoint(${position.x},${position.y});return !!h&&(n===h||n.contains(h))})()`); assert.equal(hit,true,`Actual pointer target: ${selector}`); for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...position, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) }
  const wheel = async (deltaX, deltaY = 0, modifiers = 0) => { const position = await moveTo('.recent-focus__time-scale'); return win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...position, deltaX, deltaY, modifiers }) }
  const shot = async name => {
    const entrance = await win.webContents.executeJavaScript(`(async()=>{const p=document.querySelector('.recent-focus__message-preview'),animations=p?.getAnimations({subtree:true})??[],before=animations.map(a=>({type:a.constructor.name,playState:a.playState,currentTime:a.currentTime}));await Promise.all(animations.map(a=>a.finished));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return{before,after:animations.map(a=>({type:a.constructor.name,playState:a.playState,currentTime:a.currentTime})),opacity:p?getComputedStyle(p).opacity:null}})()`)
    if (entrance.opacity !== null) assert.equal(entrance.opacity,'1')
    const cameraDom = () => win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview'),b=document.querySelector('[data-input-preview-id]');return{state:navigationSceneState(),range:document.querySelector('.recent-focus__range').textContent,date:document.querySelector('.recent-focus__date')?.value,markerIDs:[...document.querySelectorAll('[data-message-id]')].map(n=>n.dataset.messageId),preview:p?{opacity:getComputedStyle(p).opacity,role:p.dataset.messageAuthor,bodyID:b?.dataset.inputPreviewId,bodyText:b?.textContent}:null,selection:window.getSelection().toString()}})()`)
    const cameraBefore = await cameraDom(), prime = await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}), primeBytes = prime.toPNG()
    assert.equal(prime.isEmpty(),false); const cameraAfterPrime = await cameraDom(); assert.deepEqual(cameraAfterPrime,cameraBefore)
    const primeFile = name === 'wide' ? `${variant}-${name}-camera-prime.png` : null
    if (primeFile) await fs.writeFile(path.join(evidence,primeFile),primeBytes)
    const primeFact = { size:prime.getSize(),sha256:createHash('sha256').update(primeBytes).digest('hex'),file:primeFile }
    await painted()
    const header = await win.webContents.executeJavaScript(`(()=>{const h=document.querySelector('.recent-focus__header'),r=h.getBoundingClientRect(),v=document.querySelector('.recent-focus__viewport').getBoundingClientRect();const controls=[...h.querySelectorAll('button,select,input')].map(n=>({name:n.getAttribute('aria-label'),r:n.getBoundingClientRect().toJSON()}));return{height:r.height,viewportHeight:v.height,controls}})()`)
    assert.equal(header.height, 28); assert.ok(header.viewportHeight >= 66)
    const image = `${variant}-${name}.png`, finalFrame = await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}); assert.equal(finalFrame.isEmpty(),false); await fs.writeFile(path.join(evidence, image),finalFrame.toPNG())
    const cameraAfter = await cameraDom(); assert.deepEqual(cameraAfter,cameraBefore)
    actual.frames.push({ image, width: await win.webContents.executeJavaScript('innerWidth'), header, state: await state(), camera:{entrance,before:cameraBefore,afterPrime:cameraAfterPrime,prime:primeFact,after:cameraAfter} })
  }
  if (variant === 'authors-crowded') {
    await until('window.navigationSceneState && navigationSceneState().markers.length===4')
    const markers = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.recent-focus__message')].map(n=>({id:n.dataset.messageId,role:n.dataset.messageAuthor,at:Number(n.dataset.messageAt)}))`)
    assert.equal(markers.length,4); assert.equal(new Set(markers.map(n=>Math.floor(n.at/60000))).size,1)
    actual.pointerCoverage = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.recent-focus__message')].map(n=>{const r=n.getBoundingClientRect();return{id:n.dataset.messageId,hitId:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.recent-focus__message')?.dataset.messageId}})`)
    actual.pointerBoundary = 'Coincident marker centers can be occluded; individual keyboard markers and all Input record bodies are checked below. This scene does not sign direct pointer access to every coincident marker.'
    await win.webContents.executeJavaScript(`document.querySelector('.recent-focus__message').focus()`); actual.keyboardMarkers=[]
    for(let i=0;i<markers.length;i++){
      if(i) for(const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
      await until(`document.activeElement?.dataset.messageId===${JSON.stringify(markers[i].id)}`)
      const focused=await win.webContents.executeJavaScript(`({id:document.activeElement.dataset.messageId,previewId:document.querySelector('[data-input-preview-id]')?.dataset.inputPreviewId,role:document.querySelector('.recent-focus__message-preview .log-turn')?.dataset.speakerRole})`)
      assert.equal(focused.id,markers[i].id);assert.equal(focused.previewId,markers[i].id);assert.equal(focused.role,markers[i].role);actual.keyboardMarkers.push(focused)
    }
    await shot('keyboard-markers')
    await click('[aria-label="View input records"]');await until('navigationSceneState().inputs===5');actual.inputBodies=[]
    const records=await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-input-message-id]')].map(n=>({id:n.dataset.inputMessageId,role:n.dataset.messageAuthor}))`)
    assert.equal(records.length,5)
    for(const record of records){
      await win.webContents.executeJavaScript(`document.querySelector('[data-input-message-id='+${JSON.stringify(JSON.stringify(record.id))}+']').focus()`);
      for(const type of ['rawKeyDown','char','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='char'?{text:'\r',unmodifiedText:'\r'}:{})})
      await until(`document.querySelector('[data-input-preview-id]')?.dataset.inputPreviewId===${JSON.stringify(record.id)}`)
      const body=await win.webContents.executeJavaScript(`({id:document.querySelector('[data-input-preview-id]').dataset.inputPreviewId,role:document.querySelector('[data-input-preview-id] .log-turn').dataset.speakerRole,text:document.querySelector('[data-input-preview-id]').textContent})`);assert.equal(body.role,record.role);assert.ok(body.text.includes(record.id.includes('native-untimed')?'Untimed native input':'Same body from independently recorded authors'));actual.inputBodies.push(body)
    }
    await shot('input-list');actual.final=await state();assert.deepEqual(actual.final.controls,[]);actual.controls=actual.final.controls;actual.passed=true;return
  }
  if (variant === 'authors-addendum') {
    await until('window.navigationSceneState && navigationSceneState().markers.length===4')
    await click('[aria-label="Previous focus window"]'); await click('[aria-label="Next focus window"]')
    await until('navigationSceneState().counts.page>=2')
    actual.initial = await state()
    win.setContentSize(640, 360); await until('innerWidth===640')
    await click('.recent-focus__message[data-message-author="human"]'); await until('!!document.querySelector("[data-input-preview-id]")')
    actual.selection = await win.webContents.executeJavaScript(`(()=>{window.originalAuthorMarker=document.querySelector('.recent-focus__message[data-message-author="human"]');window.originalAuthorBody=document.querySelector('[data-input-preview-id]');const walker=document.createTreeWalker(window.originalAuthorBody,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode()){if(node.textContent.includes('Same body'))break}if(!node)throw new Error('No actual task body');const range=document.createRange();range.selectNodeContents(node);window.getSelection().removeAllRanges();window.getSelection().addRange(range);return window.getSelection().toString()})()`)
    assert.ok(actual.selection.includes('Same body from independently recorded authors'))
    actual.detachedEntrance = await settledPopup('originalAuthorBody'); assert.equal(actual.detachedEntrance.sameBody,true); assert.equal(actual.detachedEntrance.selection,actual.selection)
    actual.beforeDetach = await state(); await wheel(1000)
    await until('!window.originalAuthorMarker.isConnected&&!document.querySelector(".recent-focus__message[data-message-author=human]")')
    actual.afterDetach = await state()
    actual.detached = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview').getBoundingClientRect(),h=document.querySelector('.recent-focus__header').getBoundingClientRect(),b=document.querySelector('[data-input-preview-id]').getBoundingClientRect();return{markerConnected:window.originalAuthorMarker.isConnected,sameBody:window.originalAuthorBody===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString(),popup:p.toJSON(),body:b.toJSON(),header:h.toJSON(),bodyVisible:b.top>=p.top&&b.bottom<=p.bottom,draft:document.querySelector('#original-draft').value}})()`)
    assert.equal(actual.detached.markerConnected,false); assert.equal(actual.detached.sameBody,true); assert.equal(actual.detached.selection,actual.selection); assert.equal(actual.detached.bodyVisible,true); assert.ok(actual.detached.popup.bottom<=actual.detached.header.top-6)
    assert.deepEqual(actual.afterDetach.counts,actual.beforeDetach.counts); assert.equal(actual.detached.draft,'Keep the original draft'); await shot('detached-body')
    win.setContentSize(320,360); await until('innerWidth===320')
    actual.narrowDetachedEntrance = await settledPopup('originalAuthorBody'); assert.equal(actual.narrowDetachedEntrance.sameBody,true); assert.equal(actual.narrowDetachedEntrance.selection,actual.selection)
    const scrollMetrics = () => win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.recent-focus__controls'),s=getComputedStyle(c);return{container:{bounds:c.getBoundingClientRect().toJSON(),clientHeight:c.clientHeight,offsetHeight:c.offsetHeight,clientWidth:c.clientWidth,scrollHeight:c.scrollHeight,scrollWidth:c.scrollWidth,scrollLeft:c.scrollLeft,scrollTop:c.scrollTop,height:s.height,overflowX:s.overflowX,overflowY:s.overflowY,scrollbarWidth:s.scrollbarWidth},controls:['Next focus window','Return to current focus window'].map(name=>{const n=document.querySelector('[aria-label="'+name+'"]'),r=n.getBoundingClientRect();return{name,bounds:r.toJSON(),hits:[r.top+2,r.top+r.height/2,r.bottom-2].map(y=>{const hit=document.elementFromPoint(r.x+r.width/2,y);return{x:r.x+r.width/2,y,tag:hit?.tagName,className:hit?.className,label:hit?.getAttribute('aria-label'),targetHit:!!hit&&(n===hit||n.contains(hit))}})}})}})()`)
    actual.beforeNarrowScrollMetrics = await scrollMetrics()
    const scrollPoint = await moveTo('.recent-focus__controls')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:800,deltaY:0})
    await until('document.querySelector(".recent-focus__controls").scrollLeft>0')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...await point('[aria-label="Next focus window"]')})
    actual.afterNarrowScrollMetrics = await scrollMetrics()
    await win.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    assert.ok(actual.afterNarrowScrollMetrics.controls.every(control=>control.hits.every(hit=>hit.targetHit)), 'Each narrow Next/Now top, centre and bottom hits its actual control after horizontal scroll')
    actual.narrowControls = await win.webContents.executeJavaScript(`(()=>{const container=document.querySelector('.recent-focus__controls');return{scrollLeft:container.scrollLeft,scrollWidth:container.scrollWidth,clientWidth:container.clientWidth,controls:['Next focus window','Return to current focus window'].map(name=>{const n=document.querySelector('[aria-label="'+name+'"]'),r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{name,bounds:r.toJSON(),targetHit:!!hit&&(n===hit||n.contains(hit))}})}})()`)
    assert.ok(actual.narrowControls.scrollLeft>0); assert.equal(actual.narrowControls.controls.length,2); assert.ok(actual.narrowControls.controls.every(item=>item.targetHit))
    const beforeNext = await state(); await click('[aria-label="Next focus window"]'); await until(`navigationSceneState().start===${beforeNext.start+beforeNext.hours*3600000}`)
    actual.afterNext = await state(); assert.equal(await win.webContents.executeJavaScript('window.getSelection().toString()'),actual.selection)
    await click('[aria-label="Return to current focus window"]'); await until('document.querySelector("[aria-label=\\"Return to current focus window\\"]").getAttribute("aria-pressed")==="true"')
    actual.afterNow = await state(); assert.equal(actual.afterNow.start,actual.initial.start)
    await win.webContents.executeJavaScript('document.querySelector("[aria-label=\\"Next focus window\\"]").focus()')
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9})
    await until('document.activeElement?.getAttribute("aria-label")==="Return to current focus window"')
    await shot('narrow-next-now')
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
    await until('!document.querySelector(".recent-focus__message-preview[role=dialog]")')
    actual.returnFocus = await win.webContents.executeJavaScript('document.activeElement?.getAttribute("aria-label")'); assert.equal(actual.returnFocus,'Return to current focus window')
    actual.final = await state(); assert.deepEqual(actual.final.controls,[]); actual.controls=actual.final.controls; actual.passed=true;return
  }
  if (variant === 'authors' || variant === 'authors-closeout') {
    await until('window.navigationSceneState && navigationSceneState().markers.length===4')
    await click('[aria-label="Previous focus window"]'); await click('[aria-label="Next focus window"]')
    await until('navigationSceneState().counts.page>=2')
    actual.initial = await state()
    assert.deepEqual(actual.initial.markers.map(n => n.role), ['unknown', 'human', 'agent', 'unknown'])
    await shot('wide')
    win.setContentSize(640, 360); await until('innerWidth===640'); if (variant === 'authors') await shot('narrow')
    const keyboard = async key => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13 }) }
    for (const role of ['human', 'agent', 'unknown']) {
      const selector = `.recent-focus__message[data-message-author="${role}"]`
      const beforeHover = await state()
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point(selector) })
      await until(`document.querySelector('.recent-focus__message-preview[role="tooltip"]')?.dataset.messageAuthor===${JSON.stringify(role)}`)
      const hover = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview[role="tooltip"]'),a=p.querySelector('.conversation-avatar'),t=p.querySelector('.recent-focus__message-meta time');return{role:p.dataset.messageAuthor,avatarClass:a.className,name:a.getAttribute('aria-label'),context:p.querySelector('.recent-focus__message-caption').textContent,excerpt:p.querySelector('.recent-focus__message-excerpt').textContent,source:p.querySelector('.recent-focus__message-meta span').textContent,time:t.textContent,timeTitle:t.title}})()`)
      assert.equal(hover.role, role); assert.ok(hover.avatarClass.split(' ').includes(`conversation-avatar--${role}`)); assert.ok(hover.name.trim().length > 0)
      assert.equal(hover.context, 'To Recipient worker'); assert.ok(hover.excerpt.includes('Same body from independently recorded authors'))
      assert.equal(hover.source, role === 'unknown' ? 'Native record' : 'Submission record'); assert.ok(hover.time.trim().length > 0); assert.equal(hover.timeTitle, 'Record time, not a verified sender time')
      assert.deepEqual((await state()).controls, beforeHover.controls); actual[`${role}HoverFacts`] = hover
      actual[`${role}Hover`] = true
      const displayRole = role === 'unknown' ? 'human' : role
      await click(selector); await until(`document.querySelector('.recent-focus__message-preview[role="dialog"] .log-turn')?.dataset.speakerRole===${JSON.stringify(displayRole)}`)
      if (role === 'agent') { if (variant === 'authors') await shot('agent-details'); const r = await win.webContents.executeJavaScript(`document.querySelector('.recent-focus__message-preview').getBoundingClientRect().toJSON()`); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:r.left+4, y:r.top+r.height/2, deltaX:0, deltaY:8000 }); await until(`(()=>{const r=document.querySelector('[data-input-preview-id]').getBoundingClientRect(),p=document.querySelector('.recent-focus__message-preview').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom})()`) }
      const author = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview');const r=p.querySelector('[data-input-preview-id]').getBoundingClientRect(),v=p.getBoundingClientRect();return{role:p.dataset.messageAuthor,displayRole:p.querySelector('.log-turn').dataset.speakerRole,name:p.querySelector('.log-turn__who').textContent,metadata:p.querySelector('.recent-focus__message-caption').textContent,body:p.querySelector('[data-input-preview-id]').textContent,senderAction:!!p.querySelector('.recent-focus__sender-link'),width:v.width,bodyVisible:r.top>=v.top&&r.bottom<=v.bottom}})()`)
      assert.equal(author.role, role); assert.equal(author.displayRole, displayRole); assert.ok(author.body.includes('Same body from independently recorded authors')); assert.equal(author.width, 332); assert.equal(author.bodyVisible, true)
      if (role === 'unknown') { assert.equal(author.name, 'You'); assert.ok(author.metadata.includes('Prompt · Sender not recorded')) }
      assert.equal(author.senderAction, role === 'agent'); actual[`${role}Preview`] = author
      await shot(`${role}-preview`)
      await keyboard('Escape'); await until('!document.querySelector(".recent-focus__message-preview[role=dialog]")')
    }
    // Exact known Agent navigation is an explicit action, never marker inspection.
    await click('.recent-focus__message[data-message-author="agent"]'); await until('!!document.querySelector(".recent-focus__sender-link")')
    const senderPopup = await win.webContents.executeJavaScript(`document.querySelector('.recent-focus__message-preview').getBoundingClientRect().toJSON()`); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:senderPopup.left+4, y:senderPopup.top+senderPopup.height/2, deltaX:0, deltaY:8000 })
    await until(`(()=>{const n=document.querySelector('.recent-focus__sender-link'),r=n.getBoundingClientRect(),p=n.closest('.recent-focus__message-preview').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.recent-focus__sender-link')===n})()`); await click('.recent-focus__sender-link'); await until('navigationSceneState().controls.length===1')
    assert.deepEqual((await state()).controls, ['focus-author-sender']); actual.explicitSender = true
    await click('.recent-focus__message[data-message-author="human"]'); await until('!!document.querySelector("[data-input-preview-id]")')
    actual.selection = await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[data-input-preview-id]');window.authorPinned=node;const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(text.textContent.includes('Same body'))break}if(!text)throw new Error('No actual task text');const range=document.createRange();range.selectNodeContents(text);window.getSelection().removeAllRanges();window.getSelection().addRange(range);return window.getSelection().toString()})()`)
    actual.pinnedEntrance = await settledPopup('authorPinned')
    assert.equal(actual.pinnedEntrance.sameBody, true); assert.equal(actual.pinnedEntrance.selection, actual.selection)
    actual.pinnedGeometry = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview').getBoundingClientRect(),h=document.querySelector('.recent-focus__header').getBoundingClientRect();return{popup:p.toJSON(),header:h.toJSON(),controls:[...document.querySelectorAll('[data-focus-window-control]')].map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{name:n.getAttribute('aria-label'),bounds:r.toJSON(),hitClass:hit?.className,targetHit:!!hit&&(n===hit||n.contains(hit))}})}})()`)
    assert.ok(actual.pinnedGeometry.controls.length >= 7)
    assert.ok(actual.pinnedGeometry.controls.every(control => control.targetHit), 'Every actual 640px window control centre is physically reachable while a message is pinned')
    assert.ok(actual.pinnedGeometry.popup.bottom <= actual.pinnedGeometry.header.top - 6, 'Pinned body ends above the stable Timeline Header')
    const before = await state(); assert.ok(before.counts.projector > 0); actual.viewportAttempts = []
    actual.mousePhase = { start: before, controls: [], viewportUpdates: 0 }
    const hitTarget = async (selector, kind, index) => {
      const geometry = await win.webContents.executeJavaScript(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),r=target.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),popup=document.querySelector('.recent-focus__message-preview');return{kind:${JSON.stringify(kind)},index:${index},target:r.toJSON(),popup:popup?.getBoundingClientRect().toJSON(),hit:{tag:hit?.tagName,className:hit?.className,label:hit?.getAttribute('aria-label')},targetHit:!!hit&&(target===hit||target.contains(hit))}})()`)
      actual.viewportAttempts.push(geometry); assert.equal(geometry.targetHit,true, `${kind} target is physically reachable`)
    }
    for (let i = 0; i < 100; i++) {
      let prior=await state(); await hitTarget('.recent-focus__time-scale','wheel',i); await wheel(i % 2 ? -2 : 2); await until(`navigationSceneState().start!==${prior.start}`)
      prior=await state(); const selector=`[aria-label="Zoom ${i % 2 ? 'in' : 'out'} Focus timeline"]`; await hitTarget(selector,'zoom',i); await click(selector); await until(`navigationSceneState().hours!==${prior.hours}`)
      assert.equal(await win.webContents.executeJavaScript('window.getSelection().toString()'),actual.selection, 'Each actual viewport action preserves pinned body selection')
    }
    actual.after200 = await state(); assert.deepEqual(actual.after200.counts, before.counts); assert.equal(actual.after200.hours,before.hours); actual.viewportUpdates = 200
    actual.mousePhase.end = actual.after200; actual.mousePhase.viewportUpdates = 200; actual.mousePhase.controls = actual.after200.controls.slice(before.controls.length); assert.deepEqual(actual.mousePhase.controls, [])
    actual.preservation = await win.webContents.executeJavaScript(`({sameBody:window.authorPinned===document.querySelector('[data-input-preview-id]'),selection:window.getSelection().toString(),draft:document.querySelector('#original-draft').value})`)
    assert.equal(actual.preservation.sameBody, true); assert.equal(actual.preservation.selection, actual.selection); assert.equal(actual.preservation.draft, 'Keep the original draft')
    win.setContentSize(320, 360); await until('innerWidth===320')
    await until(`document.querySelector('.recent-focus__message-preview').getBoundingClientRect().width===304`)
    actual.narrowBrowse = { before: await state(), steps: [] }
    const narrowControls = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.recent-focus__controls button,.recent-focus__controls select,.recent-focus__controls input')].map(n=>n.getAttribute('aria-label'))`)
    assert.ok(narrowControls.length >= actual.pinnedGeometry.controls.length); assert.ok(narrowControls.every(name=>name && name.trim().length > 0))
    for (const name of narrowControls) {
      const selector = `[aria-label="${name}"]`
      const metrics = () => win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.recent-focus__controls'),n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),v=c.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return{name:${JSON.stringify(name)},scrollLeft:c.scrollLeft,clip:v.toJSON(),target:r.toJSON(),inClip:x>=v.left&&x<=v.right&&y>=v.top&&y<=v.bottom,targetHit:!!hit&&(n===hit||n.contains(hit))}})()`)
      const beforeScroll = await metrics()
      if (!beforeScroll.inClip) {
        const direction = beforeScroll.target.x + beforeScroll.target.width/2 < beforeScroll.clip.left ? -1 : 1
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...await moveTo('.recent-focus__controls'),deltaX:800*direction,deltaY:0})
        await until(`document.querySelector('.recent-focus__controls').scrollLeft!==${beforeScroll.scrollLeft}`); await painted()
      }
      const afterScroll = await metrics(); assert.equal(afterScroll.inClip,true, `${name} centre is within the actual horizontal toolbar clip`); assert.equal(afterScroll.targetHit,true, `${name} is physically reachable after original toolbar browsing`)
      assert.equal(await win.webContents.executeJavaScript('window.getSelection().toString()'),actual.selection)
      assert.equal(await win.webContents.executeJavaScript('window.authorPinned===document.querySelector("[data-input-preview-id]")'),true)
      actual.narrowBrowse.steps.push({ before: beforeScroll, after: afterScroll })
    }
    actual.narrowBrowse.after = await state(); assert.deepEqual(actual.narrowBrowse.after.counts,actual.narrowBrowse.before.counts); assert.deepEqual(actual.narrowBrowse.after.controls,actual.narrowBrowse.before.controls)
    await hitTarget('[aria-label="Zoom in Focus timeline"]', 'narrow-zoom', 200)
    actual.narrowPreview = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview'),r=p.getBoundingClientRect(),b=p.querySelector('[data-input-preview-id]').getBoundingClientRect();return{popup:r.toJSON(),body:b.toJSON(),bodyVisible:b.top>=r.top&&b.bottom<=r.bottom,selection:window.getSelection().toString()}})()`)
    assert.equal(actual.narrowPreview.bodyVisible, true); assert.equal(actual.narrowPreview.selection, actual.selection); if (variant === 'authors') await shot('human-320-preview')
    win.setContentSize(640, 360); await until('innerWidth===640')
    await keyboard('Escape'); await until('!document.querySelector(".recent-focus__message-preview[role=dialog]")')
    await click('[aria-label="View input records"]'); await until('navigationSceneState().inputs===5')
    actual.list = await win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-input-message-id]')].map(n=>({id:n.dataset.inputMessageId,role:n.dataset.messageAuthor,label:n.getAttribute('aria-label')}))`)
    assert.deepEqual(actual.list.map(n=>n.role), ['unknown', 'unknown', 'human', 'agent', 'unknown'])
    if (variant === 'authors') await shot('input-list')
    actual.final = await state(); assert.deepEqual(actual.final.counts, before.counts)
    actual.controls = actual.final.controls
    assert.deepEqual(actual.controls, ['focus-author-sender'])
    // The one explicit, verified sender navigation is reported separately from
    // forbidden lifecycle/control operations. No Runtime operation exists here.
    actual.allowedNavigation = [...actual.controls]
    actual.passed = true; return
  }
  await until('window.navigationSceneState && navigationSceneState().counts.catalog===1')
  await click('[aria-label="View input records"]')
  await win.webContents.executeJavaScript(`(()=>{const select=document.querySelector('[aria-label="Input records Context"]');select.value='archive-navigation';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await until('navigationSceneState().inputs===91')
  actual.initial = await state(); assert.deepEqual(actual.initial.counts, { catalog: 1, page: 3, timeline: 1 })
  if (mode === 'supplement') {
    const scroll = async (selector, deltaY) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...await point(selector), deltaX: 0, deltaY })
    if (variant === 'known') {
      await click('[data-input-message-id]'); await until('!!document.querySelector("[data-input-preview-id]")')
      await click('.recent-focus__source-details summary'); await until('document.querySelector(".recent-focus__source-details").open')
      actual.details = await win.webContents.executeJavaScript(`document.querySelector('.recent-focus__source-details').textContent`)
      assert.ok(actual.details.includes('Observed Context project: Alpha')); assert.ok(actual.details.includes('Message-time project: Not recorded'))
      await scroll('.recent-focus__message-preview header', -8000)
      await until('document.querySelector(".recent-focus__message-preview").scrollTop===0')
      actual.detailsGeometry = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.recent-focus__source-details p').getBoundingClientRect(),p=document.querySelector('.recent-focus__message-preview').getBoundingClientRect();return{details:r.toJSON(),preview:p.toJSON(),visible:r.top>=p.top&&r.bottom<=p.bottom}})()`)
      assert.equal(actual.detailsGeometry.visible, true); await shot('source-details')
      await scroll('.recent-focus__message-preview header', 8000)
      await until(`(()=>{const body=document.querySelector('[data-input-preview-id]'),r=body.getBoundingClientRect(),p=body.closest('.recent-focus__message-preview').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom})()`)
      actual.body = await win.webContents.executeJavaScript(`({id:document.querySelector('[data-input-preview-id]').dataset.inputPreviewId,source:document.querySelector('[data-input-preview-id]').dataset.inputSource,text:document.querySelector('[data-input-preview-id]').textContent})`)
      assert.equal(actual.body.source, 'native'); assert.ok(actual.body.text.includes('Original retained task')); await shot('native-body')
    } else {
      for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await until('!document.querySelector(".recent-focus__message-preview")'); win.setContentSize(640, 360); await until('innerWidth===640')
      await win.webContents.executeJavaScript('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      actual.scrollBefore = await win.webContents.executeJavaScript(`(()=>{const n=document.querySelector('.recent-focus__viewport'),r=document.querySelector('.recent-focus__time-scale').getBoundingClientRect();return{scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight,target:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.className}})()`)
      const scrollPoint = await point('.recent-focus__time-scale'); await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...scrollPoint })
      await scroll('.recent-focus__time-scale', 120)
      await until('document.querySelector(".recent-focus__viewport").scrollTop>0')
      actual.scrollAfter = await win.webContents.executeJavaScript(`(()=>{const n=document.querySelector('.recent-focus__viewport');return{scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,clientHeight:n.clientHeight}})()`)
      await shot('unknown-track')
      const nativePoint = await win.webContents.executeJavaScript(`(()=>{const group=[...document.querySelectorAll('[data-timeline-project]')].find(n=>n.dataset.timelineProject==='unknown-project');if(!group)throw new Error('Missing true unknown project');const clip=document.querySelector('.recent-focus__viewport').getBoundingClientRect();for(const node of group.querySelectorAll('[data-message-source="native"]')){const r=node.getBoundingClientRect(),x=r.x+1,y=r.y+r.height/2;if(y<clip.top||y>clip.bottom)continue;const hit=document.elementFromPoint(x,y)?.closest('[data-message-source="native"]');if(hit&&group.contains(hit))return{x,y,id:hit.dataset.messageId}}throw new Error('No visible true native marker hit')})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: nativePoint.x, y: nativePoint.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
      await until('!!document.querySelector("[data-input-preview-id]")')
      actual.nativeHit = nativePoint; actual.body = await win.webContents.executeJavaScript(`({id:document.querySelector('[data-input-preview-id]').dataset.inputPreviewId,source:document.querySelector('[data-input-preview-id]').dataset.inputSource,text:document.querySelector('[data-input-preview-id]').textContent})`)
      assert.equal(actual.body.id, nativePoint.id); assert.equal(actual.body.source, 'native'); assert.ok(actual.body.text.includes('Original retained task')); await shot('native-body')
    }
    actual.final = await state(); assert.deepEqual(actual.final.counts, actual.initial.counts); assert.deepEqual(actual.final.controls, []); actual.passed = true; return
  }
  throw new Error(`Unsupported actual author scene ${variant}/${mode}`)
} catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) { actual.failureGeometry = await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('.recent-focus__message-preview'),h=document.querySelector('.recent-focus__header'),c=document.querySelector('.recent-focus__controls');return{popup:p?.getBoundingClientRect().toJSON(),header:h?.getBoundingClientRect().toJSON(),controlScroll:c?{bounds:c.getBoundingClientRect().toJSON(),clientHeight:c.clientHeight,offsetHeight:c.offsetHeight,clientWidth:c.clientWidth,scrollWidth:c.scrollWidth,scrollLeft:c.scrollLeft,scrollTop:c.scrollTop,overflowX:getComputedStyle(c).overflowX,overflowY:getComputedStyle(c).overflowY}:null,controls:[...document.querySelectorAll('[data-focus-window-control]')].map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{name:n.getAttribute('aria-label'),bounds:r.toJSON(),hitClass:hit?.className,hitLabel:hit?.getAttribute('aria-label'),targetHit:!!hit&&(n===hit||n.contains(hit))}})}})()`); actual.failureState = await state(); actual.controls = actual.failureState.controls; await fs.writeFile(path.join(evidence, `${variant}-failure.png`), (await win.webContents.capturePage()).toPNG()) } }
finally { await fs.writeFile(path.join(evidence, `${variant}-scene.json`), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) }
})
