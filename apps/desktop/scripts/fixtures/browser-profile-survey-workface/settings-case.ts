import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
export async function settingsCase(ctx: { phase: string; directory: string; window: BrowserWindow; evaluate(expression: string): Promise<any>; result(args: string[], input?: string): Promise<any>; receipt: any; probeAck: { hold():void; release(lose:boolean):void } }) {
 const { window, evaluate, receipt } = ctx, contents = window.webContents
 contents.debugger.attach('1.3')
 const wait = async (expression: string) => { const deadline=Date.now()+15000;while(Date.now()<deadline){const value=await evaluate(expression);if(value)return value;await new Promise(resolve=>setTimeout(resolve,40))}throw new Error('Private Settings input target unavailable: '+expression) }
 const click=async(selector:string)=>{const r=await wait(`(()=>{const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];const e=nodes.find(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0});if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});await new Promise(resolve=>setTimeout(resolve,80))}
 const before=await ctx.result(['browser','profile','ls'])
 receipt.settings={before,frames:[],independentVisualReview:'not-performed'}
 await click('.surface-navigation__utilities button:first-child')
 assert.equal(await evaluate('profileSurveyNative.read().mainSurface'),'survey','Real Survey navigation precedes Settings')
 await click('[aria-label="Settings"]')
 await click('[data-settings-target="browser-profiles"]')
 await wait('Boolean(document.querySelector(".browser-profile-editor"))')
 assert.equal(await evaluate('document.querySelector(".browser-profile-editor__advanced").open'),false,'Advanced settings start closed')
 const profileIds=before.profiles.map((value:any)=>value.id)
 const capture=async(label:string)=>{const name=ctx.phase+'-'+label+'.png';await writeFile(join(ctx.directory,name),(await window.capturePage()).toPNG());receipt.frames.push({file:name});receipt.settings.frames.push(name)}
 const geometry=()=>evaluate(`(()=>{const c=document.querySelector('.settings-browser-profiles'),grid=c.querySelector('.settings-resource-split'),lib=c.querySelector('.browser-profile-library'),ed=c.querySelector('.browser-profile-editor'),who=ed.querySelector('.browser-profile-editor__who').getBoundingClientRect(),open=ed.querySelector('.browser-profile-editor__open').getBoundingClientRect(),cs=getComputedStyle(c);return{contentWidth:c.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),libraryHidden:getComputedStyle(lib).display==='none',columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,editorWidth:ed.getBoundingClientRect().width,headerOverlap:Math.min(who.right,open.right)>Math.max(who.left,open.left)+1&&Math.min(who.bottom,open.bottom)>Math.max(who.top,open.top)+1}})()`)
 receipt.settings.boundaries=[]
 for(const width of [719,720,721]){
  for(let attempt=0;attempt<5;attempt++){const g=await geometry();if(Math.abs(g.contentWidth-width)<0.6)break;const size=window.getSize();assert.ok(size[0]!==undefined);window.setSize(Math.round(size[0]+width-g.contentWidth),850);await new Promise(resolve=>setTimeout(resolve,120))}
  const g=await geometry();assert.ok(Math.abs(g.contentWidth-width)<0.6);assert.equal(g.libraryHidden,width<720);assert.equal(g.columns,width<720?1:2);assert.ok(g.editorWidth>320);assert.equal(g.headerOverlap,false);receipt.settings.boundaries.push(g)
 }
 for(const mode of ['dark','light']){await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)})`);for(const [label,width,height] of [['normal',1280,900],['narrow',740,840],['short',1000,620]] as const){window.setSize(width,height);await new Promise(resolve=>setTimeout(resolve,180));const g=await geometry();assert.ok(g.editorWidth>320);assert.equal(g.headerOverlap,false);await capture('settings-'+mode+'-'+label)}}
 window.setSize(1100,850)
 await click('.browser-profile-editor__advanced > summary')
 assert.equal(await evaluate('document.querySelector(".browser-profile-editor__advanced").open'),true)
 assert.ok(await evaluate('document.querySelector("[aria-label=Environment]")&&document.querySelector(".browser-profile-editor__advanced").textContent.includes("Network")'))
 const draftSelector='.profile-environment input[type="text"], .profile-environment input:not([type])'
 const field=await wait(`(()=>{const e=document.querySelector(${JSON.stringify(draftSelector)});return e&&{label:e.getAttribute('aria-label'),value:e.value}})()`)
 await click(draftSelector);await contents.debugger.sendCommand('Input.insertText',{text:'private-unsaved-environment'})
 const entered=await evaluate(`document.querySelector(${JSON.stringify(draftSelector)}).value`)
 await click('.browser-profile-editor__advanced > summary');await click('.browser-profile-editor__advanced > summary')
 assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)}).value`),entered,'Collapsing advanced settings preserves the real input')
 await click('[aria-label="Close settings"]');await click('[aria-label="Settings"]');await click('[data-settings-target="browser-profiles"]')
 await wait('document.querySelector(".settings-content").dataset.settingsActive==="browser-profiles"&&document.querySelector(".browser-profile-editor").getBoundingClientRect().height>0')
 assert.equal(await evaluate(`document.querySelector(${JSON.stringify(draftSelector)}).value`),entered,'Hiding and returning preserves original editor draft')
 const after=await ctx.result(['browser','profile','ls'])
 assert.deepEqual(after.profiles.map((value:any)=>({id:value.id,revision:value.revision,network:value.network??null})),before.profiles.map((value:any)=>({id:value.id,revision:value.revision,network:value.network??null})),'Draft/collapse/hide cannot modify the Profile route')
 assert.equal(receipt.ipc.filter((value:any)=>value.channel==='browser:probeProfileNetwork').length,0,'Merely exposing diagnostics cannot start a probe')
 receipt.settings.draft={field,valuePreserved:true};receipt.settings.noAutomaticProbe=true
 for(const mode of ['dark','light']){await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)});document.querySelector('[aria-label=Environment]').scrollIntoView({block:'start'})`);await new Promise(resolve=>setTimeout(resolve,120));await capture('settings-'+mode+'-advanced-environment')}
 ctx.probeAck.hold()
 await click('.profile-network-diagnostics__heading button')
 await wait('document.querySelector(".profile-network-diagnostics__heading button").disabled')
 // The original owner completes; only this fixture's exact reply is held and lost once.
 for(const mode of ['dark','light']){await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)});document.querySelector('[aria-label="Proxy diagnostics"]').scrollIntoView({block:'center'})`);await new Promise(resolve=>setTimeout(resolve,120));await capture('settings-'+mode+'-probe-ack-pending')}
 await wait('Boolean(document.querySelector(".profile-network-diagnostics__heading button").disabled)')
 const ackDeadline=Date.now()+15000;while(!receipt.originalProbeReply&&Date.now()<ackDeadline)await new Promise(resolve=>setTimeout(resolve,20))
 assert.equal(receipt.originalProbeReply?.ok,true,'The original production probe must actually finish before only its ACK is lost')
 ctx.probeAck.release(true)
 await wait('document.querySelector(".profile-network-diagnostics__notice")?.textContent.includes("unconfirmed")')
 for(const mode of ['dark','light']){await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)});document.querySelector('.profile-network-diagnostics__notice').scrollIntoView({block:'center'})`);await new Promise(resolve=>setTimeout(resolve,120));await capture('settings-'+mode+'-probe-ack-unknown')}
 assert.equal(receipt.ipc.filter((value:any)=>value.channel==='browser:probeProfileNetwork').length,1,'A lost reply cannot trigger a second probe')
 await click('.profile-network-diagnostics__notice button')
 await wait('Boolean(document.querySelector(".profile-network-diagnostics__facts"))')
 const original=receipt.originalProbeReply.value.diagnostic;const inspected=await ctx.result(['browser','profile','network','history','--profile',original.profileId,'--operation-id',original.id]);assert.equal(inspected.diagnostics[0].id,original.id)
 receipt.settings.inspectedOriginalId=original.id
 receipt.settings.ackBoundary='Original production probe ran once; only fixture IPC return was held/lost. No remote failure or result value is invented.'
 const identity={profileIds};if(ctx.phase==='first'){receipt.savedIdentity=identity;await writeFile(join(ctx.directory,'retained.json'),JSON.stringify(identity))}else{const prior=JSON.parse(await readFile(join(ctx.directory,'retained.json'),'utf8'));assert.deepEqual(identity,prior);receipt.recoveredIdentity=identity}
 receipt.cases.push({kind:'actual-Settings-entry-collapse-hide-route-and-draft',passed:true})
}
