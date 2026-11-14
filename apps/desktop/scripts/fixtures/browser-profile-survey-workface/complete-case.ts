import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, type WebContentsView } from 'electron'
import { mintObjectId, mintCapabilityToken } from '@agentmux/core/object-id'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { nativeInput, nativeUntil } from './native-input'
import { admissionGeometry } from './admission-geometry'
import { persistentTask } from './persistent-task'
import type { ProfileSwitchPorts } from './profile-switch-ports'
import type { CompletePorts } from './complete-ports'
import type { cliFollow } from './cli-follow'

type Context = {
  phase: string; directory: string; window: BrowserWindow; core: any; store: any; receipt: any
  ports: ProfileSwitchPorts; observation: CompletePorts; taskWorkspaceId: string; pageUrl: string
  evaluate(expression: string): Promise<any>
  result(args: string[], input?: string): Promise<any>
  cli(args: string[], input?: string, actor?: string): Promise<any>
  follow(operationId: string): Promise<ReturnType<typeof cliFollow>>
}
const pause=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const region=(id:string)=>`[data-workbench-region-id="${id}"]`

/** T004's own real chain, independent of admission/profile-switch completion flags. */
export async function completeCase(ctx: Context) {
  const {phase,directory,window,core,ports,observation,receipt,evaluate,result}=ctx
  const origins=JSON.parse(process.env.AGENTMUX_PROFILE_SURVEY_ORIGINS!)
  const proof:any={completed:false,cases:[],input:[],frames:[]};receipt.complete=proof
  const input=nativeInput(window.webContents,proof.input)
  const facts=()=>evaluate('profileSurveyNative.read()')
  const mark=(kind:string,data:any={})=>{proof.cases.push({kind,passed:true,...data});process.stdout.write(`Profile Survey complete ${phase}: ${kind} passed\n`)}
  const owner=(browserId:string)=>nativeUntil(async()=>{
    for(const tab of Object.values((await facts()).tabs) as any[])for(const surface of Object.values(tab.regions) as any[])
      if(surface.kind==='browser'&&surface.browserId===browserId)return{tab,surface,reference:{regionId:surface.regionId,browserId}}
    return null
  },'the original complete-case Browser/Region binding')
  const native=(browserId:string,url?:string):Promise<WebContentsView>=>nativeUntil(()=>{
    const view=observation.native(browserId)
    return view?.webContents&&!view.webContents.isDestroyed()&&!view.webContents.isLoading()&&(!url||view.webContents.getURL()===url)?view:null
  },'the actual complete-case native page '+browserId)
  const showSurvey=async()=>{await input.click('.surface-navigation__utilities button:first-child');assert.equal((await facts()).mainSurface,'survey')}
  const choose=async(profileId?:string)=>{
    await input.select('[aria-label="Survey environment"]',profileId?'profile:'+profileId:'default')
    const view=profileId?{kind:'profile',profileId}:{kind:'default'}
    await nativeUntil(async()=>JSON.stringify((await facts()).surveyProfileView)===JSON.stringify(view),'the original complete-case Survey environment view')
    const published=await result(['space','ls','--presentation']);assert.deepEqual(published.catalog.survey.profileView,view)
  }
  const activate=async(reference:any)=>{
    await input.click(`[data-survey-page-browser-id="${reference.browserId}"] .survey-item`)
    await nativeUntil(()=>evaluate(`[...document.querySelectorAll('${region(reference.regionId)}')].some(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0)`),'the accurate Survey page presentation')
  }
  const task=async(reference:any)=>{
    const response=await ctx.cli(['space','focus','--region',reference.regionId,'--input','target'])
    assert.equal(response.value.ok,true);assert.ok(['applied','unchanged'].includes(response.value.result.navigation.state))
    assert.equal(response.value.result.navigation.selection.space.regionId,reference.regionId)
    assert.equal(response.value.result.presentation.state,'main-visible');assert.equal(response.value.result.presentation.regionId,reference.regionId)
    if(response.code!==0){assert.equal(response.code,1);assert.equal(response.value.result.partial,true)}
    proof.focus??=[];proof.focus.push(response.value.result)
  }
  const navigate=async(reference:any,url:string)=>{await input.fill(region(reference.regionId)+' .browser-toolbar input',url);await input.key('Enter','Enter',13);await nativeUntil(async()=>(await owner(reference.browserId)).surface.url===url,'the original page navigation');return await native(reference.browserId,url)}
  const identity=(view:WebContentsView)=>view.webContents.executeJavaScript(`document.querySelector('#identity')?.textContent`)
  const login=async(opened:any,user:string,suffix:string)=>{
    await task(opened.region);const view=await native(opened.region.browserId,origins.loginUrl+suffix)
    await nativeUntil(()=>view.getVisible()&&view.getBounds().width>0,'the visible original sign-in page')
    const site=nativeInput(view.webContents,proof.input);await site.fill('[aria-label="Account"]',user);await site.click('button[type="submit"]')
    await nativeUntil(()=>!view.webContents.isLoading()&&view.webContents.getURL()===ctx.pageUrl,'real sign-in form POST and redirect')
    assert.equal(await identity(view),user);site.release();return view
  }
  const capture=async(label:string,mode:string,width=1280,height=900)=>{
    await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)})`);window.setSize(width,height);await pause(220)
    const presentation={native:observation.presentation(),dom:await evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return[...document.querySelectorAll('[data-native-browser-stage]')].filter(e=>e.checkVisibility()).map(e=>({browserId:e.dataset.nativeBrowserStage,rect:rect(e),video:[...e.querySelectorAll('video')].map(v=>({readyState:v.readyState,paused:v.paused,width:v.videoWidth,height:v.videoHeight,currentTime:v.currentTime,visible:v.checkVisibility()}))}))})()`)}
    const file=`${phase}-complete-${mode}-${label}.png`;await writeFile(join(directory,file),(await window.capturePage()).toPNG())
    proof.frames.push({file,width,height,presentation});receipt.frames.push({file})
  }
  const geometry=async(page:any,url:string)=>nativeUntil(async()=>{
    const attempt:any={};(proof.geometryObservations??=[]).push(attempt)
    try{return await admissionGeometry(window,evaluate,page,url,value=>{attempt.observed=value})}
    catch(error){
      if(!(error instanceof assert.AssertionError))throw error
      attempt.unconfirmed=error.message;return null
    }
  },'the original DOM layout and actual Native presentation commit the same strict full Region geometry')
  const program=async(browserId:string,operationId:string,code:string)=>{
    const run=await ctx.cli(['browser','run','--browser',browserId,'--operation-id',operationId],code,'workface')
    assert.equal(run.code,0,JSON.stringify(run.value));assert.equal(run.value.ok,true)
    const report=run.value.result;assert.equal(report.runOperation.id,operationId);assert.equal(report.runOperation.browserId,browserId)
    assert.equal(report.outcome.kind,'completed',JSON.stringify(report.outcome));return report
  }
  const actorRead=async(args:string[])=>{
    const response=await ctx.cli(args,'','workface')
    assert.equal(response.code,0,JSON.stringify(response.value));assert.equal(response.value.ok,true);return response.value.result
  }
  const browserState=async(id:string)=>(await owner(id)).surface
  const activity=async(reference:any)=>input.click(region(reference.regionId)+' .browser-operation-status__trigger')
  const fieldCode=`const page=await snapshot({scope:'page',maxNodes:60});const fields=page.nodes.filter(node=>node.role==='text input'&&node.name==='Page draft');if(fields.length!==1)throw Error('Expected one original fixture field');`

  if(phase==='first'){
    window.setSize(1600,1000)
    await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(ctx.taskWorkspaceId)})`)
    const seeded=await facts(),launcher=Object.values(seeded.tabs).flatMap((tab:any)=>Object.values(tab.regions)).find((surface:any)=>surface.kind==='launcher'&&surface.workspaceId===ctx.taskWorkspaceId) as any
    assert.ok(launcher)
    assert.ok(Object.keys(seeded.launcherDrafts).length>0,'An original unsent App draft must actually exist before the workface chain')
    assert.equal((await result(['browser','profile','ls'])).profiles.filter((value:any)=>!value.isDefault).length,0)
    const defaultTask=await result(['browser','open','--url',origins.loginUrl+'?complete-default','--right-of',launcher.regionId])
    assert.equal(defaultTask.survey.outcome,'not-requested')
    await login(defaultTask,'default-person','?complete-default');const defaultView=await navigate(defaultTask.region,ctx.pageUrl+'?complete-task-default')
    await showSurvey();await choose();const beforeDefault=ports.calls.filter(call=>call.channel==='browser:create').length
    await input.click('[aria-label="New webpage"]')
    const defaultCall=await nativeUntil(()=>ports.calls.filter(call=>call.channel==='browser:create')[beforeDefault]?.returned?ports.calls.filter(call=>call.channel==='browser:create')[beforeDefault]:null,'the default Survey native reply')
    const defaultPage=await owner(defaultCall.returned.id);await navigate(defaultPage.reference,ctx.pageUrl+'?complete-survey-default')
    const shared=await native(defaultPage.reference.browserId,ctx.pageUrl+'?complete-survey-default')
    assert.equal(shared.webContents.session,defaultView.webContents.session);assert.equal(await identity(shared),'default-person')
    const defaultMembers=await result(['space','survey-list']);assert.ok(defaultMembers.pageReferences.some((ref:any)=>ref.browserId===defaultPage.reference.browserId));assert.equal(defaultMembers.pageReferences.some((ref:any)=>ref.browserId===defaultTask.region.browserId),false)
    mark('same-candidate-default-real-login',{task:defaultTask.region,survey:defaultPage.reference})

    const graph=await result(['space','ls','--presentation']),zone=graph.catalog.zones.find((value:any)=>value.workspaceId===ctx.taskWorkspaceId);assert.ok(zone)
    const file=await result(['file','open','--path','original.txt','--zone',zone.zoneId])
    const actor=await result(['agent','open','--executor','proof','--execution-workspace',ctx.taskWorkspaceId,'--zone',zone.zoneId,'--tab',file.placement.tabId,'--region',file.placement.regionId,'--split','right'])
    const credential=await nativeUntil(async()=>{try{return JSON.parse(await readFile(join(directory,'workface-credential.json'),'utf8'))}catch{return null}},'the actual Core-injected fixture capability receipt')
    assert.equal(credential.agentSessionId,actor.agent.agentSessionId);assert.ok(credential.capability)
    proof.actorCredential={agentSessionId:credential.agentSessionId,source:'Original Core injection into the explicitly synthetic Provider',credentialDisclosed:false}
    const a=(await result(['browser','profile','create','--label','Work environment'])).profile,b=(await result(['browser','profile','create','--label','Other environment'])).profile
    const page=await result(['browser','open','--url',origins.loginUrl+'?complete-A','--profile',a.id,'--right-of',file.placement.regionId])
    const other=await result(['browser','open','--url',ctx.pageUrl+'?complete-B','--profile',b.id,'--right-of',file.placement.regionId])
    await login(page,'workface-person','?complete-A');await navigate(page.region,ctx.pageUrl+'?complete-A')
    assert.equal(await identity(await native(other.region.browserId,ctx.pageUrl+'?complete-B')),'signed-out')
    await showSurvey();await choose(a.id);await activate(page.survey.reference)
    const visible=await evaluate(`[...document.querySelectorAll('.global-survey-surface [data-workbench-region-id]')].filter(e=>e.checkVisibility()&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).map(e=>e.dataset.workbenchRegionId)`)
    assert.deepEqual([...new Set(visible)],[page.region.regionId],'The Profile page does not collect or project its mixed Task siblings')
    assert.equal((await result(['space','survey-list'])).collectedZoneIds.includes(zone.zoneId),false)
    proof.beforeGive={nativeUrl:(await native(page.region.browserId)).webContents.getURL(),surfaceUrl:(await browserState(page.region.browserId)).url,navigationId:(await browserState(page.region.browserId)).navigationId}
    const give=await nativeUntil(()=>evaluate(`(()=>{const e=[...document.querySelectorAll('${region(page.region.regionId)} button[aria-label^="Give to "]')].filter(e=>e.checkVisibility());return e.length===1?e[0].getAttribute('aria-label'):null})()`),'the one original in-Tab Agent handoff control')
    proof.giveControlUi={label:give,expectedAgentSessionId:actor.agent.agentSessionId}
    await input.click(region(page.region.regionId)+' button[aria-label^="Give to "]')
    await nativeUntil(async()=>(await browserState(page.region.browserId)).control?.agent?.agentSessionId===actor.agent.agentSessionId&&(await browserState(page.region.browserId)).control.owner==='agent','trusted original Main handoff to the exact Core Session')
    const runtimeBefore=await core.statusAgent(actor.agent.agentSessionId);assert.equal(runtimeBefore.run.state,'running');assert.ok(runtimeBefore.run.pid>0)
    proof.afterGive={nativeUrl:(await native(page.region.browserId)).webContents.getURL(),surfaceUrl:(await browserState(page.region.browserId)).url,navigationId:(await browserState(page.region.browserId)).navigationId}
    proof.runtimeBefore={run:runtimeBefore.run,owner:core.runtimeIdentity(),sessionId:actor.agent.agentSessionId}
    const typedRefusal=await evaluate(`profileSurveyNative.api.browser.switchProfile(${JSON.stringify(page.region.browserId)},${JSON.stringify(b.id)}).then(()=>({refused:false}),error=>({refused:true,code:error.code}))`)
    assert.deepEqual(typedRefusal,{refused:true,code:'BROWSER_AGENT_CONTROL_ACTIVE'});assert.equal((await browserState(page.region.browserId)).profileId,a.id)
    proof.typedRefusal=typedRefusal
    mark('credential-bound-original-page-and-trusted-association',{actor:actor.agent,reference:page.survey.reference})

    const activeId='workface-original-wait';let runFailure:any
    const running=ctx.cli(['browser','run','--browser',page.region.browserId,'--operation-id',activeId],fieldCode+`await fillInput(fields[0].ref,'Agent prepared this original page');await waitForElement('Private workface release',20000);return 'unexpected automatic completion';`,'workface')
    void running.then(value=>{if(value.value.result?.runOperation?.phase!=='stopped')runFailure=new Error('Original Browser program settled before the intended handoff: '+JSON.stringify(value.value))},error=>{runFailure=error})
    await nativeUntil(async()=>{if(runFailure)throw runFailure;return(await browserState(page.region.browserId)).activity?.operation?.phase==='waiting'},'the actual credentialed program waiting in the original page')
    const inspect=await actorRead(['browser','inspect','--operation-id',activeId]);assert.equal(inspect.runOperation.operator.id,actor.agent.agentSessionId);assert.equal(inspect.runOperation.browserId,page.region.browserId)
    const reader=await ctx.follow(activeId)
    await nativeUntil(()=>reader.state.frames.some((frame:any)=>frame.result?.initial?.runOperation?.id===activeId)&&reader.state.frames.some((frame:any)=>frame.params?.event?.type==='progress'),'real compiled CLI follow opening and original progress')
    const activeSubscriptions=observation.snapshot().subscriptions.active;assert.ok(activeSubscriptions>0)
    await reader.dispose();assert.equal(reader.state.code,0);assert.notEqual(reader.state.parseFailure,true)
    await nativeUntil(()=>observation.snapshot().subscriptions.active<activeSubscriptions,'the original Journal reader disposal')
    const afterRead=await actorRead(['browser','inspect','--operation-id',activeId]);assert.equal(afterRead.runOperation.phase,'waiting','Disposing only the public reader does not stop its business operation')
    for(const mode of ['dark','light'])await capture('agent-waiting',mode)
    const stopped=await ctx.cli(['browser','stop','--operation-id',activeId],'','workface');assert.equal(stopped.code,0);assert.equal(stopped.value.result.runOperation.phase,'stopped')
    const ended=await running;assert.equal(ended.code,0);assert.equal(ended.value.result.runOperation.phase,'stopped')
    assert.equal((await browserState(page.region.browserId)).control.owner,'agent','Explicit operation Stop does not silently return input')
    proof.publicOperation={inspect,afterRead,stop:stopped.value.result,ended:ended.value.result}
    mark('compiled-cli-run-inspect-follow-stop-original-owner',{operationId:activeId})

    await input.click(region(page.region.regionId)+' [aria-label="Take control of Browser"]')
    await nativeUntil(async()=>(await browserState(page.region.browserId)).control.owner==='human','the trusted person takes the original Browser input')
    const humanView=await native(page.region.browserId,ctx.pageUrl+'?complete-A'),site=nativeInput(humanView.webContents,proof.input)
    await site.fill('[aria-label="Page draft"]','Human reviewed and handed back this original page')
    site.release()
    for(const mode of ['dark','light'])await capture('human-handoff',mode,980,760)
    await activity(page.region)
    const returnLabel=await nativeUntil(()=>evaluate(`(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].filter(e=>e.checkVisibility()&&e.textContent.trim().startsWith('Return to '));return e.length===1?e[0].textContent.trim():null})()`),'the actual return-to-original-Agent control')
    await input.click('[role="menuitem"]',returnLabel)
    await nativeUntil(async()=>(await browserState(page.region.browserId)).control.owner==='agent','the original Main owner receives trusted return control')
    assert.equal((await browserState(page.region.browserId)).control.agent.agentSessionId,actor.agent.agentSessionId)
    const handback=await program(page.region.browserId,'workface-after-human',fieldCode+`const original=await js(${JSON.stringify(`document.querySelector('[aria-label="Page draft"]').value`)});if(original!=='Human reviewed and handed back this original page')throw Error('Original human input missing');return {url:page.url,navigationId:page.navigationId,humanInput:original};`)
    proof.humanHandoff=handback;assert.equal(handback.result.humanInput,'Human reviewed and handed back this original page')
    mark('trusted-human-take-and-return-with-original-input')

    const childRun=await program(page.region.browserId,'workface-related-page',`const page=await snapshot({scope:'page',maxNodes:60});const links=page.nodes.filter(node=>node.role==='link'&&node.name==='Open related page');if(links.length!==1)throw Error('Expected one original related-page ref');await click(links[0].ref);return {sourceUrl:page.url,sourceNavigationId:page.navigationId};`)
    const child=await nativeUntil(()=>observation.childOf(page.region.browserId),'the actual original Main native-opened child event')
    const childOwner=await owner(child.browser.id),childView=await native(child.browser.id,origins.childUrl)
    assert.notEqual(child.browser.id,page.region.browserId);assert.equal(child.browser.profileId,a.id);assert.equal(child.browser.source.browserId,page.region.browserId);assert.equal(child.browser.source.navigationId,childRun.result.sourceNavigationId)
    assert.equal(childView.webContents.session,humanView.webContents.session);assert.notEqual(new URL(origins.childUrl).origin,new URL(ctx.pageUrl).origin);assert.equal(await identity(childView),'workface-person')
    const targets=await result(['browser','targets']);assert.ok(targets.targets.some((target:any)=>target.id===child.browser.id))
    proof.child={browser:child.browser,reference:childOwner.reference,publicRun:childRun}
    const childWindow=await nativeUntil(async()=>{
      const page=await evaluate(`profileSurveyNative.api.ui.workbenchWindows.call('app.window.ls',{})`)
      const descriptor=page.windows.find((value:any)=>value.target?.kind==='region'&&value.target.regionId===childOwner.reference.regionId)
      proof.child.windowObservation=page
      return descriptor?.presentation==='visible'&&descriptor.documentGeneration?descriptor:null
    },'the original Main owner confirms the exact native child Region auxiliary window')
    const auxiliary=await nativeUntil(()=>BrowserWindow.getAllWindows().find(candidate=>{
      if(candidate.isDestroyed()||candidate.webContents.isLoading())return false
      const url=new URL(candidate.webContents.getURL());return url.pathname.endsWith('/workbench-window.html')&&url.searchParams.get('window')===childWindow.windowId&&url.searchParams.get('document')===childWindow.documentGeneration
    }),'the actual fixed production auxiliary document')
    const shell=await nativeUntil(async()=>{
      const observed=await auxiliary.webContents.executeJavaScript(`({regions:[...document.querySelectorAll('[data-workbench-region-id]')].filter(e=>e.checkVisibility()).map(e=>e.dataset.workbenchRegionId),privilegedBridge:typeof window.agentmux})`)
      return observed.regions.includes(childOwner.reference.regionId)?observed:null
    },'the original App portal presents the exact child Region in its script-free auxiliary shell')
    assert.equal(shell.privilegedBridge,'undefined','The auxiliary shell has no replacement preload or privileged bridge')
    proof.child.auxiliary={descriptor:childWindow,contentsId:auxiliary.webContents.id,observed:shell}
    const auxiliaryFile='first-complete-native-child-workface.png';await writeFile(join(directory,auxiliaryFile),(await auxiliary.capturePage()).toPNG());receipt.frames.push({file:auxiliaryFile});proof.frames.push({file:auxiliaryFile,windowId:childWindow.windowId})
    mark('cross-origin-native-child-original-profile-and-source',{reference:childOwner.reference})

    await showSurvey();await choose(a.id);await activate(page.survey.reference)
    const download=await program(page.region.browserId,'workface-authorized-result',`const page=await snapshot({scope:'page',maxNodes:60});const links=page.nodes.filter(node=>node.role==='link'&&node.name==='Download result');if(links.length!==1)throw Error('Expected one original download ref');return {observed:{url:page.url,navigationId:page.navigationId},download:await download(links[0].ref,{path:'workface-result.txt',timeoutMs:10000})};`)
    const transfer=download.result.download,reference=transfer.reference;assert.equal(transfer.status,'completed');assert.ok(reference)
    assert.equal(reference.workspaceId,ctx.taskWorkspaceId);assert.equal(reference.browserId,page.region.browserId);assert.equal(reference.operationId,download.runOperation.id);assert.equal(reference.navigationId,download.result.observed.navigationId)
    const bytes=await readFile(join(directory,'workspace/workface-result.txt'));assert.equal(hash(bytes),origins.artifact.sha256);assert.deepEqual(bytes,Buffer.from(origins.artifact.base64,'base64'))
    const read=await program(page.region.browserId,'workface-read-original-result',`return await readDownload(${JSON.stringify(reference)},{offset:0,maxBytes:4096});`)
    assert.deepEqual(read.result.reference,reference);assert.deepEqual(Buffer.from(read.result.data,'base64'),bytes)
    const history=await actorRead(['browser','history','--browser',page.region.browserId]);for(const id of [activeId,'workface-after-human','workface-related-page','workface-authorized-result','workface-read-original-result'])assert.ok(history.operations.some((operation:any)=>operation.id===id))
    proof.download={run:download,read,reference,sha256:hash(bytes),bytes:bytes.length,history}
    mark('original-download-authorized-workspace-and-public-read',{reference})

    const cost=async(id:string)=>{
      const before=observation.snapshot(),runsBefore=await core.listRuns()
      await program(page.region.browserId,id,'return await pageInfo();')
      const follower=await ctx.follow(id);await nativeUntil(()=>follower.state.frames.some((frame:any)=>frame.result?.initial?.runOperation?.id===id)&&follower.state.frames.some((frame:any)=>frame.params?.event?.type==='progress'),'one real cost observation subscription')
      await follower.dispose();await nativeUntil(()=>observation.snapshot().subscriptions.active===before.subscriptions.active,'the related cost reader has disposed')
      const after=observation.snapshot(),runsAfter=await core.listRuns()
      assert.deepEqual(runsAfter.map((run:any)=>run.runId).sort(),runsBefore.map((run:any)=>run.runId).sort(),'A related Browser observation does not create unrelated Runtime Runs')
      assert.deepEqual(after.native,before.native,'A related read creates no new Native Browser or Profile instance')
      const progress=follower.state.frames.filter((frame:any)=>frame.params?.event?.type==='progress').map((frame:any)=>frame.params.event.data.event.type)
      assert.ok(progress.length>0)
      return{before,after,runScript:after.runScript-before.runScript,subscriptions:after.subscriptions.opened-before.subscriptions.opened,progress,runtimeRuns:runsAfter.map((run:any)=>run.runId)}
    }
    const costBefore=await cost('workface-cost-before'),unrelatedProfiles:string[]=[],unrelatedSessions:{agentSessionId:string;runId:string}[]=[]
    const metadataBefore=await ctx.store.loadMetadata(),profilesBefore=await result(['browser','profile','ls'])
    for(let index=0;index<16;index++){
      const profile=(await result(['browser','profile','create','--label','Unrelated persisted environment '+index])).profile;unrelatedProfiles.push(profile.id)
      const agentSessionId=mintObjectId(),runId=mintObjectId()
      await ctx.store.compareAndSwapMetadata(null,{kind:'agent',agentSessionId,providerId:'codex',executorId:'proof',hostId:'local',workspacePath:join(directory,'legacy-workspace'),run:{runId},retiredRuns:[],createdAt:1,updatedAt:1,hookBindingId:mintObjectId(),hookToken:mintCapabilityToken()})
      unrelatedSessions.push({agentSessionId,runId})
      proof.unstartedColdSessionIds=unrelatedSessions.map(value=>value.agentSessionId)
    }
    assert.equal((await ctx.store.loadMetadata()).length,metadataBefore.length+16,'The original durable Session owner actually accepted the unrelated cold records')
    assert.equal((await result(['browser','profile','ls'])).profiles.length,profilesBefore.profiles.length+16,'The original Profile owner actually persisted the unrelated Profile records')
    const costAfter=await cost('workface-cost-after')
    assert.equal(costBefore.runScript,1);assert.equal(costAfter.runScript,1);assert.equal(costBefore.subscriptions,1);assert.equal(costAfter.subscriptions,1)
    assert.deepEqual(costAfter.progress,costBefore.progress,'The same related public operation has the same actual progress work after unrelated metadata grows')
    assert.equal(costAfter.after.browserEvents-costAfter.before.browserEvents,costBefore.after.browserEvents-costBefore.before.browserEvents,'Unrelated persistent records do not amplify the measured original Browser events')
    assert.equal(costAfter.after.sessionFactory-costAfter.before.sessionFactory,0,'The related operation admits no additional Native Session after unrelated records grow')
    assert.equal(observation.snapshot().native.some((value:any)=>unrelatedProfiles.includes(value.profileId)),false)
    const sessionRequests=receipt.completeOwnerObservation.sessionFactory.map((value:any)=>value.partition)
    for(const id of unrelatedProfiles)assert.equal(sessionRequests.includes(browserProfilePartition(id)),false,'Metadata-only unrelated Profiles have no Native Session factory admission')
    proof.cost={scope:'Measured BVM calls/native entries, original Journal subscriptions/progress and Session factory calls only; no CPU/memory/all-performance claim',before:costBefore,after:costAfter,unrelatedProfiles,unrelatedSessions}
    mark('related-native-operation-counts-with-unrelated-persistent-records')

    const resultFile=await result(['file','open','--path','workface-result.txt','--zone',zone.zoneId])
    await task(resultFile.placement)
    assert.equal(proof.focus.at(-1).input.after.ownerKind,'editor');assert.equal(proof.focus.at(-1).input.after.regionId,resultFile.placement.regionId)
    await nativeUntil(async()=>{
      const observed=await evaluate(`(()=>{const e=document.activeElement?.closest('.editor-pane');return{active:document.activeElement?.tagName,visible:e?.checkVisibility()??false,text:e?.textContent??null}})()`)
      proof.resultEditor=observed
      return observed.visible&&observed.text?.replaceAll(String.fromCharCode(160),' ').includes('Signed in as: workface-person')
    },'the actual original Workspace result editor is readable')
    for(const mode of ['dark','light'])await capture('readable-result',mode)
    await showSurvey();await choose(a.id);await activate(page.survey.reference)
    // Reading an Agent-owned preview does not transfer its native input lease.
    // The person explicitly takes input, then asks the original field-check owner.
    await input.click(region(page.region.regionId)+' [aria-label="Take control of Browser"]')
    await nativeUntil(async()=>(await browserState(page.region.browserId)).control.owner==='human','the person explicitly chooses the original page before declaring read-only completion conditions')
    await input.click(region(page.region.regionId)+' [aria-label="More browser tools"]')
    await input.click('[aria-label="Open human demonstration draft"]')
    proof.completionChecks=[]
    const field={key:'signed-in-identity',type:'string',source:{selector:'#identity',read:'text'}}
    const originalNavigation=(await browserState(page.region.browserId)).navigationId
    for(const [status,expected]of [['passed','workface-person'],['not-met','a different fixture identity']]){
      const declaration={request:{fields:[field]},criteria:[{kind:'field-equals',key:field.key,expected}]}
      const evaluation=await evaluate(`profileSurveyNative.api.browser.checkOutcomeFields(${JSON.stringify(page.region.browserId)},${JSON.stringify(declaration)})`)
      assert.equal(evaluation.status,status);assert.equal(evaluation.context.browserId,page.region.browserId);assert.equal(evaluation.context.navigationId,originalNavigation)
      assert.equal(evaluation.conditions.length,1);assert.equal(evaluation.conditions[0].status,status);assert.deepEqual(evaluation.conditions[0].criterion,declaration.criteria[0])
      const operation=await evaluate(`profileSurveyNative.api.browser.getOperation(${JSON.stringify(evaluation.context.operationId)})`)
      assert.equal(operation.phase,'completed','A completed observation action does not imply its declared condition passed')
      assert.deepEqual(operation.outcome.evaluation,evaluation);assert.deepEqual(operation.outcome.registration.context,evaluation.context)
      const beforeVerification=observation.snapshot().runScript
      const verified=await evaluate(`profileSurveyNative.api.browser.verifyOutcome(${JSON.stringify(page.region.browserId)},${JSON.stringify(operation.id)})`)
      assert.deepEqual(verified,evaluation);assert.equal(observation.snapshot().runScript,beforeVerification,'Verifying recorded field evidence does not rerun its producer')
      const inspected=await actorRead(['browser','inspect','--operation-id',operation.id]),listed=await actorRead(['browser','history','--browser',page.region.browserId])
      assert.deepEqual(inspected.runOperation.completion,evaluation);assert.deepEqual(listed.operations.find((value:any)=>value.id===operation.id)?.completion,evaluation)
      assert.equal(Object.hasOwn(inspected.runOperation,'outcome'),false,'Public completion does not expose the Main producer registration')
      const condition='.browser-outcome-criteria',label=status==='passed'?'Satisfied':'Not satisfied'
      await nativeUntil(()=>evaluate(`Boolean(document.querySelector('.browser-rsi-timeline[data-operation-id="${operation.id}"]'))`),'the original completion operation is selected in the real nearby activity rail')
      if(!await evaluate(`document.querySelector('${condition}').open`))await input.click(condition+' > summary')
      const ui=await nativeUntil(()=>evaluate(`(()=>{const timeline=document.querySelector('.browser-rsi-timeline[data-operation-id="${operation.id}"]'),root=timeline?.closest('.browser-trace-rail')?.querySelector('${condition}');if(!root?.checkVisibility())return null;const summary=root.querySelector(':scope>summary')?.textContent;if(summary!==${JSON.stringify('Completion condition · '+label)})return null;return{operationId:timeline.dataset.operationId,summary,open:root.open,statuses:[...root.querySelectorAll('[data-outcome-status]')].map(e=>({status:e.dataset.outcomeStatus,text:e.textContent})),action:timeline.querySelector('.browser-rsi-timeline__header small')?.textContent}})()`),'the real nearby UI distinguishes this declared condition from action termination')
      assert.equal(ui.open,true);assert.deepEqual(ui.statuses.map((value:any)=>value.status),[status]);assert.ok(ui.statuses[0].text.length>0);assert.ok(ui.action.endsWith('Completed'))
      proof.completionChecks.push({declaration,evaluation,operation,verified,inspected,history:listed.operations.find((value:any)=>value.id===operation.id),ui,controlAfter:(await browserState(page.region.browserId)).control})
      await capture('completion-condition-'+status,'dark')
    }
    assert.equal((await browserState(page.region.browserId)).navigationId,originalNavigation)
    assert.equal(await identity(await native(page.region.browserId)),'workface-person','Read-only field conditions preserve the original page identity')
    await input.click('[aria-label="Close browser activity timeline"]')
    mark('original-completion-evaluation-public-carrier-and-nearby-ui')
    // Field checking is an explicit automation action in the existing owner;
    // final native reading therefore takes control again through the same UI.
    await input.click(region(page.region.regionId)+' [aria-label="Take control of Browser"]')
    await nativeUntil(async()=>(await browserState(page.region.browserId)).control.owner==='human','the person explicitly chooses the original page for final native reading')
    proof.finalControl={browserId:page.region.browserId,owner:'human',source:'Trusted Take control pointer and original Main snapshot'}
    for(const mode of ['dark','light']){await evaluate(`profileSurveyNative.appearance(${JSON.stringify(mode)})`);window.setSize(1280,900);const settled=await geometry(page,ctx.pageUrl+'?complete-A');await capture('original-page-and-agent',mode);proof.frames.at(-1).geometry=settled}
    await writeFile(join(directory,'first-complete-native-page.png'),(await (await native(page.region.browserId)).webContents.capturePage()).toPNG())
    await writeFile(join(directory,'first-complete-native-child.png'),(await childView.webContents.capturePage()).toPNG())
    await evaluate('profileSurveyNative.checkpoint()')
    const final=await facts(),runtimeFinal=await core.statusAgent(actor.agent.agentSessionId);assert.equal(runtimeFinal.run.state,'running');assert.equal(runtimeFinal.run.pid,runtimeBefore.run.pid)
    for(const [id,draft]of Object.entries(seeded.launcherDrafts))assert.deepEqual(final.launcherDrafts[id],draft,'The whole chain keeps every original unsent App draft')
    receipt.savedIdentity={actor:actor.agent,runtime:{run:runtimeFinal.run,identity:core.runtimeIdentity()},page,other,defaultTask,defaultPage:defaultPage.reference,profiles:{a,b},child:proof.child,download:proof.download.reference,downloadSha256:hash(bytes),launcherDrafts:final.launcherDrafts,pageReferences:(await result(['space','survey-list'])).pageReferences,profileView:final.surveyProfileView,tabs:Object.fromEntries(Object.values(final.tabs).map((tab:any)=>[tab.id,persistentTask(tab)])),cost:proof.cost,storagePath:(await native(page.region.browserId)).webContents.session.storagePath}
    await writeFile(join(directory,'complete-retained.json'),JSON.stringify(receipt.savedIdentity))
  }else{
    const prior=JSON.parse(await readFile(join(directory,'complete-retained.json'),'utf8')),cold=await facts()
    proof.unstartedColdSessionIds=prior.cost.unrelatedSessions.map((value:any)=>value.agentSessionId)
    const actualRuns=await core.listRuns();for(const record of prior.cost.unrelatedSessions)assert.equal(actualRuns.some((run:any)=>run.runId===record.runId),false,'Persisted unrelated cold records do not awaken a Runtime Run during App restart')
    for(const [id,tab]of Object.entries(prior.tabs))assert.deepEqual(persistentTask(cold.tabs[id]),tab,'The second PID preserves the complete original Task/Browser/child/result layout')
    assert.deepEqual(cold.launcherDrafts,prior.launcherDrafts);assert.deepEqual((await result(['space','survey-list'])).pageReferences,prior.pageReferences);assert.deepEqual(cold.surveyProfileView,prior.profileView)
    const status=await core.statusAgent(prior.actor.agentSessionId);assert.equal(status.run.state,'running');assert.equal(status.run.runId,prior.runtime.run.runId);assert.equal(status.run.pid,prior.runtime.run.pid);assert.deepEqual(core.runtimeIdentity(),prior.runtime.identity)
    proof.runtimeObserved={run:status.run,identity:core.runtimeIdentity()}
    const submission=await core.submitAgentPrompt({agentSessionId:prior.actor.agentSessionId,expectedRun:{runId:status.run.runId},admissionIntent:{kind:'manual-actor'},execution:'immediate',authorHuman:true,operationId:'workface-new-input-after-restart',prompt:'Private fixture new input on the original healthy Runtime after App restart'})
    const accepted=await nativeUntil(()=>{const current=core.agentSession(prior.actor.agentSessionId);return current.promptCompletionAdmission?.acknowledged?current.promptCompletionAdmission:null},'Core acknowledges new input on the actual original healthy Run')
    assert.equal(accepted.submissionId,'workface-new-input-after-restart','The new original Run input owns this exact admission')
    assert.deepEqual(accepted.inputKey,{kind:'prompt',agentSessionId:prior.actor.agentSessionId,expectedRun:{runId:status.run.runId},submissionId:'workface-new-input-after-restart'})
    const after=await core.statusAgent(prior.actor.agentSessionId);assert.equal(after.run.state,'running');assert.equal(after.run.pid,prior.runtime.run.pid)
    proof.runtimeRecovery={before:status.run,after:after.run,identity:core.runtimeIdentity(),newSubmission:submission,admission:{acknowledged:accepted.acknowledged,submissionId:accepted.submissionId,operationId:accepted.operationId,inputKey:accepted.inputKey,transport:accepted.transport??'terminal',startByte:accepted.startByte,endByte:accepted.endByte}}
    const bytes=await readFile(join(directory,'workspace/workface-result.txt'));assert.equal(hash(bytes),prior.downloadSha256)
    const retained=await actorRead(['browser','history','--browser',prior.page.region.browserId]);assert.ok(retained.operations.some((operation:any)=>operation.id==='workface-authorized-result'))
    await showSurvey();await choose(prior.profiles.a.id);await activate(prior.page.survey.reference)
    const view=await native(prior.page.region.browserId,ctx.pageUrl+'?complete-A');assert.equal(await identity(view),'workface-person');assert.equal(view.webContents.session.storagePath,prior.storagePath)
    await nativeUntil(()=>view.getVisible()&&view.getBounds().width>0,'the second PID original native page is visible')
    proof.recoveredGeometry=await geometry(prior.page,ctx.pageUrl+'?complete-A');assert.equal(proof.recoveredGeometry.native.visible,true)
    for(const mode of ['dark','light'])await capture('restored-original-workface',mode)
    receipt.recoveredIdentity=prior
    mark('second-pid-original-workface-authoritative-runtime-and-readable-result')
  }
  const required=phase==='first'?['same-candidate-default-real-login','credential-bound-original-page-and-trusted-association','compiled-cli-run-inspect-follow-stop-original-owner','trusted-human-take-and-return-with-original-input','cross-origin-native-child-original-profile-and-source','original-download-authorized-workspace-and-public-read','related-native-operation-counts-with-unrelated-persistent-records','original-completion-evaluation-public-carrier-and-nearby-ui']:['second-pid-original-workface-authoritative-runtime-and-readable-result']
  assert.ok(required.length>0&&required.every(kind=>proof.cases.some((value:any)=>value.kind===kind&&value.passed)),'Every dedicated complete stage must actually execute')
  assert.ok(proof.frames.length>0,'The complete case must produce actual integrated workface frames')
  proof.completed=true;receipt.cases.push({kind:'complete-dedicated-oracle',phase,passed:true})
}
