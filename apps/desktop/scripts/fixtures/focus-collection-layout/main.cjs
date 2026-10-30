const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path')
const {app,BrowserWindow}=require('electron')
const [html,root,evidence,sceneMode='collection-layout']=process.argv.slice(2),headingMode=sceneMode==='heading-menu-join'
app.setPath('userData',path.join(root,'user-data'));app.setPath('sessionData',path.join(root,'session-data'))
const result={schema:headingMode?'agentmux.focus-group-heading-menu-scene-actual.v1':'agentmux.focus-collection-scene-actual.v1',mode:sceneMode,passed:false,frames:[],userRuntimeTouched:false}
let win
app.whenReady().then(async()=>{try{
  win=new BrowserWindow({width:1200,height:960,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}})
  await win.loadFile(html,{query:{proofMode:sceneMode}});win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  const read=source=>win.webContents.executeJavaScript(source)
  async function until(label,predicate){const end=Date.now()+12000;do{if(await predicate())return;await new Promise(done=>setTimeout(done,30))}while(Date.now()<end);throw new Error('Private collection scene did not settle: '+label)}
  const painted=()=>read(`(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished));await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))})()`)
  async function shot(file,state){await painted();const bytes=(await win.webContents.capturePage()).toPNG();assert.ok(bytes.length>0);await fs.writeFile(path.join(evidence,file),bytes);result.frames.push({file,state})}
  const resize=async width=>{await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:960,deviceScaleFactor:1,mobile:false});await painted()}
  async function mode(value){await read(`collectionProof.mode(${JSON.stringify(value)})`);await until('actual mode '+value,()=>read(`document.querySelector('.global-focus-surface')?.dataset.focusTopicPresentation===${JSON.stringify(value)}`));await painted()}
  async function click(selector){const r=await read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing control '+${JSON.stringify(selector)});n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...r,button:'left',clickCount:1})}
  const cards=()=>read(`[...document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]')].map(n=>n.dataset.sessionId).sort()`)
  async function scanStart(){
    await until('scan top and visible original first Collection',()=>read(`(async()=>{const rows=document.querySelector('.global-focus-main .focus-project-lanes__rows');rows.scrollTop=0;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const first=rows.querySelector('.focus-project-lanes__row'),r=rows.getBoundingClientRect(),f=first.getBoundingClientRect();return rows.scrollTop===0&&f.top>=r.top-1&&f.top<r.bottom})()`))
  }
  async function inspectPreview(){
    await click('[data-settings-preview-open="project-scanning"]')
    await until('actual narrow preview reached through original View preview action',()=>read(`(()=>{const pane=document.querySelector('[data-settings-pane]'),preview=document.querySelector('.focus-settings-preview'),a=pane.getBoundingClientRect(),b=preview.getBoundingClientRect();return document.activeElement===preview&&b.top>=a.top-1&&b.bottom<=Math.min(a.bottom,innerHeight)+1&&b.width>0})()`))
    await painted()
  }

  async function board(){await read(`collectionProof.view('board')`);await until('original board',()=>read(`!!document.querySelector('.global-focus-surface:not([hidden]) .focus-project-lanes__row[data-focus-source="collection"]')`));await painted()}
  async function headingScenes(){
    const target=await read('collectionProof.headingTargets()'),checks=[]
    const node=id=>`document.querySelector('button.focus-context[data-session-id="${id}"]').closest('.focus-project-lanes__row').querySelector('.focus-project-lanes__axis')`
    const key=async(name,code,virtual)=>{for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:virtual})}
    const noMenu=()=>read(`!document.querySelector('[role="menu"],.topic-dialog,.space-icon-picker')`)
    async function atHeading(id){await read(`(()=>{const n=${node(id)};n.scrollIntoView({block:'center',inline:'nearest'});collectionProof.rememberHeading(${JSON.stringify(id)})})()`);await painted();return read(`(()=>{const n=${node(id)},r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.focus-project-lanes__axis')===n}})()`)}
    async function pointer(id,button='left'){const p=await atHeading(id);assert.equal(p.hit,true,'Original heading is really hit-testable');for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button,buttons:type==='mousePressed'?(button==='right'?2:1):0,clickCount:1})}
    async function open(id,keyboard=false){const before=await read(`collectionProof.headingFacts(${JSON.stringify(id)})`);await atHeading(id)
      if(keyboard){for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'F10',code:'F10',windowsVirtualKeyCode:121,modifiers:8})}
      else await pointer(id,'right')
      await until('actual heading menu',()=>read(`!!document.querySelector('[role="menu"]')`));assert.deepEqual(await read(`collectionProof.headingFacts(${JSON.stringify(id)})`),before,'Opening object menu never runs original fold/filter/navigation')
    }
    async function menuItem(label){const p=await read(`(()=>{const a=[...document.querySelectorAll('[role="menuitem"]')].filter(n=>n.textContent.trim()===${JSON.stringify(label)});if(a.length!==1)throw new Error('Expected one original menu item '+${JSON.stringify(label)});const n=a[0],r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})}
    async function dialogButton(selector,label){const p=await read(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(n=>n.textContent.trim()===${JSON.stringify(label)});if(a.length!==1)throw new Error('Expected one original Dialog button');const r=a[0].getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})}
    async function returned(id,label){await until(label,()=>read(`collectionProof.headingReturned(${JSON.stringify(id)})&&!document.querySelector('[role="menu"],.topic-dialog,.space-icon-picker')`));checks.push({id,label,returnedToOriginal:true})}
    async function escape(id){await key('Escape','Escape',27);await returned(id,'Escape returns original heading')}
    async function geometry(kind){const bounds=await read(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(kind)})];return nodes.map(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewport:[innerWidth,innerHeight]}})})()`);assert.ok(bounds.length>0);for(const b of bounds)assert.ok(b.width>0&&b.height>0&&b.left>=-1&&b.top>=-1&&b.right<=b.viewport[0]+1&&b.bottom<=b.viewport[1]+1,JSON.stringify(bounds));return bounds}
    await board();await modeChange('cards');await resize(1200);await read(`collectionProof.theme('dark')`)
    const leftBefore=await read(`collectionProof.headingFacts('task1')`);await pointer('task1');await until('original left fold',()=>read(`collectionProof.headingFacts('task1').collapsed==='true'`));assert.equal(await noMenu(),true)
    await pointer('task1');await until('original left unfold',()=>read(`collectionProof.headingFacts('task1').collapsed===null`));assert.deepEqual(await read(`collectionProof.headingFacts('task1')`),leftBefore)
    await pointer('task5');await until('original left Project filter',()=>read(`collectionProof.headingFacts('task5').projectFilter`));assert.equal(await noMenu(),true);assert.deepEqual(await cards(),['task5']);await click('[aria-label="Remove Project filter"]');await until('original clear Project filter',async()=>!(await read(`collectionProof.headingFacts('task5').projectFilter`)))
    result.headingLeftClick={collectionFoldAndExpand:true,projectFilterAndClear:true,noExtraMenuOrDialog:true}
    for(const [theme,width]of[['dark',1200],['light',360]]){
      await resize(width);await read(`collectionProof.theme(${JSON.stringify(theme)})`);await scanStart()
      await open('task1',width===360);await geometry('[role="menu"]');await shot(`heading-category-${theme}-${width}.png`,'Actual single Category object menu, accurate original Space');await escape('task1')
      await open('task1');await menuItem('Copy Category link');await returned('task1','Copy returns original Category heading');assert.equal((await read('collectionProof.facts().headingTransport.clipboard')).at(-1),target.category.link)
      await open('task1');await menuItem('Rename category…');await until('original Category Dialog',()=>read(`!!document.querySelector('.topic-dialog input')`))
      await read(`(()=>{const input=document.querySelector('.topic-dialog input');input.focus();input.select()})()`);await win.webContents.debugger.sendCommand('Input.insertText',{text:'MAC · 未提交的分组名称'})
      assert.equal(await read(`document.querySelector('.topic-dialog input').value`),'MAC · 未提交的分组名称');await geometry('.topic-dialog');await shot(`heading-rename-${theme}-${width}.png`,'Original Category rename Dialog; unsaved draft remains local');await click('.topic-dialog .confirmation-dialog__cancel');await returned('task1','Cancel returns original Category heading')
      await open('task1');await menuItem('Change avatar…');await until('original shared Picker',()=>read(`!!document.querySelector('.space-icon-picker')`));await geometry('.space-icon-picker');await shot(`heading-picker-${theme}-${width}.png`,'Original shared Category Picker; no avatar or icon save')
      await dialogButton('.space-icon-picker button','Cancel');await returned('task1','Picker Cancel returns original Category heading')
      await open('task5',true);await geometry('[role="menu"]');await shot(`heading-project-${theme}-${width}.png`,'Original registered Project menu, bounded path and resource actions');await menuItem('Copy Path');await returned('task5','Project Copy returns original Project heading');assert.equal((await read('collectionProof.facts().headingTransport.clipboard')).at(-1),target.projectPath)
      await open('task6');await read(`(()=>{const n=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(target.secondCategory.title)});if(!n)throw new Error('Original second Category missing');n.focus()})()`);await key('ArrowRight','ArrowRight',39);await until('actual multi-Category submenu',()=>read(`document.querySelectorAll('[role="menu"]').length===2`));await geometry('[role="menu"]');await shot(`heading-multi-${theme}-${width}.png`,'Multiple confirmed Categories retain each exact target; second Category submenu')
      await menuItem('Copy Category link');await returned('task6','Second Category copy returns original multi heading');assert.equal((await read('collectionProof.facts().headingTransport.clipboard')).at(-1),target.secondCategory.link)
      if(theme==='dark'){await open('task9',true);assert.deepEqual(await read(`[...document.querySelectorAll('[role="menuitem"]')].map(n=>n.textContent.trim())`),['Collapse Collection']);await geometry('[role="menu"]');await shot('heading-unknown-dark-1200.png','Unknown membership keeps only its own presentation fold action');await escape('task9')}
    }
    await modeChange('sections');result.headingInteractions=checks;assert.ok(checks.length>=10)
    const facts=await read('collectionProof.facts()');for(const name of ['topicWrites','avatarWrites','iconWrites','reveals','terminalOpens','workspaceSelections'])assert.deepEqual(facts.headingTransport[name],[],name)
    assert.deepEqual(facts.selections,[]);assert.equal(facts.sameIcons,true)
    await resize(1200);await read(`collectionProof.theme('dark')`);await modeChange('cards');await scanStart()
    await open('task1');await menuItem('Change avatar…');await until('original Picker for saved preset',()=>read(`!!document.querySelector('.space-icon-picker')`))
    await click(`.space-icon-picker [data-space-icon-choice="${target.category.preset}"]`)
    assert.equal(await read(`document.querySelector('.space-icon-picker [data-space-icon-choice="${target.category.preset}"]').getAttribute('aria-pressed')`),'true')
    const readsBeforeSave=await read('collectionProof.facts().headingTransport.appearanceReads.length')
    await click('.space-icon-picker__save');await returned('task1','Original preset Save returns original Category heading')
    await until('saved preset on exact original Category heading',()=>read(`!!(${node('task1')}).querySelector('[data-space-icon-kind="category"][data-space-icon-source="manual"][data-space-icon="${target.category.preset}"]')`))
    const feedback=await read(`(()=>{const f=collectionProof.facts(),n=${node('task1')},icon=n.querySelector('[data-space-icon-kind="category"]'),key=collectionProof.headingTargets().category.subject.spaceId;return{subject:collectionProof.headingTargets().category.subject,choice:icon.dataset.spaceIcon,key,source:icon.dataset.spaceIconSource,storeChoice:f.spaceObjectIcons[key],appearanceSpaceObjectIcons:f.configuredSpaceObjectIcons,configurationWrite:f.headingTransport.iconWrites[0],writeCount:f.headingTransport.iconWrites.length,appearanceReadCount:f.headingTransport.appearanceReads.length,originalActorsPreserved:f.sameSessions&&f.sameTabs&&f.sameLayouts&&f.sameDrafts&&f.sameFocus}})()`)
    assert.equal(feedback.choice,target.category.preset);assert.equal(feedback.source,'manual');assert.deepEqual(feedback.subject,target.category.subject);assert.equal(feedback.writeCount,1);assert.equal(feedback.configurationWrite.accepted,true);assert.equal(feedback.configurationWrite.key,target.category.subject.spaceId);assert.equal(feedback.configurationWrite.choice,target.category.preset)
    assert.deepEqual(feedback.configurationWrite.after,{...feedback.configurationWrite.before,[target.category.subject.spaceId]:target.category.preset});assert.deepEqual(feedback.appearanceSpaceObjectIcons,feedback.configurationWrite.after);assert.equal(feedback.storeChoice,target.category.preset);assert.equal(feedback.appearanceReadCount,readsBeforeSave,'Saved symbol does not probe default appearance or an image asset');assert.equal(feedback.originalActorsPreserved,true)
    result.savedAvatarFeedback={...feedback,appearanceReadsAfterSave:feedback.appearanceReadCount-readsBeforeSave,originalStoreSave:true,privateConfigurationOnly:true}
    await shot('saved-category-avatar-dark-1200.png','Original Category Picker saves Book preset through private configuration; exact Collection heading updates immediately')
    await modeChange('sections')
  }
  const modeChange=mode
  await until('current source board',()=>read(`window.collectionProof?.ready&&document.querySelectorAll('.global-focus-main button.focus-context[data-session-id]').length===9`))
  const expected=await cards();assert.equal(new Set(expected).size,9)
  result.before=await read('collectionProof.facts()')
  for(const theme of ['dark','light'])for(const width of [1200,360]){
    await resize(width);await read(`collectionProof.theme(${JSON.stringify(theme)})`)
    for(const value of ['cards','sections']){
      await board();await mode(value)
      await scanStart()
      assert.deepEqual(await cards(),expected,'Mode/width/theme never duplicates or drops an original Agent')
      const geometry=await read(`(()=>{const root=document.querySelector('.global-focus-main'),r=root.getBoundingClientRect();return{left:r.left,right:r.right,viewport:innerWidth,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth}})()`)
      assert.ok(geometry.left>=0&&geometry.right<=geometry.viewport+1&&geometry.scrollWidth<=geometry.clientWidth+1,JSON.stringify(geometry))
      if(value==='cards')assert.equal(await read(`document.querySelectorAll('.global-focus-main [data-focus-topic-section]').length`),0)
      else assert.ok(await read(`document.querySelectorAll('.global-focus-main [data-focus-topic-section]').length`)>0)
      if(value==='cards'){
        const longTitle=await read(`(()=>{const n=[...document.querySelectorAll('.global-focus-main .focus-context__topic > span')].find(n=>n.textContent.length>40);if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{name:n.textContent,height:r.height,fontSize:parseFloat(s.fontSize),clamp:s.webkitLineClamp,accessible:n.parentElement.getAttribute('aria-label')}})()`)
        assert.ok(longTitle&&longTitle.height>=longTitle.fontSize*2&&longTitle.clamp==='2'&&longTitle.accessible.includes(longTitle.name),'Actual long Topic spans two visible lines with complete accessible title')
        result.longTopic??=[];result.longTopic.push({theme,width,...longTitle})
      }
      await shot(`board-${value}-${theme}-${width}.png`,`${value} · ${theme} · ${width} · original Collection and Project scan`)
      if(theme==='dark'){
        await read(`(()=>{const rows=document.querySelector('.focus-project-lanes__rows');rows.scrollTop=rows.scrollHeight})()`);await painted()
        await shot(`sources-${value}-${width}.png`,`${value} · ${width} · all memberships, confirmed unclassified and unknown sources`)
      }
    }
  }
  await resize(1200);await read(`collectionProof.theme('dark')`);await mode('cards');await read(`collectionProof.metadataError(true)`);await painted()
  await scanStart()
  await until('original visible Category service notice',()=>read(`!![...document.querySelectorAll('.focus-project-lanes__recovery')].find(n=>n.textContent==='Details unconfirmed')`))
  const notice=await read(`(()=>{const n=[...document.querySelectorAll('.focus-project-lanes__collection-notice')].find(n=>n.textContent==='Details unconfirmed'),r=n.getBoundingClientRect(),s=getComputedStyle(n);return{x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,text:n.textContent}})()`)
  assert.ok(notice.width>0&&notice.scrollWidth<=notice.clientWidth+1,'Complete unconfirmed service meaning is visibly readable')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:notice.x,y:notice.y,buttons:0})
  await until('original full Category failure tooltip visible',()=>read(`document.querySelector('.workbench-tab-name-tooltip')?.textContent.includes('Private Category metadata read failed')`))
  await painted()
  result.categoryNotice={...notice,fullExplanation:await read(`document.querySelector('.workbench-tab-name-tooltip').textContent`)}
  await shot('category-service-notice.png' ,'Original Category read failure keeps membership and Agent capability')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:2,buttons:0});await read(`collectionProof.metadataError(false)`);await painted()
  for(const width of [1200,360]){
    await resize(width);await read(`collectionProof.view('settings')`)
    await until('original settings',()=>read(`!!document.querySelector('.focus-settings [data-settings-field="topic-presentation"]')`))
    await click('[data-settings-field="topic-presentation"] input[value="sections"]')
    await until('same shared preview uses sections',()=>read(`!!document.querySelector('.focus-settings-preview [data-focus-topic-section]')`))
    await shot(`settings-sections-${width}.png`,'Actual settings draft changes the original shared preview before save')
    if(width===360){await inspectPreview();await shot('settings-preview-sections-360.png','Original View preview reaches the complete narrow shared Topic sections')}
    assert.equal(await read('collectionProof.facts().mode'),'cards','Unsaved draft does not change actual Focus')
    await click('[data-settings-field="topic-presentation"] input[value="cards"]')
    await until('shared preview returns cards',()=>read(`!document.querySelector('.focus-settings-preview [data-focus-topic-section]')`))
    await shot(`settings-cards-${width}.png`,'Actual settings default card Topic treatment')
    if(width===360){await inspectPreview();await shot('settings-preview-cards-360.png','Original View preview reaches the complete narrow shared Topic card provenance')}
    if(headingMode&&width===1200){
      const origin=await read(`(()=>{const pane=document.querySelector('[data-settings-pane]'),n=document.querySelector('.focus-settings-preview .focus-project-lanes__axis');if(!n)throw new Error('Original example heading missing');const scroll=pane.scrollTop;n.scrollIntoView({block:'nearest'});n.focus();const r=n.getBoundingClientRect();return{scroll,x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:origin.x,y:origin.y,button:'right',buttons:type==='mousePressed'?2:0,clickCount:1})
      await painted();assert.equal(await read(`!!document.querySelector('[role="menu"],.topic-dialog,.space-icon-picker')`),false,'Settings examples never resolve real resource menus on right click')
      for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'F10',code:'F10',windowsVirtualKeyCode:121,modifiers:8})
      await painted();assert.equal(await read(`!!document.querySelector('[role="menu"],.topic-dialog,.space-icon-picker')`),false,'Settings example keyboard never opens a real resource menu')
      await read(`(()=>{document.querySelector('[data-settings-field="topic-presentation"] input[value="cards"]').focus();document.querySelector('[data-settings-pane]').scrollTop=${origin.scroll}})()`)
      result.previewHeadingIsolation={nativeRightClick:true,nativeShiftF10:true,noBusinessMenu:true}
    }
  }
  await resize(1200);await click('[data-settings-field="topic-presentation"] input[value="sections"]')
  await click('[data-settings-save-bar] button')
  await until('original authored preference saved via private transport',()=>read(`collectionProof.facts().mode==='sections'`))
  await board();await until('actual scan matches saved mode',()=>read(`document.querySelector('.global-focus-surface').dataset.focusTopicPresentation==='sections'`))
  await shot('saved-mode-on-board.png','Saved authored preference reaches actual Focus; private transport only')
  if(headingMode)await headingScenes()
  result.after=await read('collectionProof.facts()')
  for(const key of ['sameSessions','sameTabs','sameLayouts','sameDrafts','sameFocus'])assert.equal(result.after[key],true,key)
  assert.deepEqual(result.after.controls,{stop:0,resume:0,write:0,launchAgent:0,interrupt:0})
  for(const key of ['topicWrites','avatarWrites','reveals','terminalOpens','workspaceSelections'])assert.deepEqual(result.after.headingTransport[key],[],key)
  assert.equal(result.after.headingTransport.iconWrites.length,headingMode?1:0)
  assert.deepEqual(await cards(),expected)
  result.passed=true
}catch(error){if(win)try{result.previewDiagnostics=await win.webContents.executeJavaScript(`(()=>{const p=document.querySelector('[data-settings-pane]'),v=document.querySelector('.focus-settings-preview');return{visibility:document.visibilityState,active:document.activeElement?.outerHTML.slice(0,300),pane:p?.getBoundingClientRect().toJSON(),scroll:[p?.scrollTop,p?.scrollHeight,p?.clientHeight],preview:v?.getBoundingClientRect().toJSON(),enabled:v?.dataset.active}})()`)}catch{};result.failure={name:error?.name??typeof error,message:error?.message??String(error),stack:error?.stack};if(win)try{await fs.writeFile(path.join(evidence,'failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}}
finally{await fs.writeFile(path.join(evidence,'actual.json'),JSON.stringify(result,null,2)+'\n');if(win&&!win.isDestroyed())win.destroy();app.exit(result.passed?0:1)}})
