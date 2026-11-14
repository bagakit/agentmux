// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import {act,useEffect,useLayoutEffect}from'react'
import{expect,it,vi}from'vitest'
import{appendFileSync}from'node:fs'
import{createWorkspaceLayout}from'@agentmux/layout'
import{questionReplyKey}from'@agentmux/client-ui/conversation-question-reply'
import{useAppStore,type AgentSteerQueueEntry}from'../src/renderer/src/store'
import{createWorkbenchTab}from'../src/renderer/src/lib/workbench-tabs'
import{composerConfig,composerSession}from'./helpers/composer-dom-fixture'
import{createClientUiRoot}from'./helpers/client-ui-render'
import{WorkspaceWorkbench}from'../src/renderer/src/components/WorkspaceWorkbench'
import{AgentComposerTools}from'../src/renderer/src/components/AgentComposerTools'
import{AgentContextUsage}from'../src/renderer/src/components/AgentContextUsage'
import{ObservationSurfaceGallery}from'../src/renderer/src/components/ObservationSurfaceGallery'
import{api}from'../src/renderer/src/lib/api'
import type{SessionSnapshot}from'../src/shared/contracts'
const port=vi.hoisted(()=>({mounts:{}as Record<string,number>,retires:{}as Record<string,number>}))
vi.mock('../src/renderer/src/components/TerminalView',()=>({
 TerminalView:({session}:{session:SessionSnapshot})=>{
  useEffect(()=>{port.mounts[session.id]=(port.mounts[session.id]??0)+1;return()=>{port.retires[session.id]=(port.retires[session.id]??0)+1}},[session.id])
  return <output data-native-port={session.id} data-run={session.control.run.runId}/>
 }
}))
vi.mock('react-resizable-panels',async()=>{
 const{createRequire}=await import('node:module')
 return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
function record(value:unknown){if(process.env.COMPOSER_TOOLS_FACTS)appendFileSync(process.env.COMPOSER_TOOLS_FACTS,JSON.stringify(value)+'\n')}
it('actual Workspace Pane Composer editor and Mailbox stay live while only never-presented Tools DOM waits',async()=>{
 const initial=useAppStore.getState()
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}}))
 const host=document.body.appendChild(document.createElement('div')),root=createClientUiRoot(host)
 const sessions=['a','b','c'].map(id=>composerSession(id)),b=sessions[1]!
 b.turnUsage={inputTokens:20,outputTokens:0,totalTokens:20,observedAt:1,context:{usedTokens:20,capacityTokens:100}}
 b.promptInputNotApplied={submissionId:'original-question-op',run:b.control.run}
 const input={source:{providerId:'codex',nativeSessionId:'original-native'},turnId:'original-turn',recordId:'original-question',operationId:'original-question-op',
  expectedRun:b.control.run,afterSubmissionId:null,answers:[{questionId:'q',answer:'Original frozen answer'}]}
 const key=questionReplyKey(b.id,input)
 const queueEntry:AgentSteerQueueEntry={operationId:'original-deferred-b',runId:b.control.run.runId,text:'Original explicitly deferred queue 中',status:'deferred',awaitingExplicitSend:true,enqueuedAt:1}
 const send=vi.spyOn(useAppStore.getState(),'send')
 const tabs=Object.fromEntries(sessions.map(s=>[s.id,createWorkbenchTab(s.id,{kind:'agent',phase:'attached',regionId:'region-'+s.id,workspaceId:'workspace',sessionId:s.id})]))
 tabs.launcher=createWorkbenchTab('launcher',{kind:'launcher',regionId:'region-launcher',workspaceId:'workspace'})
 const skills=vi.spyOn(api.ui,'listAgentSkills').mockResolvedValue([{name:'alpha',description:'Original alpha skill',path:'/private/alpha/SKILL.md',source:'project'},{name:'omega',description:'Original omega skill',path:'/private/omega/SKILL.md',source:'project'}])
 let captureDone:()=>void=()=>{}
 const capture=vi.spyOn(api.ui,'captureScreenshot').mockImplementation(()=>new Promise(resolve=>{captureDone=()=>resolve(null)}))
 useAppStore.setState({config:{...composerConfig,composerShortcuts:[{id:'original-command',keyword:'original-status',label:'Read original status',body:'Exact configured command body'}]},loading:false,sessions,tabs,layouts:{workspace:createWorkspaceLayout('group',['a','b','c','launcher'])},timelines:{},agentNames:{},
  activeWorkspaceId:'workspace',mainSurface:'workbench',providerCatalog:[],agentComposerDrafts:{a:'Original a',b:'Original b 中文',c:'Original c'},agentSteerQueues:{b:[queueEntry]},
  questionReplies:{b:{[key]:{hostId:'local',phase:'unknown',input,diagnostic:{code:'ORIGINAL_UNKNOWN',message:'Original uncertainty'}}}},
  viewModes:{a:'terminal',b:'terminal',c:'terminal'},pendingAgentLaunches:{},recoveryCandidates:[],runtimeEndpointWarnings:[]})
 const region=(id:string)=>host.querySelector<HTMLElement>('[data-workbench-region-id="region-'+id+'"]')!
 const activate=(id:string)=>act(async()=>useAppStore.getState().activateTab('workspace','group',id,'local'))
 const click=(node:HTMLElement|null)=>{expect(node).not.toBeNull();return act(async()=>node!.click())}
 try{
  await act(async()=>root.render(<WorkspaceWorkbench workspaceId="workspace" visible/>))
  const initialCosts={allTools:host.querySelectorAll('.composer-tools').length,agentTools:['a','b','c'].filter(id=>region(id).querySelector('.composer-tools')).length,
   launcherTools:region('launcher').querySelectorAll('.composer-tools').length,svg:host.querySelectorAll('svg').length,dom:host.querySelectorAll('*').length,
   agentBodies:host.querySelectorAll('.agent-surface').length,richEditors:host.querySelectorAll('[contenteditable="true"]').length,
   mailbox:host.querySelectorAll('.composer-mailbox').length,contextChips:host.querySelectorAll('.composer__context').length,contextCards:host.querySelectorAll('.composer__context-card').length}
  expect(initialCosts.contextChips,'Actual hidden Composers must not prebuild context chips').toBe(1)
  expect(initialCosts.contextCards,'Actual hidden Composers must not prebuild context cards').toBe(1)
  expect(useAppStore.getState().questionReplies.b?.[key]?.phase,'Original hidden background reply reconciliation must still execute').toBe('rejected')
  expect(Object.keys(port.mounts)).toEqual(['a','b','c'])
  const bPane=region('b').querySelector('.agent-surface')
  await activate('b')
  const contextChip=region('b').querySelector('.composer__context'),contextCard=region('b').querySelector('.composer__context-card')
  expect(contextChip?.textContent).toContain('20%')
  const bInput=region('b').querySelector<HTMLElement & {editor:Editor}>('[contenteditable="true"]')
  expect(bInput).not.toBeNull()
  const tools=region('b').querySelector<HTMLElement>('.composer-tools')!
  expect(tools).not.toBeNull();expect(region('b').querySelector('[contenteditable="true"]')).toBe(bInput)
  await act(async()=>bInput!.editor.commands.setTextSelection({from:2,to:6}))
  const selection={from:bInput!.editor.state.selection.from,to:bInput!.editor.state.selection.to}
  await click(tools.querySelector('[aria-label="Show the message tool row"]'))
  expect(tools.dataset.mode).toBe('current')
  const skillTrigger=tools.querySelector<HTMLElement>('[aria-label="Choose a skill"]')!
  await act(async()=>skillTrigger.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',buttons:0})))
  await vi.waitFor(()=>expect(skills).toHaveBeenCalledExactlyOnceWith('b'))
  const query=document.querySelector<HTMLInputElement>('[aria-label="Find skills"]')!
  expect(query).not.toBeNull()
  await act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(query,'omega')
   query.dispatchEvent(new Event('input',{bubbles:true}))
  })
  expect(document.querySelector('.composer-menu__results')?.textContent).toContain('omega')
  await activate('a');await activate('b')
  expect(region('b').querySelector('.composer__context'),'Warm Composer retains its context chip').toBe(contextChip)
  expect(region('b').querySelector('.composer__context-card'),'Warm Composer retains its context reading DOM').toBe(contextCard)
  expect(region('b').querySelector('.composer-tools')).toBe(tools)
  expect(document.querySelector('[aria-label="Find skills"]')).toBe(query)
  expect(query.value).toBe('omega');expect(tools.dataset.mode).toBe('current')
  expect({from:bInput!.editor.state.selection.from,to:bInput!.editor.state.selection.to},'Original rich-editor selection remains through menu and warm navigation').toEqual(selection)
  const omega=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.includes('Original omega skill'))
  await click(omega??null)
  expect(expandSemanticReferences(useAppStore.getState().agentComposerDrafts.b!)).toContain('@/private/omega/SKILL.md')
  const commandTrigger=tools.querySelector<HTMLElement>('[aria-label="Choose a command"]')!
  await act(async()=>commandTrigger.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',buttons:0})))
  const command=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.includes('Read original status'))
  await click(command??null)
  expect(expandSemanticReferences(useAppStore.getState().agentComposerDrafts.b!)).toContain('Exact configured command body')
  const editedDraft=useAppStore.getState().agentComposerDrafts.b
  await click(tools.querySelector('[aria-label="Capture a screen region"]'))
  await vi.waitFor(()=>expect(capture).toHaveBeenCalledTimes(1))
  const button=tools.querySelector<HTMLButtonElement>('[aria-label="Capture a screen region"]')!
  expect(button.disabled).toBe(true)
  await activate('a')
  expect(region('b').querySelector('.composer-tools')).toBe(tools);expect(button.disabled).toBe(true)
  await act(async()=>captureDone())
  await activate('b')
  expect(region('b').querySelector('.agent-surface')).toBe(bPane)
  expect(region('b').querySelector('[contenteditable="true"]')).toBe(bInput)
  expect(region('b').querySelector('.composer-tools')).toBe(tools)
  expect(button.disabled).toBe(false);expect(capture).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentComposerDrafts.b).toBe(editedDraft)
  expect(useAppStore.getState().agentSteerQueues.b?.[0]).toBe(queueEntry)
  expect(queueEntry).toMatchObject({text:'Original explicitly deferred queue 中',status:'deferred',awaitingExplicitSend:true})
  expect(useAppStore.getState().sessions).toBe(sessions);expect(useAppStore.getState().sessions[1]).toBe(b)
  expect(region('b').querySelector('[data-native-port="b"]')?.getAttribute('data-run')).toBe(b.control.run.runId)
  expect(port.mounts.b).toBe(1);expect(send).not.toHaveBeenCalled()
  expect(port.retires).toEqual({})
  expect(initialCosts.launcherTools,'The unchanged default Launcher caller remains eager').toBeGreaterThan(0)
  record({case:'actual-tools-only-dom',initialCosts,afterVisits:{tools:host.querySelectorAll('.composer-tools').length,svg:host.querySelectorAll('svg').length,dom:host.querySelectorAll('*').length},
   backgroundQuestionRejected:true,actualMailboxNotStubbed:true,allPaneAndComposerEditorsRemain:true,originalDOMAndDraftPreserved:true,contextFirstPresentationAndWarmDOM:true,
   skillLoadAndFilteredMenuQueryWarm:true,skillAndCommandInsertUsable:true,selectionWarm:true,nonemptyDeferredQueueAndCurrentSessionRunPreserved:true,noCoreSend:true,layoutPhaseWarm:true,capturePendingAndCompletionWhileHidden:true,defaultLauncherEager:true,
   isolation:'Actual WorkspaceWorkbench/SessionPane/AgentSessionComposer/SessionMailbox/AgentComposerTools and maintained rich editor, no substitutes. Only native terminal port and skill/capture host calls controlled; no live App or allocation-byte claim.'})
  expect(initialCosts.agentTools,'Only never-presented agent Tools DOM should defer; real Pane/editor/mailbox stay mounted').toBe(1)
 }finally{captureDone();await act(async()=>root.unmount());host.remove();document.getElementById('agentmux-window-overlay-host')?.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()}
})

it('context first parent-layout contains current hidden updates and retains warm nodes, while the actual Gallery default stays eager',async()=>{
 const initial=useAppStore.getState()
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const host=document.body.appendChild(document.createElement('div')),root=createClientUiRoot(host)
 const frames:{visible:boolean;text:string|null;details:string|null}[]=[]
 type Usage=Parameters<typeof AgentContextUsage>[0]['usage']
 function Observed({visible,usage}:{visible:boolean;usage:Usage}){
  useLayoutEffect(()=>{frames.push({visible,text:host.querySelector('.composer__context')?.textContent??null,details:host.querySelector('.composer__context-card')?.textContent??null})})
  return <AgentContextUsage visible={visible} source="original-session/run" usage={usage}/>
 }
 const sample={inputTokens:25,outputTokens:0,totalTokens:25,observedAt:1,context:{usedTokens:25,capacityTokens:100}}
 const cases=[{name:'known',usage:{...sample,context:{usedTokens:75,capacityTokens:100}},chip:'75%',body:'25% remaining'},
  {name:'unknown',usage:{inputTokens:25,outputTokens:0,totalTokens:25,observedAt:1},chip:'—',body:'Used tokens and capacity not reported'},
  {name:'real-zero',usage:{...sample,context:{usedTokens:0,capacityTokens:100}},chip:'0%',body:'100% remaining'}]
 try{
  for(const sampleCase of cases){
   await act(async()=>root.render(<Observed key={sampleCase.name} visible={false} usage={sample}/>))
   expect(host.querySelector('.composer__context'),'Never-presented context has no chip DOM').toBeNull()
   expect(host.querySelector('.composer__context-card'),'Never-presented context has no details DOM').toBeNull()
   await act(async()=>root.render(<Observed key={sampleCase.name} visible={false} usage={sampleCase.usage}/>))
   const before=frames.length
   await act(async()=>root.render(<Observed key={sampleCase.name} visible usage={sampleCase.usage}/>))
   expect(frames[before]?.text,'First visible parent layout must contain current usage synchronously: '+sampleCase.name).toContain(sampleCase.chip)
   expect(frames[before]?.details).toContain(sampleCase.body)
   const chip=host.querySelector('.composer__context'),card=host.querySelector('.composer__context-card'),heading=card?.querySelector('h3')
   await act(async()=>root.render(<Observed key={sampleCase.name} visible={false} usage={sampleCase.usage}/>))
   expect(host.querySelector('.composer__context'),'Warm hidden context retains the exact chip').toBe(chip)
   expect(host.querySelector('.composer__context-card'),'Warm hidden context retains reading DOM').toBe(card)
   await act(async()=>root.render(<Observed key={sampleCase.name} visible usage={sampleCase.usage}/>))
   expect(host.querySelector('.composer__context-card h3')).toBe(heading)
  }
  useAppStore.setState({config:composerConfig})
  await act(async()=>root.render(<ObservationSurfaceGallery/>))
  expect(host.querySelector('.observation-gallery .composer__context')?.textContent,'Actual Gallery omits visible and remains eager').toContain('24%')
  record({case:'context-first-visible-parent-layout',samples:cases.map(c=>c.name),frames,firstLayoutCurrent:true,warmExactDOM:true,actualGalleryDefaultEager:true})
 }finally{await act(async()=>root.unmount());host.remove();document.getElementById('agentmux-window-overlay-host')?.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()}
})

it('the actual Tools runs hooks while initially inactive, shows on the first true render and leaves the omitted caller eager',async()=>{
 const initial=useAppStore.getState()
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const host=document.body.appendChild(document.createElement('div')),root=createClientUiRoot(host)
 const change=vi.fn(),load=vi.fn(async()=>[{name:'original',description:'Original skill',path:'/private/original/SKILL.md',source:'project' as const}])
 const props={disabled:false,commands:[{text:'/status',description:'Read original status'}],loadSkills:load,
  onChooseSkill:vi.fn(),onCommand:vi.fn(),runAction:async(action:()=>void|Promise<void>)=>{await action()},
  viewMode:'terminal' as const,onViewModeChange:change}
 try{
  useAppStore.setState({config:{...composerConfig,messageToolInitialLayout:'one-line'}})
  await act(async()=>root.render(<AgentComposerTools key="initial-hook" {...props} active={false}/>))
  expect(host.querySelector('.composer-tools')).toBeNull()
  useAppStore.setState({config:{...composerConfig,messageToolInitialLayout:'two-line'}})
  await act(async()=>root.render(<AgentComposerTools key="initial-hook" {...props} active/>))
  const shown=host.querySelector<HTMLElement>('.composer-tools')
  expect(shown,'The first true commit must render directly, without an effect or timer').not.toBeNull()
  expect(shown!.dataset.mode,'The initial hook ran while inactive and retained its original phase').toBe('collapsed')
  await act(async()=>root.render(<AgentComposerTools key="initial-hook" {...props} active={false}/>))
  expect(host.querySelector('.composer-tools')).toBe(shown)
  await act(async()=>root.render(<AgentComposerTools key="default-caller" {...props}/>))
  const eager=host.querySelector<HTMLElement>('.composer-tools')
  expect(eager).not.toBeNull();expect(eager!.dataset.mode).toBe('current')
  await act(async()=>eager!.querySelector<HTMLButtonElement>('[aria-label="Show Activity"]')!.click())
  expect(change).toHaveBeenCalledExactlyOnceWith('activity')
  expect(load).not.toHaveBeenCalled()
  record({case:'actual-tools-default-hooks-first-true',inactiveHooksRetainedPhase:true,firstTrueSynchronous:true,
   visitedHiddenSameDOM:true,omittedActiveEager:true,nonemptyControlAction:true,noAutomaticSkillOrCapture:true})
 }finally{await act(async()=>root.unmount());host.remove();useAppStore.setState(initial,true);vi.restoreAllMocks();vi.unstubAllGlobals()}
})
