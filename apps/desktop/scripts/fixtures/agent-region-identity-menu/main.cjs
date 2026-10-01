const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises'), path = require('node:path')
const swapProof = require('./swap.cjs')
const mailboxProof = require('./mailbox.cjs')
const [html, privateRoot, evidence, probe = 'complete'] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { schema: 'agentmux.region-identity-menu-render.v1', probe, passed: false, frames: [], selections: [], userRunTouched: false }
let win
const evaluate = expression => win.webContents.executeJavaScript(expression)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const leftId = 'region-actions-target', rightId = 'region-actions-survivor', tabId = 'region-actions-tab'
const region = `document.querySelector('[data-workbench-region-id="${leftId}"]')`
const surface = `(${region}??document.querySelector('.agent-surface'))`
const more = `${surface}.querySelector('.agent-region-header__more')`
const menu = `document.querySelector('.agent-region-menu[data-owner-region-id="${leftId}"]')`
const item = label => `([...${menu}.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()===${JSON.stringify(label)}))`
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(25) }
  throw new Error('Timed out: ' + expression)
}
const visible = expression => `(()=>{const e=${expression};if(!e)return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility==='visible'&&s.display!=='none'&&Number(s.opacity)>0})()`
async function painted() {
  return evaluate(`(async()=>{let timer,finished=0;try{return await Promise.race([(async()=>{for(;;){
    const animations=document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime));
    finished+=animations.length;await Promise.all(animations.map(a=>a.finished.catch(error=>{if(a.playState!=='idle')throw error})));
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
    if(!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime)))return{finished,doubleRAF:true}
  }})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Unsettled finite animations')),3000)})])}finally{clearTimeout(timer)}})()`)
}
async function key(key, code, virtual) {
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual })
}
async function point(expression) {
  return evaluate(`(()=>{const e=${expression};if(!e)throw new Error('Missing actual target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
}
async function click(expression) {
  const p = await point(expression)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...p, button:'left', clickCount:1 })
}
async function open(kind='mouse') {
  if (kind === 'keyboard') { await evaluate(`${more}.focus()`); await key('ArrowDown','ArrowDown',40) }
  else if (kind === 'hover') await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseMoved', ...await point(more), buttons:0 })
  else await click(more)
  await waitFor(visible(`${menu}?.querySelector('[role="menuitem"]')`));await painted()
  assert.ok(await evaluate(`${menu}.querySelectorAll('[role="menuitem"]').length`)>0,'Actual nonempty menu')
}
async function close(expectFocus=true) {
  if(expectFocus)await key('Escape','Escape',27)
  else await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:735,buttons:0})
  await waitFor(`!${menu}`);await painted()
  if(expectFocus)assert.equal(await evaluate(`document.activeElement===${more}`),true,'Keyboard Escape returns to the original More trigger')
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:735,buttons:0})
}
async function seed(width, mode='terminal') {
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: mode==='readonly'?width:width * 2 + 1, height:740, deviceScaleFactor:1,mobile:false })
  const generation=await evaluate(mode==='readonly'?'identityMenu.observe()':`identityMenu.mode(${JSON.stringify(['cold','notice'].includes(mode)?mode:'terminal')})`)
  await waitFor(`document.querySelector('[data-region-actions-generation="${generation}"]') && document.querySelectorAll('.agent-region-header').length===${mode==='readonly'?1:2}`)
  await waitFor(visible(more))
  if(mode==='history'){await open();await click(item('Conversation history'));await waitFor(visible(`${surface}.querySelector('.session-history:not(.session-history--inline)')`))}
  if(mode==='cold')await waitFor(visible(`${surface}.querySelector('.session-history--inline')`))
  if(mode==='activity'){await click(`${surface}.querySelector('.composer-tool--view-toggle')`);await waitFor(`${surface}.querySelector('.composer-tool--view-toggle').getAttribute('aria-label')==='Show Terminal'`)}
  if(mode==='search'){
    await waitFor(`Boolean(${surface}.querySelector('.xterm-helper-textarea'))`)
    await evaluate(`${surface}.querySelector('.xterm-helper-textarea').focus()`)
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'f',code:'KeyF',modifiers:4,windowsVirtualKeyCode:70})
    await waitFor(visible(`${surface}.querySelector('.terminal-search')`))
  }
  await painted();await delay(120);await painted()
}
async function identity() {
  const names=await evaluate(`[...document.querySelectorAll('.agent-region-header strong')].map(node=>({name:node.textContent,title:node.title,aria:node.closest('header').getAttribute('aria-label')}))`)
  assert.ok(names.length>0,'Actual identities are nonempty')
  const expected=await evaluate('identityMenu.names')
  names.forEach((entry,index)=>{assert.ok(entry.name?.trim(),'Actual Agent name is nonempty');assert.equal(entry.name,expected[index]);assert.equal(entry.title,expected[index]);assert.ok(entry.aria.includes(expected[index]))})
  assert.equal(await evaluate(`document.querySelectorAll('.agent-input-stack__rail').length`),0)
  return names
}
async function measurement(terminal) {
  return evaluate(`(()=>{const s=${surface},body=s.querySelector('.agent-body'),r=body.getBoundingClientRect();return{
    body:{x:r.x,y:r.y,width:r.width,height:r.height},terminal:${terminal?'identityMenu.terminal()':'null'}}})()`)
}
async function geometry(readonly) {
  return evaluate(`(()=>{const s=${surface},r=s.getBoundingClientRect();const hit=selector=>{
    const node=s.querySelector(selector);if(!node)throw new Error('Missing '+selector);const b=node.getBoundingClientRect();
    return {width:b.width,height:b.height,contained:b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom,
      hits:[[.5,.5],[.1,.1],[.9,.1],[.1,.9],[.9,.9]].map(([x,y])=>document.elementFromPoint(b.x+b.width*x,b.y+b.height*y)?.closest(selector)===node)}};
    return{width:r.width,more:hit('.agent-region-header__more'),close:${readonly?'null':"hit('.workbench-region__close')"},
      inputs:s.querySelectorAll('.composer [role="textbox"]').length,toggles:s.querySelectorAll('.composer-tool--view-toggle').length,
      readOnly:!!s.querySelector('.agent-region-header__mode'),search:!!s.querySelector('.terminal-search'),notice:!!s.querySelector('.agent-launch-notice')}})()`)
}
async function capture(name) {
  const png=(await win.webContents.capturePage()).toPNG();assert.ok(png.length>0,'Actual captured image is nonempty');await fs.writeFile(path.join(evidence,name+'.png'),png)
  return createHash('sha256').update(png).digest('hex')
}
async function composerVisual(layoutOwning=false) {
  result.captureOnly=true;result.aestheticReview='not-performed'
  const composer=`${surface}.querySelector('.composer')`,editor=`${composer}.querySelector('[role="textbox"]')`
  const toggle=`${composer}.querySelector('.composer-tool--mode')`,control=`${composer}.querySelector('.continuous-progress-control')`
  const trigger=`${composer}.querySelector('.composer__mailbox')`,mailbox=`${composer}.querySelector('.composer-mailbox')`
  const progressTab=`${mailbox}.querySelector('[role="tab"][id$="-progress-tab"]')`
  const form=`${control}.querySelector('form')`
  async function frame(width,state){
    result.stage={width,state};await waitFor(visible(editor));await waitFor(visible(trigger));await painted()
    if(layoutOwning&&state.startsWith('progress-')&&!state.endsWith('-closed'))assert.equal(await evaluate(`${progressTab}.getAttribute('aria-selected')`),'true','The captured Progress scene is the actual selected page')
    if(layoutOwning&&/^progress-(active|paused|unconfirmed)-open$/.test(state)){
      const actions=await evaluate(`Array.from(${control}.querySelectorAll('.continuous-progress-panel__actions button')).map(button=>{
        const text=Array.from(button.childNodes).find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim()),range=document.createRange();range.selectNodeContents(text)
        return{label:button.textContent.trim(),fontSize:parseFloat(getComputedStyle(button).fontSize),textHeight:range.getBoundingClientRect().height,disabled:button.disabled}
      })`)
      assert.equal(actions.length,3,'Actual Progress control observations are nonempty')
      assert.deepEqual(actions.map(action=>action.label),[state==='progress-active-open'?'Pause':'Resume','Check now','Stop loop'])
      for(const action of actions){assert.ok(action.fontSize>=12&&action.textHeight>=12,'Progress action text is readable at the current body font')}
      result.progressActions??=[];result.progressActions.push({width,state,actions})
    }
    const file=`${width}-composer-${state}.png`,png=await capture(file.slice(0,-4))
    result.frames.push({width,state,file,png})
    if(layoutOwning&&state==='progress-open'){
      const observed=await evaluate(`(()=>{
        const composer=${composer},form=composer.querySelector('.continuous-progress-control form')
        const checkbox=form.querySelector('input[type="checkbox"]'),label=checkbox.closest('label')
        const text=Array.from(label.childNodes).find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim())
        const range=document.createRange();range.selectNodeContents(text)
        const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
        const fields=Array.from(form.querySelectorAll('input:not([type="checkbox"]),textarea')).map(node=>{
          const style=getComputedStyle(node);return {rect:rect(node),font:style.fontFamily,fontSize:style.fontSize,paddingTop:parseFloat(style.paddingTop),paddingLeft:parseFloat(style.paddingLeft),radius:parseFloat(style.borderTopLeftRadius)}
        })
        return {checkbox:rect(checkbox),text:rect(range),fields,parentFont:getComputedStyle(form).fontFamily,parentFontSize:getComputedStyle(form).fontSize,draft:composer.querySelector('[role="textbox"]').textContent}
      })()`)
      result.progressLayouts??=[];result.progressLayouts.push({width,...observed})
      assert.equal(observed.fields.length,2,'Actual unbound form retains its two editing fields')
      assert.ok(observed.checkbox.width>0&&observed.checkbox.width<observed.fields[0].rect.width,'Checkbox must retain intrinsic width rather than stretch with editing fields')
      assert.ok(observed.text.left>=observed.checkbox.right,'Checkbox precedes its associated text on the same row')
      assert.ok(observed.text.top<observed.checkbox.bottom&&observed.checkbox.top<observed.text.bottom,'Checkbox and associated text share a readable row')
      for(const field of observed.fields){
        assert.equal(field.font,observed.parentFont,'Editing fields retain the current form typography')
        assert.equal(field.fontSize,observed.parentFontSize,'Editing fields do not shrink the form text')
        assert.ok(field.paddingTop>0&&field.paddingLeft>0&&field.radius>0,'Editing fields retain intentional inset and shape')
      }
      assert.match(observed.draft,/This draft remains unsent\./,'Opening progress retains the actual long draft')
    }
  }
  async function draft(text){
    await waitFor(visible(editor));await click(editor)
    for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:4,windowsVirtualKeyCode:65})
    await win.webContents.debugger.sendCommand('Input.insertText',{text})
    await waitFor(`${editor}.textContent.includes(${JSON.stringify(text.split('\n').at(-1))})`)
  }
  async function fill(expression,text){
    await evaluate(`${expression}.scrollIntoView({block:'nearest'})`);await click(expression)
    win.webContents.selectAll();await key('Backspace','Backspace',8)
    await waitFor(`${expression}.value===''`);await win.webContents.insertText(text)
    await waitFor(`${expression}.value===${JSON.stringify(text)}`)
  }
  async function openProgress(width){
    await click(trigger);await waitFor(`${mailbox}.matches(':popover-open') && ${mailbox}.dataset.state==='open'`);await painted()
    if(width!==undefined)await frame(width,'mailbox-open')
    assert.equal(await evaluate(`Boolean(${progressTab})`),true,'Actual shared Mailbox must expose its Progress tab')
    await click(progressTab);await waitFor(`${progressTab}.getAttribute('aria-selected')==='true'`)
    await waitFor(visible(control))
  }
  async function dismiss(){
    await key('Escape','Escape',27);await waitFor(`!${mailbox}.matches(':popover-open')`)
    result.progressDismissals??=[];result.progressDismissals.push(await evaluate(`({activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className,activeLabel:document.activeElement?.getAttribute('aria-label'),sameTrigger:document.activeElement===${trigger}})`))
    assert.equal(await evaluate(`document.activeElement===${trigger}`),true,'Native Escape returns focus to the same Mailbox trigger')
  }
  const readForm=()=>evaluate(`Array.from(${form}.elements).filter(node=>node.matches('input,textarea')).map(node=>node.type==='checkbox'?node.checked:node.value)`)
  async function phase(expected){
    await waitFor(visible(toggle));await click(toggle)
    await waitFor(`${composer}.querySelector('.composer-tools').dataset.mode===${JSON.stringify(expected)}`)
  }
  for(const width of [640,320]){
    if(layoutOwning)await evaluate(`identityMenu.appearance(${JSON.stringify(width===640?'dark':'light')})`)
    result.stage={width,state:'one-line-short'};await evaluate("identityMenu.progress('inactive')");await seed(width);await waitFor(visible(editor));await waitFor(`${trigger}?.dataset.progressState==='inactive'`)
    await draft('Review this workspace and keep the current draft.');await frame(width,'one-line-short')
    await phase('current');await frame(width,'tools-short')
    await phase('expanded');await draft('Review the current workspace.\nExplain the finding and its impact.\nKeep the original working surface.\nSuggest a focused next step.\nThis draft remains unsent.');await frame(width,'expanded-long')
    const terminalBefore=await evaluate('identityMenu.terminal()'),observationsBefore=await evaluate('identityMenu.progressFacts()')
    await openProgress(width);await waitFor(visible(form));await frame(width,'progress-open')
    await fill(`${form}.querySelector('input[type="number"]')`,'17')
    await fill(`${form}.querySelector('textarea')`,'继续当前任务，保留用户输入。')
    await click(`${form}.querySelector('input[type="checkbox"]')`)
    for(const [label,text] of [['Tracker root','/private/visual-task-source'],['Feature ID','visual-task'],['Public Tracker script','/private/visual-task-source/feature-tracker.sh']])
      await fill(`${form}.querySelector('[aria-label="${label}"]')`,text)
    const settings=await readForm();assert.deepEqual(settings,['17','继续当前任务，保留用户输入。',true,'/private/visual-task-source','visual-task','/private/visual-task-source/feature-tracker.sh'])
    await frame(width,'progress-filled')
    if(layoutOwning){
      const target=`${control}.querySelector('[data-progress-details="target"]')`
      await evaluate(`${target}.querySelector('summary').scrollIntoView({block:'nearest',container:'nearest'})`);await painted()
      const gesture=await evaluate(`(()=>{const summary=${target}.querySelector('summary'),r=summary.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{selected:${progressTab}.getAttribute('aria-selected'),open:${target}.open,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?.outerHTML,sameTarget:summary.contains(hit),scroll:${mailbox}.querySelector('.composer-mailbox__content').scrollTop}})()`)
      result.progressTargetGestures??=[];result.progressTargetGestures.push(gesture)
      assert.equal(gesture.sameTarget,true,'The actual Target summary is hit before native disclosure')
      await click(`${target}.querySelector('summary')`)
      assert.equal(await evaluate(`${target}.open`),true)
      const expected=await evaluate(`identityMenu.progressFacts().reads.find(target=>target.agentSessionId==='session-codex')`)
      assert.ok(expected,'The actual target read is nonempty')
      assert.deepEqual(await evaluate(`Array.from(${target}.querySelectorAll('dd')).map(node=>node.textContent)`),['Codex (codex)',expected.hostId,expected.agentSessionId,expected.workspacePath])
      await evaluate(`${target}.querySelector('dd:last-child').scrollIntoView({block:'nearest',container:'nearest'})`);await frame(width,'progress-target-details')
      await evaluate(`${target}.querySelector('summary').scrollIntoView({block:'nearest',container:'nearest'})`);await painted();await click(`${target}.querySelector('summary')`);assert.deepEqual(await readForm(),settings)
    }
    await click(`${mailbox}.querySelector('[role="tab"][id$="-inbox-tab"]')`)
    await waitFor(`${progressTab}.getAttribute('aria-selected')==='false'`);await click(progressTab)
    assert.deepEqual(await readForm(),settings,'Switching message/Progress pages preserves the actual unsent settings')
    await dismiss();await openProgress()
    assert.deepEqual(await readForm(),settings,'Native close/reopen preserves the actual unsent settings')
    assert.deepEqual(await evaluate('identityMenu.progressFacts()'),observationsBefore,'Disclosure does not relist or recreate loop observers')
    await dismiss();assert.deepEqual(await evaluate('identityMenu.terminal()'),terminalBefore,'Progress disclosure retains the original terminal instance and layout')
    await frame(width,'progress-closed')
    await phase('collapsed');await frame(width,'one-line-return')
    for(const state of ['active','paused','unconfirmed']){
      await evaluate(`identityMenu.progress(${JSON.stringify(state)})`);await waitFor(`${trigger}.dataset.progressState===${JSON.stringify(state)}`)
      await frame(width,`progress-${state}-closed`);await openProgress();await frame(width,`progress-${state}-open`);await dismiss()
    }
    if(layoutOwning){
      await evaluate("identityMenu.progress('active',true)");await openProgress()
      const decision=`${control}.querySelector('.continuous-progress-panel__decision p')`
      await evaluate(`${decision}.scrollIntoView({block:'end',container:'nearest'})`)
      assert.match(await evaluate(`${decision}.textContent`),/Original decision line 14:/)
      await frame(width,'progress-decision-tail')
      const configuration=`${control}.querySelector('[data-progress-details="configuration"]')`
      await evaluate(`${configuration}.querySelector('summary').scrollIntoView({block:'nearest',container:'nearest'})`);await painted();await click(`${configuration}.querySelector('summary')`)
      assert.equal(await evaluate(`${configuration}.open`),true)
      assert.equal(await evaluate(`${configuration}.querySelector('.continuous-progress-control__prompt').textContent`),Array.from({length:12},(_,index)=>`Saved continuation line ${index+1}: keep the original user input and finish the assigned task.`).join('\n'))
      await evaluate(`${configuration}.querySelector('.continuous-progress-control__prompt').scrollIntoView({block:'end',container:'nearest'})`);await painted()
      const tail=await evaluate(`(()=>{const prompt=${configuration}.querySelector('.continuous-progress-control__prompt'),text=prompt.firstChild,range=document.createRange(),start=text.textContent.lastIndexOf('\\n')+1;range.setStart(text,start);range.setEnd(text,text.textContent.length);const content=range.toString(),clip=${mailbox}.querySelector('.composer-mailbox__content').getBoundingClientRect(),r=range.getBoundingClientRect(),words=[];for(const match of content.matchAll(/\\S+/g)){const word=document.createRange();word.setStart(text,start+match.index);word.setEnd(text,start+match.index+match[0].length);const bounds=word.getBoundingClientRect();words.push({text:match[0],top:bounds.top,bottom:bounds.bottom,left:bounds.left,right:bounds.right})}return{text:content,words,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},clip:{top:clip.top,bottom:clip.bottom,left:clip.left,right:clip.right},source:Array.from(${configuration}.querySelectorAll('dd')).at(-1).textContent}})()`)
      result.progressSavedTails??=[];result.progressSavedTails.push({width,...tail})
      assert.equal(tail.text,'Saved continuation line 12: keep the original user input and finish the assigned task.')
      assert.ok(tail.words.length>0,'The complete saved final line has nonempty original words')
      // pre-wrap can hang spaces at a wrap boundary; each actual word must fit without relaxing the clip.
      for(const word of tail.words)assert.ok(word.top>=tail.clip.top&&word.bottom<=tail.clip.bottom&&word.left>=tail.clip.left&&word.right<=tail.clip.right,'The saved continuation final complete line is readable in the actual scroll clip: '+word.text)
      assert.equal(tail.source,'/private/visual-task-source/feature-tracker.sh')
      await frame(width,'progress-saved-prompt-tail')
      await evaluate(`Array.from(${configuration}.querySelectorAll('dd')).at(-1).scrollIntoView({block:'end',container:'nearest'})`);await painted()
      assert.equal(await evaluate(`(()=>{const source=Array.from(${configuration}.querySelectorAll('dd')).at(-1),r=source.getBoundingClientRect(),clip=${mailbox}.querySelector('.composer-mailbox__content').getBoundingClientRect();return r.top>=clip.top&&r.bottom<=clip.bottom})()`),true,'The complete saved source is readable in the actual scroll clip')
      await frame(width,'progress-saved-configuration-tail');await dismiss()
    }
    result.progressBehavior??=[];result.progressBehavior.push({width,settings,observationsBefore,observationsAfter:await evaluate('identityMenu.progressFacts()'),terminalBefore,terminalAfter:await evaluate('identityMenu.terminal()')})
  }
  assert.ok(result.frames.length>0,'Actual composer scenes are nonempty')
  if(layoutOwning)assert.equal(result.progressLayouts?.length,2,'Both actual widths have a nonempty form observation')
  if(layoutOwning){
    await evaluate("identityMenu.appearance('dark');identityMenu.progress('paused')");await seed(320)
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:641,height:430,deviceScaleFactor:1,mobile:false})
    await waitFor(visible(editor));await painted();await openProgress()
    const before=await evaluate('identityMenu.terminal()')
    const controls=`${control}.querySelector('.continuous-progress-panel__actions')`
    await evaluate(`${controls}.scrollIntoView({block:'nearest',container:'nearest'})`);await frame(320,'progress-short-controls')
    assert.equal(await evaluate(visible(`${controls}.querySelector('button')`)),true)
    assert.equal(await evaluate(visible(`${mailbox}.querySelector('[aria-label="Close mailbox"]')`)),true)
    await dismiss();assert.deepEqual(await evaluate('identityMenu.terminal()'),before,'Short Progress retains the same terminal and rows')
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:641,height:740,deviceScaleFactor:1,mobile:false})
  }
}
async function terminalLoadingVisual() {
  result.captureOnly=true;result.aestheticReview='not-performed';result.loadingLayouts=[]
  for(const width of [640,320]){
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:width*2+1,height:740,deviceScaleFactor:1,mobile:false})
    await evaluate('window.loadingFixture=identityMenu.terminalLoading(); void 0')
    const view=`${surface}.querySelector('.terminal-view')`
    try{
      await waitFor(visible(`${view}?.querySelector(':scope > .full-page-loading--region')`))
      await waitFor(visible(`${view}?.querySelector(':scope > .terminal-service-window')`))
      await painted()
      for(const state of ['loading','released']){
        if(state==='released'){
          await evaluate('loadingFixture.release()')
          await waitFor(`!${view}.querySelector(':scope > .full-page-loading--region')`)
          await painted()
        }
        const observed=await evaluate(`(()=>{
          const view=${view},canvas=view.querySelector(':scope > .terminal-view__xterm'),notice=view.querySelector(':scope > .terminal-service-window')
          const loading=view.querySelector(':scope > .full-page-loading--region'),style=getComputedStyle(canvas)
          const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
          return {view:rect(view),canvas:rect(canvas),notice:rect(notice),loading:loading?{...rect(loading),position:getComputedStyle(loading).position}:null,
            marginTop:parseFloat(style.marginTop),marginBottom:parseFloat(style.marginBottom),terminal:identityMenu.terminal(),noticeCount:notice.querySelectorAll('.service-window').length}
        })()`)
        const file=`${width}-terminal-${state}.png`,png=await capture(file.slice(0,-4))
        result.frames.push({width,state,file,png});result.loadingLayouts.push({width,state,...observed})
        assert.ok(observed.noticeCount>0,'Actual terminal notices are nonempty during the layout observation')
        assert.ok(observed.canvas.width>0&&observed.view.height>0,'The actual terminal layout is nonempty')
        const available=observed.view.height-observed.notice.height-observed.marginTop-observed.marginBottom
        assert.ok(Math.abs(observed.canvas.height-available)<=1,'The actual xterm gets the space left by notices, not the loading surface')
        if(state==='loading')assert.equal(observed.loading.position,'absolute','The actual Region loading surface is outside terminal flex flow')
        if(state==='released'){
          const previous=result.loadingLayouts.at(-2)
          assert.equal(observed.terminal.id,previous.terminal.id,'Releasing the original attach keeps the same xterm')
        }
      }
    }finally{await evaluate('loadingFixture.release()')}
  }
  assert.equal(result.frames.length,4,'Both actual widths have loading and released frames')
  assert.equal(result.loadingLayouts.length,4,'The actual layout observations are nonempty')
}
async function selection(label,width,input='mouse') {
  await seed(width);await identity();await open()
  await evaluate('identityMenu.focusNeighbor()');await painted()
  const conjunction=await evaluate(`({active:identityMenu.facts().active,open:${menu}?.dataset.state==='open'})`)
  assert.deepEqual(conjunction,{active:rightId,open:true})
  const before=await evaluate('identityMenu.facts()')
  const actual=label==='Split'?`([...${menu}.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()==='Split Down'))`:item(label)
  assert.equal(await evaluate(visible(actual)),true,'Actual selected menu item is visible')
  const menuPng=await capture(`${width}-${label.replaceAll(' ','-')}-${input}-conjunction`)
  // Capture must not change the focus fact. The capture listener also records this at the trusted click.
  assert.deepEqual(await evaluate(`({active:identityMenu.facts().active,open:${menu}?.dataset.state==='open'})`),conjunction)
  if(input==='touch'){
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...await point(actual),id:1}]})
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false})
  }else if(input==='keyboard'){await evaluate(`${actual}.focus()`);await key('Enter','Enter',13)}
  else await click(actual)
  await waitFor(`identityMenu.facts().selections.length>=${before.selections.length+2}`)
  await painted();const after=await evaluate('identityMenu.facts()'),events=after.selections.slice(before.selections.length)
  assert.equal(events.length,2,'Actual item event collection is nonempty and exact')
  assert.deepEqual(events.map(event=>event.type),input==='keyboard'?['keydown','click']:['pointerdown','click'])
  // Radix turns a real Enter key into HTMLElement.click(); preserve that provenance honestly.
  assert.equal(events[0].trusted,true);assert.equal(events[1].trusted,input!=='keyboard')
  for(const event of events){assert.equal(event.label,label==='Split'?'Split Down':label);assert.equal(event.owner,leftId);assert.equal(event.open,true);assert.equal(event.active,rightId)}
  if(input!=='keyboard')assert.equal(events[0].pointerType,input)
  assert.deepEqual(after.sessions,before.sessions);assert.equal(after.draft,before.draft)
  if(label==='Copy Region Address'){
    assert.equal(after.clipboard.length,before.clipboard.length+1);assert.equal(after.clipboard.at(-1),before.regionAddress)
    assert.equal(after.active,rightId)
  }else if(label==='Split'){
    const root=after.tab.layout.root;assert.equal(root.type,'split');assert.deepEqual(root.second,{type:'leaf',regionId:rightId})
    assert.equal(root.first.type,'split');assert.deepEqual(root.first.first,{type:'leaf',regionId:leftId})
    assert.equal(root.first.direction,'vertical');assert.equal(Object.keys(after.tab.regions).length,3)
  }else{
    assert.deepEqual(Object.keys(after.tab.regions),[rightId]);const moved=Object.values(after.tabs).filter(tab=>tab.id!==tabId&&tab.regions[leftId])
    assert.equal(moved.length,1);assert.deepEqual(Object.keys(moved[0].regions),[leftId]);assert.deepEqual(moved[0].regions[leftId],before.tab.regions[leftId])
  }
  result.selections.push({width,label,input,conjunction,menuPng,before,after})
}
app.whenReady().then(async()=>{
  try{
    await fs.mkdir(evidence,{recursive:true});win=new BrowserWindow({show:false,width:860,height:780,webPreferences:{backgroundThrottling:false,sandbox:false}})
    result.consoleErrors=[];win.webContents.on('console-message',details=>{if(details.level==='error')result.consoleErrors.push(details.message)})
    await win.loadFile(html);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await waitFor('Boolean(window.identityMenu)')
    if(probe==='terminal-loading-owning')await terminalLoadingVisual()
    else if(probe==='composer-visual'||probe==='composer-layout-owning'){
      await composerVisual(probe==='composer-layout-owning')
      await mailboxProof({win,evaluate,waitFor,visible,painted,click,key,point,seed,capture,result,surface})
    }
    else if(probe==='name'){await seed(640);result.names=await identity()}
    else if(probe==='target')await selection('Split',320)
    else if(probe.startsWith('swap-'))result.swap=await swapProof({win,evaluate,waitFor,painted,open,close,click,point,key,geometry,capture,probe,report:value=>result.swap=value})
    else{
      for(const width of [640,420,320])for(const mode of ['terminal','activity','history','cold','notice','search','readonly']){
        result.stage={width,mode};await seed(width,mode);const names=await identity()
        const hasTerminal=['terminal','history','notice','search','readonly'].includes(mode),before=await measurement(hasTerminal)
        await open('hover');const hover=await measurement(hasTerminal);assert.deepEqual(hover,before,'Hover preserves container, authoritative resize calls and actual xterm instance')
        const entries=await evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].map(item=>item.textContent.trim())`)
        assert.ok(entries.length>0);assert.equal(entries.filter(text=>text==='Conversation history').length,['cold','history'].includes(mode)?0:1)
        const menuPng=await capture(`${width}-${mode}-menu`);await close(false)
        await open('keyboard');const keyboard=await measurement(hasTerminal);assert.deepEqual(keyboard,before,'Keyboard disclosure preserves terminal facts');await close()
        const after=await measurement(hasTerminal);assert.deepEqual(after,before,'Menu dismissal preserves terminal facts')
        const hit=await geometry(mode==='readonly')
        for(const target of [hit.more,...(hit.close?[hit.close]:[])]){assert.equal(target.width,22);assert.equal(target.height,22);assert.equal(target.contained,true);assert.equal(target.hits.length,5);assert.ok(target.hits.every(Boolean))}
        if(mode==='readonly'){assert.equal(hit.readOnly,true);assert.equal(hit.inputs,0);assert.equal(hit.toggles,0)}else{assert.equal(hit.inputs,1);assert.equal(hit.toggles,1)}
        if(mode==='search')assert.equal(hit.search,true);if(mode==='notice')assert.equal(hit.notice,true)
        const png=await capture(`${width}-${mode}`);result.frames.push({width,mode,names,entries,before,hover,keyboard,after,hit,png,menuPng})
      }
      assert.equal(result.frames.length,21)
      for(const width of [640,320])for(const label of ['Copy Region Address','Split','Move to New Tab'])await selection(label,width)
      await selection('Copy Region Address',320,'touch');await selection('Copy Region Address',320,'keyboard')
      assert.equal(result.selections.length,8)
      result.swap=await swapProof({win,evaluate,waitFor,painted,open,close,click,point,key,geometry,capture,probe,report:value=>result.swap=value})
    }
    result.passed=true
  }catch(error){result.failure={name:error.name,message:error.message,stack:error.stack,stage:result.stage}}
  finally{
    if(win&&!win.isDestroyed())result.mailboxInputs??=await evaluate('window.identityMenu?.mailboxInputs?.()??[]')
    await fs.writeFile(path.join(evidence,'render.json'),JSON.stringify(result,null,2));win?.destroy();app.exit(result.passed?0:1)
  }
})
