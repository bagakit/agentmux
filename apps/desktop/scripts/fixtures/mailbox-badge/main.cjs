const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const [html, privateRoot, evidence, capture] = process.argv.slice(2);
app.setPath('userData', path.join(privateRoot, 'user-data'));
let win;
const result = { schema: 'agentmux.mailbox-badge-native.v1', passed: false, frames: [], scenes: [], userRunTouched: false, console: [] };
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const trigger = `${surface}.querySelector('.composer__mailbox')`;
const evaluate = async expression => {
  const value = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(expression)})}catch(error){return{__probeError:true,name:error.name,message:error.message,stack:error.stack}}})()`);
  if (value?.__probeError) { const error = new Error(value.message); error.name = value.name; error.stack = value.stack; throw error; }
  return value;
};
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(expression) { for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25); } assert.fail('Actual Renderer fact did not arrive: ' + expression); }
async function painted() { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await delay(60); }
async function click(expression) {
  const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await painted();
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},t=${trigger},b=t.querySelector('.composer-mailbox__unread'),rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};let text=null;if(b){const r=document.createRange();r.selectNodeContents(b);const c=getComputedStyle(b);text={text:b.textContent,font:c.font,fontFamily:c.fontFamily,padding:c.padding,rect:rect(r)}}return{trigger:rect(t),badge:rect(b),slot:rect(t.querySelector('.composer-mailbox__inbox-count')),envelope:rect(t.querySelector('svg.lucide-mail')),attention:rect(t.querySelector('.composer-mailbox__attention')),badgeText:text,progress:rect(t.querySelector('.composer-mailbox__progress')),status:rect(s.querySelector('.composer-agent-identity .agent-avatar__status')),composer:rect(s.querySelector('.composer')),editor:rect(s.querySelector('.composer [role="textbox"]')),draft:s.querySelector('.composer [role="textbox"]').textContent,terminal:mailboxBadge.terminal(),facts:mailboxBadge.facts()}})()`);
}
async function settled() { let old = await geometry(); for (let i = 0; i < 12; i++) { await delay(120); const next = await geometry(); if (JSON.stringify([old.trigger,old.editor,old.terminal,old.facts.resizes]) === JSON.stringify([next.trigger,next.editor,next.terminal,next.facts.resizes])) return next; old = next; } assert.fail('The original native surface did not settle'); }
function stable(before, after) {
  for (const name of ['trigger', 'composer', 'editor', 'draft', 'terminal']) assert.deepEqual(after[name], before[name], 'Unread changes preserve original ' + name);
  for (const name of ['sessions', 'tab', 'layout', 'drafts', 'queues', 'resizes', 'writes']) assert.deepEqual(after.facts[name], before.facts[name], 'Unread changes preserve original ' + name);
}
function separated(a, b) { return a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y; }
async function badgeGeometry(inbox = true, attention) {
  const g = await geometry();
  assert.ok(g.status && g.progress && g.slot && g.envelope, 'Actual Avatar, Progress, Inbox slot and envelope are nonempty');
  assert.equal(Boolean(g.badge), inbox, 'Only Inbox unread creates the entry number');
  if (attention !== undefined) assert.equal(Boolean(g.attention), attention, 'Only Notices unread creates attention');
  assert.equal(g.trigger.height, 24, 'The existing 24px tool height is preserved');
  assert.ok(g.slot.x >= g.envelope.right, 'Inbox number sits to the right of its envelope');
  assert.ok(g.slot.right <= g.trigger.right + 0.1, 'Inbox slot stays inside the Mailbox horizontal bounds');
  if (g.badge) assert.ok(g.badge.x >= g.slot.x - 0.5 && g.badge.right <= g.slot.right + 0.5, 'Inbox slot contains complete 99+ without crowding its neighbors');
  for (const mark of [g.badge, g.attention, g.progress].filter(Boolean)) {
    assert.ok(mark.x >= g.trigger.x && mark.right <= g.trigger.right + 0.1, 'Hints stay inside Mailbox horizontal bounds');
    assert.ok(mark.y >= g.trigger.y && mark.bottom <= g.trigger.bottom + 0.1, 'Hints stay inside Mailbox vertical bounds');
    assert.equal(separated(mark, g.status), true, 'Mailbox hints do not overlap Avatar status');
  }
  if (g.attention) {
    assert.ok(g.attention.x < g.envelope.right && g.attention.y < g.envelope.y, 'Notices attention is at the envelope upper left');
    assert.equal(separated(g.attention, g.progress), true, 'Notices attention does not overlap Progress');
    const ink = await evaluate(`(()=>{const e=${trigger}.querySelector('.composer-mailbox__attention'),c=getComputedStyle(e),t=document.createElement('span');t.style.color=getComputedStyle(document.documentElement).getPropertyValue('--amber').trim();return{color:c.color,amber:t.style.color,animation:c.animationName}})()`);
    assert.equal(ink.color, ink.amber, 'Notices attention uses the existing amber token');
    assert.equal(ink.animation, 'none', 'Notices attention is static');
  }
  if (!g.badge) return g;
  assert.equal(separated(g.badge, g.progress), true, 'Inbox unread does not overlap Progress');
  if (g.attention) assert.equal(separated(g.badge, g.attention), true, 'Inbox unread and Notices attention are separate');
  const text = await evaluate(`(()=>{const b=${trigger}.querySelector('.composer-mailbox__unread'),range=document.createRange();range.selectNodeContents(b);const cs=getComputedStyle(b),token=document.createElement('span');token.style.color=getComputedStyle(document.documentElement).getPropertyValue('--text-2').trim();return{text:b.textContent,fontSize:cs.fontSize,color:cs.color,neutral:token.style.color,background:cs.backgroundColor,transform:cs.transform,rects:Array.from(range.getClientRects()).map(r=>({x:r.x,right:r.right,top:r.top,bottom:r.bottom}))}})()`);
  assert.equal(text.fontSize, '10px'); assert.ok(text.rects.length > 0 && text.text.length > 0);
  assert.equal(text.color, text.neutral, 'Inbox unread uses the actual neutral text token');
  assert.equal(text.background, 'rgba(0, 0, 0, 0)', 'Ordinary Inbox mail has no red alert background');
  assert.equal(text.transform, 'none', 'Complete Inbox glyphs are not scaled');
  for (const r of text.rects) assert.ok(r.x >= g.badge.x - 0.5 && r.right <= g.badge.right + 0.5 && r.top >= g.badge.y - 1 && r.bottom <= g.badge.bottom + 1, 'Complete unread text Range is readable inside its badge');
  assert.ok(g.slot.width <= 22, 'Inbox slot reserves only the natural small 99+ width');
  return { ...g, text };
}
async function frame(scene, name) {
  if (capture !== 'capture') return;
  // A hidden Electron window can capture a stale canvas layer after the badge's DOM update.
  // Refresh only the private fixture's mounted xterms and observe their actual render before capture.
  const terminalPaint = await evaluate(`(()=>{const terminals=(globalThis.resultReadyTerminals??[]).filter(entry=>!entry.disposed&&entry.terminal.element?.isConnected);if(!terminals.length)throw Error('No actual mounted Terminal to paint');return Promise.all(terminals.map(entry=>new Promise((done,reject)=>{const terminal=entry.terminal;let lease;const timer=setTimeout(()=>{lease?.dispose();reject(Error('Actual Terminal render did not arrive'))},2000);lease=terminal.onRender(range=>{clearTimeout(timer);lease.dispose();done({id:entry.id,rows:terminal.rows,...range})});terminal.refresh(0,terminal.rows-1)})))})()`);
  assert.ok(terminalPaint.length > 0);
  await painted(); const file = `${scene.width}-${scene.appearance}-${scene.mode}-${name}.png`, bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length > 0);
  await fs.writeFile(path.join(evidence, file), bytes); result.frames.push({ scene, file, terminalPaint });
}
async function scene(scene) {
  result.stage = scene;
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: scene.width * 2 + 1, height: 750, deviceScaleFactor: 1, mobile: false });
  await evaluate(`mailboxBadge.seed(${scene.pending > 0});mailboxBadge.appearance(${JSON.stringify(scene.appearance)});mailboxBadge.draft(${JSON.stringify(scene.draft)});mailboxBadge.unread(0);mailboxBadge.notices(false)`);
  await waitFor(`Boolean(${surface})`);
  for (let i = 0; i < ['collapsed','current','expanded'].indexOf(scene.mode); i++) await click(`${surface}.querySelector('.composer-tool--mode')`);
  await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating') && ${trigger}.dataset.progressState==='active'`);
  await click(`${surface}.querySelector('.terminal-view__xterm')`);
  const baseline = await settled(); assert.equal(baseline.trigger.height, 24); assert.equal(baseline.badge, null);
  assert.ok(baseline.terminal.rows > 0 && baseline.terminal.visibleLines.length > 0);
  assert.equal(await evaluate(`${trigger}.querySelector(':scope > span:not([class])')`), null, 'Pending is absent from the Mailbox entry');
  assert.equal(await evaluate(`${surface}.querySelector('[id$="-outbox-tab"]').getAttribute('aria-label')`), `Outbox: ${scene.pending} pending`);
  await frame(scene, 'unread-0');
  const observations = [];
  for (const count of [1,12,100]) {
    await evaluate(`mailboxBadge.unread(${count})`);
    await waitFor(`${trigger}.getAttribute('aria-label').includes(${JSON.stringify('Inbox '+count+' unread')})`);
    await painted(); const g = await badgeGeometry(true, false); stable(baseline,g);
    assert.equal(g.text.text, count > 99 ? '99+' : String(count));
    assert.equal(await evaluate(`${trigger}.title`), `Mailbox: Inbox ${count} unread, Outbox ${scene.pending} pending, Notices 0 need attention. Continuous progress: active`);
    observations.push({count,...g}); if (count === (scene.width === 640 ? 1 : scene.appearance === 'light' ? 12 : 100)) await frame(scene, 'inbox-'+count);
  }
  await evaluate('mailboxBadge.unread(0);mailboxBadge.notices(true)'); await painted();
  await waitFor(`${trigger}.title.includes('Notices 1 need attention')`);
  const noticesOnly = await badgeGeometry(false, true); stable(baseline, noticesOnly); await frame(scene, 'notices-only');
  await evaluate('mailboxBadge.unread(12)');
  await waitFor(`${trigger}.title.includes('Inbox 12 unread')`); await painted();
  const mixed = await badgeGeometry(true, true); stable(baseline, mixed); await frame(scene, 'mixed');
  if (scene.width === 640) {
    for (const state of ['waiting','disconnected']) {
      await evaluate(`mailboxBadge.state(${JSON.stringify(state)})`); await painted(); await badgeGeometry(); await frame(scene, state);
    }
    await evaluate(`mailboxBadge.state('working')`); await painted();
  }
  let read;
  if (scene.width === 640) {
    const point = await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', ...point });
    await waitFor(`${surface}.querySelector('.composer-mailbox').matches(':popover-open')`); await delay(200);
    assert.ok(await evaluate(`${trigger}.getAttribute('aria-label').includes('Inbox 12 unread')`), 'Native hover preview does not acknowledge Inbox');
    assert.ok(await evaluate(`${trigger}.getAttribute('aria-label').includes('Notices 1 need attention')`), 'Native hover preview does not acknowledge Notices');
    assert.deepEqual((await geometry()).facts.receipts, {});
    await click(trigger);
    await waitFor(`!${trigger}.querySelector('.composer-mailbox__unread')&&${trigger}.title.includes('Inbox 0 unread')`);
    assert.equal(await evaluate(`${surface}.querySelector('.composer-mailbox [aria-selected="true"]').getAttribute('aria-label')`),'Inbox: 0 unread');
    assert.ok(await evaluate(`Boolean(${trigger}.querySelector('.composer-mailbox__attention'))`), 'Reading Inbox preserves unread Notices attention');
    assert.equal(Object.keys((await geometry()).facts.receipts['mail:session-codex']).length,12);
    await frame(scene, 'after-inbox-read');
    await click(`${surface}.querySelector('[id$="-system-tab"]')`);
    await waitFor(`!${trigger}.querySelector('.composer-mailbox__attention')&&${trigger}.title.includes('Notices 0 need attention')`);
    assert.ok(await evaluate(`${surface}.querySelectorAll('.composer-notice').length>0`), 'Read Notices remain available until their owner recovers');
    assert.equal(await evaluate(`${trigger}.title`), 'Mailbox: Inbox 0 unread, Outbox 0 pending, Notices 0 need attention. Continuous progress: active');
    await click(`${surface}.querySelector('[aria-label="Close mailbox"]')`);
    await waitFor(`!${surface}.querySelector('.composer-mailbox').matches(':popover-open')`);
    read = await geometry(); stable(baseline,read); assert.equal(read.badge,null); assert.equal(read.attention,null);
    await frame(scene,'after-read-zero');
  }
  await click(`${surface}.querySelector('.terminal-view__xterm')`);
  const writes = await evaluate('mailboxBadge.facts().writes.length');
  for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'q',code:'KeyQ',windowsVirtualKeyCode:81,...(type==='keyDown'?{text:'q',unmodifiedText:'q'}:{})});
  await waitFor(`mailboxBadge.facts().writes.length===${writes+1}`);
  const after = await geometry(); assert.equal(after.facts.writes.at(-1).data,'q'); assert.deepEqual(after.facts.drafts,baseline.facts.drafts); assert.equal(after.terminal.id,baseline.terminal.id);
  assert.ok(after.facts.inputs.length>0 && after.facts.inputs.some(input=>input.trusted&&input.terminal&&input.key==='q'));
  result.scenes.push({scene,baseline,observations,noticesOnly,mixed,read,after});
}
app.whenReady().then(async()=>{
  try {
    win=new BrowserWindow({width:1281,height:750,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.on('console-message',(_event,_level,message)=>result.console.push(message));
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await waitFor('Boolean(window.mailboxBadge)');
    for (const s of [{width:640,appearance:'dark',mode:'collapsed',pending:0,draft:'Original short draft'}, {width:320,appearance:'light',mode:'current',pending:1,draft:'Keep the original long draft near its next natural line wrap boundary.'},{width:320,appearance:'dark',mode:'expanded',pending:1,draft:'Original long draft\nSecond retained line\nThird unsent line'}]) await scene(s);
    assert.equal(result.scenes.length,3); result.passed=true;
  } catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack}; result.failureFacts=await geometry().catch(()=>null); result.failureDom=await evaluate('document.body.innerHTML').catch(()=>null); }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2)); win?.destroy();app.exit(result.passed?0:1); }
});
