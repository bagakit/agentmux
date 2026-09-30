const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const [html, privateRoot, evidence, scope, baselineFile] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { correctionsOnly: scope==='corrections-only', schema: 'agentmux.goals-maturity-render.v1', mode: scope==='goal-main-mote-only' ? 'goal-main-mote' : scope==='direct-goal-only' ? 'direct-goal' : scope?.startsWith('density') ? 'density' : 'maturity', beforeOnly: ['before-only','density-before-only'].includes(scope), passed: false, frames: [], observations: [], userRunTouched: false, consoleErrors: [] }
let win
async function phase(name) { if(['direct-goal-only','goal-main-mote-only'].includes(scope)) await fs.writeFile(path.join(evidence,'phase.json'), JSON.stringify({phase:name,at:Date.now()})) }
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(expression) { for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(25)}throw new Error('Timed out: '+expression) }
async function paint(){ await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(70) }
async function size(width){await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:780,deviceScaleFactor:1,mobile:false});await paint()}
async function capture(name,width){await phase('capture:'+name);if(scope==='corrections-only' && ['1280-dark-mixed-list','1280-dark-unoutlined-detail','620-light-initial','620-light-zero-match-focus','1280-dark-compact-new-save-failure'].includes(name))return;await paint();let appearance;if(['direct-goal-only','goal-main-mote-only'].includes(scope)){appearance=await evaluate('({config:goalsVisual.directFacts().appearance,dom:document.documentElement.dataset.appearance,colorScheme:document.documentElement.style.colorScheme})');const expected=name.split('-')[1];assert.deepEqual(appearance,{config:expected,dom:expected,colorScheme:expected},'Frame theme is the actual Config and painted DOM theme')}const bytes=(await win.webContents.capturePage()).toPNG();const file=name+'.png';await fs.writeFile(path.join(evidence,file),bytes);result.frames.push({name,width,file,...(appearance?{appearance}:{}),sha256:crypto.createHash('sha256').update(bytes).digest('hex')})}
const button = label => `([...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)} || node.getAttribute('aria-label')===${JSON.stringify(label)}))`
async function click(expression){const point=await evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Missing actual target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});await paint()}
async function insert(selector,text){await click(`document.querySelector(${JSON.stringify(selector)})`);await win.webContents.debugger.sendCommand('Input.insertText',{text});await paint()}
async function keyboardFocus(selector){for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await paint()}
async function visibleDetail(label){const bounds=await evaluate(`(()=>{const detail=document.querySelector('.goals-detail'),title=document.querySelector('.goals-title'),d=detail.getBoundingClientRect(),t=title.getBoundingClientRect();return {width:d.width,height:d.height,left:d.left,right:d.right,top:d.top,bottom:d.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,titleHeight:t.height,titleScrollHeight:title.scrollHeight,titleRows:title.rows,titleTop:t.top,titleBottom:t.bottom,nativeFieldSizing:CSS.supports('field-sizing','content')}})()`);assert.ok(bounds.width>200 && bounds.height>200 && bounds.left>=0 && bounds.right<=bounds.viewportWidth+1 && bounds.top>=0 && bounds.top<bounds.viewportHeight-200,'Selected Goal detail occupies a real readable viewport');assert.ok(bounds.titleHeight<150 && bounds.titleTop<bounds.viewportHeight-100,'Goal title grows with actual current width without hiding the document');assert.equal(bounds.nativeFieldSizing,true);result.observations.push({scene:label,visibleDetail:bounds})}
async function scenario(mode,width,theme){await evaluate(`goalsVisual.seed(${JSON.stringify(mode)});goalsVisual.appearance(${JSON.stringify(theme)})`);await size(width);await paint();const facts=await evaluate('goalsVisual.facts()');result.observations.push({scene:mode,width,theme,facts});return facts}
async function densityStart(scene, expectedRequests, baseline) {
 const geometry=await evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}},common=document.querySelector('.goals-common'),collection=document.querySelector('.goals-collection'),rows=[...document.querySelectorAll('[data-demand-id]')],actions=[...document.querySelectorAll('[data-common-action]')],reading=document.querySelector('.goals-common__reading'),art=common.querySelector('img');return {surface:box(document.querySelector('.goals-surface')),common:box(common),collection:box(collection),toolbar:box(document.querySelector('.goals-toolbar')),rows:rows.map(e=>({id:e.dataset.demandId,...box(e),title:e.querySelector('strong').textContent,next:e.querySelector('.goals-row__next').textContent,facts:e.querySelector('.goals-row__facts').textContent})),actions:actions.map(e=>({...box(e),body:e.querySelector('.goals-entry__request').textContent,facts:e.querySelector('.goals-common__facts').textContent})),reading:{...box(reading),clientHeight:reading.clientHeight,scrollHeight:reading.scrollHeight},brand:art?{...box(art),loaded:art.naturalWidth>0}:null,collapsed:document.querySelector('[aria-label="收起常用操作"]')?.getAttribute('aria-expanded')}})()`)
 assert.equal(geometry.collapsed,'true','Density preserves expanded directory preference')
 assert.ok(geometry.actions.length>0,'Actual mounted common actions are nonempty')
 assert.deepEqual(geometry.actions.map(item=>item.body),expectedRequests,'Full original one-click requests remain visible in the actual controls')
 assert.ok(geometry.actions.every(item=>item.facts.includes('Agent')),'Actual action target facts remain nonempty')
 assert.ok(geometry.brand?.loaded && geometry.brand.width>0 && geometry.brand.height>0,'One real brand image remains rendered')
 if(!result.beforeOnly){
  assert.ok(geometry.common.height<=200,'Top common actions fit the 200px functional budget')
  const before=baseline.render.observations.find(item=>item.scene===scene&&item.geometry)?.geometry
  assert.ok(before?.common.height>0,'Same-fixture measured baseline is nonempty')
  assert.ok(geometry.common.height<=before.common.height*.7,'Top common actions remove at least 30 percent of measured prior occupancy')
  assert.ok(geometry.collection.width>=geometry.surface.width*.88,'Goal scanning uses at least 88 percent of available width')
  assert.ok(geometry.actions.every(item=>Math.abs(item.top-geometry.actions[0].top)<1),'Wide full original requests are arranged in parallel')
  assert.ok(geometry.reading.scrollHeight<=geometry.reading.clientHeight+1,'Normal first actions need no nested decorative scrolling')
  if(scene==='mixed'){
   assert.equal(geometry.rows.length,6,'Exactly six real Goal rows are mounted')
   assert.ok(geometry.rows.every(item=>item.title&&item.next),'Real Goal title and next-step facts are nonempty')
   assert.ok(geometry.rows.reduce((sum,item)=>sum+item.height,0)/geometry.rows.length<=64,'Wide simple Goal rows average at most 64px')
   assert.ok(geometry.rows.every(item=>item.top>=geometry.collection.top && item.bottom<=geometry.collection.bottom),'All six real Goals are readable in the first scan viewport')
  }
 }
 result.observations.push({scene,geometry})
}
async function densityDetail(scene) {
 await visibleDetail(scene)
 const geometry=await evaluate(`(()=>{const rail=document.querySelector('.goals-index').getBoundingClientRect(),detail=document.querySelector('.goals-detail').getBoundingClientRect(),documentStyle=getComputedStyle(document.querySelector('.goals-document')),doc=document.querySelector('.goals-document').getBoundingClientRect(),toolbar=document.querySelector('.goals-detail__toolbar').getBoundingClientRect();return {railWidth:rail.width,bodyOffset:doc.left+parseFloat(documentStyle.paddingLeft)-detail.left,toolbarOffset:toolbar.left+parseFloat(getComputedStyle(document.querySelector('.goals-detail__toolbar')).paddingLeft)-detail.left,documentWidth:doc.width,detailWidth:detail.width,criteria:document.querySelectorAll('[data-goal-success-criterion]').length}})()`)
 assert.ok(geometry.criteria>0,'Actual detail success criteria are nonempty')
 if(!result.beforeOnly){assert.ok(geometry.railWidth>=260 && geometry.railWidth<=320,'Detail navigation stays within its 260–320px budget');assert.ok(geometry.bodyOffset>=16 && geometry.bodyOffset<=24,'Goal document starts 16–24px from the detail boundary');assert.equal(geometry.bodyOffset,geometry.toolbarOffset,'Goal document and toolbar share their left reading edge')}
 result.observations.push({scene,detailGeometry:geometry})
}
async function densityScenes(){
 const baseline=result.beforeOnly?null:JSON.parse(await fs.readFile(baselineFile,'utf8'))
 if(scope==='density-detail-only'){await scenario('proposal',1280,'dark');await densityDetail('wide-detail');await capture('1280-dark-density-detail',1280);return}
 const defaults=['我还不知道能做什么，可以了解我并给我建议吗？','我有一些点子，我们开始尝试一个项目']
 await scenario('empty',1280,'light');await densityStart('empty',defaults,baseline);await capture('1280-light-density-initial',1280)
 if(scope==='density-start-only')return
 await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280)
 const facts=await evaluate('goalsVisual.facts()');assert.equal(facts.ids.length,6);assert.ok(facts.criteria>0&&facts.reports>0&&facts.checks>0,'Mixed target/result collections are nonempty');await densityStart('mixed',defaults,baseline);await capture('1280-dark-density-mixed',1280)
 await evaluate('goalsVisual.seedCommon("project")');await size(1280)
 await densityStart('project',[...defaults,'根据最近的项目情况，建议我下一步应该做什么'],baseline);await capture('1280-dark-density-project',1280)
 await scenario('proposal',1280,'dark');await densityDetail('wide-detail');await capture('1280-dark-density-detail',1280)
 if(result.beforeOnly)return
 await scenario('empty',620,'light');await capture('620-light-density-initial',620)
 await evaluate('goalsVisual.seedCommon("long-project");goalsVisual.appearance("dark")');await size(620);await click(button("全部操作（7）"))
 const long=await evaluate(`(()=>{const e=document.querySelector('[data-common-action="prompt:common-review"]'),body=e.querySelector('.goals-entry__request'),r=body.getBoundingClientRect();return {body:body.textContent,width:r.width,containerWidth:document.querySelector('.goals-common').getBoundingClientRect().width,count:document.querySelectorAll('[data-common-action]').length,facts:[...document.querySelectorAll('.goals-common__facts')].map(e=>e.textContent)}})()`)
 assert.equal(long.count,7);assert.ok(long.body.startsWith('1.')&&long.body.includes('9.'),'Actual long original request includes its complete last paragraph');assert.ok(long.width<=long.containerWidth);assert.ok(long.facts.some(text=>text.includes('workspace-continuity-and-reliable-delivery')),'Actual long Project target remains readable')
 await keyboardFocus('[data-common-action="builtin:next"]');await paint();result.observations.push({scene:'long-request',long});await capture('620-dark-density-long-request-tail',620)
 await scenario('results',1280,'dark');await densityDetail('results');assert.equal(await evaluate('document.querySelectorAll("[data-goal-criterion-id]").length'),2);assert.equal(await evaluate('document.querySelectorAll(".goals-evidence__open").length'),2);await capture('1280-dark-density-results',1280)
 await scenario('unknown',620,'light');await visibleDetail('density-unknown');assert.equal(await evaluate('Boolean(document.querySelector("[data-goal-accept],[data-goal-accept-gaps]"))'),false);await evaluate('document.querySelector(".goals-grounding").scrollIntoView({block:"start"})');await capture('620-light-density-unknown',620)
 await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280);await click(button('管理'));await click(button('新增操作'));await insert('[data-common-editor] textarea','先读取真实记录，再建议一次可验证的小尝试。');await evaluate('window.originalDensityEditor=document.querySelector("[data-common-editor] textarea");goalsVisual.holdConfigSave()');await click(button('保存操作'));await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")');await evaluate('goalsVisual.finishConfigSave(true)');await waitFor('Boolean(document.querySelector(".goals-common__context-feedback")?.textContent.includes("保存未完成"))');await size(620);await visibleDetail('density-compact-error');await capture('620-dark-density-compact-error',620);await click(button('回到常用操作'))
 assert.equal(await evaluate('window.originalDensityEditor===document.querySelector("[data-common-editor] textarea")'),true,'Density retains the original mounted editor');assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'),'先读取真实记录，再建议一次可验证的小尝试。');assert.equal(await evaluate('document.activeElement.textContent.trim()'),'保存操作');const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),p=e.closest('.goals-common__manager').getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,scrollTop:p.top,scrollBottom:p.bottom,scrollRight:p.right,scrollbar:parseFloat(getComputedStyle(e.closest('.goals-common__manager'),'::-webkit-scrollbar').width),outline:getComputedStyle(e).outlineWidth}})()`);assert.ok(focus.top>=focus.scrollTop&&focus.bottom<=focus.scrollBottom&&focus.right<=focus.scrollRight-focus.scrollbar,'Original returned Save stays fully visible away from the scrollbar');assert.equal(focus.outline,'2px');result.observations.push({scene:'manager-return',focus});await capture('620-dark-density-manager-return',620);assert.equal(result.frames.length,10)
}
async function visibleDirectPmo(tabId) {
 await phase('waiting-for-painted-dedicated-pmo');await waitFor(`(()=>{const e=document.querySelector('[data-pmo-teams-topic-floating]');if(!e)return false;const r=e.getBoundingClientRect();return e.matches(':popover-open') && getComputedStyle(e).visibility==='visible' && e.dataset.moteTargetTab===${JSON.stringify(tabId)} && r.width>200 && r.height>200})()`)
 const panel=await evaluate(`(()=>{const e=document.querySelector('[data-pmo-teams-topic-floating]'),r=e.getBoundingClientRect();return {tabId:e.dataset.moteTargetTab,regionId:e.dataset.moteTargetRegion,popover:e.matches(':popover-open'),visibility:getComputedStyle(e).visibility,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`)
 assert.ok(panel.left>=0 && panel.top>=0 && panel.right<=panel.viewportWidth+1 && panel.bottom<=panel.viewportHeight+1,'Actual dedicated PMO is painted within this viewport')
 result.observations.push({scene:'painted-dedicated-pmo',panel});await paint()
}
async function visibleDirectLauncherFooter() {
 await phase('scrolling-original-launcher-to-footer')
 const expand = await evaluate(`Boolean(document.querySelector('[data-pmo-teams-topic-floating] [aria-label="Expand Agents"]'))`)
 if (expand) await click(`document.querySelector('[data-pmo-teams-topic-floating] [aria-label="Expand Agents"]')`)
 assert.ok(await evaluate(`Boolean(document.querySelector('[data-pmo-teams-topic-floating] .launch-surface__footer'))`), 'Original expanded Agent section has a real recovery footer')
 await evaluate(`document.querySelector('[data-pmo-teams-topic-floating] .launch-surface__footer').scrollIntoView({block:'end'})`);await paint()
 const footer=await evaluate(`(()=>{const p=document.querySelector('[data-pmo-teams-topic-floating] .launch-surface'),r=p.getBoundingClientRect();return {overflow:getComputedStyle(p).overflowY,scrollTop:p.scrollTop,scrollHeight:p.scrollHeight,clientHeight:p.clientHeight,port:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},actions:[...p.querySelectorAll('.launch-surface__footer .launcher-primary-actions .launcher-resume-trigger,.launch-surface__footer .launcher-launch-button')].map(e=>{const b=e.getBoundingClientRect();return {text:e.textContent.trim(),left:b.left,top:b.top,right:b.right,bottom:b.bottom,height:b.height}})}})()`)
 assert.equal(footer.overflow,'auto');assert.deepEqual(footer.actions.map(e=>e.text),['Resume','Launch'])
 for(const action of footer.actions)assert.ok(action.height>20 && action.left>=footer.port.left && action.right<=footer.port.right && action.top>=footer.port.top && action.bottom<=footer.port.bottom,'Original launcher scrollport exposes the complete recovery controls')
 result.observations.push({scene:'original-launcher-footer-visible',footer})
}
async function directScenes() {
 await evaluate('goalsVisual.seedDirect();goalsVisual.appearance("light")');await size(1280)
 assert.equal(await evaluate('document.querySelectorAll("[data-demand-id]").length'),0)
 await capture('1280-light-direct-empty',1280)
 await click(button('Goal filters'));await evaluate(`(()=>{const e=document.querySelector('[aria-label="Filter project"]');e.value=e.options[1].value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await click(button('Goal filters'))
 await evaluate('goalsVisual.appearance("dark")');await click('document.querySelector("button[data-new-goal]")')
 await waitFor('goalsVisual.directFacts().request===null && Boolean(goalsVisual.directFacts().tabId)')
 const created=await evaluate('goalsVisual.directFacts()')
 assert.deepEqual(created.creates,[created.goal.id]);assert.equal(created.goal.description,'');assert.equal(created.goal.status,'backlog');assert.equal(created.goal.alignment,undefined);assert.equal(created.topicId,created.pmoTopic)
 assert.equal(created.launches.length,1);assert.ok(created.launches[0].prompt.includes(`existing Goal ${created.goal.id}`));assert.ok(created.launches[0].prompt.includes('existing undefined Goal draft'));assert.equal(created.floating.targetTabId,created.tabId)
 assert.equal(await evaluate('document.querySelector("[data-demand-id]").classList.contains("goals-row--undefined")'),true)
 result.observations.push({scene:'actual-new-goal',facts:created});await visibleDirectPmo(created.tabId)
 await waitFor('document.querySelectorAll("[data-pmo-teams-topic-floating] .conversation-native-thread__record").length===2')
 const native = await evaluate(`({ records: document.querySelectorAll('[data-pmo-teams-topic-floating] .conversation-native-thread__record').length,
   meaningfulAnswer: document.querySelector('[data-pmo-teams-topic-floating] .conversation-native-thread')?.textContent.includes('你希望通过这次尝试，解决什么问题？') ?? false,
   rulers: document.querySelectorAll('[data-pmo-teams-topic-floating] .activity-ruler').length })`)
 assert.deepEqual(native, { records: 2, meaningfulAnswer: true, rulers: 0 }, 'Actual public reader consumes both nonempty preview records without an empty observation ruler')
 result.observations.push({scene:'direct-preview-native-body',native,wireBoundary:'Exact captured Renderer request; Core guide/Notes and real CLI delivery excluded'})
 await capture('1280-dark-direct-goal-pmo',1280)
 await size(620);assert.equal((await evaluate('goalsVisual.directFacts()')).goal.id,created.goal.id);await visibleDirectPmo(created.tabId);await capture('620-dark-direct-goal-pmo',620)
 await click(button('Close Mote'));await evaluate('goalsVisual.appearance("light")');await visibleDetail('direct-returned-goal');await capture('620-light-direct-returned-goal',620)
 await evaluate('goalsVisual.seedDirect("save-unknown");goalsVisual.appearance("light")');await size(1280);await click('document.querySelector("button[data-new-goal]")')
 await waitFor('goalsVisual.directFacts().request?.phase==="save" && !goalsVisual.directFacts().request.pending')
 const unknown=await evaluate('goalsVisual.directFacts()');assert.equal(unknown.goal,undefined);assert.equal(unknown.tabId,undefined);assert.equal(unknown.creates.length,1);assert.equal(unknown.launches.length,0)
 assert.ok(await evaluate('document.querySelector(".goals-creation").textContent.includes("重新读取目标")'))
 result.observations.push({scene:'save-unknown',facts:unknown});await capture('1280-light-direct-save-unknown',1280);await size(620);await capture('620-light-direct-save-unknown',620)
 await evaluate('goalsVisual.restoreDirectService()');await click(button('重新读取目标'));await waitFor('goalsVisual.directFacts().request===null')
 const readback=await evaluate('goalsVisual.directFacts()');assert.equal(readback.goal.id,unknown.request.id);assert.deepEqual(readback.creates,[unknown.request.id]);assert.equal(readback.launches.length,1)
 await click(button('Close Mote'));await evaluate('goalsVisual.seedDirect("pmo");goalsVisual.appearance("dark")');await size(620);await click('document.querySelector("button[data-new-goal]")')
 await waitFor('goalsVisual.directFacts().request?.phase==="pmo" && !goalsVisual.directFacts().request.pending')
 const failed=await evaluate('goalsVisual.directFacts()');assert.equal(failed.surface.kind,'launcher');assert.ok(failed.draft.includes(`existing Goal ${failed.goal.id}`));assert.equal(failed.floating.targetTabId,failed.tabId)
 assert.equal(failed.tabName,'PMO · '+failed.goal.title)
 result.observations.push({scene:'pmo-failure',facts:failed});await visibleDirectPmo(failed.tabId);await visibleDirectLauncherFooter();await capture('620-dark-direct-pmo-unknown',620)
 await click(button('Close Mote'));await evaluate('goalsVisual.restoreDirectService()');await click(button('重试专属讨论'));await waitFor('goalsVisual.directFacts().request===null')
 assert.equal((await evaluate('goalsVisual.directFacts()')).tabId,failed.tabId);await click(button('Close Mote'))
 await evaluate('goalsVisual.proposeDirectGoal()');await evaluate('goalsVisual.appearance("light")');await size(1280)
 const proposal=await evaluate('goalsVisual.directFacts()');assert.equal(proposal.goal.id,failed.goal.id);assert.deepEqual(proposal.creates,[failed.goal.id]);assert.equal(proposal.goal.alignment.criteria.length,1);assert.equal(proposal.goal.alignment.confirmedAt,null)
 assert.equal(await evaluate('document.querySelector("[data-demand-id]").classList.contains("goals-row--undefined")'),false)
 result.observations.push({scene:'same-goal-proposal',facts:proposal});await capture('1280-light-direct-same-goal-proposal',1280)
 assert.equal(result.frames.length,8)
}
app.whenReady().then(async()=>{
 try{
  await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:1280,height:780,webPreferences:{sandbox:false,backgroundThrottling:false}})
  win.webContents.on('console-message',details=>{if(details.level==='error')result.consoleErrors.push({message:details.message,line:details.lineNumber,source:details.sourceId})})
  await phase('loading-compiled-renderer');await win.loadFile(html);await phase('loaded-compiled-renderer');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  await phase('waiting-for-original-mounted-goals');await waitFor('Boolean(window.goalsVisual) && document.querySelectorAll("[data-demand-id]").length===6');await phase('original-goals-mounted')
  const originalRuns=await evaluate('goalsVisual.facts().runs');assert.ok(originalRuns.length>0,'Original preview Runs exist')
  if(scope==='project-links-only'){
   await require('./project-links.cjs')({evaluate,size,click,capture,waitFor,result})
  }else if(scope==='goal-main-mote-only'){
   await require('./main-mote.cjs')({evaluate,size,click,capture,waitFor,result,visibleDirectPmo})
  }else if(scope==='direct-goal-only'){
   await directScenes()
  }else if(scope?.startsWith('density')){
   await densityScenes()
  }else if(scope==='before-only'){
   await scenario('confirmed',1280,'dark');await waitFor('Boolean(document.querySelector("[data-goal-summary]"))')
   const counts=await evaluate('({goals:document.querySelectorAll("[data-demand-id]").length,criteria:document.querySelectorAll("[data-goal-success-criterion]").length})')
   assert.ok(counts.goals>0 && counts.criteria>0,'Actual baseline Goal and criteria exist');result.observations.push({scene:'wide-detail-baseline',counts})
   await capture('1280-dark-before-detail',1280)
  }else if(scope==='width-only'){
   await scenario('results',1280,'dark');await evaluate('window.originalGoalTitle=document.querySelector(".goals-title")');await insert('[aria-label="Goal title"]',' · retained draft');const titleDraft=await evaluate('document.querySelector(".goals-title").value');await size(620);await visibleDetail('same-goal-narrow');await size(1280);await visibleDetail('same-goal-wide-return');assert.equal(await evaluate('window.originalGoalTitle===document.querySelector(".goals-title")'),true,'Width changes retain the same Goal title editor');assert.equal(await evaluate('document.querySelector(".goals-title").value'),titleDraft,'Width changes retain the same authored title draft');await capture('1280-dark-retained-title-width-return',1280)
   await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280)
   await click(button('管理'));await click(button('新增操作'));await insert('[data-common-editor] textarea','先读取真实记录，再建议一次可验证的小尝试。')
   await evaluate('goalsVisual.holdConfigSave()');await click(button('保存操作'))
   await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")')
   await evaluate('goalsVisual.finishConfigSave(true)')
   await waitFor('Boolean(document.querySelector(".goals-common__context-feedback")?.textContent.includes("保存未完成"))')
   assert.equal(await evaluate('document.querySelector(".goals-common__content").hidden'),true)
   await size(620);await visibleDetail('compact-narrow-new-save-error');await capture('620-dark-compact-new-save-failure',620);await click(button('回到常用操作'))
   assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'),'先读取真实记录，再建议一次可验证的小尝试。')
   assert.equal(await evaluate('document.activeElement.textContent.trim()'),'保存操作','Return restores the original now-enabled save control')
   const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),p=e.closest('.goals-common__manager').getBoundingClientRect();return {label:e.textContent.trim(),top:r.top,bottom:r.bottom,left:r.left,right:r.right,scrollLeft:p.left,scrollRight:p.right,scrollClientRight:p.left+e.closest('.goals-common__manager').clientWidth,scrollbarWidth:parseFloat(getComputedStyle(e.closest('.goals-common__manager'),'::-webkit-scrollbar').width),scrollTop:p.top,scrollBottom:p.bottom,viewport:innerHeight,outline:getComputedStyle(e).outlineWidth,outlineStyle:getComputedStyle(e).outlineStyle,outlineColor:getComputedStyle(e).outlineColor}})()`);assert.ok(focus.top>=focus.scrollTop && focus.bottom<=Math.min(focus.scrollBottom,focus.viewport),'Returned original focus control is visible inside its scrollport');assert.ok(focus.left>=focus.scrollLeft && focus.right<=focus.scrollRight-focus.scrollbarWidth,'Returned focus stays clear of the manager scrollbar');assert.equal(focus.outline,'2px','Returned original focus has a complete authored outline');assert.equal(focus.outlineStyle,'solid');result.observations.push({scene:'returned-common',focus});await capture('620-dark-returned-common-draft',620)
  }else if(scope==='return-only'){
   await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280)
   await click(button('管理'));await click(button('新增操作'));await insert('[data-common-editor] textarea','先读取真实记录，再建议一次可验证的小尝试。')
   await evaluate('goalsVisual.holdConfigSave()');await click(button('保存操作'))
   await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")')
   await evaluate('goalsVisual.finishConfigSave(true)')
   await waitFor('Boolean(document.querySelector(".goals-common__context-feedback")?.textContent.includes("保存未完成"))')
   assert.equal(await evaluate('document.querySelector(".goals-common__content").hidden'),true)
   await size(620);await visibleDetail('compact-narrow-new-save-error');await capture('620-dark-compact-new-save-failure',620);await click(button('回到常用操作'))
   assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'),'先读取真实记录，再建议一次可验证的小尝试。')
   assert.equal(await evaluate('document.activeElement.textContent.trim()'),'保存操作','Return restores the original now-enabled save control')
   const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),p=e.closest('.goals-common__manager').getBoundingClientRect();return {label:e.textContent.trim(),top:r.top,bottom:r.bottom,left:r.left,right:r.right,scrollLeft:p.left,scrollRight:p.right,scrollClientRight:p.left+e.closest('.goals-common__manager').clientWidth,scrollbarWidth:parseFloat(getComputedStyle(e.closest('.goals-common__manager'),'::-webkit-scrollbar').width),scrollTop:p.top,scrollBottom:p.bottom,viewport:innerHeight,outline:getComputedStyle(e).outlineWidth,outlineStyle:getComputedStyle(e).outlineStyle,outlineColor:getComputedStyle(e).outlineColor}})()`);assert.ok(focus.top>=focus.scrollTop && focus.bottom<=Math.min(focus.scrollBottom,focus.viewport),'Returned original focus control is visible inside its scrollport');assert.ok(focus.left>=focus.scrollLeft && focus.right<=focus.scrollRight-focus.scrollbarWidth,'Returned focus stays clear of the manager scrollbar');assert.equal(focus.outline,'2px','Returned original focus has a complete authored outline');assert.equal(focus.outlineStyle,'solid');result.observations.push({scene:'returned-common',focus});await capture('620-dark-returned-common-draft',620)
  }else if(scope==='narrow-layout-only'){
   await scenario('proposal',620,'light');await visibleDetail('narrow-layout');await capture('620-light-narrow-layout-legibility',620)
  }else if(scope==='legibility-only'){
   await scenario('results',1280,'dark')
   const type=await evaluate('({heading:parseFloat(getComputedStyle(document.querySelector(".goals-grounding h2")).fontSize),body:parseFloat(getComputedStyle(document.querySelector("[data-goal-result-summary]")).fontSize),checks:document.querySelectorAll("[data-goal-criterion-id]").length})')
   assert.ok(type.checks>0,'Actual result checks are nonempty');assert.ok(type.heading>type.body,'Reading responsibilities have stronger heading hierarchy than prose');result.observations.push({scene:'legibility',type});await capture('1280-dark-results-legibility',1280)
  }else{
   await scenario('empty',620,'light')
   assert.deepEqual(await evaluate('goalsVisual.facts().ids'),[])
   assert.deepEqual(await evaluate('[...document.querySelectorAll(".goals-entry__request")].map(node=>node.textContent)'),['我还不知道能做什么，可以了解我并给我建议吗？','我有一些点子，我们开始尝试一个项目'])
   await capture('620-light-initial',620)
   await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280)
   const mixed=await evaluate('goalsVisual.facts()');assert.equal(mixed.ids.length,6);assert.ok(mixed.criteria>0 && mixed.reports>0 && mixed.checks>0,'Mixed fixture includes nonempty actual target and result collections')
   result.observations.push({scene:'mixed',facts:mixed})
   assert.deepEqual(await evaluate('[...document.querySelectorAll(".goals-row__next")].map(node=>node.textContent)'),['Goal needs an outline','Decision needed','Goal ready for confirmation','Goal agreed · No result report','Results ready for review','Results need checking'])
   await capture('1280-dark-mixed-list',1280)
   await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")')
   await waitFor('Boolean(document.querySelector(".goals-detail"))')
   const compact=await evaluate('({context:document.querySelector(".goals-common").dataset.commonContext,height:document.querySelector(".goals-common").getBoundingClientRect().height,hidden:document.querySelector(".goals-common__content").hidden,headings:[...document.querySelectorAll(".goals-document h2")].map(node=>node.textContent)})')
   assert.equal(compact.context,'compact');assert.equal(compact.hidden,true);assert.ok(compact.height<80,'Start area gives Goal navigation its reading space');assert.ok(compact.headings.includes('Goal definition'));result.observations.push({scene:'unoutlined',compact})
   await capture('1280-dark-unoutlined-detail',1280)
   await scenario('proposal',620,'light')
   assert.equal(await evaluate('document.querySelectorAll("[data-goal-success-criterion]").length'),2)
   assert.equal(await evaluate('[...document.querySelectorAll("[data-goal-success-criterion]")].some(node=>node.closest("details:not([open])"))'),false,'Pre-confirmation criteria stay expanded')
   assert.equal(await evaluate('Boolean(document.querySelector("[data-goal-confirm]"))'),true)
   await visibleDetail('confirmable');await keyboardFocus('[data-goal-confirm]');await capture('620-light-confirmable-detail-focus',620)
   await scenario('confirmed',620,'light')
   assert.equal(await evaluate('document.querySelectorAll("[aria-label^=\\\"Open discussion for\\\"]").length'),1)
   assert.equal(await evaluate('document.querySelector(".goals-no-results .goals-button--primary").textContent.trim()'),'Open discussion')
   await visibleDetail('no-report');await capture('620-light-agreed-no-report',620)
   await scenario('results',1280,'dark')
   assert.equal(await evaluate('document.querySelectorAll("[data-goal-criterion-id]").length'),2)
   assert.equal(await evaluate('document.querySelectorAll(".goals-evidence__open").length'),2)
   const type=await evaluate('({heading:parseFloat(getComputedStyle(document.querySelector(".goals-grounding h2")).fontSize),body:parseFloat(getComputedStyle(document.querySelector("[data-goal-result-summary]")).fontSize)})')
   assert.ok(type.heading>type.body,'Reading responsibilities have stronger heading hierarchy than prose');result.observations.push({scene:'results',type})
   await visibleDetail('results');await capture('1280-dark-results-and-evidence',1280)
   await evaluate('document.querySelector("[data-goal-accept]").scrollIntoView({block:"nearest"})');await capture('1280-dark-results-reading-tail',1280)
   await evaluate('window.originalGoalTitle=document.querySelector(".goals-title")');await insert('[aria-label="Goal title"]',' · retained draft');const titleDraft=await evaluate('document.querySelector(".goals-title").value');await size(620);await visibleDetail('same-goal-narrow');await size(1280);await visibleDetail('same-goal-wide-return');assert.equal(await evaluate('window.originalGoalTitle===document.querySelector(".goals-title")'),true,'Width changes retain the same Goal title editor');assert.equal(await evaluate('document.querySelector(".goals-title").value'),titleDraft,'Width changes retain the same authored title draft');await capture('1280-dark-retained-title-width-return',1280)
   await scenario('unknown',620,'dark')
   assert.equal(await evaluate('Boolean(document.querySelector("[data-goal-accept],[data-goal-accept-gaps]"))'),false)
   await visibleDetail('unknown');await evaluate('document.querySelector(".goals-grounding").scrollIntoView({block:"start"})');await capture('620-dark-unknown-results',620)
   await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("light")');await size(620)
   await insert('[aria-label="Search goals"]','No matching goal')
   assert.equal(await evaluate('document.querySelectorAll("[data-demand-id]").length'),0)
   await keyboardFocus('.goals-empty button');await capture('620-light-zero-match-focus',620)
   await click(button('Clear search & filters'))
   assert.equal(await evaluate('document.querySelectorAll("[data-demand-id]").length'),6)
   assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Search goals','Zero-match recovery returns focus to the live search')
   await scenario('questions',620,'light')
   assert.equal(await evaluate('Boolean(document.querySelector("[data-goal-confirm]"))'),false)
   assert.equal(await evaluate('Boolean(document.querySelector(".goals-open-questions"))'),true)
   await visibleDetail('decisions');await capture('620-light-decisions-detail',620)
   await evaluate('goalsVisual.seedMaturity();goalsVisual.appearance("dark")');await size(1280)
   await click(button('管理'));await click(button('新增操作'));await insert('[data-common-editor] textarea','先读取真实记录，再建议一次可验证的小尝试。')
   await evaluate('goalsVisual.holdConfigSave()');await click(button('保存操作'))
   await click('document.querySelector("[data-demand-id=\\\"goal:visual-0\\\"]")')
   await evaluate('goalsVisual.finishConfigSave(true)')
   await waitFor('Boolean(document.querySelector(".goals-common__context-feedback")?.textContent.includes("保存未完成"))')
   assert.equal(await evaluate('document.querySelector(".goals-common__content").hidden'),true)
   await capture('1280-dark-compact-new-save-failure',1280)
   await size(620);await visibleDetail('compact-narrow-new-save-error');await capture('620-dark-compact-new-save-failure',620);await click(button('回到常用操作'))
   assert.equal(await evaluate('document.querySelector("[data-common-editor] textarea").value'),'先读取真实记录，再建议一次可验证的小尝试。')
   assert.equal(await evaluate('document.activeElement.textContent.trim()'),'保存操作','Return restores the original now-enabled save control')
   const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),p=e.closest('.goals-common__manager').getBoundingClientRect();return {label:e.textContent.trim(),top:r.top,bottom:r.bottom,left:r.left,right:r.right,scrollLeft:p.left,scrollRight:p.right,scrollClientRight:p.left+e.closest('.goals-common__manager').clientWidth,scrollbarWidth:parseFloat(getComputedStyle(e.closest('.goals-common__manager'),'::-webkit-scrollbar').width),scrollTop:p.top,scrollBottom:p.bottom,viewport:innerHeight,outline:getComputedStyle(e).outlineWidth,outlineStyle:getComputedStyle(e).outlineStyle,outlineColor:getComputedStyle(e).outlineColor}})()`);assert.ok(focus.top>=focus.scrollTop && focus.bottom<=Math.min(focus.scrollBottom,focus.viewport),'Returned original focus control is visible inside its scrollport');assert.ok(focus.left>=focus.scrollLeft && focus.right<=focus.scrollRight-focus.scrollbarWidth,'Returned focus stays clear of the manager scrollbar');assert.equal(focus.outline,'2px','Returned original focus has a complete authored outline');assert.equal(focus.outlineStyle,'solid');result.observations.push({scene:'returned-common',focus});await capture('620-dark-returned-common-draft',620)
   assert.ok(result.frames.length===(scope==='corrections-only'?9:14),'Finite representative images with only necessary reading/decision/feedback frames')
  }
  assert.deepEqual(await evaluate('goalsVisual.facts().runs'),originalRuns,'Original preview Run identities remain intact')
  assert.deepEqual(result.consoleErrors,[]);result.passed=true
 }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack}}
 finally{await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)}
})
