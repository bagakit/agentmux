const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const [html, privateRoot, evidence, capture] = process.argv.slice(2);
const anchorOnly = capture === "anchor-capture";
const compactContract = process.env.AGENTMUX_PENDING_COMPACT_CONTRACT === '1';
const compactCheckpoint = process.env.AGENTMUX_PENDING_COMPACT_CHECKPOINT ?? null;
assert.ok(compactCheckpoint === null || ['hover', 'distance', 'coarse', 'min-gap', 'overlap', 'more', 'send'].includes(compactCheckpoint), 'Only the seven bounded compact checkpoints are allowed');
app.setPath('userData', path.join(privateRoot, 'user-data'));
let win;
const result = { schema: 'agentmux.composer-pending-delivery-native.v1', passed: false,
  userRunTouched: false, aestheticReview: 'not-performed', scenes: [], frames: [], checkpoints: [], noticeTransitions: [], console: [], rendererErrors: [] };
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const neighbor = `document.querySelector('[data-workbench-region-id="result-input-neighbor"]')`;
const editor = `${surface}.querySelector('.composer [role="textbox"]')`;
const strip = `document.querySelector('.composer-pending:not([hidden])')`;
const selectedCard = `${strip}.querySelector('.composer-pending__card[data-selected="true"]')`;
const panel = `${surface}.querySelector('.composer-mailbox')`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const value = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(expression)})}catch(error){return{__probeError:true,name:error.name,message:error.message,stack:error.stack}}})()`);
  if (value?.__probeError) { const error = new Error(value.message); error.name = value.name; error.stack = value.stack + '\nProbe expression: ' + expression; throw error; }
  return value;
}
async function waitFor(expression) {
  for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25); }
  assert.fail('Actual Renderer fact did not arrive: ' + expression);
}
async function painted() {
  await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  await delay(35);
}
async function click(expression, proofName = null) {
  const before = await evaluate(proofName ? `(()=>{const node=(${expression});if(!node)throw Error('Actual control is absent');const r=node.getBoundingClientRect();if(!r.width||!r.height)throw Error('Actual control is not visible');const point={x:r.x+r.width/2,y:r.y+r.height/2},card=node.closest('.composer-pending__card'),hit=document.elementFromPoint(point.x,point.y),rect=n=>{if(!n)return null;const v=n.getBoundingClientRect();return{x:v.x,y:v.y,width:v.width,height:v.height,right:v.right,bottom:v.bottom}};return{point,target:{tag:node.tagName,label:node.getAttribute('aria-label'),rect:rect(node)},card:card?{operationId:card.dataset.operationId,selected:card.dataset.selected,rect:rect(card),transform:getComputedStyle(card).transform}:null,hit:{tag:hit?.tagName,label:hit?.closest('button')?.getAttribute('aria-label')??null,operationId:hit?.closest('.composer-pending__card')?.dataset.operationId??null},eventStart:pendingNative.buttonEvents.length}})()` : `(()=>{const node=(${expression});if(!node)throw Error('Actual control is absent');const rect=node.getBoundingClientRect();if(!rect.width||!rect.height)throw Error('Actual control is not visible');return{point:{x:rect.x+rect.width/2,y:rect.y+rect.height/2}}})()`);
  const point = before.point, proof = proofName ? { name: proofName, before } : null;
  if (proof) (result.singleClicks ??= []).push(proof);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
  await painted();
  if (proof) proof.after = await evaluate(`(()=>{const point=${JSON.stringify(point)},id=${JSON.stringify(before.card?.operationId ?? null)},node=document.elementFromPoint(point.x,point.y),card=id?document.querySelector('.composer-pending__card[data-operation-id="'+id+'"]'):null,button=card?.querySelector('.composer-pending__more'),rect=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return{point,hit:{tag:node?.tagName,label:node?.closest('button')?.getAttribute('aria-label')??null,operationId:node?.closest('.composer-pending__card')?.dataset.operationId??null},card:card?{operationId:card.dataset.operationId,selected:card.dataset.selected,rect:rect(card),transform:getComputedStyle(card).transform}:null,originalMoreRect:rect(button),popover:${panel}.matches(':popover-open'),events:pendingNative.buttonEvents.slice(${before.eventStart})}})()`);
}
async function key(key, code, virtual, text, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: virtual,
      ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
  }
  await painted();
}
async function geometry() {
  return evaluate(`(()=>{
    const s=${surface},n=${neighbor},rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const original=window.pendingNative?.terminal??s.querySelector('.xterm'),records=globalThis.resultReadyTerminals??[];
    const owner=records.find(r=>r.terminal.element===original&&!r.disposed),other=records.find(r=>n.contains(r.terminal.element)&&!r.disposed);
    const activeBuffer=owner.terminal.buffer.active;
    const terminal={id:owner.id,cols:owner.terminal.cols,rows:owner.terminal.rows,baseY:activeBuffer.baseY,viewportY:activeBuffer.viewportY,
      cursorX:activeBuffer.cursorX,cursorY:activeBuffer.cursorY,cursorLine:activeBuffer.getLine(activeBuffer.baseY+activeBuffer.cursorY)?.translateToString(true),
      visibleLines:Array.from({length:owner.terminal.rows},(_,i)=>activeBuffer.getLine(activeBuffer.viewportY+i)?.translateToString(true)??'')};
    const screen=rect(original.querySelector('.xterm-screen')),cursorRow=terminal.baseY+terminal.cursorY-terminal.viewportY;
    const cellHeight=screen.height/terminal.rows,b=${strip},e=${editor},composer=s.querySelector('.composer');
    const helper=original.querySelector('.xterm-helper-textarea'),helperStyle=getComputedStyle(helper);
    const selected=b?.querySelector('.composer-pending__card[data-operation-id="'+b.dataset.operationId+'"]'),state=selected?.querySelector('.composer-pending__state'),preview=selected?.querySelector('.composer-pending__preview'),mailbox=composer.querySelector('.composer__mailbox');
    const editorSlot=e.closest('.composer__editor'),controls=mailbox.closest('.composer__toolbar > div');
    const range=node=>{if(!node)return[];const r=document.createRange();r.selectNodeContents(node);return[...r.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}))};
    const buffer=other?.terminal.buffer.active;
    return{terminal,nativeLinePrefix:window.pendingNative.nativeLinePrefix,buffer:{type:activeBuffer.type,stable:activeBuffer===window.pendingNative.buffer,repeatedReadStable:activeBuffer===owner.terminal.buffer.active},screen,cellHeight,
      helperTextarea:{rect:rect(helper),height:helperStyle.height,lineHeight:helperStyle.lineHeight,fontSize:helperStyle.fontSize,inlineStyle:helper.getAttribute('style')},
      cursorCell:{x:screen.x+terminal.cursorX*screen.width/terminal.cols,y:screen.y+cursorRow*cellHeight,width:screen.width/terminal.cols,height:cellHeight,right:screen.x+(terminal.cursorX+1)*screen.width/terminal.cols,bottom:screen.y+(cursorRow+1)*cellHeight},cursorText:{x:screen.x,y:screen.y+cursorRow*cellHeight,right:screen.x+Math.min(terminal.cols,terminal.cursorLine.length)*screen.width/terminal.cols,bottom:screen.y+(cursorRow+1)*cellHeight},cursorVisible:cursorRow>=0&&cursorRow<terminal.rows,
      cursorBottom:screen.y+(cursorRow+1)*cellHeight,ownerRect:rect(s),terminalRect:rect(original),
      originalConnected:Boolean(original?.isConnected),originalHidden:Boolean(original?.closest('[hidden]')),originalId:owner?.id,
      retainedNodes:{editor:e===window.pendingNative.editor,terminal:original===window.pendingNative.terminal,neighbor:n===window.pendingNative.neighbor},
      neighbor:{region:rect(n),terminal:rect(n.querySelector('.xterm')),id:other?.id,rows:other?.terminal.rows,cols:other?.terminal.cols,
        cursorX:buffer?.cursorX,cursorY:buffer?.cursorY,baseY:buffer?.baseY,viewportY:buffer?.viewportY,
        visibleLines:buffer?Array.from({length:other.terminal.rows},(_,i)=>buffer.getLine(buffer.viewportY+i)?.translateToString(true)??''):[],
        draft:n.querySelector('.composer [role="textbox"]')?.textContent},
      editor:rect(e),composer:rect(composer),draft:e?.textContent,editorFocused:document.activeElement===e,
      mailbox:{rect:rect(mailbox),attention:rect(mailbox.querySelector('.composer-mailbox__attention')),
        inboxCount:rect(mailbox.querySelector('.composer-mailbox__inbox-count')),progress:rect(mailbox.querySelector('.composer-mailbox__progress')),
        gap:parseFloat(getComputedStyle(mailbox).columnGap),composerDisplay:getComputedStyle(composer).display,
        editorSlot:{rect:rect(editorSlot),isComposerChild:editorSlot.parentElement===composer,gridColumn:getComputedStyle(editorSlot).gridColumn,gridRow:getComputedStyle(editorSlot).gridRow},
        controls:{rect:rect(controls),gridColumn:getComputedStyle(controls).gridColumn,gridRow:getComputedStyle(controls).gridRow}},
      strip:b?{rect:rect(b),operationId:b.dataset.operationId,busy:selected?.dataset.busy,outsideInput:!composer.contains(b),
        count:b.querySelector('.composer-pending__count')?.textContent,position:getComputedStyle(b).position,background:getComputedStyle(b).backgroundColor,
        maskImage:getComputedStyle(b).maskImage,pointerX:b.style.getPropertyValue('--queue-pointer-x'),pointerY:b.style.getPropertyValue('--queue-pointer-y'),
        headerCount:b.querySelectorAll('.composer-pending__heading, .composer-pending__count').length,inlineEditorCount:b.querySelectorAll('.composer-pending__card .composer-queued-editor').length,
        hover:b.matches(':hover'),focused:b.matches(':focus-within'),focusedLabel:b.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null,
        previewClipped:preview?preview.scrollWidth>preview.clientWidth:false,
        heading:rect(b.querySelector('.composer-pending__heading')),announcers:[...b.querySelectorAll('[role="status"]')].map(node=>node.textContent),
        cards:[...b.querySelectorAll('.composer-pending__card')].map(node=>({id:node.dataset.operationId,index:Number(node.dataset.queueIndex),selected:node.dataset.selected,
          rect:rect(node),hover:node.matches(':hover'),transform:getComputedStyle(node).transform,animation:getComputedStyle(node).animationName,timeline:getComputedStyle(node).animationTimeline,shadow:getComputedStyle(node).boxShadow,transition:getComputedStyle(node).transitionDuration,
          layoutHeight:node.offsetHeight,layoutLeft:node.offsetLeft,layoutTop:node.offsetTop,transformOrigin:getComputedStyle(node).transformOrigin,offsetParentIsList:node.offsetParent===node.parentElement,preview:node.querySelector('.composer-pending__preview')?.textContent ?? null,
          editing:node.dataset.editing,ordinal:node.querySelector('.composer-pending__more')?.textContent,background:getComputedStyle(node).backgroundColor,backdropFilter:getComputedStyle(node).backdropFilter,
          previewTitle:node.querySelector('.composer-pending__preview')?.getAttribute('title') ?? null,previewLines:range(node.querySelector('.composer-pending__preview')),
          state:{label:node.querySelector('.composer-pending__state').getAttribute('aria-label'),icon:node.querySelector('.composer-pending__state svg')?.getAttribute('class'),rect:rect(node.querySelector('.composer-pending__state')),hiddenLabel:node.querySelector('.composer-pending__sr-only')?.textContent},
          actions:[...node.querySelectorAll('button')].map(button=>({rect:rect(button),label:button.getAttribute('aria-label'),background:getComputedStyle(button).backgroundColor,
            copyState:button.dataset.copyState,icon:button.querySelector('svg')?.getAttribute('class'),animation:button.querySelector('svg')?getComputedStyle(button.querySelector('svg')).animationName:null}))})),
        reading:{id:b.querySelector('.composer-pending__reading')?.dataset.readingId,text:b.querySelector('.composer-pending__body')?.textContent,
          state:b.querySelector('.composer-pending__reading-state')?.textContent,bodyCount:b.querySelectorAll('.composer-pending__body').length,readerCount:b.querySelectorAll('.composer-pending__reading').length,
          editing:b.querySelectorAll('.composer-pending__reading textarea').length,rect:rect(b.querySelector('.composer-pending__reading'))},
        list:{rect:rect(b.querySelector('.composer-pending__cards')),layoutWidth:b.querySelector('.composer-pending__cards')?.offsetWidth,layoutHeight:b.querySelector('.composer-pending__cards')?.offsetHeight,scrollTop:b.querySelector('.composer-pending__cards')?.scrollTop,scrollHeight:b.querySelector('.composer-pending__cards')?.scrollHeight},
        label:state?.getAttribute('aria-label'),stateRect:rect(state?.querySelector('svg')),preview:preview?.textContent,
        previewRect:rect(preview),sendDisabled:selected?.querySelector('.composer-pending__send')?.disabled}:null,
      popover:s.querySelector('.composer-mailbox').matches(':popover-open'),facts:pendingDelivery.facts(),trustedActions:window.pendingNative.actions,trustedHoverActions:window.pendingNative.hoverActions,buttonEvents:window.pendingNative.buttonEvents,
      terminalEvents:window.pendingNative.terminalEvents}
  })()`);
}
async function settled() {
  let previous = await geometry();
  for (let i = 0; i < 12; i++) {
    await delay(60); const next = await geometry();
    const stable = value => JSON.stringify([value.terminal, value.neighbor, value.editor, value.strip, value.facts.resizes]);
    if (stable(previous) === stable(next)) return next;
    previous = next;
  }
  assert.fail('The actual original terminal geometry did not settle');
}
function noticeGeometry(before, after) {
  for (const facts of [before, after]) {
    assert.equal(facts.mailbox.gap, 2, 'The existing Mailbox uses its actual 2px control gap');
    assert.equal(facts.mailbox.inboxCount, null); assert.equal(facts.mailbox.progress, null);
    if (facts.mailbox.attention) assert.equal(facts.mailbox.attention.width, 10, 'The existing Notices control is the actual 10px Bell');
    assert.ok(facts.editor.width > 0, 'The maintained original editor retains usable positive width');
    assert.equal(facts.mailbox.composerDisplay, 'grid');
    assert.equal(facts.mailbox.editorSlot.isComposerChild, true, 'The actual editor slot is the original composer grid child');
  }
  assert.notEqual(Boolean(after.mailbox.attention), Boolean(before.mailbox.attention), 'This comparison crosses the actual Notices appearance boundary');
  for (const name of ['editorSlot', 'controls']) {
    assert.equal(after.mailbox[name].gridColumn, before.mailbox[name].gridColumn);
    assert.equal(after.mailbox[name].gridRow, before.mailbox[name].gridRow);
  }
  const noticeWidthDelta = (Number(Boolean(after.mailbox.attention)) - Number(Boolean(before.mailbox.attention))) * 12;
  assert.equal(after.mailbox.rect.width - before.mailbox.rect.width, noticeWidthDelta, 'Only the measured 10px Bell and 2px gap change the Mailbox control width');
  assert.equal(after.mailbox.controls.rect.width - before.mailbox.controls.rect.width, noticeWidthDelta, 'Only that Mailbox change grows the original control group');
  const sameRow = after.mailbox.editorSlot.gridRow === after.mailbox.controls.gridRow;
  if (sameRow) {
    for (const facts of [before, after]) {
      const slot = facts.mailbox.editorSlot.rect, controls = facts.mailbox.controls.rect;
      assert.ok(slot.y < controls.bottom && controls.y < slot.bottom, 'Measured original editor and controls share the same row');
      assert.ok(slot.right <= controls.x + 1, 'The original control group occupies the column after the editor');
    }
    assert.equal(after.mailbox.editorSlot.rect.width - before.mailbox.editorSlot.rect.width, -noticeWidthDelta);
    assert.equal(after.editor.width - before.editor.width, -noticeWidthDelta, 'The existing control column takes exactly the Bell and gap from the middle editor');
  }
  else {
    for (const facts of [before, after]) assert.ok(facts.mailbox.controls.rect.y >= facts.mailbox.editorSlot.rect.bottom - 1, 'The original narrow controls occupy the measured row below the editor');
    assert.equal(after.mailbox.editorSlot.rect.width, before.mailbox.editorSlot.rect.width);
    assert.equal(after.editor.width, before.editor.width, 'The narrow editor retains its full row across Notices changes');
  }
  return { before: { mailbox: before.mailbox, editor: before.editor }, after: { mailbox: after.mailbox, editor: after.editor }, noticeWidthDelta, sameRow };
}
function retained(before, after, attentionTransition = false, priorPermissionTransition = false) {
  assert.equal(after.originalConnected, true); assert.equal(after.originalHidden, false);
  assert.equal(after.originalId, before.originalId); assert.equal(after.terminal.id, before.terminal.id);
  assert.deepEqual(after.retainedNodes, { editor: true, terminal: true, neighbor: true }, 'Pending UI retains the actual original DOM nodes');
  assert.equal(after.terminal.cols, before.terminal.cols); assert.equal(after.terminal.cursorX, before.terminal.cursorX);
  assert.equal(after.terminal.cursorLine, before.terminal.cursorLine, 'The original unfinished terminal prompt remains readable');
  assert.deepEqual(after.neighbor, before.neighbor, 'Pending UI leaves the neighboring terminal, layout and draft exact');
  assert.equal(after.draft, before.draft); assert.equal(after.editor.height, before.editor.height);
  const noticeBoundary = attentionTransition ? noticeGeometry(before, after) : null;
  if (!attentionTransition) {
    assert.deepEqual(after.editor, before.editor, 'Floating cards preserve the original editor geometry exactly');
    assert.deepEqual(after.composer, before.composer, 'Floating cards take zero normal-flow height');
    assert.deepEqual(after.terminalRect, before.terminalRect, 'Floating cards preserve the original terminal rectangle');
    assert.equal(after.terminal.rows, before.terminal.rows, 'Floating cards change zero terminal rows');
    if (!priorPermissionTransition) assert.equal(after.facts.resizes.length, before.facts.resizes.length, 'Floating cards cause zero attachment resize requests');
  }
  for (const name of ['sessions', 'tab', 'layout', 'drafts', 'writes', 'pastes']) assert.deepEqual(after.facts[name], before.facts[name], 'Pending UI preserves original ' + name);
  return noticeBoundary;
}
function visibleCursor(facts) {
  assert.equal(facts.cursorVisible, true, 'The actual original terminal cursor remains in its viewport');
  assert.ok(facts.terminal.cursorLine.startsWith(facts.nativeLinePrefix), 'The actual private unfinished terminal text retains its original prefix');
  assert.ok(facts.cursorBottom <= facts.terminalRect.bottom + 1, 'The cursor line remains inside the real terminal');
  if (facts.strip) {
    const intersects=(a,b)=>a.x<b.right&&a.right>b.x&&a.y<b.bottom&&a.bottom>b.y;
    const list=facts.strip.list.rect,visibleCards=facts.strip.cards.filter(card=>intersects(card.rect,list)).map(card=>({x:Math.max(card.rect.x,list.x),right:Math.min(card.rect.right,list.right),y:Math.max(card.rect.y,list.y),bottom:Math.min(card.rect.bottom,list.bottom)}));
    const footprints=[facts.strip.reading.rect,...visibleCards].filter(Boolean);
    assert.ok(footprints.every(r=>!intersects(r,facts.cursorCell)), 'Actual floating card footprints do not cover the terminal cursor cell');
    assert.ok(footprints.every(r=>!intersects(r,facts.cursorText)), 'Actual floating card footprints do not cover the unfinished terminal text');
  }
}
async function frame(scene, name) {
  const paints = await evaluate(`(()=>{const entries=(globalThis.resultReadyTerminals??[]).filter(r=>!r.disposed&&r.terminal.element?.isConnected&&!r.terminal.element.closest('[hidden]'));if(!entries.length)throw Error('No actual visible terminal to paint');return Promise.all(entries.map(r=>new Promise((resolve,reject)=>{let lease;const timer=setTimeout(()=>{lease?.dispose();reject(Error('Actual terminal render did not arrive'))},2000);lease=r.terminal.onRender(range=>{clearTimeout(timer);lease.dispose();resolve({id:r.id,rows:r.terminal.rows,...range})});r.terminal.refresh(0,r.terminal.rows-1)})))})()`);
  assert.equal(paints.length, 2, 'Both original owner and neighbor terminals actually paint');
  await painted(); const image = await win.webContents.capturePage(), bytes = image.toPNG();
  const file = `${scene.name ?? scene.viewport}-${scene.appearance}-${name}.png`;
  assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes);
  result.frames.push({ scene, name, file, size: image.getSize(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), terminalPaint: paints });
}
async function pointAt(expression) {
  const before = await evaluate(`(()=>{const node=(${expression}),r=node.getBoundingClientRect(),card=node.closest('.composer-pending__card'),b=${strip};const rect=n=>{const v=n.getBoundingClientRect();return{x:v.x,y:v.y,width:v.width,height:v.height,right:v.right,bottom:v.bottom}};return{point:{x:r.x+r.width/2,y:r.y+r.height/2},previewRect:rect(node),cardRect:rect(card),stripRect:rect(b),operationId:card.dataset.operationId,selected:card.dataset.selected,transform:getComputedStyle(card).transform,animation:getComputedStyle(card).animationName,shadow:getComputedStyle(card).boxShadow}})()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...before.point });
  await delay(160); await painted();
  return before;
}
function copyFeedback(facts, id, state, reduced) {
  const card=facts.strip.cards.find(card=>card.id===id),button=card.actions.find(action=>action.label==='复制这条待发消息');
  assert.equal(button.copyState,state,state==='copied'?'Copy success requires the original clipboard true outcome':'Failed or late Copy must not report success');
  if(state==='copied'){
    assert.match(button.icon,/lucide-check/,'Real Copy success immediately displays Check');
    assert.deepEqual(facts.strip.announcers,['已复制待发消息'],'One accessible status announces real copy success');
    if(reduced)assert.equal(button.animation,'none','Reduced motion retains static visible Check without animation');
    else assert.notEqual(button.animation,'none','Normal motion provides a short real Copy success animation');
  }else{
    assert.doesNotMatch(button.icon,/lucide-check/,'Failure or a stale copied body cannot display a success mark');
    assert.ok(!facts.strip.announcers.includes('已复制待发消息'),'Failure or stale body cannot announce copy success');
  }
}
function sharedPivot(facts) {
  const list=facts.strip.list,visible=facts.strip.cards.filter(card=>card.rect.y<list.rect.bottom&&card.rect.bottom>list.rect.y);
  assert.ok(visible.length>1,'Shared pivot is measured on distinct visible original cards');
  for(const card of visible){
    assert.equal(card.offsetParentIsList,true,'Original card offsets belong to the actual list');
    const [x,y]=card.transformOrigin.split(' ').map(Number.parseFloat);
    assert.ok(Number.isFinite(x)&&Number.isFinite(y));
    assert.ok(Math.abs(card.layoutLeft+x-list.layoutWidth)<1,'Every original card shares the list right edge as world pivot');
    assert.ok(Math.abs(card.layoutTop+y-list.scrollTop-list.layoutHeight)<1,'Every original card shares the list bottom edge as world pivot');
  }
}
async function initializeScene(scene, shortPrompt = false) {
  result.stage = scene;
  win.setContentSize(scene.viewport, 750);
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: scene.viewport, height: 750, deviceScaleFactor: 1, mobile: false });
  await evaluate(`pendingDelivery.seed(${JSON.stringify(scene.appearance)})`);
  await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating')&&pendingDelivery.terminal().cursorLine.includes('half typed prompt')`);
  await evaluate(`(()=>{window.pendingNative={editor:${editor},terminal:${surface}.querySelector('.xterm'),neighbor:${neighbor},actions:[],hoverActions:[],buttonEvents:[],terminalEvents:[],phase:'seed',nativeLinePrefix:${JSON.stringify(shortPrompt ? 'agent > a' : 'agent > half typed prompt')}};const log=window.pendingNative,record=resultReadyTerminals.find(r=>r.terminal.element===log.terminal&&!r.disposed);log.buffer=record.terminal.buffer.active;const observe=(kind,value)=>{const b=record.terminal.buffer.active;log.terminalEvents.push({kind,value,phase:log.phase,bufferType:b.type,bufferStable:b===log.buffer,repeatedReadStable:b===record.terminal.buffer.active,rows:record.terminal.rows,baseY:b.baseY,viewportY:b.viewportY,cursorY:b.cursorY,stack:kind==='scroll'?new Error('Private terminal scroll observation').stack:undefined})};record.terminal.onResize(value=>observe('resize',value));record.terminal.onScroll(value=>observe('scroll',value));if(!window.pendingNativeRecorder){window.pendingNativeRecorder=true;for(const kind of ['pointerdown','mousedown','focusin','pointerup','mouseup','click'])document.addEventListener(kind,event=>{const target=event.target instanceof Element?event.target:null,card=target?.closest('.composer-pending__card'),log=window.pendingNative;if(!card||!log||log.buttonEvents.length>=128)return;const r=target.getBoundingClientRect(),button=target.closest('button'),x=typeof event.clientX==='number'?event.clientX:null,y=typeof event.clientY==='number'?event.clientY:null,hit=x!==null&&y!==null?document.elementFromPoint(x,y):null;log.buttonEvents.push({kind,trusted:event.isTrusted,at:event.timeStamp,x,y,tag:target.tagName,label:button?.getAttribute('aria-label')??null,operationId:card.dataset.operationId,selected:card.dataset.selected,targetRect:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},hitLabel:hit?.closest('button')?.getAttribute('aria-label')??null,hitOperationId:hit?.closest('.composer-pending__card')?.dataset.operationId??null})},true);document.addEventListener('pointermove',event=>{const target=event.target instanceof Element?event.target.closest('.composer-pending__card'):null;if(target&&window.pendingNative)window.pendingNative.hoverActions.push({trusted:event.isTrusted,operationId:target.dataset.operationId})},true);document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('.composer-pending button'):null;if(target&&window.pendingNative)window.pendingNative.actions.push({trusted:event.isTrusted,label:target.getAttribute('aria-label'),operationId:target.closest('.composer-pending__card')?.dataset.operationId??target.closest('.composer-pending')?.dataset.operationId})},true)}})()`);
  // CDP typing exercises the maintained original editor, without an Enter or Runtime submit.
  await click(editor); await key('End', 'End', 35); await key('x', 'KeyX', 88, 'x');
  await waitFor(`pendingDelivery.facts().drafts[resultReady.sessionId].includes('x')`);
  if (shortPrompt) await evaluate(`new Promise(done=>{const r=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);r.terminal.write(${JSON.stringify('\r\x1b[2Kagent > a')},done)})`);
  if (!shortPrompt) await evaluate(`new Promise(done=>{const r=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);r.terminal.write('x'.repeat(Math.max(0,r.terminal.cols-r.terminal.buffer.active.cursorX-2)),done)})`);
  const baseline = await settled();
  assert.equal(baseline.strip, null, 'An empty queue has no pending slot'); visibleCursor(baseline);
  assert.ok(baseline.facts.inputs.some(input => input.trusted && input.composer && input.key === 'x'));
  assert.ok(Math.abs(baseline.ownerRect.width - scene.ownerWidth) <= 8, 'The actual owner uses the bounded scene width');
  return baseline;
}

function compactGeometry(facts, count) {
  const floating = facts.strip;
  assert.ok(floating); assert.equal(floating.headerCount, 0, 'No separate pending/position header remains');
  assert.equal(floating.reading.readerCount, 0, 'Hover creates no extra large body or reason panel');
  assert.equal(floating.cards.length, count); assert.equal(new Set(floating.cards.map(card => card.id)).size, count);
  assert.ok(floating.rect.width <= 360.1 && floating.rect.height <= 320.1);
  assert.ok(Math.abs(floating.rect.right - facts.composer.right) < 1, 'The actual tool right edge is the only horizontal anchor');
  assert.equal(floating.outsideInput, true); assert.equal(floating.background, 'rgba(0, 0, 0, 0)');
  for (const card of floating.cards) {
    assert.equal(card.ordinal, `${card.index + 1}/${count}`, 'Each original operation has its own accurate ordinal');
    assert.equal(card.previewTitle, null); assert.equal(card.state.hiddenLabel, card.state.label);
    if (card.editing !== 'true') assert.equal(card.layoutHeight, 28);
  }
  const selected = floating.cards.find(card => card.selected === 'true');
  const list = floating.list.rect;
  if (selected.rect.y >= list.y && selected.rect.bottom <= list.bottom + 1) {
    for (const label of ['复制这条待发消息', '在 Outbox 查看待发消息和操作']) {
      const button = selected.actions.find(action => action.label === label);
      assert.ok(button && button.rect.width >= 23.9 && button.rect.height >= 23.9, 'Actual original actions retain 24px touch/focus targets');
    }
  }
  if (count > 1) sharedPivot(facts);
}
function compactGap(facts, expected) {
  const gap = facts.composer.y - facts.strip.rect.bottom;
  const natural = { x: facts.strip.rect.x, right: facts.strip.rect.right, y: facts.composer.y - 8 - facts.strip.rect.height, bottom: facts.composer.y - 8 };
  const text = facts.cursorText, intersects = natural.x < text.right && natural.right > text.x && natural.y < text.bottom && natural.bottom > text.y;
  const minimum = intersects ? Math.max(8, facts.composer.y - facts.helperTextarea.rect.y + 2) : 8;
  if (expected !== undefined) assert.equal(intersects, false, 'The left-short control actually does not overlap the natural stack');
  assert.ok(Math.abs(gap - (expected ?? minimum)) < 1, 'Only the actual visible current line overlap gives a minimal gap; no unconditional native-row clearance');
  return { gap, natural, text, intersects, minimum };
}
async function compactActivate(scene, expression, proofName = null) {
  if (scene.pointer !== 'coarse') return click(expression, proofName);
  const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();if(!r.width||!r.height)throw Error('Actual touch target missing');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1, id: 1 }] });
  await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await painted();
}
async function compactDistance(scene, baseline) {
  const selected = baseline.strip.cards.find(card => card.selected === 'true');
  const r = selected.rect, roi = { x: Math.ceil(r.x + 2), y: Math.ceil(r.y + 2), width: Math.floor(r.width - 4), height: Math.floor(r.height - 4) };
  assert.ok(roi.width > 20 && roi.height > 8);
  const samples = [], bitmaps = [];
  for (const [name, distance] of [['far', 280], ['mid', 130], ['near', 6]]) {
    const point = { x: baseline.strip.rect.right + distance, y: r.y + r.height / 2 };
    assert.ok(point.x < scene.viewport, 'The distance sample uses a real in-window point outside the cards');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await painted();
    const actual = await settled();
    retained(baseline, actual); assert.equal(actual.strip.operationId, baseline.strip.operationId);
    assert.equal(actual.strip.hover, false, 'Distance does not select another card or use a hover panel');
    assert.deepEqual(actual.strip.rect, baseline.strip.rect);
    const coordinates = [Number.parseFloat(actual.strip.pointerX), Number.parseFloat(actual.strip.pointerY)];

    const image = await win.webContents.capturePage(roi), bytes = image.toPNG(), bitmap = image.toBitmap();
    const file = `${scene.name}-${name}-card-roi.png`; await fs.writeFile(path.join(evidence, file), bytes);
    bitmaps.push(bitmap); samples.push({ name, point, roi, coordinates, maskImage: actual.strip.maskImage, file, bitmapBytes: bitmap.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    await frame(scene, 'compact-single-' + name);
  }
  const differences = bitmaps.slice(1).map((bitmap, index) => {
    assert.equal(bitmap.length, bitmaps[index].length);
    let changedChannels = 0, absoluteDelta = 0;
    for (let channel = 0; channel < bitmap.length; channel++) {
      const delta = Math.abs(bitmap[channel] - bitmaps[index][channel]); if (delta) changedChannels++; absoluteDelta += delta;
    }
    return { from: samples[index].name, to: samples[index + 1].name, changedChannels, absoluteDelta };
  });
  result.checkpoints.push({ scene, name: 'actual-card-distance-pixels', samples, differences });
  assert.ok(differences.every(row => row.changedChannels > 20 && row.absoluteDelta > 100), 'Both distance steps change the actual same-card bitmap, beyond CSS property presence');
  for (const sample of samples) {
    assert.match(sample.maskImage, /radial-gradient/);
    assert.ok(Math.abs(sample.coordinates[0] - (sample.point.x - baseline.strip.rect.x)) < 1 && Math.abs(sample.coordinates[1] - (sample.point.y - baseline.strip.rect.y)) < 1);
  }
}
async function compactMultiDistance(scene, baseline) {
  // One pointer acts on distinct actual original cards. No hover or focus selects them.
  await click(editor);
  const ids = [baseline.strip.cards[0].id, baseline.strip.cards[2].id], samples = [], pixels = new Map();
  for (const [step, target] of [[0, baseline.strip.cards[0]], [1, baseline.strip.cards[2]]]) {
    const point = { x: baseline.strip.rect.right + 6, y: target.rect.y + target.rect.height / 2 };
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await painted();
    const actual = await settled(); assert.equal(actual.strip.maskImage.includes('radial-gradient'), true);
    assert.equal(actual.strip.hover, false); assert.equal(actual.strip.focused, false);
    assert.equal(actual.strip.operationId, baseline.strip.operationId); assert.deepEqual(actual.facts.queues, baseline.facts.queues);
    const cards = [];
    for (const id of ids) {
      const card = actual.strip.cards.find(row => row.id === id), original = baseline.strip.cards.find(row => row.id === id);
      assert.deepEqual(card.rect, original.rect); assert.equal(card.transform, original.transform, 'Distance changes no card plane or queue selection');
      const roi = { x: Math.ceil(card.rect.x + 2), y: Math.ceil(card.rect.y + card.rect.height / 2 - 4), width: Math.floor(card.rect.width - 4), height: 8 };
      const image = await win.webContents.capturePage(roi), bitmap = image.toBitmap(), bytes = image.toPNG();
      const file = `${scene.name}-multi-distance-${step}-${card.index}-roi.png`; await fs.writeFile(path.join(evidence, file), bytes);
      const center = { x: card.rect.x + card.rect.width / 2, y: card.rect.y + card.rect.height / 2 };
      const distance = Math.hypot(point.x - center.x, point.y - center.y), old = pixels.get(id);
      let changedChannels = 0, absoluteDelta = 0;
      if (old) { assert.equal(old.length, bitmap.length); for (let i = 0; i < bitmap.length; i++) { const delta = Math.abs(bitmap[i] - old[i]); if (delta) changedChannels++; absoluteDelta += delta; } }
      cards.push({ id, index: card.index, rect: card.rect, transform: card.transform, distance, roi, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bitmapBytes: bitmap.length, changedChannels, absoluteDelta });
      pixels.set(id, bitmap);
    }
    assert.notEqual(cards[0].distance, cards[1].distance, 'Distinct card geometry has independently measured distance to the same pointer');
    samples.push({ point, selectedId: actual.strip.operationId, cards });
  }
  result.checkpoints.push({ scene, name: 'actual-multiple-card-distance-pixels', samples });
  assert.ok(samples[1].cards.every(row => row.changedChannels > 20 && row.absoluteDelta > 100), 'Both original cards respond in their actual bitmap to one pointer move');
}
async function compactInlineEdit(scene, baseline) {
  const sid = await evaluate('resultReady.sessionId'), original = baseline.facts.queues[sid][0];
  await compactActivate(scene, `${selectedCard}.querySelector('.composer-pending__preview')`);
  const textarea = `${strip}.querySelector('.composer-pending__card[data-operation-id="${original.operationId}"] textarea')`;
  await waitFor(`Boolean(${textarea})`);
  const editing = await settled();
  assert.equal(editing.strip.inlineEditorCount, 1); assert.equal(editing.strip.reading.readerCount, 0);
  assert.equal(editing.strip.operationId, original.operationId); assert.equal(editing.strip.maskImage, 'none');
  assert.equal(await evaluate(`document.activeElement===${textarea}`), true);
  await key('End', 'End', 35); await key('q', 'KeyQ', 81, 'q');
  const text = await evaluate(`${textarea}.value`), caret = [];
  for (const [name, code, virtual] of [['ArrowLeft', 'ArrowLeft', 37], ['ArrowRight', 'ArrowRight', 39], ['Home', 'Home', 36], ['End', 'End', 35]]) {
    await key(name, code, virtual);
    const facts = await evaluate(`({focused:document.activeElement===${textarea},value:${textarea}.value,start:${textarea}.selectionStart,end:${textarea}.selectionEnd,id:${strip}.dataset.operationId})`);
    assert.equal(facts.focused, true); assert.equal(facts.value, text); assert.equal(facts.id, original.operationId); caret.push({ name, ...facts });
  }
  assert.equal((await evaluate('pendingDelivery.facts()')).queues[sid][0].text, original.text, 'The original queue body is unchanged before Save');
  await frame(scene, 'compact-inline-edit');
  await compactActivate(scene, `${strip}.querySelector('[aria-label="保存待发消息"]')`);
  await waitFor(`!${strip}.querySelector('textarea')`);
  const saved = await settled(); retained(baseline, saved);
  assert.equal(saved.facts.queues[sid][0].operationId, original.operationId); assert.equal(saved.facts.queues[sid][0].text, text);
  assert.deepEqual(saved.facts.attempts, baseline.facts.attempts, 'Saving this original body never submits it');
  result.checkpoints.push({ scene, name: 'original-inline-edit-focus-and-save', original, text, caret, editing, saved });
  return saved;
}
async function compactOriginalMore(scene, before) {
  const sid = await evaluate('resultReady.sessionId'), entry = before.facts.queues[sid][1];
  const target = `${strip}.querySelector('.composer-pending__card[data-operation-id="${entry.operationId}"] .composer-pending__more')`;
  await compactActivate(scene, target, 'single-nonfirst-original-more');
  if (compactCheckpoint === 'more') await frame(scene, 'compact-more-first-after');
  await waitFor(`${panel}.matches(':popover-open')&&Boolean(${panel}.querySelector('[data-record-key="queue:${entry.operationId}"]'))`);
  const actual = await evaluate(`({id:${panel}.querySelector('.composer-mailbox__detail').dataset.recordKey,text:${panel}.textContent,facts:pendingDelivery.facts(),hidden:document.querySelector('.composer-pending[data-operation-id="${entry.operationId}"]').hidden})`);
  assert.equal(actual.id, 'queue:' + entry.operationId); assert.ok(actual.text.includes(entry.text)); assert.equal(actual.hidden, true);
  assert.deepEqual(actual.facts.queues, before.facts.queues); assert.deepEqual(actual.facts.attempts, before.facts.attempts);
  if (compactCheckpoint !== 'more') await frame(scene, 'compact-more-original');
  // Close the real original Mail through the maintained tool control.
  await compactActivate(scene, `${surface}.querySelector('.composer__mailbox')`);
  await waitFor(`!${panel}.matches(':popover-open')&&!${strip}.hidden`);
  result.checkpoints.push({ scene, name: 'nonfirst-ordinal-original-mail', entry, actual });
}
async function compactNativeLine(scene) {
  await evaluate(`new Promise(done=>{const r=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);pendingNative.phase='private-long-native-line';r.terminal.write('x'.repeat(Math.max(0,r.terminal.cols-r.terminal.buffer.active.cursorX-2)),done)})`);
  const longBaseline = await settled();
  await evaluate("pendingDelivery.queue('保护当前原生长行 · 光标回左不移除右侧正文',2)");
  const right = await settled(); retained(longBaseline, right);
  result.checkpoints.push({ scene, name: 'actual-long-line-caret-right', right }); await frame(scene, 'compact-caret-right'); visibleCursor(right);
  // The original preview write port already echoes terminal-output bytes.
  // Use actual trusted xterm ArrowLeft input through that owner; observe only.
  const count = Math.max(1, right.terminal.cursorX - 4);
  assert.ok(count <= 512, 'This controlled keyboard probe is bounded by the actual terminal row');
  await evaluate(`(()=>{const r=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);pendingNative.arrowObserved={count:${count},data:[]};pendingNative.arrowLease=r.terminal.onData(data=>{if(pendingNative.arrowObserved.data.length<512)pendingNative.arrowObserved.data.push(data)})})()`);
  try {
    await click(`pendingNative.terminal.querySelector('.xterm-helper-textarea')`);
    for (let i = 0; i < count; i++) for (const type of ['keyDown', 'keyUp']) {
      await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    }
    await painted(); await waitFor(`pendingDelivery.terminal().cursorX===${right.terminal.cursorX - count}`);
    const left = await settled(), echo = await evaluate('pendingNative.arrowObserved');
    assert.equal(echo.data.length, count); assert.ok(echo.data.every(data => data === '\x1b[D'));
    assert.equal(left.facts.writes.length - right.facts.writes.length, count, 'Every trusted ArrowLeft consumes the original preview write port once');
    assert.equal(left.terminal.cursorX, right.terminal.cursorX - count); assert.equal(left.terminal.cursorLine, right.terminal.cursorLine);
    assert.deepEqual(left.terminal.visibleLines, right.terminal.visibleLines); assert.equal(left.buffer.stable, true);
    assert.equal(left.originalId, right.originalId); assert.deepEqual(left.retainedNodes, right.retainedNodes);
    assert.deepEqual(left.facts.queues, right.facts.queues); assert.equal(left.draft, right.draft);
    result.checkpoints.push({ scene, name: 'actual-long-line-caret-return-left', right, left, echo });
    await frame(scene, 'compact-caret-return-left');
    compactGap(left); visibleCursor(left); // Strictly protects text still extending right, not only the helper rect.
  } finally { await evaluate('pendingNative.arrowLease?.dispose()').catch(() => {}); }
  await evaluate('pendingDelivery.clear()');
}
async function compactNativeScroll(scene, baseline) {
  await evaluate('pendingDelivery.distinctQueue(100)');
  const stack = await settled(); retained(baseline, stack); compactGeometry(stack, 100);
  await evaluate(`(()=>{const list=${strip}.querySelector('.composer-pending__cards');window.pendingCompactNodes=[...list.children];window.pendingCompactWheels=[];list.addEventListener('wheel',event=>pendingCompactWheels.push({trusted:event.isTrusted,prevented:event.defaultPrevented,deltaY:event.deltaY}),{passive:true});list.scrollTop=list.children[96].offsetTop-96})()`);
  const point = await evaluate(`(()=>{const r=${strip}.querySelector('.composer-pending__cards').getBoundingClientRect();return{x:r.right-2,y:r.y+r.height/2}})()`);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); await painted();
  const before = await settled(), card = before.strip.cards[96];
  assert.equal(card.selected, 'false'); assert.equal(card.animation, 'composer-pending-depth');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 46 });
  await waitFor(`${strip}.querySelector('.composer-pending__cards').scrollTop>${before.strip.list.scrollTop}+20`);
  const after = await settled(); retained(before, after); sharedPivot(after);
  result.checkpoints.push({ scene, name: 'actual-spatial-scroll-tail', before, after });
  assert.equal(after.strip.operationId, before.strip.operationId); assert.deepEqual(after.facts.queues, before.facts.queues);
  assert.notEqual(after.strip.cards[96].transform, card.transform, 'Trusted native wheel changes the same original card depth');
  const matrix = value => value.slice(9, -1).split(',').map(Number), a = matrix(card.transform), b = matrix(after.strip.cards[96].transform);
  assert.equal(a.length, 16); assert.equal(b.length, 16);
  assert.ok(Math.abs(a[14] - b[14]) > 2 && Math.abs(a[6] - b[6]) > .02, 'Depth and tilt change beyond a planar vertical displacement');
  assert.equal(await evaluate(`pendingCompactNodes.every((node,i)=>node===${strip}.querySelector('.composer-pending__cards').children[i])`), true);
  assert.ok(await evaluate('pendingCompactWheels.some(row=>row.trusted&&!row.prevented&&row.deltaY>0)'));
  // All head/middle/tail original cards remain reachable via trusted keyboard.
  await click(`${strip}.querySelector('.composer-pending__card[data-queue-index="96"] .composer-pending__state')`);
  const navigationStart = await settled(); assert.equal(navigationStart.strip.inlineEditorCount, 0);
  assert.equal(navigationStart.strip.operationId, navigationStart.strip.cards[96].id);
  for (const [name, code, virtual, index] of [['Home', 'Home', 36, 0], ['End', 'End', 35, 99]]) {
    await key(name, code, virtual);
    const reached = await settled(), item = reached.strip.cards[index];
    assert.equal(reached.strip.operationId, item.id); assert.ok(item.rect.y >= reached.strip.list.rect.y - 1 && item.rect.bottom <= reached.strip.list.rect.bottom + 1);
    assert.equal(reached.strip.maskImage, 'none', 'Actual keyboard focus remains readable at every pointer distance');
  }
  await frame(scene, 'compact-scroll-tail'); await evaluate('pendingDelivery.clear()');
}
async function compactOriginalHover(scene, multi, sid) {
  const original = multi.facts.queues[sid][2];
  const originalPreview = `${strip}.querySelector('[data-operation-id="${original.operationId}"] .composer-pending__preview')`;
  const pointer = await pointAt(originalPreview);
  const hovered = await settled();
  const hit = await evaluate(`(()=>{const point=${JSON.stringify(pointer.point)},card=${strip}.querySelector('[data-operation-id="${original.operationId}"]'),node=document.elementFromPoint(point.x,point.y);return{point,operationId:node?.closest('.composer-pending__card')?.dataset.operationId??null,originalCardContainsHit:Boolean(node&&card.contains(node)),cardHover:card.matches(':hover'),stripHover:${strip}.matches(':hover'),elements:document.elementsFromPoint(point.x,point.y).slice(0,6).map(n=>({tag:n.tagName,className:n.className,operationId:n.closest('.composer-pending__card')?.dataset.operationId??null}))}})()`);
  result.checkpoints.push({ scene, name: 'first-trusted-card-hover-hit', original, pointer, after: hovered, hit });
  await frame(scene, 'compact-multi');
  retained(multi, hovered); compactGeometry(hovered, 3); visibleCursor(hovered);
  assert.equal(hovered.strip.operationId, original.operationId);
  assert.equal(hit.operationId, original.operationId, 'The first trusted pointer still hits the same original card after its transform settles');
  assert.equal(hit.originalCardContainsHit, true);
  const lifted = hovered.strip.cards.find(card => card.id === original.operationId);
  assert.equal(pointer.selected, 'false', 'The one trusted hover starts on an unselected original card');
  assert.equal(lifted.selected, 'true'); assert.equal(lifted.animation, 'none');
  assert.notEqual(lifted.transform, pointer.transform, 'The same original card actually lifts after the one trusted hover');
  assert.notEqual(lifted.shadow, pointer.shadow, 'The lifted original card has the actual selected shadow');
  // Preserve raw :hover facts; hidden-window pseudo state does not own the data-selected lift.
  assert.deepEqual(hovered.facts.queues, multi.facts.queues); assert.deepEqual(hovered.facts.attempts, multi.facts.attempts);
  assert.ok(hovered.trustedHoverActions.some(action => action.trusted && action.operationId === original.operationId));
  result.checkpoints.push({ scene, name: 'trusted-original-card-hover-without-extra-reader', original, hovered });
}
async function compactBegin(scene) {
  result.stage = scene;
  await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: scene.pointer === 'coarse', maxTouchPoints: 1 });
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: scene.pointer === 'fine' ? 'no-preference' : 'reduce' }] });
  const baseline = await initializeScene(scene, true);
  const media = await evaluate(`({fine:matchMedia('(hover: hover) and (pointer: fine)').matches,coarse:matchMedia('(hover: none), (pointer: coarse)').matches,touchPoints:navigator.maxTouchPoints})`);
  assert.equal(media.fine, scene.pointer === 'fine'); assert.equal(media.coarse, scene.pointer === 'coarse');
  if (scene.pointer === 'coarse') assert.ok(media.touchPoints > 0);
  await evaluate(`for(const r of resultReadyTerminals.filter(r=>!r.disposed))r.terminal.options.cursorBlink=false`);
  return { baseline, media };
}
async function compactScene(scene) {
  const { baseline, media } = await compactBegin(scene), sid = await evaluate('resultReady.sessionId');
  await evaluate("pendingDelivery.queue('原消息')");
  const single = await settled(); retained(baseline, single); compactGeometry(single, 1); compactGap(single, 8); visibleCursor(single);
  if (scene.pointer === 'fine') await compactDistance(scene, single);
  else {
    assert.equal(single.strip.maskImage, 'none'); const material = single.strip.cards[0];
    assert.match(material.background, /(?:\/\s*0?\.\d+|,\s*0\.\d+\))/); assert.match(material.backdropFilter, /blur\(/);
    await frame(scene, 'compact-single-touch');
  }
  await compactActivate(scene, `${selectedCard}.querySelector('.composer-pending__copy')`);
  const copied = await settled(); assert.equal(copied.facts.copies.at(-1), copied.facts.queues[sid][0].text); copyFeedback(copied, copied.strip.operationId, 'copied', scene.pointer === 'coarse');
  await compactInlineEdit(scene, copied);
  await evaluate("pendingDelivery.queue('原第二条 · 编号更多只打开这一条\\n第二行原文仍在 Mail',1);pendingDelivery.queue('原第三条 · 可达且不借用他人操作',1)");
  const multi = await settled(); compactGeometry(multi, 3); retained(baseline, multi); visibleCursor(multi); compactGap(multi);
  if (scene.pointer === 'fine') { await compactMultiDistance(scene, multi); await compactOriginalHover(scene, multi, sid); }
  if (scene.pointer === 'coarse') await frame(scene, 'compact-multi');
  await compactOriginalMore(scene, multi);
  await compactActivate(scene, `${selectedCard}.querySelector('.composer-pending__dismiss')`);
  await waitFor(`Boolean(${strip}.querySelector('.composer-pending__restore'))`);
  const collapsed = await settled(); assert.deepEqual(collapsed.facts.queues, multi.facts.queues); assert.equal(collapsed.draft, baseline.draft);
  await compactActivate(scene, `${strip}.querySelector('.composer-pending__restore')`);
  await waitFor(`Boolean(${strip}.querySelector('.composer-pending__cards'))`);
  result.checkpoints.push({ scene, name: 'original-collapse-remains-discoverable', collapsed });
  // An actual selected Send still follows the existing original queue owner.
  const target = multi.facts.queues[sid][1];
  await compactActivate(scene, `${strip}.querySelector('.composer-pending__card[data-operation-id="${target.operationId}"] .composer-pending__send')`, 'single-original-selected-send');
  await waitFor(`pendingDelivery.facts().phase[${JSON.stringify(sid)}]==='preparing'`); await evaluate('pendingDelivery.prepared()');
  await waitFor('pendingDelivery.facts().attempts.length===1');
  const attempt = await evaluate('pendingDelivery.facts().attempts[0]'); assert.equal(attempt[1], target.text); assert.equal(attempt[2], target.operationId);
  await evaluate('pendingDelivery.submitted()'); await waitFor(`!pendingDelivery.facts().inFlight[${JSON.stringify(sid)}]`); await evaluate('pendingDelivery.clear()');
  const staleStyle = await evaluate(`(()=>{const node=pendingNative.terminal.querySelector('.xterm-screen'),old=node.style.height;node.style.height='96px';return old})()`);
  const staleBaseline = await settled();
  await evaluate("pendingDelivery.queue('原消息')");
  const stale = await settled(); compactGap(stale, 8); retained(staleBaseline, stale);
  await evaluate(`pendingNative.terminal.querySelector('.xterm-screen').style.height=${JSON.stringify(staleStyle)};pendingDelivery.clear()`);
  const restored = await settled(); retained(baseline, restored);
  if (scene.pointer === 'fine') { await compactNativeLine(scene); const scrollBaseline = await settled(); await compactNativeScroll(scene, scrollBaseline); }
  const end = await settled(); assert.equal(end.strip, null); assert.equal(end.originalId, baseline.originalId); assert.equal(end.buffer.stable, true);
  assert.deepEqual(end.retainedNodes, { editor: true, terminal: true, neighbor: true }); assert.equal(end.draft, baseline.draft);
  result.scenes.push({ scene, media, baseline, single, copied, multi, attempt, stale, end });
}

async function compactBoundedCheckpoint() {
  const scene = compactCheckpoint === 'coarse'
    ? { name: 'coarse-narrow-dark', viewport: 640, ownerWidth: 320, appearance: 'dark', pointer: 'coarse' }
    : { name: 'fine-wide-dark', viewport: 1280, ownerWidth: 640, appearance: 'dark', pointer: 'fine' };
  result.scope.checkpoint = compactCheckpoint;
  result.scope.fullMatrixQualified = false;
  if (compactCheckpoint === 'send') {
    await compactScene(scene);
    assert.equal(result.frames.length, 9, 'Only the original first fine scene is complete for the bounded Send checkpoint');
    return;
  }
  const { baseline, media } = await compactBegin(scene), sid = await evaluate('resultReady.sessionId');
  if (compactCheckpoint === 'overlap') {
    await compactNativeLine(scene);
  } else {
    await evaluate("pendingDelivery.queue('原消息')");
    const single = await settled();
    result.checkpoints.push({ scene, name: 'bounded-' + compactCheckpoint + '-original-geometry', baseline, single });
    if (compactCheckpoint === 'min-gap') await frame(scene, 'compact-short-min-gap');
    retained(baseline, single); compactGeometry(single, 1);
    if (compactCheckpoint === 'distance') {
      compactGap(single, 8); visibleCursor(single); await compactDistance(scene, single);
    } else if (compactCheckpoint === 'coarse') {
      await frame(scene, 'compact-single-touch');
      assert.equal(single.strip.maskImage, 'none', 'Actual coarse input has stable unmasked crystal');
      const material = single.strip.cards[0];
      assert.match(material.background, /(?:\/\s*0?\.\d+|,\s*0\.\d+\))/); assert.match(material.backdropFilter, /blur\(/);
      compactGap(single, 8); visibleCursor(single);
    } else if (compactCheckpoint === 'min-gap') {
      compactGap(single, 8); visibleCursor(single);
    } else {
      await evaluate("pendingDelivery.queue('原第二条 · 编号更多只打开这一条',1);pendingDelivery.queue('原第三条 · 可达且不借用他人操作',1)");
      const multi = await settled(); retained(baseline, multi); compactGeometry(multi, 3); compactGap(multi); visibleCursor(multi);
      if (compactCheckpoint === 'more') {
        await frame(scene, 'compact-more-first-before');
        await compactOriginalMore(scene, multi);
      } else await compactOriginalHover(scene, multi, sid);
    }
    await evaluate('pendingDelivery.clear()');
  }
  const end = await settled();
  assert.equal(end.strip, null); assert.equal(end.originalId, baseline.originalId); assert.equal(end.buffer.stable, true);
  assert.deepEqual(end.retainedNodes, { editor: true, terminal: true, neighbor: true }); assert.equal(end.draft, baseline.draft);
  result.scenes.push({ scene, media, baseline, end, checkpoint: compactCheckpoint });
  assert.equal(result.frames.length, { hover: 1, distance: 3, coarse: 1, 'min-gap': 1, overlap: 2, more: 2 }[compactCheckpoint], 'The bounded checkpoint captures its exact finite frame count');
}

app.whenReady().then(async () => {
  try {
    await fs.mkdir(evidence, { recursive: true });
    win = new BrowserWindow({ width: 1280, height: 750, show: false,
      webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, _level, message) => result.console.push(message));
    await win.loadFile(html); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitFor('Boolean(window.pendingDelivery)');
    await evaluate(`(()=>{window.pendingNativeErrors=[];window.addEventListener('error',event=>pendingNativeErrors.push({message:event.message,stack:event.error?.stack,filename:event.filename,line:event.lineno,column:event.colno}));window.addEventListener('unhandledrejection',event=>pendingNativeErrors.push({message:String(event.reason),stack:event.reason?.stack}))})()`);
    result.scope = { actualElectron: true, actualXterm: true, queueAdapter: 'controlled preview of original Store', terminalProducer: 'original private terminal-output echo adapter; trusted bounded ArrowLeft, observation only', ctxmuxNativeHealthQualified: false, touchRepresentative: 'Electron touch emulation at the actual narrow CSS viewport; not physical phone', compactFlag: compactContract };
    const scenes = [
      { name: 'fine-wide-dark', viewport: 1280, ownerWidth: 640, appearance: 'dark', pointer: 'fine' },
      { name: 'fine-wide-light', viewport: 1280, ownerWidth: 640, appearance: 'light', pointer: 'fine' },
      { name: 'fine-narrow-dark', viewport: 640, ownerWidth: 320, appearance: 'dark', pointer: 'fine' },
      { name: 'fine-narrow-light', viewport: 640, ownerWidth: 320, appearance: 'light', pointer: 'fine' },
      ...anchorOnly ? [] : [
        { name: 'coarse-narrow-dark', viewport: 640, ownerWidth: 320, appearance: 'dark', pointer: 'coarse' },
        { name: 'coarse-narrow-light', viewport: 640, ownerWidth: 320, appearance: 'light', pointer: 'coarse' }
      ]
    ];
    if (compactCheckpoint) await compactBoundedCheckpoint();
    else {
      for (const config of scenes) await compactScene(config);
      assert.deepEqual(result.scenes.map(row => row.scene.name), scenes.map(row => row.name));
      assert.equal(result.frames.length, anchorOnly ? 36 : 44, 'Each nonempty fine nine-frame and coarse four-frame scene is complete');
    }
    result.rendererErrors = await evaluate('window.pendingNativeErrors');
    assert.deepEqual(result.rendererErrors, [], 'Successful actual Renderer scenes have no error or unhandled rejection');
    result.passed = true;
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack };
    result.rendererErrors = await evaluate('window.pendingNativeErrors??[]').catch(() => []);
    result.failureFacts = await geometry().catch(() => null);
    result.failureDom = await evaluate('document.body.innerHTML').catch(() => null);
  } finally {
    await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2));
    win?.destroy(); app.exit(result.passed ? 0 : 1);
  }
});
