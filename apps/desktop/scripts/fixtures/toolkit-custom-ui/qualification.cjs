const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

// A bounded real desktop consumer. Scene controls never replace Toolkit/Main/Run facts.
module.exports = async function qualify(c) {
  const {win,raw,owner,store,toolkit,read,until,click,frame,pause,work,privateRoot,evidence,cli,stage}=c
  const signal=()=>new AbortController().signal
  const settings='.surface-navigation [aria-label="Settings"]'
  const result='.performance-popover'
  const trigger=id=>`button[data-toolkit-id="${id}"]`
  raw.qualificationScope='toolkit-custom-ui'
  raw.boundary='Actual private App, product preload, unique ConfigOwner/ToolkitOwner, compiled CLI and public Core Raw Runtime. Terminal Session input/attachment is real; this does not qualify an Agent Provider resume or user App installation.'
  raw.desktop={settingsCliDurable:false,capturedAction:false,focusAndKeyboard:false,originalWorkbenchExact:false,singleModelCost:false}
  raw.cli=[];raw.states=[];raw.keyboard=[]
  const key=async(keyCode,modifiers=[])=>{raw.actions.push({type:'trusted-key',keyCode,modifiers,at:Date.now()});win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Return')win.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await pause(30)}
  const text=async(selector,value)=>{await click(selector);await read(`document.querySelector(${JSON.stringify(selector)}).select()`);await win.webContents.insertText(value);await pause(30);assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`),value,'Native text entry retains the exact authored value')}
  const script=async value=>{await until('document.querySelector(".toolkit-editor .monaco-editor textarea")?.isConnected');await click('.toolkit-editor .monaco-editor textarea');await key('A',['meta']);await win.webContents.insertText(value);await until(`window.toolkitScene.scriptValue().then(value=>value===${JSON.stringify(value)})`)}
  const get=async id=>{const value=(await toolkit.execute({operation:'toolkit.get',toolId:id},signal())).snapshot;raw.lastStatusById={...raw.lastStatusById,[id]:value};return value}
  const update=async(id,changes)=>{const before=owner.current.toolkit.tools.find(t=>t.id===id);assert.ok(before);return (await toolkit.execute({operation:'toolkit.update',toolId:id,changes,expected:Object.fromEntries(Object.keys(changes).map(key=>[key,before[key]]))},signal())).definition}
  const cliCall=(...args)=>{
    const record={args,startedAt:Date.now(),stdout:'',stderr:'',code:null};raw.cli.push(record)
    const child=spawn(process.execPath,[cli,'--endpoint',`unix:${path.join(privateRoot,'runtime','control.sock')}`,...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AGENTMUX_AGENT_SESSION_ID:undefined,AGENTMUX_AGENT_CAPABILITY:undefined},stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',b=>record.stdout+=b);child.stderr.on('data',b=>record.stderr+=b)
    return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{record.code=code;record.endedAt=Date.now();try{assert.equal(code,0,record.stderr);const frames=record.stdout.split('\n').filter(Boolean).map(JSON.parse);assert.equal(frames.length,1,'Actual compiled CLI has one complete frame');resolve(frames[0])}catch(error){reject(error)}})})
  }
  const cliUpdate=async(id,changes,expected,basename)=>{const file=path.join(privateRoot,basename+'.json');await fs.writeFile(file,JSON.stringify({changes,expected}));return cliCall('toolkit','update',id,'--input',file)}
  const opened=()=>read(`document.querySelector(${JSON.stringify(result)})?.checkVisibility({visibilityProperty:true})===true`)
  const close=async()=>{if(await opened()){await click('[data-toolkit-close]');await until(`!document.querySelector(${JSON.stringify(result)})`)}await pause(40)}
  const open=async id=>{await close();await click(trigger(id));const name=owner.current.toolkit.tools.find(t=>t.id===id).name;await until(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')===${JSON.stringify(name)}&&document.querySelector('.performance-status')?.textContent`)}
  const save=async()=>{await click('.toolkit-editor [data-settings-save-bar] button');await until('document.querySelector(".toolkit-editor__status").textContent==="Saved"')}
  const showSettings=async()=>{if(await read(`document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded')!=='true'`))await click(settings);await click('[data-settings-target="toolkit"]');await until('document.querySelector(".toolkit-library")?.checkVisibility()')}
  const hideSettings=async()=>{if(await read(`document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded')==='true'`))await click(settings);await until('window.toolkitScene.models().then(models=>models.length===0)')}
  const finish=async(id,state='succeeded')=>{const deadline=Date.now()+8000;let value;do{value=await get(id);if(value.admission===null&&value.state===state)break;assert.ok(Date.now()<deadline,'The actual captured script reaches its authoritative terminal state');await pause(20)}while(true);return value}
  const run=async id=>{await open(id);await click('.toolkit-result__actions > button:first-child');return get(id)}
  const picture=async(file,scene,expectedState)=>{if(expectedState){await until(`document.querySelector('.performance-status')?.dataset.state===${JSON.stringify(expectedState)}`);raw.states.push({file,toolId:await read(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')`),state:expectedState})}await frame(file,scene)}

  // No second-process setState or layout seed: actual App boot restored this Terminal leaf.
  const healthy=await read('window.toolkitScene.setup.healthy')
  assert.ok(healthy?.runId&&healthy.pid>0)
  await until(`window.toolkitScene.attachments.some(value=>value.session.control.run.runId===${JSON.stringify(healthy.runId)})&&document.querySelector('.xterm-helper-textarea')?.isConnected`)
  raw.sessionAttach=(await read('window.toolkitScene.attachments')).find(value=>value.session.control.run.runId===healthy.runId)
  assert.equal(raw.sessionAttach.session.control.kind,'terminal');raw.sessionAttach.runId=healthy.runId
  await click('.xterm-screen');await win.webContents.insertText('gui-'+stage);await key('Return')
  await until(`window.toolkitScene.writes.some(value=>value.control.run.runId===${JSON.stringify(healthy.runId)}&&String(value.data).includes('gui-${stage}'))`)
  await until(`window.toolkitScene.terminalReplay().then(value=>value.gap===null&&value.replay.map(chunk=>chunk.data).join('').includes('ACK:gui-${stage}'))`)
  await until('window.toolkitScene.terminalObservation()?.liveReady===true&&window.toolkitScene.terminalObservation().visible===true&&window.toolkitScene.terminalObservation().acceptsInput===true')
  raw.terminalInput={control:healthy,rendererWrites:await read('window.toolkitScene.writes'),mainWrites:raw.sessionCalls.writes.slice(),replay:await read('window.toolkitScene.terminalReplay()'),view:await read('window.toolkitScene.terminalObservation()')}

  await picture(stage+'-1480-dark-terminal.png',{theme:'dark',settingsExpanded:'false'})
  if(stage==='restart'){
    assert.equal(await read('window.toolkitScene.setup.stage'),'restart')
    await open('summary');await picture('restart-1480-dark-confirmed.png',{theme:'dark',settingsExpanded:'false'},'succeeded')
    raw.restoredResult=await get('summary');assert.ok(raw.restoredResult.latestConfirmed?.text.includes('Everything is ready'))
    await close();raw.desktop.originalWorkbenchExact=true;return
  }

  const original=structuredClone(owner.current)
  const initialSummary=original.toolkit.tools.find(t=>t.id==='summary')
  await showSettings();await picture('1480-dark-library.png',{theme:'dark',view:'library',libraryVisible:true,settingsExpanded:'true'})
  await click('[data-tool-id="summary"]');await until('window.toolkitScene.models().then(models=>models.length===1)')
  await picture('1480-dark-editor.png',{theme:'dark',view:'editor',editor:'summary',settingsExpanded:'true'})
  await read('window.toolkitScene.theme("light")');await picture('1480-light-editor.png',{theme:'light',view:'editor',editor:'summary',settingsExpanded:'true'});await read('window.toolkitScene.theme("dark")')
  await click('.toolkit-editor__result-actions > summary');await click('[data-toolkit-edit-action="refresh"]')
  await until('window.toolkitScene.models().then(models=>models.length===1&&models[0].path==="/summary/actions/refresh.mjs")')
  await picture('1480-dark-action-editor.png',{theme:'dark',view:'editor',editor:'summary'})
  await text('.toolkit-editor__action-heading input','Refresh identity from result')
  await script("console.log('Native action edit accepted')")
  await save()
  const editedAction=(await cliCall('toolkit','inspect','summary')).result.snapshot.definition.actions[0]
  assert.equal(editedAction.label,'Refresh identity from result');assert.equal(editedAction.script,"console.log('Native action edit accepted')")
  await text('.toolkit-editor__action-heading input',initialSummary.actions[0].label)
  await script(initialSummary.actions[0].script);await save()
  await click('.toolkit-editor__action-heading > button')
  await text('.toolkit-editor__name input','Authored workspace check')
  await save()
  const saved=await cliCall('toolkit','inspect','summary')
  assert.equal(saved.result.snapshot.definition.name,'Authored workspace check')
  assert.deepEqual((await store.get()).toolkit.tools,owner.current.toolkit.tools,'Actual durable ConfigStore and CLI use the same definition')
  assert.equal(saved.result.snapshot.latestConfirmed,null,'Saving does not execute')
  raw.savedDefinition=saved.result.snapshot.definition

  await click('.toolkit-workbench__toolbar > button')
  await until('document.querySelector(".toolkit-editor__name input")?.value===""')
  const createdId=await read('document.querySelector("[data-tool-editor]").dataset.toolEditor')
  await text('.toolkit-editor__name input','Created in the real Settings UI')
  await text('.toolkit-editor__fields input:not([type])',work)
  await click('.toolkit-icon-picker > summary');await click('.toolkit-icon-picker label:has(input[value="key-round"])')
  await key('Escape')
  await click('.toolkit-editor .toolkit-settings__choices label:has(input[value="label"])')
  const createdScript="console.log('UI_CREATED_ACK')"
  await script(createdScript)
  await click('.toolkit-editor__arguments > summary');await click('.toolkit-editor__arguments > button')
  await text('.toolkit-argument input','literal argument')
  await save()
  const created=(await cliCall('toolkit','inspect',createdId)).result.snapshot
  assert.deepEqual({...created.definition,id:undefined,revision:undefined},{id:undefined,revision:undefined,name:'Created in the real Settings UI',icon:'key-round',enabled:true,statusBar:'label',workspacePath:work,script:createdScript,args:['literal argument'],actions:[]})
  assert.equal(created.admission,null);assert.equal(created.latestConfirmed,null)
  raw.createdViaSettings=created
  await click('.toolkit-editor__footer > button');await click('.confirmation-dialog [data-confirm-label="Delete tool"]')
  await until(`!window.toolkitScene.display().tools.some(t=>t.id===${JSON.stringify(createdId)})`)
  await click('[data-tool-id="summary"]');await until('window.toolkitScene.models().then(models=>models.length===1&&models[0].path==="/summary.mjs")')

  // Native authored pending input must retain the original sibling expected value.
  await read('window.toolkitScene.holdSave()')
  const externalScript="console.log('CLI accepted sibling C')"
  const external=cliUpdate('summary',{script:externalScript},{script:initialSummary.script},'pending-cli')
  await until('window.toolkitScene.saveHeld()')
  await text('.toolkit-editor__name input','Name saved while CLI waits')
  await click('.toolkit-editor [data-settings-save-bar] button')
  await until('document.querySelector(".toolkit-editor__status").textContent==="Saving…"')
  const authoredScript="console.log('Authored pending U')"
  await script(authoredScript)
  await read('window.toolkitScene.releaseSave()');const externalReply=await external
  await until('document.querySelector(".toolkit-editor__status").textContent==="Unsaved"')
  assert.equal((await get('summary')).definition.script,externalScript)
  await click('.toolkit-editor [data-settings-save-bar] button')
  await until('document.querySelector(".toolkit-editor [data-settings-save-bar] [role=alert]")?.textContent.length>0')
  assert.equal((await get('summary')).definition.script,externalScript,'Conflict does not overwrite the CLI sibling')
  raw.pendingConflict={externalReply,current:await get('summary'),draft:authoredScript,error:await read('document.querySelector(".toolkit-editor [data-settings-save-bar] [role=alert]").textContent')}
  await read('document.querySelector(".toolkit-editor [data-settings-save-bar]").scrollIntoView({block:"end"})')
  await picture('1480-dark-conflict.png',{theme:'dark',view:'editor',editor:'summary'})
  // Captured CLI repair is deliberate, never an automatic retry of the rejected UI write.
  await cliUpdate('summary',{script:initialSummary.script,name:initialSummary.name},{script:externalScript,name:'Name saved while CLI waits'},'restore-after-conflict')
  await script(initialSummary.script)
  await text('.toolkit-editor__name input',initialSummary.name)
  await until('document.querySelector(".toolkit-editor__status").textContent==="Saved"')

  // The passive layer never takes cancellation away from the actual Monaco input.
  await click('.toolkit-editor .monaco-editor textarea')
  await read('window.toolkitInputNode=document.activeElement;window.toolkitSettingsNode=document.querySelector(".settings-page")')
  assert.equal(await read('window.toolkitInputNode.isConnected&&!!window.toolkitInputNode.closest(".monaco-editor")&&document.querySelector(".toolkit-editor .monaco-editor").checkVisibility({visibilityProperty:true})'),true,'The original focused input belongs to the actual visible connected Monaco editor')
  const monacoKeys=await read('window.toolkitScene.events.length')
  const monacoHover=await read(`(()=>{const b=document.querySelector(${JSON.stringify(trigger('summary'))}).getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`)
  win.webContents.sendInputEvent({type:'mouseMove',...monacoHover})
  await until(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')===${JSON.stringify(initialSummary.name)}`)
  assert.equal(await read('document.activeElement===window.toolkitInputNode'),true,'Actual Monaco focus stays with its original input during hover')
  await key('Escape');await until(`!document.querySelector(${JSON.stringify(result)})`)
  raw.monacoEscape=await read(`({focusSame:document.activeElement===window.toolkitInputNode,inputConnected:window.toolkitInputNode.isConnected,settingsSame:document.querySelector('.settings-page')===window.toolkitSettingsNode,settingsExpanded:document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded'),keys:window.toolkitScene.events.slice(${monacoKeys})})`)
  assert.equal(raw.monacoEscape.focusSame,true);assert.equal(raw.monacoEscape.inputConnected,true);assert.equal(raw.monacoEscape.settingsSame,true);assert.equal(raw.monacoEscape.settingsExpanded,'true')
  assert.ok(raw.monacoEscape.keys.length>0&&raw.monacoEscape.keys.some(event=>event.key==='Escape'&&event.isTrusted&&event.originalInputTarget),'The actual original Monaco input receives the native Escape')
  assert.equal(await read('window.toolkitScene.scriptValue()'),initialSummary.script,'Passive Escape preserves the actual selected script model')

  // A visited draft survives a real same-target Configure route, without remounting the editor.
  await text('.toolkit-editor__name input','Visited unsaved draft')
  await read('window.toolkitDraftNode=document.querySelector(".toolkit-editor__name input")')
  win.setContentSize(640,800);await until('document.querySelector(".toolkit-editor .toolkit-editor__back")?.checkVisibility()')
  await click('.toolkit-editor .toolkit-editor__back');await open('summary');await click('.toolkit-result__actions > button:last-child')
  await until('document.querySelector(".toolkit-workbench").dataset.view==="editor"')
  assert.equal(await read('document.querySelector(".toolkit-editor__name input")===window.toolkitDraftNode'),true)
  assert.equal(await read('document.querySelector(".toolkit-editor__name input").value'),'Visited unsaved draft')
  win.setContentSize(1480,900);await until('document.querySelector(".settings-sidebar [data-settings-target=general]")?.checkVisibility()')
  await click('.settings-sidebar [data-settings-target="general"]');await open('summary');await click('.toolkit-result__actions > button:last-child')
  await until('document.querySelector(".toolkit-editor__name input")?.value==="Visited unsaved draft"')
  assert.equal(await read('document.querySelector(".toolkit-editor__name input")===window.toolkitDraftNode'),true,'Same target reopens the actual existing editor node')
  await text('.toolkit-editor__name input',initialSummary.name)
  await hideSettings()

  // Passive hover never creates a Run or steals original Terminal input.
  await click('.xterm-screen')
  const inputBefore=await read('document.activeElement.className')
  const beforeHover=await cliCall('toolkit','inspect','summary')
  const hover=await read(`(()=>{const n=document.querySelector(${JSON.stringify(trigger('summary'))}),b=n.getBoundingClientRect();return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`)
  win.webContents.sendInputEvent({type:'mouseMove',...hover})
  await until(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')==='Workspace summary'`)
  assert.equal(await read('document.activeElement.className'),inputBefore)
  assert.equal((await get('summary')).admission,null);assert.equal(beforeHover.result.snapshot.latestConfirmed,null)
  await key('Escape');await until(`!document.querySelector(${JSON.stringify(result)})`)
  assert.equal(await read('document.activeElement.className'),inputBefore,'Passive Escape retains the real Terminal input')
  raw.hover={before:beforeHover.result.snapshot,after:await get('summary'),focus:inputBefore,create:0}

  await open('summary');await key('Escape')
  assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(trigger('summary'))})`),true,'Explicit close restores its exact original trigger')
  raw.triggerKeyboard=[]
  for(const activation of ['Return','Space']){
    await key(activation)
    await until(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')===${JSON.stringify(initialSummary.name)}`)
    assert.equal(await read(`document.activeElement.isConnected&&document.activeElement.checkVisibility()&&!!document.activeElement.closest(${JSON.stringify(result)})`),true,'Native keyboard activation enters only the selected nonmodal result')
    raw.triggerKeyboard.push({activation,focused:await read('document.activeElement.outerHTML')})
    await key('Escape');await until(`!document.querySelector(${JSON.stringify(result)})`)
    assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(trigger('summary'))})`),true,'Native Escape restores the same selected trigger')
  }
  await key('Return');await until(`document.querySelector(${JSON.stringify(result)})?.getAttribute('aria-label')===${JSON.stringify(initialSummary.name)}`)
  await picture('1480-dark-not-run.png',{theme:'dark',settingsExpanded:'false'},'idle')
  await key('Tab');raw.keyboard.push({operation:'Tab',focused:await read('document.activeElement.outerHTML')})
  assert.equal(await read(`document.activeElement.isConnected&&document.activeElement.checkVisibility()&&!!document.activeElement.closest(${JSON.stringify(result)})`),true)
  await key('Tab',['shift']);raw.keyboard.push({operation:'Shift+Tab',focused:await read('document.activeElement.outerHTML')})
  assert.equal(await read(`document.activeElement.isConnected&&document.activeElement.checkVisibility()&&!!document.activeElement.closest(${JSON.stringify(result)})`),true)
  await click('.toolkit-result__actions > button:first-child');await finish('summary')
  await until('document.querySelector("[data-toolkit-output]")?.textContent.includes("Everything is ready")')
  const source=await get('summary');raw.confirmedSource=source
  await picture('1480-dark-success.png',{theme:'dark',settingsExpanded:'false'},'succeeded')
  await click('.toolkit-result__details > summary');assert.equal(await read('document.querySelector(".toolkit-result__details").open'),true)
  await picture('1480-dark-details.png',{theme:'dark',settingsExpanded:'false'},'succeeded')
  await click('[data-toolkit-action="refresh"]');const action=await finish('summary')
  await until('document.querySelector("[data-toolkit-output]")?.textContent.includes("Identity refreshed")')
  assert.equal(action.latestConfirmed.action.id,'refresh');assert.equal(action.latestConfirmed.action.sourceExecutionId,source.latestConfirmed.executionId)
  assert.equal(action.latestConfirmed.definition.revision,source.latestConfirmed.definition.revision);assert.equal(action.latestConfirmed.target.workspacePath,work)
  assert.notEqual(action.latestConfirmed.executionId,source.latestConfirmed.executionId);assert.ok(action.latestConfirmed.run.runId)
  assert.deepEqual((await cliCall('toolkit','inspect','summary')).result.snapshot.latestConfirmed,action.latestConfirmed)
  raw.capturedAction={source:source.latestConfirmed,result:action.latestConfirmed};raw.desktop.capturedAction=true
  await picture('1480-dark-action-result.png',{theme:'dark',settingsExpanded:'false'},'succeeded')
  await click('.toolkit-result__actions > button:nth-last-child(2)');await until('document.querySelector(".toolkit-result__script")?.checkVisibility()')
  assert.equal(await read('document.querySelector(".toolkit-result__script").value'),source.latestConfirmed.definition.actions[0].script)
  await picture('1480-dark-captured-script.png',{theme:'dark',settingsExpanded:'false'})
  const resultState = () => read(`(()=>{const dialog=document.querySelector('.performance-popover');const control=dialog?.querySelector('[data-toolkit-action="refresh"]');return{dialog:dialog?.getAttribute('aria-label')??null,dialogConnected:dialog?.isConnected??false,scriptVisible:dialog?.querySelector('.toolkit-result__script')?.checkVisibility()??false,output:dialog?.querySelector('[data-toolkit-output]')?.textContent??null,actionConnected:control?.isConnected??false,actionVisible:control?.checkVisibility({visibilityProperty:true})??false,actionDisabled:control?.disabled??null}})()`)
  assert.equal(await read('document.querySelector(".toolkit-result > button.small-button")?.textContent.trim()'),'Back to result','The exact visible script-return control')
  await click('.toolkit-result > button.small-button')
  raw.scriptReturn={immediate:await resultState()}
  await until(`(()=>{const p=document.querySelector('.performance-popover[aria-label="Workspace summary"]');const a=p?.querySelector('[data-toolkit-action="refresh"]');return !!a?.isConnected&&a.checkVisibility({visibilityProperty:true})&&!a.disabled&&!p.querySelector('.toolkit-result__script')})()`)
  raw.scriptReturn.connected=await resultState()
  const configBefore=action.definition
  await cliUpdate('summary',{actions:[{...configBefore.actions[0],script:"console.log('Changed action target')"}]},{actions:configBefore.actions},'changed-action')
  raw.scriptReturn.afterConfiguration=await resultState()
  await until(`(()=>{const p=document.querySelector('.performance-popover[aria-label="Workspace summary"]');const a=p?.querySelector('[data-toolkit-action="refresh"]');return !!a?.isConnected&&a.checkVisibility({visibilityProperty:true})&&!a.disabled})()`)
  await click('[data-toolkit-action="refresh"]');await until('document.querySelector(".toolkit-result [role=alert]")?.textContent.length>0')
  const conflictedAction=await get('summary')
  assert.deepEqual(conflictedAction.latestConfirmed,action.latestConfirmed,'A stale result button preserves the original confirmed action')
  assert.equal(conflictedAction.admission,null,'A stale result button cannot launch a different saved action')
  raw.actionConflict={error:await read('document.querySelector(".toolkit-result [role=alert]").textContent'),latest:action.latestConfirmed,snapshot:conflictedAction}
  await close();await update('summary',{actions:initialSummary.actions})

  // Long live output stays owned by the manual execution when the hover reader closes.
  const identity=original.toolkit.tools.find(t=>t.id==='identity')
  await update('identity',{script:"console.log('LIVE_BEGIN');await new Promise(resolve=>setTimeout(resolve,1600));console.log(Array.from({length:240},(_,i)=>'Line '+i+' · retained local result').join('\\n'))"})
  await run('identity');await until('document.querySelector(".performance-status")?.dataset.state==="running"')
  const live=await get('identity');assert.ok(live.admission?.run?.runId)
  await picture('1480-dark-running.png',{theme:'dark',settingsExpanded:'false'},'running')
  await close();const still=await cliCall('toolkit','inspect','identity')
  assert.equal(still.result.snapshot.admission.executionId,live.admission.executionId,'Closing only disposes this reader, not the script')
  assert.equal(still.result.snapshot.consumerCount,0)
  await finish('identity');await open('identity');await picture('1480-dark-long-result.png',{theme:'dark',settingsExpanded:'false'},'succeeded')
  win.setContentSize(320,800);await read('window.toolkitScene.theme("light")');await picture('320-light-long-result.png',{theme:'light',settingsExpanded:'false'},'succeeded')
  await close();win.setContentSize(1480,900);await read('window.toolkitScene.theme("dark")')
  await update('identity',{script:'process.exitCode=3;console.error("Local check failed clearly")'});await run('identity');await finish('identity','failed')
  await picture('1480-dark-failed.png',{theme:'dark',settingsExpanded:'false'},'failed');await close()
  await update('identity',{script:'/* Explicit successful empty output. */'});await run('identity');const empty=await finish('identity')
  assert.equal(empty.latestConfirmed.text,'');await until('document.querySelector(".toolkit-result__empty")?.textContent.includes("No output")')
  await picture('1480-dark-empty-result.png',{theme:'dark',settingsExpanded:'false'},'succeeded');await close()

  // A real durable receipt write failure leaves unknown. No fabricated DTO/result callback.
  await update('identity',{script:"console.log('UNKNOWN_RECEIPT_CONTROL');await new Promise(resolve=>setTimeout(resolve,700))"})
  await run('identity');await until('document.querySelector(".performance-status")?.dataset.state==="running"')
  const beforeUnconfirmed=structuredClone(await get('identity'))
  assert.equal(beforeUnconfirmed.state,'running');assert.ok(beforeUnconfirmed.admission?.executionId&&beforeUnconfirmed.admission.run?.runId)
  const receipts=path.join(privateRoot,'userData','toolkit-receipts.json'),backup=receipts+'.before-controlled-fault'
  await fs.rename(receipts,backup);await fs.mkdir(receipts)
  try{
    await until('document.querySelector(".performance-status")?.dataset.state==="unknown"')
    const unknown=await get('identity');assert.equal(unknown.state,'unknown');assert.ok(unknown.admission?.run?.runId)
    assert.ok(unknown.reason?.trim(),'Unknown states its actual failed confirmation step')
    assert.equal(unknown.admission.executionId,beforeUnconfirmed.admission.executionId);assert.deepEqual(unknown.admission.run,beforeUnconfirmed.admission.run,'Unknown preserves the exact actual Run')
    assert.deepEqual(unknown.latestConfirmed,empty.latestConfirmed,'A failed receipt never discards the original confirmed result')
    assert.equal(await read('document.querySelector(".toolkit-result__actions > button:first-child").disabled'),true,'Unknown cannot silently run again')
    raw.unknown={before:beforeUnconfirmed,snapshot:unknown,cause:'Owned receipt destination temporarily replaced by a directory; original bytes preserved.'}
    await picture('1480-dark-unknown.png',{theme:'dark',settingsExpanded:'false'},'unknown')
  }finally{await fs.rmdir(receipts);await fs.rename(backup,receipts)}
  await click('.toolkit-result__actions > button:nth-child(2)')
  const recovered=await finish('identity')
  assert.equal(recovered.latestConfirmed.executionId,raw.unknown.snapshot.admission.executionId)
  assert.equal(recovered.latestConfirmed.exitCode,0);assert.equal(recovered.latestConfirmed.state,'succeeded')
  for(const field of ['definition','target','run','text'])assert.deepEqual(recovered.latestConfirmed[field],raw.unknown.snapshot.admission[field],'Recovery retains the exact captured '+field)
  assert.notEqual(recovered.latestConfirmed.executionId,empty.latestConfirmed.executionId,'Recovery confirms this execution instead of substituting the old result')
  const rejectedStops=raw.runPortStops.filter(value=>value.runId===recovered.latestConfirmed.run.runId)
  assert.equal(rejectedStops.length,1);assert.equal(rejectedStops[0].accepted,false);assert.ok(rejectedStops[0].error,'The actual Core stop rejection is observed, never inferred from the final result')
  assert.deepEqual((await cliCall('toolkit','inspect','identity')).result.snapshot.latestConfirmed,recovered.latestConfirmed)
  raw.stopRecovery={before:raw.unknown.snapshot,confirmed:recovered,stop:rejectedStops[0],oldConfirmed:empty.latestConfirmed}
  await close()

  // A different still-live execution provides the genuine accepted Stop control.
  await update('identity',{script:"console.log('LIVE_STOP_CONTROL');await new Promise(resolve=>setTimeout(resolve,6000));console.log('UNEXPECTED_AFTER_STOP')"})
  await run('identity');await until('document.querySelector(".performance-status")?.dataset.state==="running"')
  await until('document.querySelector("[data-toolkit-output]")?.textContent.includes("LIVE_STOP_CONTROL")')
  const beforeAcceptedStop=structuredClone(await get('identity'));assert.equal(beforeAcceptedStop.state,'running');assert.ok(beforeAcceptedStop.admission?.run?.runId)
  assert.ok(beforeAcceptedStop.admission.text.includes('LIVE_STOP_CONTROL'),'The actual still-live execution produced nonempty terminal text before trusted Stop')
  await click('.toolkit-result__actions > button:nth-child(2)')
  const acceptedStop=await finish('identity','stopped')
  assert.equal(acceptedStop.latestConfirmed.executionId,beforeAcceptedStop.admission.executionId)
  assert.deepEqual(acceptedStop.latestConfirmed.definition,beforeAcceptedStop.admission.definition);assert.deepEqual(acceptedStop.latestConfirmed.target,beforeAcceptedStop.admission.target);assert.deepEqual(acceptedStop.latestConfirmed.run,beforeAcceptedStop.admission.run)
  assert.ok(acceptedStop.latestConfirmed.text.includes('LIVE_STOP_CONTROL'));assert.equal(acceptedStop.latestConfirmed.text.includes('UNEXPECTED_AFTER_STOP'),false)
  const acceptedStops=raw.runPortStops.filter(value=>value.runId===acceptedStop.latestConfirmed.run.runId)
  assert.equal(acceptedStops.length,1);assert.equal(acceptedStops[0].accepted,true);assert.equal(acceptedStops[0].error,undefined)
  raw.acceptedStop={before:beforeAcceptedStop,confirmed:acceptedStop,stop:acceptedStops[0]}
  await close()
  await update('identity',{script:identity.script})

  // Real narrow/wide library/editor scenes and configuration geometry.
  await showSettings();await click('[data-tool-id="summary"]');await until('window.toolkitScene.models().then(models=>models.length===1)')
  win.setContentSize(320,800);await picture('320-dark-editor.png',{theme:'dark',view:'editor',editor:'summary',settingsExpanded:'true'})
  await click('.toolkit-editor .toolkit-editor__back');await picture('320-dark-library.png',{theme:'dark',view:'library',libraryVisible:true})
  await click('[data-tool-id="summary"]');await read('window.toolkitScene.theme("light")');await picture('320-light-editor.png',{theme:'light',view:'editor',editor:'summary'})
  await hideSettings();await read('window.toolkitScene.theme("dark")');win.setContentSize(1480,900)
  await update('identity',{name:'Identity, authentication and account details for this local workspace'})
  raw.geometry=[]
  for(const width of [1480,640,320])for(const mode of ['icon','label','disabled']){
    win.setContentSize(width,800)
    await owner.edit(owner.current,{...owner.current,toolkit:{...owner.current.toolkit,performance:{enabled:mode!=='disabled',statusBar:mode==='label'?'label':'icon'}}})
    for(const definition of owner.current.toolkit.tools)await update(definition.id,{enabled:mode!=='disabled',statusBar:mode==='label'?'label':'icon'})
    await until(`window.toolkitScene.display()?.tools.length===2&&window.toolkitScene.display().tools.every(t=>t.enabled===${mode!=='disabled'}&&t.statusBar===${JSON.stringify(mode==='label'?'label':'icon')})`)
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const geometry=await read(`(()=>{const rect=n=>({x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}),visible=n=>n.isConnected&&n.checkVisibility({visibilityProperty:true}),nav=document.querySelector('.surface-navigation'),group=document.querySelector('.window-status-bar__toolkits'),bar=document.querySelector('.toolkit-statusbar');return{viewport:innerWidth,settings:Array.from(document.querySelectorAll('button[aria-label="Settings"]')).filter(visible).map(n=>({rect:rect(n),left:!!n.closest('.surface-navigation'),right:!!n.closest('.window-status-bar__toolkits')})),nav:rect(nav),group:rect(group),direction:getComputedStyle(bar).flexDirection,tools:Array.from(bar.querySelectorAll('button.performance-trigger')).filter(visible).map(n=>({id:n.dataset.toolkitId??null,name:n.getAttribute('aria-label'),label:n.querySelector(':scope>span')?.textContent??null,rect:rect(n)}))}})()`)
    geometry.controls=await read(`Array.from(document.querySelectorAll('.window-status-bar__right button')).filter(n=>n.isConnected&&n.checkVisibility({visibilityProperty:true})).map(n=>{const b=n.getBoundingClientRect();return{name:n.getAttribute('aria-label'),x:b.x,y:b.y,width:b.width,height:b.height}})` )
    assert.ok(geometry.controls.length>0,'Actual right-side control geometry is nonempty')
    assert.equal(geometry.controls.filter(control=>control.name==='Keyboard shortcuts').length,1,'The actual Keyboard entry remains in the measured control set')
    for(const control of geometry.controls)assert.ok(control.width>0&&control.height>0&&control.x>=-0.5&&control.x+control.width<=width+0.5,'Every measured control remains within the actual viewport')
    for(let i=0;i<geometry.controls.length;i++)for(let j=i+1;j<geometry.controls.length;j++){const a=geometry.controls[i],b=geometry.controls[j];assert.ok(a.x+a.width<=b.x+0.5||b.x+b.width<=a.x+0.5||a.y+a.height<=b.y+0.5||b.y+b.height<=a.y+0.5,'Actual keyboard/tool controls do not overlap')}
    assert.equal(geometry.viewport,width);assert.equal(geometry.settings.length,1);assert.equal(geometry.settings[0].left,true);assert.equal(geometry.settings[0].right,false);assert.equal(geometry.direction,'row-reverse')
    assert.ok(geometry.nav.x+geometry.nav.width<=geometry.group.x+0.5)
    if(mode==='disabled')assert.equal(geometry.tools.length,0)
    else{assert.ok(geometry.tools.length>0);const performance=geometry.tools.find(tool=>tool.id==='performance');assert.ok(performance);for(const tool of geometry.tools){assert.ok(tool.rect.width>0&&tool.rect.x>=geometry.group.x-0.5&&tool.rect.x+tool.rect.width<=width+0.5);if(tool.id!=='performance')assert.ok(tool.rect.x+tool.rect.width<=performance.rect.x+0.5);if(mode==='label'&&tool.id)assert.ok(tool.label?.trim())}}
    const direct=geometry.tools.map(tool=>tool.id).filter(id=>id&&id!=='performance'),overflow=[]
    if(mode!=='disabled'&&geometry.tools.some(tool=>tool.id===null)){
      await click('.toolkit-statusbar button[aria-label="More tools"]');await until('document.querySelector(".toolkit-overflow__item")?.checkVisibility()')
      const names=await read('Array.from(document.querySelectorAll(".toolkit-overflow__item")).map(n=>n.textContent)')
      assert.ok(names.length>0,'Named overflow is nonempty')
      for(const name of names){const def=owner.current.toolkit.tools.find(t=>t.name===name);assert.ok(def,'Overflow exposes the exact saved accessible name');overflow.push(def.id)}
      if(width===320&&mode==='label'){
        const id=overflow[overflow.length-1],name=owner.current.toolkit.tools.find(t=>t.id===id).name
        await click('.toolkit-overflow__item:last-child');await until(`document.querySelector('.performance-title h2')?.textContent===${JSON.stringify(name)}`)
        assert.equal((await get(id)).consumerCount,1,'Native overflow selection subscribes the exact selected Main tool')
        for(const other of owner.current.toolkit.tools.filter(t=>t.id!==id))assert.equal((await get(other.id)).consumerCount,0)
        geometry.overflowSelected={id,name,snapshot:await get(id)}
        await picture('320-dark-named-overflow-result.png',{theme:'dark',settingsExpanded:'false'})
      }
      await close()
    }
    const expected=mode==='disabled'?[]:owner.current.toolkit.tools.filter(t=>t.enabled).map(t=>t.id)
    assert.deepEqual([...direct,...overflow].sort(),expected.sort(),'Direct and named overflow exactly cover every enabled user tool, without omissions or duplicates')
    geometry.coverage={direct,overflow,expected}
    if(width===320&&mode==='label')assert.ok(overflow.length>0,'Actual long name exercises narrow overflow')
    raw.geometry.push({width,mode,...geometry})

  }
  assert.equal(raw.geometry.length,9)
  for(const width of [1480,640,320]){const entries=raw.geometry.filter(v=>v.width===width);for(const scene of entries)assert.deepEqual(scene.settings[0].rect,entries[0].settings[0].rect)}
  await owner.edit(owner.current,{...owner.current,toolkit:{...owner.current.toolkit,performance:original.toolkit.performance}})
  for(const definition of original.toolkit.tools)await update(definition.id,{name:definition.name,enabled:definition.enabled,statusBar:definition.statusBar})
  win.setContentSize(1480,900)

  // True Monaco allocation, with unrelated Store inputs; functional render cost is separate.
  const costConfig=structuredClone(owner.current),seed=costConfig.toolkit.tools.find(t=>t.id==='summary')
  const actions=Array.from({length:16},(_,i)=>({id:'cost-action-'+i,label:'Action '+i,script:'console.log('+i+')',args:[]}))
  await owner.edit(owner.current,{...owner.current,hosts:[...owner.current.hosts,...Array.from({length:8-owner.current.hosts.length},(_,i)=>({id:'cost-host-'+i,kind:'ssh',label:'Cost Host '+i,hostname:'cost-'+i+'.invalid'}))],toolkit:{...owner.current.toolkit,tools:[{...seed,actions},costConfig.toolkit.tools[1],...Array.from({length:126},(_,i)=>({...seed,actions,id:'cost-tool-'+i,name:'Cost Tool '+i}))]}})
  await until('window.toolkitScene.display()?.tools.length===128');await showSettings();await click('[data-tool-id="summary"]')
  await until('window.toolkitScene.models().then(models=>models.length===1&&models[0].path==="/summary.mjs")')
  raw.modelCost={before:await read('window.toolkitScene.models()')};assert.equal(raw.modelCost.before.length,1);assert.equal(raw.modelCost.before[0].disposed,false)
  await read('window.toolkitScene.unrelated()');raw.modelCost.inputs=await read('window.toolkitScene.inputCounts()');assert.equal(raw.modelCost.inputs.unrelated,128);assert.equal(raw.modelCost.inputs.hosts,8);assert.equal(new Set(raw.modelCost.inputs.unrelatedRunIds).size,128);assert.ok(raw.modelCost.inputs.unrelatedRunIds.length===128&&raw.modelCost.inputs.unrelatedRunIds.every(id=>id!==healthy.runId),'Unrelated subjects never alias the original healthy Run')
  raw.modelCost.after=await read('window.toolkitScene.models()');assert.deepEqual(raw.modelCost.after,raw.modelCost.before)
  if(!await read('document.querySelector(".toolkit-editor__result-actions").open'))await click('.toolkit-editor__result-actions > summary')
  raw.modelCost.actions=[]
  for(const action of actions){await click(`[data-toolkit-edit-action="${action.id}"]`);await until(`window.toolkitScene.models().then(models=>models.length===1&&models[0].path===${JSON.stringify('/summary/actions/'+action.id+'.mjs')})`);const models=await read('window.toolkitScene.models()');assert.equal(models.length,1);assert.equal(models[0].disposed,false);raw.modelCost.actions.push({id:action.id,models})}
  assert.equal(raw.modelCost.actions.length,16);await hideSettings();raw.modelCost.closed=await read('window.toolkitScene.models()');assert.deepEqual(raw.modelCost.closed,[])
  await read('window.toolkitScene.restoreInputs()');await owner.edit(owner.current,costConfig)
  await until('window.toolkitScene.display()?.tools.length===2');raw.desktop.singleModelCost=true

  // Empty library is real configuration, then restored without replacing saved results.
  await owner.edit(owner.current,{...owner.current,toolkit:{...owner.current.toolkit,tools:[]}})
  await showSettings();assert.equal(await read('document.querySelectorAll(".toolkit-library [data-tool-id]").length'),1)
  await picture('1480-dark-empty-library.png',{theme:'dark',view:'library',libraryVisible:true,libraryItems:1,settingsExpanded:'true'})
  await hideSettings();await owner.edit(owner.current,costConfig);await until('window.toolkitScene.display()?.tools.length===2')
  // Produce the final actual result after definition changes for ordinary GUI recovery.
  await run('summary');await finish('summary');await until('document.querySelector("[data-toolkit-output]")?.textContent.includes("Everything is ready")');await close()
  const keyboard=await read(`Array.from(document.querySelectorAll('.surface-navigation button,.window-status-bar__utilities button,.surface-navigation__slot--launcher button')).filter(n=>n.isConnected&&n.checkVisibility({visibilityProperty:true})&&!n.disabled).map(n=>({name:n.getAttribute('aria-label'),id:n.dataset.toolkitId??null}))`)
  assert.ok(keyboard.length>=7,'Actual footer keyboard controls are nonempty')
  await click(settings);await key('Escape');await until(`document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded')==='false'`)
  assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(settings)})`),true)
  const targets=await read('Array.from(document.querySelectorAll(".surface-navigation button,.window-status-bar__right button")).filter(n=>n.isConnected&&n.checkVisibility({visibilityProperty:true})&&!n.disabled).map(n=>n.getAttribute("aria-label"))')
  assert.ok(targets.length>=7&&targets.every(Boolean),'Nonempty real footer focus sequence')
  const last=targets[targets.length-1]
  await click(`button[aria-label=${JSON.stringify(last)}]`);await key('Escape')
  assert.equal(await read(`document.activeElement===document.querySelector('button[aria-label='+${JSON.stringify(JSON.stringify(last))}+']')`),true)
  const reached=new Set([last])
  for(const expected of targets.slice(0,-1).reverse()){await key('Tab',['shift']);const actual=await read('document.activeElement.getAttribute("aria-label")');assert.equal(actual,expected,'Native Shift+Tab reaches the exact connected visible neighbour');reached.add(actual);raw.keyboard.push({operation:'native Shift+Tab',name:actual})}
  for(const expected of targets.slice(1)){await key('Tab');const actual=await read('document.activeElement.getAttribute("aria-label")');assert.equal(actual,expected,'Native Tab reaches the exact connected visible neighbour');reached.add(actual);raw.keyboard.push({operation:'native Tab',name:actual})}
  assert.deepEqual([...reached].sort(),[...targets].sort())
  raw.desktop.focusAndKeyboard=true;raw.desktop.settingsCliDurable=true
  await close();await hideSettings();win.setContentSize(1480,900)
  assert.deepEqual(await read('window.toolkitScene.surface()'),raw.before,'Toolkit does not replace original workbench, focused leaf or draft')
  raw.desktop.originalWorkbenchExact=true
}
