const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const [html, privateRoot, evidence] = process.argv.slice(2);
app.setPath('userData', path.join(privateRoot, 'user-data'));
let win;
const result = { schema: 'agentmux.mailbox-badge-native.v1', passed: false, frames: [], scenes: [], userRunTouched: false };
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const trigger = `${surface}.querySelector('.composer__mailbox')`;
const evaluate = expression => win.webContents.executeJavaScript(expression), delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(expression) { for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25); } assert.fail('Actual Renderer fact did not arrive: ' + expression); }
async function painted() { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await delay(60); }
async function click(expression) {
  const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await painted();
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},t=${trigger},b=t.querySelector('.composer-mailbox__unread'),rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};let text=null;if(b){const r=document.createRange();r.selectNodeContents(b);const c=getComputedStyle(b);text={text:b.textContent,font:c.font,fontFamily:c.fontFamily,padding:c.padding,rect:rect(r)}}return{trigger:rect(t),badge:rect(b),badgeText:text,progress:rect(t.querySelector('.composer-mailbox__progress')),status:rect(s.querySelector('.composer-agent-identity .agent-avatar__status')),composer:rect(s.querySelector('.composer')),editor:rect(s.querySelector('.composer [role="textbox"]')),draft:s.querySelector('.composer [role="textbox"]').textContent,terminal:mailboxBadge.terminal(),facts:mailboxBadge.facts()}})()`);
}
async function settled() { let old = await geometry(); for (let i = 0; i < 12; i++) { await delay(120); const next = await geometry(); if (JSON.stringify([old.trigger,old.editor,old.terminal,old.facts.resizes]) === JSON.stringify([next.trigger,next.editor,next.terminal,next.facts.resizes])) return next; old = next; } assert.fail('The original native surface did not settle'); }
function stable(before, after) {
  for (const name of ['trigger', 'composer', 'editor', 'draft', 'terminal']) assert.deepEqual(after[name], before[name], 'Unread changes preserve original ' + name);
  for (const name of ['sessions', 'tab', 'layout', 'drafts', 'queues', 'resizes', 'writes']) assert.deepEqual(after.facts[name], before.facts[name], 'Unread changes preserve original ' + name);
}
function separated(a, b) { return a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y; }
async function badgeGeometry() {
  const g = await geometry();
  assert.ok(g.badge && g.status && g.progress, 'Actual unread, Avatar status and Progress marks are all nonempty');
  assert.equal(separated(g.badge, g.status), true, 'Unread badge does not overlap the actual Avatar status');
  assert.ok(g.badge.x >= g.trigger.x && g.badge.right <= g.trigger.right + 0.1, 'Unread badge stays inside the Mailbox horizontal bounds');
  assert.ok(g.badge.y >= g.trigger.y && g.badge.bottom <= g.trigger.bottom && g.badge.y < g.trigger.y + g.trigger.height / 2);
  assert.equal(separated(g.badge, g.progress), true, 'Unread badge does not overlap Progress');
  const text = await evaluate(`(()=>{const b=${trigger}.querySelector('.composer-mailbox__unread'),range=document.createRange();range.selectNodeContents(b);const cs=getComputedStyle(b);return{text:b.textContent,fontSize:cs.fontSize,color:cs.color,background:cs.backgroundColor,surface0:getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim(),rects:Array.from(range.getClientRects()).map(r=>({x:r.x,right:r.right,top:r.top,bottom:r.bottom}))}})()`);
  assert.equal(text.fontSize, '10px'); assert.ok(text.rects.length > 0 && text.text.length > 0);
  assert.equal(text.color, await evaluate(`(()=>{const e=document.createElement('span');e.style.color=getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim();return e.style.color})()`), 'Badge ink follows the actual light/dark surface token');
  for (const r of text.rects) assert.ok(r.x >= g.badge.x - 0.5 && r.right <= g.badge.right + 0.5 && r.top >= g.badge.y - 1 && r.bottom <= g.badge.bottom + 1, 'Complete unread text Range is readable inside its badge');
  assert.ok(g.badge.height === 10 || g.badge.height === 11, 'Unread badge compact red background height is 10px or readable 11px');
  if (text.text === '1') assert.equal(g.badge.width, g.badge.height, 'Single unread digit uses the compact minimal square');
  const area = { actual: g.badge.width * g.badge.height, original12: Math.max(12, g.badge.width) * 12 };
  assert.ok(area.actual < area.original12, 'Unread badge actual red background area is smaller than its original 12px envelope');
  return { ...g, text, area };
}
async function frame(scene, name) {
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
  await evaluate(`mailboxBadge.seed(${scene.pending > 0});mailboxBadge.appearance(${JSON.stringify(scene.appearance)});mailboxBadge.draft(${JSON.stringify(scene.draft)});mailboxBadge.unread(0)`);
  for (let i = 0; i < ['collapsed','current','expanded'].indexOf(scene.mode); i++) await click(`${surface}.querySelector('.composer-tool--mode')`);
  await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating') && ${trigger}.dataset.progressState==='active'`);
  await click(`${surface}.querySelector('.terminal-view__xterm')`);
  const baseline = await settled(); assert.equal(baseline.trigger.height, 24); assert.equal(baseline.badge, null);
  assert.ok(baseline.terminal.rows > 0 && baseline.terminal.visibleLines.length > 0);
  assert.equal(await evaluate(`${trigger}.querySelector(':scope > span:not([class])')?.textContent??null`), scene.pending ? '1' : null);
  await frame(scene, 'unread-0');
  const observations = [];
  for (const count of [1,12,100]) {
    await evaluate(`mailboxBadge.unread(${count})`);
    await waitFor(`${trigger}.getAttribute('aria-label').includes(${JSON.stringify(''+count+' unread')})`);
    await painted(); const g = await badgeGeometry(); stable(baseline,g);
    assert.equal(g.text.text, count > 99 ? '99+' : String(count));
    assert.equal(await evaluate(`${trigger}.title`), `Mailbox: ${count} unread, ${count} Agent messages, 0 notices, ${scene.pending} pending. Continuous progress: active`);
    observations.push({count,...g}); await frame(scene, 'unread-'+count);
  }
  for (const state of ['waiting','disconnected']) {
    await evaluate(`mailboxBadge.state(${JSON.stringify(state)})`); await painted(); await badgeGeometry(); await frame(scene, state);
  }
  await evaluate(`mailboxBadge.state('working')`); await painted();
  let read;
  if (scene.width === 640) {
    await evaluate('mailboxBadge.unread(12)'); await painted();
    const point = await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', ...point });
    await waitFor(`${surface}.querySelector('.composer-mailbox').matches(':popover-open')`); await delay(200);
    assert.ok(await evaluate(`${trigger}.getAttribute('aria-label').includes('12 unread')`), 'Native hover preview does not acknowledge incoming messages');
    assert.deepEqual((await geometry()).facts.receipts, {});
    await click(trigger);
    await waitFor(`!${trigger}.querySelector('.composer-mailbox__unread')&&${trigger}.getAttribute('aria-label').includes('0 unread')`);
    assert.equal(await evaluate(`${surface}.querySelector('.composer-mailbox [role="tab"][aria-selected="true"]').textContent`),'Inbox (12)');
    assert.equal(await evaluate(`${trigger}.title`), 'Mailbox: 0 unread, 12 Agent messages, 0 notices, 0 pending. Continuous progress: active');
    assert.equal(Object.keys((await geometry()).facts.receipts['mail:session-codex']).length,12);
    await click(`${surface}.querySelector('[aria-label="Close mailbox"]')`);
    await waitFor(`!${surface}.querySelector('.composer-mailbox').matches(':popover-open')`);
    read = await geometry(); stable(baseline,read); assert.equal(read.badge,null);
    await frame(scene,'after-read-zero');
  }
  await click(`${surface}.querySelector('.terminal-view__xterm')`);
  const writes = await evaluate('mailboxBadge.facts().writes.length');
  for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'q',code:'KeyQ',windowsVirtualKeyCode:81,...(type==='keyDown'?{text:'q',unmodifiedText:'q'}:{})});
  await waitFor(`mailboxBadge.facts().writes.length===${writes+1}`);
  const after = await geometry(); assert.equal(after.facts.writes.at(-1).data,'q'); assert.deepEqual(after.facts.drafts,baseline.facts.drafts); assert.equal(after.terminal.id,baseline.terminal.id);
  assert.ok(after.facts.inputs.length>0 && after.facts.inputs.some(input=>input.trusted&&input.terminal&&input.key==='q'));
  result.scenes.push({scene,baseline,observations,read,after});
}
app.whenReady().then(async()=>{
  try {
    win=new BrowserWindow({width:1281,height:750,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
    await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await waitFor('Boolean(window.mailboxBadge)');
    for (const s of [{width:640,appearance:'dark',mode:'collapsed',pending:0,draft:'Original short draft'}, {width:320,appearance:'light',mode:'current',pending:1,draft:'Keep the original long draft near its next natural line wrap boundary.'},{width:320,appearance:'dark',mode:'expanded',pending:1,draft:'Original long draft\nSecond retained line\nThird unsent line'}]) await scene(s);
    assert.equal(result.scenes.length,3); result.passed=true;
  } catch(error) { result.failure={name:error.name,message:error.message,stack:error.stack}; result.failureFacts=await geometry().catch(()=>null); }
  finally { await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2)); win?.destroy();app.exit(result.passed?0:1); }
});
