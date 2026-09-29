const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const [html, profile, evidence, phase] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
let win
const report = { schema: 'agentmux.launcher-renderer-scenes.v1', passed: false, phase, pid: process.pid, profile, frames: [], scenarios: [], userRunTouched: false }
const evaluate = source => win.webContents.executeJavaScript(source)
const region = 'document.querySelector(\'[data-workbench-region-id="launchpad-input"]\')'
const element = selector => `${region}.querySelector(${JSON.stringify(selector)})`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(expression) { const end = Date.now()+11000; while(Date.now()<end) { if(await evaluate(expression)) return; await delay(40) } assert.fail('Actual Renderer fact absent: '+expression) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await delay(90) }
async function viewport(width,height) { await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false}); await paint() }
async function click(expression) {
  await evaluate(`${expression}.scrollIntoView({block:'nearest'})`); await paint()
  const point=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Actual control absent');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});await paint()
}
async function escape() { for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await paint() }
async function type(expression,text) { await click(expression);await win.webContents.debugger.sendCommand('Input.insertText',{text});await paint() }
async function frame(name) {
  await evaluate(`Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`);await paint()
  const file=name+'.png';await fs.writeFile(path.join(evidence,file),(await win.webContents.capturePage()).toPNG());report.frames.push({name,file,geometry:name.startsWith('settings')?null:await evaluate('launchpad.geometry()')})
}
async function assertGeometry() {
  const facts=await evaluate('launchpad.geometry()');assert.ok(facts.controls.length>8,'The actual Region has populated interactive controls')
  assert.ok(facts.region.width>260);assert.equal(facts.clientWidth,facts.scrollWidth,'Launcher has no horizontal overflow in the real Region')
  for(const control of facts.controls.filter(c=>c.box.width>0)) {
    assert.ok(control.box.x>=facts.region.x-1&&control.box.right<=facts.region.right+1,'Every visible control fits its own Region: '+control.label)
  }
  return facts
}
async function chooseLongOptions(){
 await click(element('[aria-label="Launch options"]'));await wait('getComputedStyle(document.querySelector(".launch-refine__panel")).visibility==="visible"')
 await evaluate(`for(const select of [...document.querySelectorAll('.launch-refine__panel select')].slice(0,2)){const choices=[...select.options].filter(o=>o.value).sort((a,b)=>b.text.length-a.text.length);select.value=choices[0].value;select.dispatchEvent(new Event('change',{bubbles:true}))}`);await escape()
 await wait(`Boolean(${element('.launch-refine__summary')})`);assert.equal(await evaluate(`${element('.launch-refine__summary')}.children.length`),2)
}
async function capture() {
  await viewport(1180,850);await wait(`Boolean(${element('.launch-terminal__body .xterm')})`);await wait('launchpad.terminalFacts()?.lines.some(line=>line.includes("$"))===true');await wait(`!${element('.terminal-view__xterm--hydrating')}`);await assertGeometry()
  const before=await evaluate('launchpad.facts()');assert.ok(before.warmRun);assert.equal(before.warmRun,before.originalWarmRun)
  await frame('wide-dark-default');await evaluate('launchpad.settings()');await wait('Boolean(document.querySelector(".settings-page"))');await frame('settings-dark-reference');await evaluate('launchpad.scene()');await paint()
  await click(element('[aria-label="Launch options"]'));await wait('Boolean(document.querySelector(".launch-refine__panel"))');await wait('getComputedStyle(document.querySelector(".launch-refine__panel")).visibility==="visible"')
  assert.equal(await evaluate('Boolean(document.querySelector("[data-overlay-host] .launch-refine__panel"))'),true,'Actual Options belongs to the window overlay host')
  await frame('options-dark');await evaluate(`for(const select of [...document.querySelectorAll('.launch-refine__panel select')].slice(0,2)){const choices=[...select.options].filter(o=>o.value).sort((a,b)=>b.text.length-a.text.length);select.value=choices[0].value;select.dispatchEvent(new Event('change',{bubbles:true}))}`);await escape();await wait('!document.querySelector(".launch-refine__panel")')
  await click(element('[aria-label="Expand Note"]'));await evaluate('launchpad.editNote('+JSON.stringify('## Launch review\nKeep the complete note across layout changes and process restart.')+')');await paint()
  await type(element('[aria-label="Browser address or search"]'),'local agent runtime')
  await frame('wide-dark-note')
  await click(element('[aria-label="Collapse Terminal"]'));await wait(`!${element('.launch-terminal__body')}`)
  const collapsed=await evaluate('launchpad.facts()');assert.equal(collapsed.warmRun,before.warmRun);assert.equal(collapsed.calls.stops.length,0)
  await click(element('[aria-label="Expand Terminal"]'));await wait(`Boolean(${element('.launch-terminal__body .xterm')})`)
  assert.equal((await evaluate('launchpad.facts()')).warmRun,before.warmRun,'The original healthy warm Run is retained')
  await viewport(901,850);await evaluate('launchpad.scene({split:true,long:true})');await paint();await chooseLongOptions();await assertGeometry();await frame('split-long-dark')
  const split=await evaluate('launchpad.facts()');assert.equal(Object.keys(split.tab.regions).length,2);assert.notEqual(split.warmRun,split.neighborRun)
  await evaluate('launchpad.scene({split:true,long:true,theme:"light"})');await paint();await chooseLongOptions();await assertGeometry();await frame('split-long-light')
  await viewport(1180,850);await evaluate('launchpad.scene({split:true,long:true,theme:"dark",ratio:0.272})');await paint();await chooseLongOptions();const small=await assertGeometry();assert.ok(small.region.width<=340)
  await click(element('[aria-label="Close Browser"]'));await click(element('[aria-label="Restore Browser"]'));await click(element('.launcher-resume-trigger'));await wait('Boolean(document.querySelector(".launcher-resume"))');await escape()
  await evaluate(`${element('.primary-button')}.focus()`);await frame('small-320-region-selected-options');report.scenarios.push({name:'Actual small Region controls',passed:true,geometry:small})
  await viewport(720,420);await evaluate('launchpad.scene({split:false,theme:"dark"})');await paint();await assertGeometry()
  const cta=element('.primary-button');await evaluate(`${cta}.scrollIntoView({block:'nearest'})`);await paint()
  const reachable=await evaluate(`(()=>{const e=${cta},r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,disabled:e.disabled}})()`)
  assert.ok(reachable.top>=0&&reachable.bottom<=420);assert.equal(reachable.disabled,false);await frame('short-height-launch')
  await click(element('.launcher-resume-trigger'));await wait('Boolean(document.querySelector(".launcher-resume"))')
  assert.ok(await evaluate('document.querySelector(".launcher-resume").innerText.includes("Runtime architecture")'))
  await frame('resume-project-short');await viewport(580,660)
  await click(`[...document.querySelectorAll('.launcher-resume__scope button')].find(e=>e.textContent.includes('All projects'))`)
  assert.equal(await evaluate('document.querySelectorAll(".launcher-resume__row").length'),2);await frame('resume-global-narrow');await escape()
  await viewport(1180,850);await evaluate('launchpad.scene({split:true,theme:"dark"})');await paint()
  const prepare=`[...${region}.querySelectorAll('button')].find(e=>e.textContent.includes('Prepare in'))`
  await click(prepare);await wait('launchpad.facts().floating?.open===true');await wait('Boolean(document.querySelector("[data-pmo-teams-topic-floating] .launch-surface"))')
  const prepared=await evaluate('launchpad.facts()');assert.equal(prepared.activeWorkspaceId,await evaluate('launchpad.workspaceId'));assert.ok(Object.values(prepared.agentDrafts).some(text=>text.includes('Project: AgentMux')&&text.includes(before.sourceDraft)))
  assert.equal(prepared.sourceDraft,before.sourceDraft);assert.equal(prepared.calls.submissions.length,0);assert.equal(prepared.calls.launches.length,0)
  await frame('mote-explicit-preparation')
  await click('document.querySelector('+JSON.stringify('[data-pmo-teams-topic-floating] [aria-label="Close Mote"]')+')');await escape()
  await click(element('[aria-label="Go to Browser address or search"]'));await wait('launchpad.facts().calls.browsers.length>0');assert.equal((await evaluate('launchpad.facts()')).calls.browsers.at(-1)[1],'local agent runtime')
  await evaluate('launchpad.scene({split:true})');await paint();const completeNote=await evaluate('launchpad.facts().drafts.note')
  await click(`[...${region}.querySelectorAll('button')].find(e=>e.textContent.includes('Save & open note'))`);await wait('launchpad.facts().drafts.note===""');const written=await evaluate('launchpad.facts().calls.files.at(-1)');assert.equal(written[1].content,completeNote);assert.equal(written[1].expectedRevision,null)
  await evaluate('launchpad.scene({split:true})');await paint();await evaluate('launchpad.editNote('+JSON.stringify(completeNote)+')');await paint()
  report.scenarios.push({name:'Actual Browser navigation and complete Note file save',passed:true,browserQuery:'local agent runtime',written})
  // Write the actual section and input controls, then a separate Electron process re-reads the same private profile.
  await evaluate('launchpad.scene({split:true})');await paint()
  await click(element('[aria-label="Close Terminal"]'));await wait(`Boolean(${element('[aria-label="Restore Terminal"]')})`)
  await evaluate('launchpad.flush()');const facts=await evaluate('launchpad.facts()');assert.deepEqual(JSON.parse(facts.workbenchStorageBytes).state.restoredWorkbench.tabs['launchpad-tab'],facts.tab);assert.equal(facts.sections.terminal,'hidden');assert.equal(facts.drafts.browser,'local agent runtime');assert.ok(facts.drafts.note.includes('complete note'))
  assert.equal(facts.calls.stops.length,0);report.expectedDurable={sections:facts.sections,drafts:facts.drafts,tab:facts.tab,layout:facts.layout,sourceDraft:facts.sourceDraft,activeWorkspaceId:facts.activeWorkspaceId};report.scenarios.push({name:'Actual utility controls preserve healthy shell and original drafts',passed:true,before,after:facts,collapsed,prepared,reachable})
  await fs.writeFile(path.join(evidence,'expected-durable.json'),JSON.stringify(report.expectedDurable,null,2));await fs.writeFile(path.join(profile,'boot.json'),JSON.stringify(await evaluate('launchpad.bootFacts()')))
}
async function restart() {
  const expected=JSON.parse(await fs.readFile(path.join(evidence,'expected-durable.json'),'utf8'))
  const facts=await evaluate('launchpad.facts()');const beforeSetup=await evaluate('launchpad.readBeforeFixtureSetup');assert.ok(beforeSetup);assert.deepEqual(beforeSetup.tabs[expected.tab.id],expected.tab,'Original Tab/Region split is read before any fixture setup');assert.deepEqual(beforeSetup.layouts[expected.activeWorkspaceId],expected.layout,'Original group and focus are read before any fixture setup');assert.equal(beforeSetup.sourceDraft,expected.sourceDraft);assert.equal(beforeSetup.activeWorkspaceId,expected.activeWorkspaceId);assert.deepEqual(facts.tab,expected.tab);assert.deepEqual(facts.layout,expected.layout);assert.deepEqual(facts.sections,expected.sections,'A new Electron process restores exact section preferences');assert.deepEqual(facts.drafts,expected.drafts,'A new Electron process restores complete Browser/Note drafts')
  assert.equal(facts.persistenceIssue,null);assert.ok(await evaluate(`Boolean(${element('[aria-label="Restore Terminal"]')})`));assert.equal(await evaluate(`${element('[aria-label="Browser address or search"]')}.value`),expected.drafts.browser)
  await frame('renderer-profile-restart');report.durable={passed:true,expected,actual:{sections:facts.sections,drafts:facts.drafts,tab:facts.tab,layout:facts.layout,sourceDraft:facts.sourceDraft,activeWorkspaceId:facts.activeWorkspaceId},beforeFixtureSetup:beforeSetup,boundary:'Two separate Electron processes, same private Renderer profile. Section and utility-draft durability only. Native Core/ctxmux Run continuity is verified separately.'}
}
app.whenReady().then(async()=>{try{
  await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{backgroundThrottling:false,sandbox:false,preload:path.join(__dirname,'preload.cjs'),additionalArguments:phase==='restart'?['--launchpad-boot='+path.join(profile,'boot.json')]:[]}})
  win.webContents.on('console-message',(_e,_level,message)=>console.log('RENDERER '+message));await win.loadFile(html,{query:{phase}});win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await wait('Boolean(window.launchpad)')
  if(phase==='restart')await restart();else await capture();report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
finally{await fs.writeFile(path.join(evidence,phase+'-render.json'),JSON.stringify(report,null,2));win?.webContents.session.flushStorageData();win?.destroy();report.passed?app.quit():app.exit(1)}})
