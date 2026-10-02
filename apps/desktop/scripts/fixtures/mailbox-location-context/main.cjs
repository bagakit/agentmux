const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const [html, privateRoot, evidence, capture] = process.argv.slice(2);
app.setPath('userData', path.join(privateRoot, 'user-data'));
let win;
const result = { schema: 'agentmux.mailbox-location-context-native.v1', passed: false, frames: [], scenes: [], identities: [], userRunTouched: false, console: [] };
const surface = `document.querySelector('[data-workbench-region-id="result-input-owner"] .agent-surface')`;
const neighbor = `document.querySelector('[data-workbench-region-id="result-input-neighbor"]')`;
const panel = `${surface}.querySelector('.composer-mailbox')`, trigger = `${surface}.querySelector('.composer__mailbox')`;
const evaluate = async expression => {
  const value = await win.webContents.executeJavaScript(`(async()=>{try{return await eval(${JSON.stringify(expression)})}catch(error){return{__probeError:true,name:error.name,message:error.message,stack:error.stack}}})()`);
  if (value?.__probeError) { const error = new Error(value.message); error.name = value.name; error.stack = value.stack; throw error; }
  return value;
};
const delay = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(expression) { for (let i = 0; i < 160; i++) { if (await evaluate(expression)) return; await delay(25); } assert.fail('Actual Renderer fact did not arrive: ' + expression); }
async function painted() { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await delay(50); }
async function click(expression) {
  const point = await evaluate(`(()=>{const e=(${expression});if(!e)throw Error('Actual control is absent: '+${JSON.stringify(expression)});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Actual control is not visible');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await painted();
}
async function key(key, code, virtual, text) {
  for (const type of ['keyDown','keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type,key,code,windowsVirtualKeyCode:virtual,
    ...(type==='keyDown' && text ? {text,unmodifiedText:text}: {})});
  await painted();
}
async function geometry() {
  return evaluate(`(()=>{const s=${surface},n=${neighbor},rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};const original=s.querySelector('.xterm'),record=(globalThis.resultReadyTerminals??[]).find(entry=>entry.terminal.element===original&&!entry.disposed);const nr=(globalThis.resultReadyTerminals??[]).find(entry=>n.contains(entry.terminal.element)&&!entry.disposed);return{terminal:mailboxNavigation.terminal(),originalConnected:Boolean(original?.isConnected),originalHidden:Boolean(original?.closest('[hidden]')),originalId:record?.id,neighbor:{region:rect(n),terminal:rect(n.querySelector('.xterm')),id:nr?.id,rows:nr?.terminal.rows,cols:nr?.terminal.cols,draft:n.querySelector('.composer [role="textbox"]')?.textContent},editor:rect(s.querySelector('.composer [role="textbox"]')),draft:s.querySelector('.composer [role="textbox"]')?.textContent,composer:rect(s.querySelector('.composer')),facts:mailboxNavigation.facts(),active:{className:document.activeElement?.className,sourceKey:document.activeElement?.dataset.messageSourceKey},popover:s.querySelector('.composer-mailbox').matches(':popover-open')}})()`);
}
async function settled() { let old = await geometry(); for (let i=0;i<12;i++) { await delay(100); const next=await geometry(); if(JSON.stringify([old.terminal,old.neighbor,old.editor,old.facts.resizes])===JSON.stringify([next.terminal,next.neighbor,next.editor,next.facts.resizes]))return next;old=next; } assert.fail('The real original terminals did not settle'); }
function retained(before, after, modeGeometry = before, resumeResizes = []) {
  assert.deepEqual(after.terminal,before.terminal,'Navigation preserves the actual original xterm instance, rows, cursor and bytes');
  assert.equal(after.originalConnected,true); assert.equal(after.originalId,before.originalId);
  assert.deepEqual(after.neighbor,before.neighbor,'Navigation preserves the neighboring terminal and draft geometry');
  assert.equal(after.draft,before.draft,'Navigation preserves original draft');
  for(const name of ['editor','composer'])assert.deepEqual(after[name],modeGeometry[name],'Navigation preserves the existing mode geometry of '+name);
  for(const name of ['sessions','tab','layout','drafts','queues','writes','pastes','dispatches'])assert.deepEqual(after.facts[name],before.facts[name],'Navigation does not change '+name);
  assert.deepEqual(after.facts.resizes,[...before.facts.resizes,...resumeResizes],'Reveal adds no resize; explicit Return has exactly the existing visibility-resume reassertion');
}
async function frame(scene,name) {
  if(capture!=='capture')return;
  const terminalPaint=await evaluate(`(()=>{const terminals=(globalThis.resultReadyTerminals??[]).filter(entry=>!entry.disposed&&entry.terminal.element?.isConnected&&!entry.terminal.element.closest('[hidden]'));if(!terminals.length)throw Error('No actual visible Terminal to paint');return Promise.all(terminals.map(entry=>new Promise((done,reject)=>{const terminal=entry.terminal;let lease;const timer=setTimeout(()=>{lease?.dispose();reject(Error('Actual Terminal render did not arrive'))},2000);lease=terminal.onRender(range=>{clearTimeout(timer);lease.dispose();done({id:entry.id,rows:terminal.rows,...range})});terminal.refresh(0,terminal.rows-1)})))})()`);
  assert.ok(terminalPaint.length>0);await painted();const file=`${scene.width}-${scene.appearance}-${scene.mode}-${name}.png`,bytes=(await win.webContents.capturePage()).toPNG();assert.ok(bytes.length>0);
  await fs.writeFile(path.join(evidence,file),bytes);result.frames.push({scene,file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),terminalPaint});
}
async function open(folder) {
  await click(trigger);await waitFor(`${panel}.matches(':popover-open')`);
  await click(`${panel}.querySelector('[id$="-${folder}-tab"]')`);
  await waitFor(`mailboxNavigation.facts().readCalls.length>0&&!${panel}.querySelector('.composer-mailbox__source-notice')`);
}
function row(kind) { return `${panel}.querySelector('[data-record-key=${JSON.stringify(kind==='captured'?'timeline:same':'native:native:codex:private-native-a:same')}].composer-mailbox__row')`; }
async function readableIdentity(kind) {
  const identity=await evaluate(`(()=>{const node=${panel}.querySelector('.log-turn[data-compact]'),who=node.querySelector('.log-turn__who'),head=node.querySelector('.log-turn__head'),range=document.createRange();range.selectNodeContents(who);const r=who.getBoundingClientRect(),h=head.getBoundingClientRect();return{name:who.textContent,width:r.width,headWidth:h.width,lines:[...range.getClientRects()].map(rect=>({x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom})),font:getComputedStyle(who).font,copy:Boolean(node.querySelector('[aria-label="Copy message"]')),info:Boolean(node.querySelector('[aria-label="Message details"]'))}})()`);
  assert.ok(identity.name&&identity.lines.length>0,'Actual recorded identity text Range is nonempty');
  assert.ok(identity.width>=Math.min(100,identity.headWidth)-0.1,'The compact identity keeps a readable width beside independent actions');
  assert.equal(identity.lines.length,1,'The recorded Inbox/Pending/native fixture identity stays on one readable line');
  assert.equal(identity.copy,true);assert.equal(identity.info,true);
  result.identities.push({scene:result.stage,kind,...identity});return identity;
}
async function showRecord(kind, detail) {
  const expression=row(kind); await waitFor(`Boolean(${expression})`);
  if(detail) { await click(expression);assert.equal(await evaluate(`${panel}.querySelector('.log-turn__body').textContent`),await evaluate('mailboxNavigation.body'));assert.equal(await evaluate(`Boolean(${panel}.querySelector('[aria-label="Copy message"]'))`),true);await readableIdentity(kind); }
  return detail ? `${panel}.querySelector('.log-turn__actions .composer-mailbox__reveal')` : `${expression}.parentElement.querySelector('.composer-mailbox__reveal')`;
}
async function located(kind) {
  await waitFor(`mailboxNavigation.facts().mode==='activity'&&${surface}.querySelector('.activity-feed')?.getBoundingClientRect().height>0`);await painted();
  const position=await evaluate(`(()=>{const key=mailboxNavigation.key(${JSON.stringify(kind)}),feed=${surface}.querySelector('.activity-feed'),matches=[...feed.querySelectorAll('.log-turn[data-message-source-key]')].filter(node=>node.dataset.messageSourceKey===key),node=matches[0],head=node?.querySelector('.log-turn__head')??node,rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};const token=document.createElement('span');token.style.backgroundColor=getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim();return{key,count:matches.length,head:rect(head),feed:rect(feed),located:node?.dataset.messageLocated,marker:node?.querySelector('.log-turn__location')?.textContent,fill:node?getComputedStyle(node).backgroundColor:null,surfaceFill:token.style.backgroundColor,animation:node?getComputedStyle(node).animationName:null,active:document.activeElement===node,otherMarked:[...feed.querySelectorAll('[data-message-located]')].filter(item=>item!==node).length,scrollTop:feed.scrollTop,behavior:getComputedStyle(feed).scrollBehavior,popover:${panel}.matches(':popover-open')}})()`);
  assert.equal(position.count,1,'Exact full source has one actual rendered node');assert.ok(position.head&&position.feed&&position.head.width>0&&position.head.height>0);
  assert.ok(position.head.y>=position.feed.y-1&&position.head.bottom<=position.feed.bottom+1,'The exact target header must be inside the actual viewport');
  assert.equal(position.located,'true');assert.equal(position.marker,'已定位此消息');assert.equal(position.active,true,'Closing the popover preserves final focus on the exact message');assert.equal(position.otherMarked,0);
  assert.equal(position.popover,false);assert.equal(position.behavior,'auto','Reduced-motion reveal has no scrolling animation');
  assert.equal(position.fill,position.surfaceFill,'The located message has the actual whole-face surface token fill');assert.notEqual(position.fill,'rgba(0, 0, 0, 0)');assert.equal(position.animation,'none');
  return position;
}
async function terminalAgain() {
  await click(`${surface}.querySelector('.composer-tool--view-toggle')`);await waitFor(`mailboxNavigation.facts().mode==='terminal'&&!${surface}.querySelector('.xterm').closest('[hidden]')`);await painted();
}

async function disclosure(scene, pending, expression=panel, originExpression='mailboxLocationContext.origin', prefix='') {
  await click(`${expression}.querySelector('[aria-label="Message details"]')`);
  await waitFor(`Boolean(${expression}.querySelector('.conversation-input-details__body'))`);
  const facts=await evaluate(`(()=>{const p=${expression},target=p.querySelector('[data-mailbox-location="target"]'),execution=p.querySelector('[data-mailbox-location="execution"]'),fields={};for(const dt of p.querySelectorAll('[data-mailbox-location] dt'))fields[dt.textContent]=dt.nextElementSibling.textContent;return{fields,target:Boolean(target),summary:p.querySelector('[data-mailbox-location="summary"]')?.textContent,sender:Boolean(p.querySelector('.conversation-input-details__sender')),copy:Boolean(p.querySelector('[aria-label="Copy message"]')),nav:Boolean(p.querySelector('.log-turn__actions .composer-mailbox__reveal')),execution:Boolean(execution),sourceText:p.querySelector('.conversation-input-details__body').textContent}})()`);
  assert.equal(facts.execution,true);assert.equal(facts.fields['执行 Host'],'local');assert.equal(facts.fields['当前执行 cwd'],await evaluate('mailboxLocationContext.cwd'));assert.equal(facts.fields['Session ID'],await evaluate('mailboxLocationContext.sessionId'));
  assert.equal(facts.copy,true);assert.equal(facts.nav,true);assert.match(facts.sourceText,/消息发生时的 Region、项目与 cwd 未记录/);
  if(pending){assert.equal(facts.target,false);assert.equal(facts.summary,undefined);assert.equal(await evaluate(`${expression}.querySelector('.composer-mailbox__reveal').disabled`),true);}
  else {
    const origin=await evaluate(`(${originExpression})`);assert.equal(facts.target,true);assert.match(facts.summary,/当前对话位置/);
    const summary=await evaluate(`(()=>{const p=${expression}.querySelector('[data-mailbox-location="summary"]'),r=p.getBoundingClientRect(),names=[...p.querySelectorAll('.composer-mailbox__location-name')].map(e=>{const rect=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);return{text:e.textContent,title:e.title,width:rect.width,lines:[...range.getClientRects()].map(r=>({top:r.top,bottom:r.bottom}))}}),region=p.querySelector('.composer-mailbox__location-region'),rr=region.getBoundingClientRect();return{names,width:r.width,region:{title:region.title,left:rr.left,right:rr.right},left:r.left,right:r.right}})()`);
    assert.equal(summary.names.length,2);for(const name of summary.names){assert.ok(name.width>=20,'The current project and Tab each keep readable space');assert.equal(name.title,name.text);assert.ok(name.lines.length>0&&name.lines.every(line=>line.top===name.lines[0].top),'The current project and Tab stay on one line');}assert.ok(summary.region.left>=summary.left&&summary.region.right<=summary.right+1,'The short Region identifier remains visible beside both names');
    for(const [label,key]of Object.entries({'显示 Workspace ID':'workspaceId','Group ID':'groupId','Tab ID':'tabId','Region ID':'regionId'}))assert.equal(facts.fields[label],origin[key]);
    assert.equal(facts.fields['资源 Host'],'resource-host');assert.equal(facts.fields['项目根目录'],await evaluate('mailboxLocationContext.repo'));assert.equal(facts.fields['Workspace / worktree 目录'],await evaluate('mailboxLocationContext.worktree'));assert.equal(facts.fields['分支'],'long-resource-worktree-branch');
    assert.notEqual(facts.fields['项目根目录'],facts.fields['Workspace / worktree 目录']);assert.notEqual(facts.fields['Workspace / worktree 目录'],facts.fields['当前执行 cwd']);
  }
  const readable=await evaluate(`(()=>{const p=${expression},results=[];for(const dt of p.querySelectorAll('[data-mailbox-location] dt')){const dd=dt.nextElementSibling,r=dd.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(dd);const lines=[...range.getClientRects()].map(x=>({left:x.left,right:x.right,width:x.width,height:x.height}));results.push({label:dt.textContent,value:dd.textContent,width:r.width,left:r.left,right:r.right,lines})}return results})()`);
  assert.ok(readable.length>=3,'Actual location full-path field Range collection is nonempty');
  for(const field of readable){assert.ok(field.width>0&&field.lines.length>0,'Location full path has a readable actual Range: '+field.label);assert.ok(field.lines.every(line=>line.left>=field.left-1&&line.right<=field.right+1),'Location full path stays readable inside its field: '+field.label);}
  await frame(scene,prefix+(pending?'pending-info':'info-address'));
  if(!pending){await evaluate(`${expression}.querySelector('[data-mailbox-location="target"] h4:nth-of-type(2)').scrollIntoView({block:'start'})`);await painted();await frame(scene,prefix+'info-resource-paths');}
  await evaluate(`${expression}.querySelector('[data-mailbox-location="execution"]').scrollIntoView({block:'end'})`);await painted();await frame(scene,prefix+(pending?'pending-execution':'info-execution'));
  // Read the lower existing disclosure; return to the independent actions in the same card.
  await evaluate(`${expression}.querySelector('.composer-mailbox__content').scrollTop=0`);await painted();await click(`${expression}.querySelector('[aria-label="Message details"]')`);
  return {facts,readable};
}
async function projectionScene(scene) {
  const before=await geometry(),refs=await evaluate('mailboxLocationContext.projections()');assert.equal(refs.length,2);
  const contexts=[];
  for(let i=0;i<refs.length;i++){
    const host=`document.getElementById(${JSON.stringify(refs[i].hostId)})`,p=`${host}.querySelector('.composer-mailbox')`;
    await waitFor(`Boolean(${host}.querySelector('.composer__mailbox'))`);await click(`${host}.querySelector('.composer__mailbox')`);await waitFor(`${p}.matches(':popover-open')`);
    await click(`${p}.querySelector('[id$="-inbox-tab"]')`);await click(`${p}.querySelector('[data-record-key="timeline:same"].composer-mailbox__row')`);
    assert.ok(await evaluate(`${p}.querySelector('[data-mailbox-location="summary"]').textContent.includes('Original target Tab')`));
    const origin=JSON.stringify({...refs[i],workspaceId:refs[i].displayWorkspaceId}),details=await disclosure(scene,false,p,origin,'projection-'+(i===0?'a-':'b-'));assert.equal(details.facts.fields['显示 Workspace'],'Independent display context-presentation-'+(i===0?'a':'b'));contexts.push(details);
    if(i===0){await click(`${p}.querySelector('[aria-label="Close mailbox"]')`);await waitFor(`!${p}.matches(':popover-open')`);}
    else {
      await click(`${p}.querySelector('[aria-label="Copy message"]')`);assert.equal(await evaluate('mailboxLocationContext.copies.at(-1)'),await evaluate('mailboxNavigation.body'));
      await click(`${p}.querySelector('.log-turn__actions .composer-mailbox__reveal')`);
      await waitFor(`Boolean(${host}.querySelector('[data-message-located]'))`);
      const position=await evaluate(`(()=>{const host=${host},node=host.querySelector('[data-message-located]'),feed=host.querySelector('.activity-feed'),r=node.querySelector('.log-turn__head').getBoundingClientRect(),f=feed.getBoundingClientRect();return{active:document.activeElement===node,top:r.top,bottom:r.bottom,feedTop:f.top,feedBottom:f.bottom,sourceKey:node.dataset.messageSourceKey,other:Boolean(document.getElementById(${JSON.stringify(refs[0].hostId)}).querySelector('[data-message-located]')),popover:${p}.matches(':popover-open')}})()`);
      assert.equal(position.active,true);assert.equal(position.other,false);assert.equal(position.popover,false);assert.equal(position.sourceKey,await evaluate('mailboxNavigation.key("captured")'));assert.ok(position.top>=position.feedTop-1&&position.bottom<=position.feedBottom+1);await frame(scene,'projection-b-located');contexts.push(position);
    }
  }
  const after=await geometry();assert.deepEqual(after.terminal,before.terminal,'Projection detail retains original underlying xterm');assert.deepEqual(after.neighbor,before.neighbor);assert.equal(after.draft,before.draft);assert.equal(after.facts.dispatches.length,0);assert.deepEqual(after.facts.writes,before.facts.writes);
  await evaluate('mailboxLocationContext.closeProjections()');await painted();return{refs,contexts,before,after};
}
async function scene(scene) {
  result.stage=scene;
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:scene.width*2+1,height:750,deviceScaleFactor:1,mobile:false});
  await evaluate(`mailboxNavigation.seed(${JSON.stringify(scene.appearance)},${JSON.stringify(scene.draft)})`);
  await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))&&!${surface}.querySelector('.terminal-view__xterm--hydrating')&&mailboxNavigation.terminal().cursorLine.includes('half typed prompt')`);
  for(let i=0;i<['collapsed','current','expanded'].indexOf(scene.mode);i++)await click(`${surface}.querySelector('.composer-tool--mode')`);
  await click(`${surface}.querySelector('.terminal-view__xterm')`);const originalBaseline=await settled();assert.ok(originalBaseline.terminal.rows>0&&originalBaseline.neighbor.rows>0);await frame(scene,'original');
  await click(`${surface}.querySelector('.composer-tool--view-toggle')`);await waitFor(`Boolean(${surface}.querySelector('.activity-feed'))`);
  const activityBaseline=await settled();await terminalAgain();await waitFor('mailboxNavigation.facts().observers===0');
  const baseline=await settled(),resumeResizes=baseline.facts.resizes.slice(originalBaseline.facts.resizes.length);assert.ok(resumeResizes.length>0);
  await open('outbox');const queue=`${panel}.querySelector('[data-record-key="queue:private-pending"].composer-mailbox__row')`;await waitFor(`Boolean(${queue})`);await click(queue);await readableIdentity('pending');const pending=await disclosure(scene,true);assert.equal((await geometry()).facts.dispatches.length,0);
  await click(`${panel}.querySelector('.composer-mailbox__back button')`);await click(`${panel}.querySelector('[id$="-inbox-tab"]')`);const capturedAction=await showRecord('captured',true);await frame(scene,'inbox-record');const info=await disclosure(scene,false);
  await click(`${panel}.querySelector('[aria-label="Copy message"]')`);assert.equal(await evaluate('mailboxLocationContext.copies.at(-1)'),await evaluate('mailboxNavigation.body'));
  await click(capturedAction);const captured=await located('captured'),afterCaptured=await geometry();retained(baseline,afterCaptured,activityBaseline);assert.equal(afterCaptured.originalHidden,true);await frame(scene,'captured-located');
  await terminalAgain();await waitFor('mailboxNavigation.facts().observers===0');const pause=await settled();retained(baseline,pause,baseline,resumeResizes);
  await open('outbox');const nativeAction=await showRecord('native',true);const nativeInfo=await disclosure(scene,false,panel,'mailboxLocationContext.origin','native-');
  if(scene.width===640)await click(nativeAction);else{await evaluate(`${nativeAction}.focus()`);await key(scene.appearance==='light'?'Enter':' ',scene.appearance==='light'?'Enter':'Space',scene.appearance==='light'?13:32,scene.appearance==='light'?'\r':' ');}
  const native=await located('native'),afterNative=await geometry();retained(pause,afterNative,activityBaseline);assert.notEqual(captured.key,native.key);await frame(scene,'native-located');
  await terminalAgain();await waitFor('mailboxNavigation.facts().observers===0');await click(`${surface}.querySelector('.terminal-view__xterm')`);const writes=await evaluate('mailboxNavigation.facts().writes.length');await key('q','KeyQ',81,'q');await waitFor(`mailboxNavigation.facts().writes.length===${writes+1}`);
  const trusted=await geometry();assert.equal(trusted.facts.writes.at(-1).data,'q');assert.equal(trusted.terminal.id,baseline.terminal.id);assert.equal(trusted.terminal.rows,baseline.terminal.rows);assert.equal(trusted.terminal.cursorX,baseline.terminal.cursorX+1);assert.ok(trusted.facts.inputs.some(input=>input.trusted&&input.terminal&&input.key==='q'));assert.equal(trusted.draft,baseline.draft);assert.deepEqual(trusted.neighbor,baseline.neighbor);
  const projections=await projectionScene(scene);result.scenes.push({scene,originalBaseline,baseline,activityBaseline,resumeResizes,pending,info,nativeInfo,captured,afterCaptured,pause,native,afterNative,trusted,projections});
}
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({width:1281,height:750,show:false,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',(_event,_level,message)=>result.console.push(message));await win.loadFile(html);win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await waitFor('Boolean(window.mailboxLocationContext)');
    for(const s of[{width:640,appearance:'dark',mode:'collapsed',draft:'Original unsent draft'},{width:320,appearance:'light',mode:'current',draft:'Keep the original long draft near its next natural line wrap boundary.'},{width:320,appearance:'dark',mode:'expanded',draft:'Original long draft\nSecond retained line\nThird unsent line'}])await scene(s);
    assert.equal(result.scenes.length,3);assert.ok(result.scenes.every(item=>item.captured.count===1&&item.native.count===1));result.passed=true;
  }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack};result.failureFacts=await geometry().catch(()=>null);result.failureDom=await evaluate('document.body.innerHTML').catch(()=>null);}
  finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1);}
});
