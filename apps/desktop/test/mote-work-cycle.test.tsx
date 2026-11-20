// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import {afterEach,expect,it,vi} from 'vitest'
import {readFile,appendFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {createMoteWorkThreadFixture,openMoteWorkThread} from '../../../packages/core/test/helpers/mote-work-thread'
import {createMoteApp,moteClick,settleMoteApp,type MoteAppFixture} from './fixtures/mote-app'
import {moteTopics,defaultAgent,defaultTab} from './fixtures/mote-workface'
import {api} from '../src/renderer/src/lib/api'
import {useAppStore} from '../src/renderer/src/store'
import {scratchTopicsScope} from '../src/renderer/src/lib/scratch-topic-snapshots'
import {PMO_TEAMS_TOPIC_ID,scratchTopicDirectoryName} from '@agentmux/host/mote-model'
import {MOTE_SUPERVISION_GUIDANCE} from '../../../packages/core/src/mote/guidance'
import {MOTE_INPUT_GUIDANCE} from '../../../packages/core/src/mote/input-source'
let app:MoteAppFixture|undefined
const closes:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{await app?.dispose();app=undefined;for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();vi.unstubAllEnvs()})
async function fixture(){
 const f=await createMoteWorkThreadFixture({directoryAddress:true,topicId:PMO_TEAMS_TOPIC_ID});closes.push(f.close)
 const call=<M extends Parameters<typeof f.rpc.call>[0]>(method:M,params:any)=>f.rpc.call(method,params,{credentials:{agentSessionId:'primary',capability:f.capability}}) as Promise<any>
 const read=(path:string)=>call('file.read',{...f.target,path})
 const write=(input:any)=>call('file.write',{...f.target,...input})
 const witness=async(kind:string,facts:unknown)=>{if(process.env.MOTE_CYCLE_FACTS)await appendFile(process.env.MOTE_CYCLE_FACTS,JSON.stringify({kind,facts})+'\n')}
 return{...f,call,read,write,witness}
}
async function showIdeas(f:Awaited<ReturnType<typeof fixture>>){
 app=createMoteApp();const state=useAppStore.getState(),workspace={...state.config!.workspaces.find(w=>w.id==='__scratch__')!,path:f.target.expectedResource.workspacePath},root=scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID)
 const topic={...moteTopics[0]!,directoryPath:dirname(f.motePath),topicPath:join(dirname(f.motePath),'topic.md'),soul:{path:join(dirname(f.motePath),'SOUL.md'),content:'# Original SOUL',version:'original'}}
 useAppStore.setState({config:{...state.config!,workspaces:state.config!.workspaces.map(w=>w.id===workspace.id?workspace:w)},scratchTopicSnapshots:{[workspace.id]:{scope:scratchTopicsScope(workspace),revision:1,topics:[topic],error:null,reading:false}},toolsOpen:true,explorerCollapsed:{[workspace.id]:false}})
 useAppStore.getState().activateTab('__scratch__','mote-group',defaultTab.id)
 vi.mocked(api.scratch.listTopics).mockResolvedValue([topic]);vi.mocked(api.scratch.readTopic).mockResolvedValue(topic)
 const directories=vi.spyOn(api.files,'readDirectory').mockImplementation(async(_workspace,path)=>{
  const relative=path===root?'.':path.startsWith(root+'/')?path.slice(root.length+1):path
  const result=await f.rpc.call('file.list',{...f.target,path:relative,mode:'directory'})
  if(result.result.status!=='directory-listed')throw Error('Original directory not readable: '+JSON.stringify(result))
  return result.result.entries.map(entry=>({...entry,path:entry.path.startsWith(root+'/')?entry.path:root+'/'+entry.path}))
 })
 const fileReads=vi.spyOn(api.files,'readPublic').mockImplementation(input=>f.rpc.call('file.read',input))
 vi.spyOn(api.files,'observe').mockResolvedValue();vi.spyOn(api.files,'unobserve').mockResolvedValue()
 await app.mount();await settleMoteApp()
 const panel=()=>{const node=document.querySelector<HTMLElement>('.mote-details');expect(node).not.toBeNull();return node!}
 const ideas=()=>[...document.querySelectorAll<HTMLButtonElement>('[aria-label="Mote pages"] button')].find(button=>button.textContent?.trim()==='Ideas')
 await vi.waitFor(()=>expect(ideas()).toBeDefined());await moteClick(ideas()!)
 await vi.waitFor(()=>expect(panel().dataset.section).toBe('ideas'))
 return{panel,directories,fileReads}
}
it('the original source CLI and Files tool chain saves a sourced proposal where the complete App Ideas actually reads it',async()=>{
 const f=await fixture(),work=await openMoteWorkThread(f),beforeWrites=f.writes.length,beforeLaunches=f.launches.length
 const page=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1})
 expect(page.links).toHaveLength(1);expect(page.observations[0].communication.replyMessageIds).toContain('first-work-result')
 expect(page.coverage).toBe('linked-sources-only');expect(page.links[0].origin.messageId).toBe(work.messageId)
 const source=await f.client.readMessage({messageId:'first-work-result'});expect(source!.envelope.body).toBe('Original scoped research result')
 expect(MOTE_INPUT_GUIDANCE).toContain(MOTE_SUPERVISION_GUIDANCE);expect(MOTE_SUPERVISION_GUIDANCE).toContain('Zero\nideas is a valid result.')
 const path='Review a smaller experiment.md',absent=await f.read(path);expect(absent.result.status).toBe('deleted');expect(absent.resource).not.toBeNull()
 // Controlled Agent tool choice, not a claim that a live model adopted the guide.
 const proposal='# A smaller experiment\n\nProposal, not accepted work.\nSource: '+work.messageId+' / first-work-result, 2026-11-15.\nScope: original research only.\nAssumption: a smaller sample may expose the uncertainty.\nNext: compare one bounded experiment before requesting implementation.\n'
 const request={...f.target,path,expectedResource:absent.resource!,expectedRevision:null,content:proposal}
 const saved=await f.call('file.create',request);expect(saved.result.status).toBe('written')
 const readback=await f.cli(['file','read','--zone',f.target.zoneId,'--space',f.target.spaceId,'--path',path,'--host','local','--workspace','__scratch__','--workspace-path',f.target.expectedResource.workspacePath])
 expect(readback.result.status).toBe('read');expect(readback.result.document.content).toBe(proposal);expect(readback.result.document.revision).toBe(saved.result.revision)
 const view=await showIdeas(f);await vi.waitFor(()=>expect(view.panel().textContent).toContain('Review a smaller experiment'))
 const button=[...view.panel().querySelectorAll<HTMLButtonElement>('.mote-details__note')].find(b=>b.textContent?.includes('Review a smaller experiment'))!;await moteClick(button)
 await vi.waitFor(()=>expect(view.panel().textContent).toContain('compare one bounded experiment'))
 expect(f.writes).toHaveLength(beforeWrites);expect(f.launches).toHaveLength(beforeLaunches);expect(app!.send).not.toHaveBeenCalled();expect(app!.launch).not.toHaveBeenCalled();expect(app!.stop).not.toHaveBeenCalled();expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
 expect(view.directories.mock.calls.every(call=>call[0]==='__scratch__')).toBe(true);expect(view.panel().dataset.moteDetails).toBe(PMO_TEAMS_TOPIC_ID);expect(view.panel().dataset.section).toBe('ideas');expect(view.fileReads.mock.calls.some(([input])=>input.spaceId===f.target.spaceId&&input.zoneId===f.target.zoneId&&input.path===path)).toBe(true)
 await f.witness('idea-visible',{target:f.target,page,request,saved,readback,visible:view.panel().textContent,moteId:view.panel().dataset.moteDetails,section:view.panel().dataset.section,fileReadRequests:view.fileReads.mock.calls.map(row=>row[0]),control:{writesBefore:beforeWrites,writesAfter:f.writes.length,launchesBefore:beforeLaunches,launchesAfter:f.launches.length,uiSend:app!.send.mock.calls,uiLaunch:app!.launch.mock.calls,uiStop:app!.stop.mock.calls,draft:useAppStore.getState().agentComposerDrafts[defaultAgent.id]}})
})
it('a related original Ideas note keeps user text and exact revision CAS; a later conflict never becomes a successful integration',async()=>{
 const f=await fixture(),path='Original experiment.md',original='# Original experiment\n\nUser paragraph stays.\n',empty=await f.read(path)
 expect((await f.call('file.create',{...f.target,path,expectedResource:empty.resource,expectedRevision:null,content:original})).result.status).toBe('written')
 const read=await f.read(path),addition='\nProposal from the original report: test one smaller sample.\n',request={path,expectedResource:read.resource,expectedRevision:read.result.document.revision,content:read.result.document.content+addition}
 expect((await f.write(request)).result.status).toBe('written');expect((await f.read(path)).result.document.content).toBe(original+addition)
 const baseline=await f.read(path),human=baseline.result.document.content+'\nLater human correction.\n';expect((await f.write({path,expectedResource:baseline.resource,expectedRevision:baseline.result.document.revision,content:human})).result.status).toBe('written')
 const draft={path,expectedResource:baseline.resource,expectedRevision:baseline.result.document.revision,content:baseline.result.document.content+'\nAnother proposal.\n'},frozen=structuredClone(draft),conflict=await f.write(draft)
 expect(conflict.result.status).toBe('conflict');expect(draft).toEqual(frozen);expect((await f.read(path)).result.document.content).toBe(human)
 const view=await showIdeas(f);await vi.waitFor(()=>expect(view.panel().textContent).toContain('Original experiment'));await moteClick([...view.panel().querySelectorAll<HTMLButtonElement>('.mote-details__note')].find(b=>b.textContent?.includes('Original experiment'))!);await vi.waitFor(()=>expect(view.panel().textContent).toContain('Later human correction.'))
 expect(await readFile(join(dirname(f.motePath),path),'utf8')).toBe(human);expect(app!.launch).not.toHaveBeenCalled();expect(app!.stop).not.toHaveBeenCalled()
 await f.witness('related-cas',{request,draft,frozen,conflict,canonical:await f.read(path)})
})
it('zero retained ideas performs no write or extra work; an unknown saved write stays unknown after exact readback',async()=>{
 const f=await fixture(),work=await openMoteWorkThread(f),underlying=f.files.write.bind(f.files),create=vi.spyOn(f.files,'create'),write=vi.spyOn(f.files,'write')
 const page=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1});expect(page.links[0].origin.messageId).toBe(work.messageId)
 const before=f.writes.length,launches=f.launches.length
 // The controlled turn chooses zero useful increments. No empty log or quota is synthesized.
 expect(create).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(f.writes).toHaveLength(before);expect(f.launches).toHaveLength(launches)
 const path='Retained proposal.md',empty=await f.read(path);expect((await f.call('file.create',{...f.target,path,expectedResource:empty.resource,expectedRevision:null,content:'# Original\n'})).result.status).toBe('written')
 const baseline=await f.read(path),request={...f.target,path,expectedResource:baseline.resource,expectedRevision:baseline.result.document.revision,content:'# Original\n\nProposal, scope not expanded.\n'}
 write.mockImplementationOnce(async(...args)=>{await underlying(...args);return{resource:args[0].expectedResource,result:{status:'unknown',code:'ORIGINAL_ACK_UNAVAILABLE',message:'Inspect the original exact file; no new write is authorized.'}}})
 const result=await f.call('file.write',request);expect(result.result.status).toBe('unknown');const readback=await f.read(path);expect(readback.result.document.content).toBe(request.content);expect(result.result.status).toBe('unknown');expect(write).toHaveBeenCalledTimes(1);expect(write.mock.calls[0]![0]).toEqual(request)
 await f.witness('zero-and-unknown',{zero:{create:0,write:0},request,result,readback,writeCalls:write.mock.calls.length})
})
it('a failed or foreign same-ID work source stays item unknown rather than an empty or borrowed Goal; link watermarks do not freeze Dispatch replies',async()=>{
 const f=await fixture(),work=await openMoteWorkThread(f),first=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1})
 await seedStoredDemand(f.demands, {id:'same-id-on-neighbor',title:'A local Goal is not the foreign original owner',status:'in_progress'})
 const goalReads=vi.spyOn(f.demands,'get')
 const original=f.client.readDispatch.bind(f.client)
 const fail=vi.spyOn(f.client,'readDispatch').mockRejectedValueOnce(Error('Exact original source unavailable'))
 const gap=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1});expect(gap.links).toHaveLength(1);expect(gap.observations[0]).toMatchObject({communication:null,issue:'Exact original source unavailable'});fail.mockRestore()
 const foreign=vi.spyOn(f.client,'readDispatch').mockImplementation(async input=>{const value=await original(input);return{...value,dispatch:{...value.dispatch,threadId:'foreign-thread'},source:{...value.source,envelope:{...value.source.envelope,threadId:'foreign-thread',application:{schema:'agentmux.goal-delegation.v1',data:{goalId:'same-id-on-neighbor',delegationOperationId:'neighbor-delegation',alignmentRevision:1,criteria:[{id:'neighbor',text:'Do not borrow this Goal'}]}}}}} as any})
 const wrong=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1});expect(wrong.links).toHaveLength(1);expect(wrong.observations[0].communication).toBeNull();expect(wrong.observations[0].issue).toContain('another original work source');expect(goalReads).not.toHaveBeenCalled();foreign.mockRestore()
 await f.cli(['agent','send','--to-session','primary','--text','A later original question','--reply-to',work.messageId,'--thread',work.source!.envelope.threadId,'--message-id','later-question','--operation-id','later-question-op'],undefined,work.opened.agent.agentSessionId,f.launches[0]!.env.AGENTMUX_AGENT_CAPABILITY)
 await f.cli(['message','dispatch','report','--source-message',work.messageId,'--reply-message','later-question','--kind','question'],undefined,work.opened.agent.agentSessionId,f.launches[0]!.env.AGENTMUX_AGENT_CAPABILITY)
 const later=await f.cli(['space','mote','dialogue','supervision','read','--input','-'],{target:f.target,limit:1});expect(later.throughSequence).toBe(first.throughSequence);expect(later.observations[0].communication.replyMessageIds).toContain('later-question');expect(later.observations[0].communication.events).toContainEqual({kind:'question',replyMessageId:'later-question'})
 await f.witness('source-coverage',{first,gap,wrong,later,goalReads:goalReads.mock.calls})
})
