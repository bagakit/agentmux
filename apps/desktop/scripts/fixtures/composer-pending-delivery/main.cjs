const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const [html, privateRoot, evidence, capture] = process.argv.slice(2);
app.setPath('userData', path.join(privateRoot, 'user-data'));
let win;
const result = { schema: 'agentmux.composer-pending-delivery-native.v1', passed: false,
  userRunTouched: false, aestheticReview: 'not-performed', scenes: [], frames: [], checkpoints: [], noticeTransitions: [], console: [], rendererErrors: [] };
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const neighbor = `document.querySelector('[data-workbench-region-id="result-input-neighbor"]')`;
const editor = `${surface}.querySelector('.composer [role="textbox"]')`;
const strip = `${surface}.querySelector('.composer-pending')`;
const panel = `${surface}.querySelector('.composer-mailbox')`;
const send = `${strip}.querySelector('[aria-label="发送这条待发消息"]')`;
const more = `${strip}.querySelector('[aria-label="在 Outbox 查看待发消息和操作"]')`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(expression) {
  const value = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(expression)})}catch(error){return{__probeError:true,name:error.name,message:error.message,stack:error.stack}}})()`);
  if (value?.__probeError) { const error = new Error(value.message); error.name = value.name; error.stack = value.stack; throw error; }
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
async function click(expression) {
  const point = await evaluate(`(()=>{const node=(${expression});if(!node)throw Error('Actual control is absent');const rect=node.getBoundingClientRect();if(!rect.width||!rect.height)throw Error('Actual control is not visible');return{x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  }
  await painted();
}
async function key(key, code, virtual, text) {
  for (const type of ['keyDown', 'keyUp']) {
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual,
      ...(type === 'keyDown' && text ? { text, unmodifiedText: text } : {}) });
  }
  await painted();
}
async function geometry() {
  return evaluate(`(()=>{
    const s=${surface},n=${neighbor},rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const original=s.querySelector('.xterm'),records=globalThis.resultReadyTerminals??[];
    const owner=records.find(r=>r.terminal.element===original&&!r.disposed),other=records.find(r=>n.contains(r.terminal.element)&&!r.disposed);
    const terminal=pendingDelivery.terminal(),activeBuffer=owner.terminal.buffer.active,screen=rect(s.querySelector('.xterm-screen')),cursorRow=terminal.baseY+terminal.cursorY-terminal.viewportY;
    const cellHeight=screen.height/terminal.rows,b=${strip},e=${editor},composer=s.querySelector('.composer');
    const state=b?.querySelector('.composer-pending__state'),preview=b?.querySelector('.composer-pending__preview'),mailbox=composer.querySelector('.composer__mailbox');
    const editorSlot=e.closest('.composer__editor'),controls=mailbox.closest('.composer__toolbar > div');
    const range=node=>{if(!node)return[];const r=document.createRange();r.selectNodeContents(node);return[...r.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}))};
    const buffer=other?.terminal.buffer.active;
    return{terminal,buffer:{type:activeBuffer.type,stable:activeBuffer===window.pendingNative.buffer,repeatedReadStable:activeBuffer===owner.terminal.buffer.active},screen,cellHeight,cursorVisible:cursorRow>=0&&cursorRow<terminal.rows,
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
      strip:b?{rect:rect(b),operationId:b.dataset.operationId,busy:b.dataset.busy,outsideInput:!composer.contains(b),
        label:state?.textContent,stateRect:rect(state),stateLines:range(state?.querySelector('span')),preview:preview?.textContent,
        previewRect:rect(preview),sendDisabled:b.querySelector('.composer-pending__send').disabled,
        marginTop:parseFloat(getComputedStyle(b).marginTop),marginBottom:parseFloat(getComputedStyle(b).marginBottom)}:null,
      popover:s.querySelector('.composer-mailbox').matches(':popover-open'),facts:pendingDelivery.facts(),trustedActions:window.pendingNative.actions,
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
function retained(before, after, attentionTransition = false) {
  assert.equal(after.originalConnected, true); assert.equal(after.originalHidden, false);
  assert.equal(after.originalId, before.originalId); assert.equal(after.terminal.id, before.terminal.id);
  assert.deepEqual(after.retainedNodes, { editor: true, terminal: true, neighbor: true }, 'Pending UI retains the actual original DOM nodes');
  assert.equal(after.terminal.cols, before.terminal.cols); assert.equal(after.terminal.cursorX, before.terminal.cursorX);
  assert.equal(after.terminal.cursorLine, before.terminal.cursorLine, 'The original unfinished terminal prompt remains readable');
  assert.deepEqual(after.neighbor, before.neighbor, 'Pending UI leaves the neighboring terminal, layout and draft exact');
  assert.equal(after.draft, before.draft); assert.equal(after.editor.height, before.editor.height);
  const noticeBoundary = attentionTransition ? noticeGeometry(before, after) : null;
  if (!attentionTransition) assert.equal(after.editor.width, before.editor.width);
  for (const name of ['sessions', 'tab', 'layout', 'drafts', 'writes', 'pastes']) assert.deepEqual(after.facts[name], before.facts[name], 'Pending UI preserves original ' + name);
  return noticeBoundary;
}
function pendingGeometry(before, after, label, busy, disabled, attentionTransition = false) {
  const noticeBoundary = retained(before, after, attentionTransition);
  assert.ok(after.strip, 'Nonempty real queue has a visible pending summary');
  assert.equal(after.strip.outsideInput, true); assert.equal(after.strip.label, label);
  assert.equal(after.strip.busy, String(busy)); assert.equal(after.strip.sendDisabled, disabled);
  const r = after.strip.rect;
  assert.ok(r.width > 0 && r.height > 0 && after.strip.previewRect.width > 0);
  assert.ok(r.bottom <= after.composer.y + 1, 'Pending summary sits outside and above the input');
  assert.ok(r.x >= after.ownerRect.x - 1 && r.right <= after.ownerRect.right + 1, 'Pending controls fit the original owner width');
  assert.ok(after.strip.stateLines.length > 0, 'Actual status text has a nonempty Range');
  assert.ok(after.strip.stateLines.every(line => line.x >= r.x - 1 && line.right <= r.right + 1), 'Status text remains inside the visible pending surface');
  assert.ok(after.terminal.rows > 0);
  const allowance = Math.ceil((r.height + after.strip.marginTop + after.strip.marginBottom) / after.cellHeight) + 1;
  assert.ok(Math.abs(after.terminal.rows - before.terminal.rows) <= allowance, 'Only the necessary pending row height changes the terminal grid');
  const attachmentIds = new Set(before.facts.resizes.map(resize => resize[0]));
  assert.ok(attachmentIds.size > 0, 'The original real terminal attachment resize collection is nonempty');
  for (const resize of after.facts.resizes.slice(before.facts.resizes.length)) {
    assert.ok(attachmentIds.has(resize[0]), 'Pending rows resize an existing attachment');
    assert.equal(resize[1], before.terminal.cols); assert.ok(resize[2] > 0);
  }
  return noticeBoundary;
}
function visibleCursor(facts) {
  assert.equal(facts.cursorVisible, true, 'The actual original terminal cursor remains in its viewport');
  assert.match(facts.terminal.cursorLine, /agent > half typed prompt/);
  assert.ok(facts.cursorBottom <= facts.terminalRect.bottom + 1, 'The cursor line remains inside the real terminal');
  if (facts.strip) assert.ok(facts.cursorBottom <= facts.strip.rect.y + 1, 'Pending UI does not cover the unfinished cursor line');
}
async function frame(scene, name) {
  if (capture !== 'capture') return;
  const paints = await evaluate(`(()=>{const entries=(globalThis.resultReadyTerminals??[]).filter(r=>!r.disposed&&r.terminal.element?.isConnected&&!r.terminal.element.closest('[hidden]'));if(!entries.length)throw Error('No actual visible terminal to paint');return Promise.all(entries.map(r=>new Promise((resolve,reject)=>{let lease;const timer=setTimeout(()=>{lease?.dispose();reject(Error('Actual terminal render did not arrive'))},2000);lease=r.terminal.onRender(range=>{clearTimeout(timer);lease.dispose();resolve({id:r.id,rows:r.terminal.rows,...range})});r.terminal.refresh(0,r.terminal.rows-1)})))})()`);
  assert.equal(paints.length, 2, 'Both original owner and neighbor terminals actually paint');
  await painted(); const image = await win.webContents.capturePage(), bytes = image.toPNG();
  const file = `${scene.viewport}-${scene.appearance}-${name}.png`;
  assert.ok(bytes.length > 0); await fs.writeFile(path.join(evidence, file), bytes);
  result.frames.push({ scene, name, file, size: image.getSize(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), terminalPaint: paints });
}
async function scene(scene) {
  result.stage = scene;
  win.setContentSize(scene.viewport, 750);
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: scene.viewport, height: 750, deviceScaleFactor: 1, mobile: false });
  await evaluate(`pendingDelivery.seed(${JSON.stringify(scene.appearance)})`);
  await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating')&&pendingDelivery.terminal().cursorLine.includes('half typed prompt')`);
  await evaluate(`(()=>{window.pendingNative={editor:${editor},terminal:${surface}.querySelector('.xterm'),neighbor:${neighbor},actions:[],terminalEvents:[],phase:'seed'};const log=window.pendingNative,record=resultReadyTerminals.find(r=>r.terminal.element===log.terminal&&!r.disposed);log.buffer=record.terminal.buffer.active;const observe=(kind,value)=>{const b=record.terminal.buffer.active;log.terminalEvents.push({kind,value,phase:log.phase,bufferType:b.type,bufferStable:b===log.buffer,repeatedReadStable:b===record.terminal.buffer.active,rows:record.terminal.rows,baseY:b.baseY,viewportY:b.viewportY,cursorY:b.cursorY,stack:kind==='scroll'?new Error('Private terminal scroll observation').stack:undefined})};record.terminal.onResize(value=>observe('resize',value));record.terminal.onScroll(value=>observe('scroll',value));if(!window.pendingNativeRecorder){window.pendingNativeRecorder=true;document.addEventListener('click',event=>{const target=event.target instanceof Element?event.target.closest('.composer-pending button'):null;if(target&&window.pendingNative)window.pendingNative.actions.push({trusted:event.isTrusted,label:target.getAttribute('aria-label'),operationId:target.closest('.composer-pending').dataset.operationId})},true)}})()`);
  // CDP typing exercises the maintained original editor, without an Enter or Runtime submit.
  await click(editor); await key('End', 'End', 35); await key('x', 'KeyX', 88, 'x');
  await waitFor(`pendingDelivery.facts().drafts[resultReady.sessionId].includes('x')`);
  const baseline = await settled();
  assert.equal(baseline.strip, null, 'An empty queue has no pending slot'); visibleCursor(baseline);
  assert.ok(baseline.facts.inputs.some(input => input.trusted && input.composer && input.key === 'x'));
  assert.ok(Math.abs(baseline.ownerRect.width - scene.ownerWidth) <= 8, 'The actual owner uses the bounded scene width');
  await frame(scene, 'empty');

  // Appearance at latest must preserve the cursor, independently of historical reading.
  assert.equal(baseline.editorFocused, true, 'The original input owns focus before bottom appearance');
  await evaluate("pendingNative.phase='bottom-pending-appearance';pendingDelivery.queue()");
  const bottomAppearance = await settled();
  result.checkpoints.push({ scene, name: 'bottom-pending-appearance', facts: bottomAppearance });
  pendingGeometry(baseline, bottomAppearance, '排队中', false, false); visibleCursor(bottomAppearance);
  assert.equal(bottomAppearance.editorFocused, true, 'Bottom pending appearance preserves original input focus');
  assert.equal(bottomAppearance.facts.attempts.length, 0, 'Bottom queue appearance has no submit');
  assert.deepEqual(bottomAppearance.facts.inFlight, {}); assert.deepEqual(bottomAppearance.facts.phase, {});
  await evaluate("pendingNative.phase='bottom-pending-cleared';pendingDelivery.clear()");
  const bottomCleared = await settled();
  result.checkpoints.push({ scene, name: 'bottom-pending-cleared', facts: bottomCleared });
  assert.equal(bottomCleared.strip, null); retained(baseline, bottomCleared);
  assert.deepEqual(bottomCleared.terminal, baseline.terminal, 'Clearing bottom pending restores the complete original terminal');
  assert.equal(bottomCleared.editorFocused, true); visibleCursor(bottomCleared);

  // A real scrolled xterm anchor must survive the new pending row, independently of bottom reading.
  await evaluate(`(()=>{const record=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);record.terminal.scrollLines(-4)})()`);
  const reading = await settled(); assert.ok(reading.terminal.viewportY < reading.terminal.baseY);
  const anchor = reading.terminal.visibleLines[0]; assert.ok(anchor.length > 0);
  await evaluate('pendingDelivery.queue()');
  const queued = await settled(); pendingGeometry(reading, queued, '排队中', false, false);
  assert.equal(queued.terminal.viewportY, reading.terminal.viewportY, 'Pending appearance retains the actual scrolled viewport anchor');
  assert.equal(queued.terminal.visibleLines[0], anchor, 'The same original history line remains at the reading anchor');
  assert.equal(queued.editorFocused, true, 'Queue appearance does not take draft focus');
  const sid = await evaluate('resultReady.sessionId'), entry = queued.facts.queues[sid][0];
  assert.equal(queued.facts.queues[sid].length, 1); assert.equal(queued.strip.operationId, entry.operationId);
  assert.equal(entry.promptCondition, null); assert.equal(queued.facts.attempts.length, 0);
  await frame(scene, 'queued-reading');
  await evaluate(`(()=>{const record=resultReadyTerminals.find(r=>r.terminal.element===pendingNative.terminal&&!r.disposed);record.terminal.scrollToBottom()})()`);
  const bottom = await settled(); visibleCursor(bottom);

  await click(send); await waitFor(`pendingDelivery.facts().phase[${JSON.stringify(sid)}]==='preparing'`);
  const preparing = await settled(); pendingGeometry(bottom, preparing, '准备发送', true, true); visibleCursor(preparing);
  assert.equal(preparing.facts.inFlight[sid], entry.operationId); assert.equal(preparing.facts.attempts.length, 0);
  assert.ok(preparing.trustedActions.some(action => action.trusted && action.label === '发送这条待发消息' && action.operationId === entry.operationId));
  // The real tail proves that this direct icon grants only the selected operation.
  await evaluate('pendingDelivery.queue()');
  const withTail = await settled(); assert.equal(withTail.facts.queues[sid].length, 2);
  const tail = withTail.facts.queues[sid][1]; assert.notEqual(tail.operationId, entry.operationId);
  pendingGeometry(preparing, withTail, '准备发送', true, true); visibleCursor(withTail);
  await frame(scene, 'preparing');
  await evaluate('pendingDelivery.prepared()');
  await waitFor(`pendingDelivery.facts().phase[${JSON.stringify(sid)}]==='submitting'&&pendingDelivery.facts().attempts.length===1`);
  const sending = await settled(); pendingGeometry(withTail, sending, '发送中', true, true); visibleCursor(sending);
  const attempt = sending.facts.attempts[0];
  assert.equal(attempt[0].agentSessionId, sid); assert.equal(attempt[0].run.runId, entry.runId);
  assert.equal(attempt[1], entry.text); assert.equal(attempt[2], entry.operationId);
  assert.equal(attempt[3].expectedRun.runId, entry.runId); assert.equal(attempt[4].allowUncertainTurn, true);
  assert.equal(sending.facts.inFlight[sid], entry.operationId); await frame(scene, 'sending');
  await evaluate('pendingDelivery.submitted()');
  await waitFor(`!pendingDelivery.facts().inFlight[${JSON.stringify(sid)}]`);
  const completed = await settled(); retained(sending, completed);
  assert.deepEqual(completed.facts.queues[sid].map(item => item.operationId), [tail.operationId]);
  assert.equal(completed.facts.phase[sid], undefined); assert.equal(completed.facts.attempts.length, 1, 'The real nonempty tail has no dispatch');
  await evaluate('pendingDelivery.clear()'); const clearedTail = await settled();
  assert.equal(clearedTail.strip, null); assert.deepEqual(clearedTail.terminal, baseline.terminal, 'Clearing the private idle tail restores the original terminal grid and cursor');
  retained(baseline, clearedTail); visibleCursor(clearedTail);
  result.checkpoints.push({ scene, name: 'cleared-tail-latest', facts: clearedTail });

  await evaluate("pendingNative.phase='interaction-only';pendingDelivery.interaction(true)"); const interaction = await settled();
  result.checkpoints.push({ scene, name: 'interaction-only', facts: interaction });
  await evaluate("pendingNative.phase='interaction-with-pending';pendingDelivery.queue()"); const waiting = await settled();
  result.checkpoints.push({ scene, name: 'interaction-with-pending', facts: waiting });
  pendingGeometry(interaction, waiting, '等待回答', false, true); visibleCursor(waiting);
  const pending = waiting.facts.queues[sid][0];
  assert.equal(waiting.facts.attempts.length, 1); assert.equal(waiting.facts.inFlight[sid], undefined);
  await frame(scene, 'waiting');
  await evaluate('pendingDelivery.interaction(false);pendingDelivery.unknown()');
  const unknown = await settled();
  result.noticeTransitions.push({ scene, name: 'unknown-notice-appears', ...pendingGeometry(clearedTail, unknown, '投递未确认', false, false, true) });
  visibleCursor(unknown);
  assert.equal(unknown.facts.queues[sid][0].operationId, pending.operationId); assert.equal(unknown.facts.attempts.length, 1);
  await frame(scene, 'unknown');
  await click(more); await waitFor(`${panel}.matches(':popover-open')&&${panel}.querySelector('[id$="-outbox-tab"]').getAttribute('aria-selected')==='true'`);
  const row = `${panel}.querySelector('[data-record-key=${JSON.stringify('queue:' + pending.operationId)}].composer-mailbox__row')`;
  await waitFor(`Boolean(${row})`); await click(row);
  await waitFor(`Boolean(${panel}.querySelector('.composer-outbox.composer-mailbox__detail'))`);
  assert.equal(await evaluate(`${panel}.querySelector('.log-turn__body').textContent`), pending.text, 'Original Outbox retains the exact full queued text');
  assert.equal(await evaluate(`${panel}.querySelector('.log-turn__actions .composer-mailbox__reveal').disabled`), true);
  assert.ok(await evaluate(`${panel}.textContent.includes('尚未发送，暂无对话位置')`));
  await click(`${panel}.querySelector('[aria-label="Copy message"]')`);
  await waitFor(`pendingDelivery.facts().copies.length===1`);
  assert.equal(await evaluate('pendingDelivery.facts().copies[0]'), pending.text, 'Real Copy sends the full original text to the private clipboard sink');
  assert.equal(await evaluate('pendingDelivery.facts().attempts.length'), 1, 'More, detail and Copy issue no delivery');
  await frame(scene, 'outbox-detail');
  await click(`${panel}.querySelector('[aria-label="Message details"]')`);
  await waitFor(`Boolean(${panel}.querySelector('.conversation-input-details__body'))`);
  const info = await evaluate(`${panel}.querySelector('.conversation-input-details__body').textContent`);
  assert.match(info, /Pending message · not a delivery receipt/); assert.match(info, /Delivery result unknown/);
  assert.equal(await evaluate(`Boolean(${panel}.querySelector('[data-mailbox-location="target"]'))`), false);
  await frame(scene, 'outbox-info');
  await click(`${panel}.querySelector('[aria-label="Close mailbox"]')`);
  await waitFor(`!${panel}.matches(':popover-open')`); await evaluate('pendingDelivery.clear()');
  await click(editor); const cleared = await settled();
  assert.equal(cleared.strip, null); assert.equal(cleared.editorFocused, true);
  retained(baseline, cleared); assert.deepEqual(cleared.terminal, baseline.terminal); visibleCursor(cleared);
  result.noticeTransitions.push({ scene, name: 'unknown-notice-clears', ...noticeGeometry(unknown, cleared) });
  assert.equal(cleared.facts.attempts.length, 1); assert.deepEqual(cleared.facts.inFlight, {}); assert.deepEqual(cleared.facts.phase, {});
  // Trusted terminal input is echoed only by the private preview adapter on the same actual xterm.
  await click(`${surface}.querySelector('.terminal-view__xterm')`);
  const writes = cleared.facts.writes.length; await key('q', 'KeyQ', 81, 'q');
  await waitFor(`pendingDelivery.facts().writes.length===${writes + 1}`); const trusted = await settled();
  assert.equal(trusted.facts.writes.at(-1).data, 'q'); assert.equal(trusted.facts.writes.at(-1).control.run.runId, entry.runId);
  assert.equal(trusted.terminal.id, baseline.terminal.id); assert.equal(trusted.terminal.rows, baseline.terminal.rows);
  assert.equal(trusted.terminal.cursorX, baseline.terminal.cursorX + 1); assert.equal(trusted.terminal.cursorLine, baseline.terminal.cursorLine + 'q');
  assert.equal(trusted.draft, baseline.draft); assert.deepEqual(trusted.neighbor, baseline.neighbor);
  assert.ok(trusted.facts.inputs.some(input => input.trusted && input.terminal && input.key === 'q'));
  result.scenes.push({ scene, baseline, reading, anchor, queued, bottom, preparing, withTail, sending, completed, clearedTail, interaction, waiting, unknown, info, cleared, trusted,
    delivery: { operationId: entry.operationId, runId: entry.runId, tailOperationId: tail.operationId, submitCount: trusted.facts.attempts.length } });
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
    for (const sceneConfig of [{ viewport: 1280, ownerWidth: 640, appearance: 'dark' }, { viewport: 1280, ownerWidth: 640, appearance: 'light' },
      { viewport: 640, ownerWidth: 320, appearance: 'dark' }, { viewport: 640, ownerWidth: 320, appearance: 'light' }]) await scene(sceneConfig);
    assert.equal(result.scenes.length, 4);
    if (capture === 'capture') assert.equal(result.frames.length, 32, 'Every bounded scene has eight complete original screenshots');
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
