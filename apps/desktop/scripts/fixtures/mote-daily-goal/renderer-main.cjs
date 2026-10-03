const {app,BrowserWindow,Menu}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const [html,privateRoot,evidence,phase]=process.argv.slice(2)
app.setPath('userData',path.join(privateRoot,'userData'))
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),result={passed:false,pid:process.pid,phase,images:[],operations:[],errors:[]}
app.whenReady().then(async()=>{let win;try {
 Menu.setApplicationMenu(null);win=new BrowserWindow({width:1040,height:790,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}})
 win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')result.errors.push(details.message)})
 await win.loadFile(html,{query:{phase,workspacePath:path.join(privateRoot,'work')}})
 const read=s=>win.webContents.executeJavaScript(s)
 for(let i=0;i<200&&!(await read('!!window.goalScene && !!document.querySelector(".goals-continuation")'));i++)await wait(25)
 assert.equal(await read('!!window.goalScene && !!document.querySelector(".goals-continuation")'),true)
 const click=async label=>{const r=await read(`(()=>{const n=[...document.querySelectorAll('.goals-continuation button')].find(n=>n.textContent===${JSON.stringify(label)});if(!n)throw Error('No original Goal control '+${JSON.stringify(label)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(r.x),y:Math.round(r.y),button:'left',clickCount:1});await wait(200)}
 const capture=async name=>{await wait(150);const facts=await read(`(()=>{const n=document.querySelector('.goals-continuation');return {overflow:n.scrollWidth>n.clientWidth,screenOverflow:document.documentElement.scrollWidth>innerWidth,text:n.textContent,...goalScene.facts()}})()`);assert.equal(facts.overflow,false);assert.equal(facts.screenOverflow,false);assert.equal(facts.drafts['exact-goal-agent'],'A later manual draft stays here.');assert.equal(facts.drafts['utility-region'],'Original utility draft stays here.');await fs.writeFile(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG());result.images.push(name+'.png');result.operations.push({name,...facts})}
 for(let i=0;i<100&&!(await read('!!document.querySelector("[contenteditable=true]")'));i++)await wait(25)
 if(phase==='seed'){
 await read('goalScene.empty()');await wait(200);await capture('goal-enable-wide-dark');win.setContentSize(320,790);await read('goalScene.theme(true)');await capture('goal-enable-narrow-light');await read('goalScene.active();goalScene.theme(false)');win.setContentSize(1040,790);await wait(200);
 await capture('goal-active-wide-dark')
 await read(`window.originalInput=document.querySelector('[contenteditable=true]');window.originalText=document.createTreeWalker(originalInput,NodeFilter.SHOW_TEXT).nextNode();originalInput.focus();const r=document.createRange();r.setStart(originalText,2);r.setEnd(originalText,9);getSelection().removeAllRanges();getSelection().addRange(r)`)
 await click('Pause')
 assert.equal(await read(`document.querySelector('[contenteditable=true]')===originalInput`),true)
 result.inputWitness=await read(`({sameNode:document.querySelector('[contenteditable=true]')===originalInput,sameText:getSelection().anchorNode===originalText,anchorOffset:getSelection().anchorOffset,focusOffset:getSelection().focusOffset,draft:originalInput.textContent})`)
 assert.equal(result.inputWitness.sameText,true);assert.equal(result.inputWitness.anchorOffset,2);assert.equal(result.inputWitness.focusOffset,9)
 await capture('goal-paused-wide-dark');await click('Resume')
 win.setContentSize(320,790);await read('goalScene.theme(true)');await capture('goal-active-narrow-light')
 await read('goalScene.unknown()');await wait(200);await capture('goal-unknown-narrow-light');await click('Inspect and retry original start')
 assert.equal(await read('goalScene.calls.at(-1).operationId'), 'durable-original-start')
 assert.equal(await read('goalScene.calls.at(-1).agentSessionId'), 'exact-goal-agent')
 await capture('goal-original-retry-error-narrow-light')
 }else{await capture('goal-restored-wide-dark')}
 const facts=await read('goalScene.facts()');result.workface={tabs:facts.tabs,layouts:facts.layouts,selection:facts.selection,drafts:facts.drafts,sessions:facts.sessions}
 assert.deepEqual(Object.keys(result.workface.tabs).sort(),['original-tab','original-utility'])
 await read('goalScene.flush()');await win.webContents.session.flushStorageData();result.passed=true
 }catch(error){result.error={message:error.message,stack:error.stack};if(win)await fs.writeFile(path.join(evidence,phase+'-failed.png'),(await win.webContents.capturePage()).toPNG())}
 finally{await fs.writeFile(path.join(evidence,phase+'.renderer-result.json'),JSON.stringify(result,null,2)+'\n');win?.destroy();app.exit(result.passed?0:1)}})
