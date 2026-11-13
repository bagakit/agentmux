import{afterEach,expect,it,vi}from'vitest'
import{join}from'node:path'
import{appendFile}from'node:fs/promises'
import{DatabaseSync}from'node:sqlite'
import{createElement}from'react'
import{renderToStaticMarkup}from'react-dom/server'
import{ConversationCoverage}from'../../client-ui/src/components/ConversationCoverage.js'
import{questionReplyOwner}from'./helpers/question-reply-owner.js'
import{savedQuestionJsonl}from'./helpers/codex-saved-question.js'
import{recordedQuestionAnswerFacts,projectConversationQuestions}from'../src/conversation-questions.js'
import{rpcOwnerFixture}from'./helpers/public-rpc-owner.js'
import{hostedTestClient}from'./helpers/hosted-runtime-port.js'
import{objectCliEnvironment}from'./helpers/object-cli-rpc.js'
import{runSourceObjectCli}from'./helpers/source-object-cli.js'
import{AgentMuxControlServer}from'../src/public-rpc-server.js'
import{connectAgentMuxRpc}from'../src/public-rpc-client.js'
import{consumeConversationWindowPage,type ConversationTimelineReadInput,type AgentConversationReadPage,type ConversationWindowAssembly}from'../src/conversation.js'
import{parseAgentSessionHistoryReadPage}from'../src/session-history-read-codec.js'
import{readAgentSessionHistory}from'../src/session-history-reader.js'
import{parseConversationChangesPage}from'../src/conversation-changes.js'
import{ConversationReaderState}from'../src/conversation-reader.js'
import{readConversationProcessDetail}from'../../client-ui/src/lib/read-conversation-process-detail.js'
import type{AgentTimelineItem}from'../src/types.js'
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(){
 const f=await rpcOwnerFixture(['retired-body']);cleanup.push(f.close)
 const reference={hostId:'local',agentSessionId:'retired-body'}
 const item=(content:string,id='a',updatedAt=1):AgentTimelineItem=>({id,agentSessionId:reference.agentSessionId,kind:'tool_call',source:'native-hook',status:'streaming',title:'Original process',content,createdAt:1,updatedAt})
 const write=(content:string,id='a',updatedAt=1)=>f.store.applyTimelineMutation({type:'upsert',agentSessionId:reference.agentSessionId,item:item(content,id,updatedAt)})
 return{...f,reference,item,write}
}
async function complete(read:(input:ConversationTimelineReadInput)=>Promise<AgentConversationReadPage>,input:ConversationTimelineReadInput){
 let pending:ConversationWindowAssembly|undefined,cursor=input.cursor
 for(let count=0;count<100;count++){
  const page=await read({...input,...(cursor?{cursor}:{})}),result=consumeConversationWindowPage(page,pending)
  if(result.kind==='complete')return result.snapshot
  pending=result.pending;cursor=page.nextCursor!
 }
 throw Error('Original bounded conversation frame did not finish')
}
it('old post-cut anchors expose the same original source-local gap through SDK, Hosted, actual RPC/source CLI and Renderer detail consumer',async()=>{
 const f=await fixture();await f.write('original body')
 const opening=await complete(input=>f.client.readAgentConversation(input),f.reference)
 const record=opening.units.flatMap(unit=>unit.records).find(record=>record.reference?.source.kind==='captured')!
 expect(record).toBeDefined()
 const anchor={record:record.reference!,revision:record.revision,frontier:opening.window.checkpoint}
 await f.write('new body')
 const exact={...f.reference,anchor},sdk=await complete(input=>f.client.readAgentConversation(input),exact)
 expect(sdk.units).toEqual([])
 const renderedGap=renderToStaticMarkup(createElement(ConversationCoverage,{coverage:sdk.coverage}))
 expect(renderedGap).toContain('data-conversation-gap="AGENT_CONVERSATION_VERSION_UNAVAILABLE"');expect(renderedGap).toContain('unavailable')
 expect(sdk.coverage.find(row=>row.source.kind==='captured')).toMatchObject({current:'unavailable',gaps:[{code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE',record:anchor.record}]})
 const current=await complete(input=>f.client.readAgentConversation(input),{...f.reference,record:anchor.record})
 expect(current.units.flatMap(unit=>unit.records)).toMatchObject([{original:{item:{content:'new body'}}}])
 const replay=await complete(input=>f.client.readAgentConversation(input),{...f.reference,view:opening.window.view!})
 expect(replay.units.flatMap(unit=>unit.records)).toMatchObject([{original:{item:{content:'original body'}}}])
 const hosted=await hostedTestClient(f.client);cleanup.push(hosted.dispose)
 const hostedPage=await hosted.sdk.readAgentConversation(exact)
 expect(hostedPage.coverage).toEqual(sdk.coverage)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'g.sock'));await server.start();cleanup.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
 const remote=await rpc.call('agent.conversation.inspect',exact);expect(remote.coverage).toEqual(sdk.coverage)
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','conversation','inspect','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),JSON.stringify(exact),15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.coverage).toEqual(sdk.coverage)
 await expect(readConversationProcessDetail(f.client,anchor,new AbortController().signal)).rejects.toThrow(/unavailable/)
 const originalBytes=JSON.stringify(opening)
 expect(JSON.stringify(replay.units)).toBe(JSON.stringify(opening.units));expect(originalBytes).toContain('original body')
 expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('basic frozen history cursor keeps retired header alignment and returns its gap instead of latest or a shifted record',async()=>{
 const f=await fixture();await f.write('first a');await f.write('separate b','b')
 const input={...f.reference,source:'captured' as const,limit:1}
 const first=await f.client.readAgentSessionHistory(input);expect(first.items).toMatchObject([{item:{id:'b'}}]);expect(first.nextCursor).toBeTypeOf('string')
 await f.write('latest a')
 const next=await f.client.readAgentSessionHistory({...input,cursor:first.nextCursor!})
 expect(parseAgentSessionHistoryReadPage(next,{...input,cursor:first.nextCursor!})).toEqual(next)
 expect(next.items).toEqual([]);expect(next.nextCursor).toBeNull();expect(next.revision).toBe(first.revision)
 expect(next.capturedStream).toMatchObject({sequence:2,gaps:[{code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}]})
})
it('an all-null limited page keeps a nonempty real public continuation and CLI gap until the final frozen header is visited',async()=>{
 const f=await fixture();await f.write('first a');await f.write('first b','b');await f.write('first c','c')
 const input={...f.reference,source:'captured' as const,limit:1},first=await f.client.readAgentSessionHistory(input)
 expect(first.items).toMatchObject([{item:{id:'c'}}]);await f.write('later a');await f.write('later b','b')
 const middle=await f.client.readAgentSessionHistory({...input,cursor:first.nextCursor!})
 expect(middle).toMatchObject({availability:'empty',items:[],capturedStream:{sequence:3,gaps:[{code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}]}})
 expect(middle.nextCursor).toBeTypeOf('string')
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'null-page.sock'));await server.start();cleanup.push(()=>server.stop())
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','history','--host','local','--session',f.reference.agentSessionId,'--source','captured','--limit','1','--cursor',first.nextCursor!],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),'',15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result).toMatchObject({availability:'empty',items:[],nextCursor:middle.nextCursor,capturedStream:middle.capturedStream})
 const last=await f.client.readAgentSessionHistory({...input,cursor:middle.nextCursor!})
 expect(last).toMatchObject({availability:'empty',items:[],nextCursor:null,capturedStream:{sequence:3,gaps:[{code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}]}})
 expect(f.rawInput).not.toHaveBeenCalled()
})
it('retirement during an original JSON fragment refuses that exact unavailable version without shifting its byte cursor',async()=>{
 const f=await fixture();await f.write('original bytes '.repeat(4000))
 const input={...f.reference,source:'captured' as const,limit:1,maxBytes:4096},first=await f.client.readAgentSessionHistory(input)
 expect(first.items[0]).toMatchObject({kind:'fragment',itemId:'a',offsetBytes:0});expect(first.nextCursor).toBeTypeOf('string')
 await f.write('replacement body')
 await expect(f.client.readAgentSessionHistory({...input,cursor:first.nextCursor!})).rejects.toMatchObject({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'})
 expect(first.items[0]).toMatchObject({kind:'fragment',itemId:'a',offsetBytes:0})
 expect(f.rawInput).not.toHaveBeenCalled()
})
it('bounded text scan counts missing-body headers on later pages and preserves the source gap at end of scan',async()=>{
 const f=await fixture();await f.write('oldest body')
 for(let index=1;index<=101;index++)await f.write('other body '+index,'other-'+index)
 const originalGaps=Array.from({length:100},(_,index)=>({code:index===42?'AGENT_CONVERSATION_VERSION_UNAVAILABLE':'ORIGINAL_QUERY_GAP_'+index,message:'Original query gap message '+index}))
 const db=new DatabaseSync(f.store.path);try{db.prepare('UPDATE captured_streams SET gaps_json=? WHERE session_id=?').run(JSON.stringify(originalGaps),f.reference.agentSessionId)}finally{db.close()}
 const input={...f.reference,source:'captured' as const,kind:'text' as const,query:'no matching literal',scanLimit:100,limit:1}
 const first=await f.client.readAgentSessionHistory(input);expect(first.scan).toEqual({examined:100,complete:false});expect(first.nextCursor).toBeTypeOf('string')
 expect(first.capturedStream?.gaps).toEqual(originalGaps)
 await f.write('later current oldest body')
 const next=await f.client.readAgentSessionHistory({...input,cursor:first.nextCursor!})
 expect(parseAgentSessionHistoryReadPage(next,{...input,cursor:first.nextCursor!})).toEqual(next)
 expect(next.items).toEqual([]);expect(next.scan).toEqual({examined:2,complete:true});expect(next.nextCursor).toBeNull()
 expect(next.capturedStream?.gaps).toContainEqual(expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}))
 expect(next.capturedStream?.gaps.slice(0,100)).toEqual(originalGaps);expect(next.capturedStream?.gaps).toHaveLength(101)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'query.sock'));await server.start();cleanup.push(()=>server.stop())
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','history','--host','local','--session',f.reference.agentSessionId,'--source','captured','--kind','text','--query',input.query,'--scan-limit','100','--limit','1','--cursor',first.nextCursor!],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),'',15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);const result=JSON.parse(cli.stdout).result
 expect(result).toMatchObject({availability:'empty',items:[],scan:{examined:2,complete:true},nextCursor:null,capturedStream:{gaps:expect.arrayContaining([expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'})])}})
 expect(result.capturedStream.gaps).toEqual(next.capturedStream!.gaps)
})

it('a captured body gap preserves independently read native answer evidence and an exact unanswered question reply through source CLI',async()=>{
 const f=await questionReplyOwner();cleanup.push(f.close)
 const ref={hostId:'local',agentSessionId:f.input.agentSessionId}
 const tool=(content:string):AgentTimelineItem=>({id:'independent-captured',agentSessionId:ref.agentSessionId,kind:'tool_call',source:'native-hook',status:'streaming',title:'Original process',content,createdAt:1,updatedAt:1})
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:ref.agentSessionId,item:tool('first captured')})
 const opened=await complete(input=>f.client.readAgentConversation(input),ref)
 const q2='independent-question-Q2',answer='Independent recorded answer'
 await appendFile(join(f.root,'native.jsonl'),savedQuestionJsonl([{type:'response_item',payload:{type:'message',id:'independent-answer-record',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:q2,question:'Independent question',answer}])+'\n</send_user_message_question_reply>'}]}}]))
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:ref.agentSessionId,item:tool('second captured')})
 await f.store.applyTimelineMutation({type:'upsert',agentSessionId:ref.agentSessionId,item:tool('third captured')})
 const native=await f.client.sessionHistoryPage(ref.agentSessionId)
 expect(recordedQuestionAnswerFacts(native).get(q2)).toMatchObject({hostId:'local',agentSessionId:ref.agentSessionId,source:f.input.source,questionId:q2,answer})
 const question=projectConversationQuestions({agentSessionId:ref.agentSessionId,historyPage:{...native,items:native.items.filter(item=>item.questionRequest)},answerContext:native})[0]!
 expect(question.recordId).toBe(f.input.recordId);expect(question.recordedAnswers.size).toBe(0)
 const changed=await complete(input=>f.client.readConversationChanges({...input,checkpoint:opened.window.checkpoint,view:opened.window.view!}),ref)
 expect(changed.coverage.find(row=>row.source.kind==='captured')).toMatchObject({current:'partial',gaps:expect.arrayContaining([expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'})])})
 const nativeCoverage=changed.coverage.find(row=>row.source.kind==='native')!
 expect(nativeCoverage.gaps.some(gap=>gap.code==='AGENT_CONVERSATION_VERSION_UNAVAILABLE')).toBe(false)
 expect(changed.units.flatMap(unit=>unit.records).some(record=>record.original.kind==='native'&&record.original.item.questionAnswers?.some(value=>value.questionId===q2&&value.answer===answer))).toBe(true)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'question.sock'));await server.start();cleanup.push(()=>server.stop())
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','question','reply','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),JSON.stringify(f.input),15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result).toMatchObject({agentSessionId:ref.agentSessionId,recordId:f.input.recordId,outcome:'submitted'})
 expect(f.send).toHaveBeenCalledOnce();expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
 await expect(f.client.replySessionQuestion({...f.input,operationId:'wrong-question-target',source:{...f.input.source,nativeSessionId:'another-native'}})).rejects.toMatchObject({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'})
 expect(f.send).toHaveBeenCalledOnce()
})
it('captured gaps and an unknown original question delivery retain its claim without replay and keep ordinary original-Run input usable',async()=>{
 const f=await questionReplyOwner({outcome:'unknown'});cleanup.push(f.close)
 const ref={hostId:'local',agentSessionId:f.input.agentSessionId}
 const write=(content:string)=>f.store.applyTimelineMutation({type:'upsert',agentSessionId:ref.agentSessionId,item:{id:'unavailable-captured',agentSessionId:ref.agentSessionId,kind:'tool_call',source:'native-hook',status:'streaming',title:'Original process',content,createdAt:1,updatedAt:1}})
 await write('first');const opening=await f.client.readAgentConversation(ref);await write('second');await write('third')
 const input={...ref,checkpoint:opening.window.checkpoint,view:opening.window.view!},changed=await f.client.readConversationChanges(input)
 expect(changed.coverage.find(row=>row.source.kind==='captured')?.gaps).toContainEqual(expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}))
 const native=changed.coverage.find(row=>row.source.kind==='native')!
 const excessive=Array.from({length:101},()=>({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE',message:'Original native gap'}))
 expect(()=>parseConversationChangesPage({...changed,coverage:changed.coverage.map(row=>row===native?{...row,gaps:excessive}:row)},input)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
 await expect(f.client.replySessionQuestion({...f.input,operationId:'wrong-target',source:{...f.input.source,nativeSessionId:'other-native'}})).rejects.toHaveProperty('code','AGENT_SESSION_HISTORY_SOURCE_CHANGED')
 await expect(f.client.replySessionQuestion(f.input)).rejects.toHaveProperty('code','AGENT_PROMPT_INPUT_UNCONFIRMED')
 const claim=await f.store.readPromptAdmission(f.input.agentSessionId,f.input.expectedRun,f.input.operationId)
 await expect(f.client.replySessionQuestion(f.input)).rejects.toBeDefined();expect(f.send).toHaveBeenCalledOnce()
 expect(await f.store.readPromptAdmission(f.input.agentSessionId,f.input.expectedRun,f.input.operationId)).toEqual(claim)
 await f.client.writeAgent({agentSessionId:ref.agentSessionId,expectedRun:f.input.expectedRun,source:'user',data:'Ordinary exact original Run input'})
 expect(f.rawInput).toHaveBeenCalledOnce();expect(f.inner.kernel.stop).not.toHaveBeenCalled();expect((await f.store.readMetadata(ref.agentSessionId))?.run).toEqual(f.input.expectedRun)
})

it('a frozen query preserves accepted firstCaptured bytes after retirement while a fresh same-cut Store read exposes its real gap',async()=>{
 const f=await fixture();await f.write('shared original body');await f.write('unrelated body','b')
 const input={...f.reference,source:'captured' as const,kind:'text' as const,query:'shared',scanLimit:1,limit:1}
 const first=await f.client.readAgentSessionHistory(input)
 expect(first).toMatchObject({items:[],scan:{examined:1,complete:false},capturedStream:{sequence:2}});expect(first.nextCursor).toBeTypeOf('string')
 await f.write('shared replacement body')
 const next=await f.client.readAgentSessionHistory({...input,cursor:first.nextCursor!})
 expect(parseAgentSessionHistoryReadPage(next,{...input,cursor:first.nextCursor!})).toEqual(next)
 expect(next.items).toMatchObject([{item:{content:'shared original body'}}]);expect(next.revision).toBe(first.revision)
 expect(next.scan).toEqual({examined:1,complete:true})
 const fresh=await f.store.readCapturedHistory(f.reference.agentSessionId,{epoch:first.capturedStream!.epoch,throughSequence:2})
 expect(fresh.records).toMatchObject([{item:{id:'b'}},{item:null,recordId:'a',sequence:1}])
 expect(fresh.stream.gaps).toContainEqual(expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}))
 expect(f.rawInput).not.toHaveBeenCalled()
})
it('the original Reader owner port retains a real firstCaptured missing-body gap at a frozen cut without treating scan completion as body completeness',async()=>{
 const f=await fixture(),first=await f.write('shared original body');await f.write('replacement body')
 // This is the existing host-local Reader port bound to an actual Store frozen cut.
 // Normal FileStore first-page reads are transaction-consistent; no torn read is claimed.
 const input={...f.reference,source:'captured' as const,kind:'text' as const,query:'shared',scanLimit:1,limit:1}
 const page=await readAgentSessionHistory(f.client,input,{readCapturedHistory:(id,query)=>f.store.readCapturedHistory(id,{...query,epoch:first.stream.epoch,throughSequence:1})})
 expect(parseAgentSessionHistoryReadPage(page,input)).toEqual(page)
 expect(page).toMatchObject({availability:'empty',items:[],scan:{examined:1,complete:true},nextCursor:null,capturedStream:{sequence:1,gaps:expect.arrayContaining([expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'})])}})
 expect(f.rawInput).not.toHaveBeenCalled()
})
it('100 original gaps survive actual retired-body public coverage with one final aggregate slot and malformed excess is rejected',async()=>{
 const f=await fixture();await f.write('first body')
 const opening=await complete(input=>f.client.readAgentConversation(input),f.reference)
 const gaps=Array.from({length:100},(_,index)=>({code:index===42?'AGENT_CONVERSATION_VERSION_UNAVAILABLE':'ORIGINAL_GAP_'+index,message:'Original gap message '+index}))
 const db=new DatabaseSync(f.store.path);try{db.prepare('UPDATE captured_streams SET gaps_json=? WHERE session_id=?').run(JSON.stringify(gaps),f.reference.agentSessionId)}finally{db.close()}
 const ordinary=await f.client.readAgentConversation(f.reference)
 expect(ordinary.coverage.find(row=>row.source.kind==='captured')?.gaps).toEqual(gaps)
 const hosted=await hostedTestClient(f.client);cleanup.push(hosted.dispose)
 const hostedOpening=await hosted.sdk.readAgentConversation(f.reference)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'gap-budget.sock'));await server.start();cleanup.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
 const remoteOpening=await rpc.call('agent.conversation.inspect',f.reference)
 await f.write('second body');await f.write('third body')
 const raw=await f.store.readCapturedHistory(f.reference.agentSessionId,{afterSequence:1})
 expect(raw.stream.gaps.slice(0,100)).toEqual(gaps);expect(raw.stream.gaps).toHaveLength(101)
 const input={...f.reference,checkpoint:opening.window.checkpoint,view:opening.window.view!}
 const changed=await f.client.readConversationChanges(input),captured=changed.coverage.find(row=>row.source.kind==='captured')!
 expect(parseConversationChangesPage(changed,input)).toEqual(changed)
 expect(captured.gaps.slice(0,100)).toEqual(gaps);expect(captured.gaps).toHaveLength(101)
 expect(captured.gaps[100]).toMatchObject({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'});expect(captured.gaps[100]).not.toHaveProperty('record');expect(captured.gaps[100]).not.toHaveProperty('continuation')
 const withGaps=(newGaps:unknown[],kind='captured')=>({...changed,coverage:changed.coverage.map(row=>row.source.kind===kind?{...row,gaps:newGaps}:row)})
 const body=captured.gaps[100]!
 for(const badGaps of[[...gaps,{...body,code:'OTHER_GAP'}],[...gaps,{...body,record:opening.units.flatMap(unit=>unit.records)[0]!.reference}],[...gaps,{...body,continuation:'original-continuation'}],[...gaps,body,body]])
  expect(()=>parseConversationChangesPage(withGaps(badGaps),input)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
 const other=changed.coverage.find(row=>row.source.kind!=='captured')!
 expect(()=>parseConversationChangesPage(withGaps([...gaps,body],other.source.kind),input)).toThrow(expect.objectContaining({code:'CONTROL_PROTOCOL_ERROR'}))
 expect((await hosted.sdk.readConversationChanges({...f.reference,checkpoint:hostedOpening.window.checkpoint,view:hostedOpening.window.view!})).coverage.find(row=>row.source.kind==='captured')?.gaps).toEqual(captured.gaps)
 const remoteInput={...f.reference,checkpoint:remoteOpening.window.checkpoint,view:remoteOpening.window.view!}
 expect((await rpc.call('agent.conversation.changes',remoteInput)).coverage.find(row=>row.source.kind==='captured')?.gaps).toEqual(captured.gaps)
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','conversation','changes','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),JSON.stringify(remoteInput),15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.coverage.find((row:{source:{kind:string}})=>row.source.kind==='captured').gaps).toEqual(captured.gaps)
 const basic={...f.reference,source:'captured' as const,limit:1},first=await f.client.readAgentSessionHistory(basic)
 expect(parseAgentSessionHistoryReadPage(first,basic).capturedStream?.gaps).toEqual(gaps)
 const originalLongHistoryGaps=[...gaps,{code:'OTHER',message:'Another original ordinary gap'},body]
 expect(parseAgentSessionHistoryReadPage({...first,capturedStream:{...first.capturedStream,gaps:originalLongHistoryGaps}},basic).capturedStream?.gaps).toEqual(originalLongHistoryGaps)
 expect(renderToStaticMarkup(createElement(ConversationCoverage,{coverage:changed.coverage}))).toContain('data-conversation-gap="AGENT_CONVERSATION_VERSION_UNAVAILABLE"')
 expect(f.rawInput).not.toHaveBeenCalled()
})
it('actual H SDK, Hosted, RPC and source CLI retain a null-body version in usage pagination with zero logical bytes',async()=>{
 const f=await fixture();await f.write('first');await f.write('second');await f.write('third')
 const input={...f.reference,limit:1},page=await f.client.readAgentSessionUsage(input)
 expect(page.captured).toMatchObject({status:'measured',records:1,logicalBytes:0,lastSequence:1,throughSequence:3,complete:false,nextCursor:expect.any(String)})
 const hosted=await hostedTestClient(f.client);cleanup.push(hosted.dispose)
 expect((await hosted.sdk.readAgentSessionUsage(input)).captured).toEqual(page.captured)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'usage.sock'));await server.start();cleanup.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose())
 expect((await rpc.call('agent.history.usage',input)).captured).toEqual(page.captured)
 const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','history','usage','--host','local','--session',f.reference.agentSessionId,'--limit','1'],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),'',15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
 expect(cli.code,cli.stdout+cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.captured).toEqual(page.captured)
 expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('a navigable record locator continues past an unrelated retired header to a healthy target on an older page',async()=>{
 const f=await fixture();await f.write('Healthy original target','healthy-target')
 for(let index=0;index<=100;index++)await f.write('Original unrelated '+index,'unrelated-'+index)
 const originalGaps=Array.from({length:100},(_,index)=>({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE',message:'Original prior version gap '+index}))
 const db=new DatabaseSync(f.store.path);try{db.prepare('UPDATE captured_streams SET gaps_json=? WHERE session_id=?').run(JSON.stringify(originalGaps),f.reference.agentSessionId)}finally{db.close()}
 const original=f.store.readCapturedHistory.bind(f.store);let armed=true,retirements=0
 vi.spyOn(f.store,'readCapturedHistory').mockImplementation(async(id,query)=>{
  const page=await original(id,query)
  if(armed&&query?.limit===1&&query.throughSequence===undefined&&query.afterSequence===undefined&&!query.recordId){
   armed=false;await f.write('Later unrelated '+ ++retirements,'unrelated-100')
  }
  return page
 })
 const input={...f.reference,record:{...f.reference,source:{kind:'captured' as const,recordId:'healthy-target'}}}
 const located=await complete(query=>f.client.readAgentConversation(query),input)
 expect(retirements).toBe(1)
 expect(located.window.anchor).toBeUndefined();expect(located.units.flatMap(unit=>unit.records)).toContainEqual(expect.objectContaining({original:{kind:'captured',item:expect.objectContaining({id:'healthy-target',content:'Healthy original target'})}}))
 expect(located.coverage.find(row=>row.source.kind==='captured')?.gaps).toContainEqual(expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}))
 expect(located.coverage.find(row=>row.source.kind==='captured')?.gaps.slice(0,100)).toEqual(originalGaps);expect(located.coverage.find(row=>row.source.kind==='captured')?.gaps).toHaveLength(101)
 const parked=await complete(query=>f.client.readAgentConversation(query),{...f.reference,view:located.window.view!})
 expect(parked.coverage).toEqual(located.coverage);expect(parked.units).toEqual(located.units)
 const hosted=await hostedTestClient(f.client);cleanup.push(hosted.dispose);armed=true
 const hostedLocated=await complete(query=>hosted.sdk.readAgentConversation(query),input)
 expect(hostedLocated.coverage.find(row=>row.source.kind==='captured')?.gaps).toEqual(located.coverage.find(row=>row.source.kind==='captured')?.gaps)
 const server=new AgentMuxControlServer({coreClients:f.coreClients},join(f.root,'locator.sock'));await server.start();cleanup.push(()=>server.stop())
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanup.push(()=>rpc.dispose());armed=true
 const remote=await complete(query=>rpc.call('agent.conversation.inspect',query),input)
 expect(remote.units).toEqual(located.units);expect(remote.coverage.find(row=>row.source.kind==='captured')?.gaps).toHaveLength(101)
 armed=true
 const cliLocated=await complete(async query=>{
  const cli=await runSourceObjectCli(['--endpoint','unix://'+server.path,'agent','conversation','inspect','--input','-'],objectCliEnvironment(f.root,{AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED:process.env.CAPTURED_G_CLI_LOADED}),JSON.stringify(query),15000,new URL('./fixtures/captured-retirement/source-loader.mjs',import.meta.url))
  expect(cli.code,cli.stdout+cli.stderr).toBe(0);return JSON.parse(cli.stdout).result
 },{...input,maxBytes:4*1024*1024,limit:100})
 expect(cliLocated.units).toEqual(located.units);expect(cliLocated.coverage.find(row=>row.source.kind==='captured')?.gaps).toHaveLength(101)
 expect(retirements).toBe(4)
 expect((await original(f.reference.agentSessionId,{recordId:'healthy-target'})).records[0]?.item).toMatchObject({content:'Healthy original target'})
 expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('a partial or rejected frame cannot publish its tentative body gap before ACK while accepted and parked view coverage keeps it until release',async()=>{
 const f=await fixture();await f.write('original accepted body')
 const opened=await f.client.readAgentConversation(f.reference),state=Reflect.get(f.client,'conversationReadState') as ConversationReaderState
 const view=state.get(opened.window.id,f.reference,opened.scope)
 await f.write('intermediate');await f.write('new large current body '.repeat(4000))
 const input={...f.reference,checkpoint:opened.window.checkpoint,view:opened.window.view!,limit:2,maxBytes:16384}
 const during=new AbortController(),duringReason=new Error('cancel after real nullable headers'),readCaptured=f.store.readCapturedHistory.bind(f.store);let entered=false
 const cancelledRead=vi.spyOn(f.store,'readCapturedHistory').mockImplementation(async(id,query)=>{
  const page=await readCaptured(id,query)
  if(query?.afterSequence!==undefined&&page.records.some(record=>record.item===null)){entered=true;during.abort(duringReason)}
  return page
 })
 await expect(f.client.readConversationChanges(input,{signal:during.signal})).rejects.toBe(duringReason)
 expect(entered).toBe(true);expect(Reflect.get(view,'capturedBodyGap')).toBeUndefined();cancelledRead.mockRestore()
 await expect(f.client.readConversationChanges({...input,maxBytes:4096})).rejects.toHaveProperty('code','AGENT_SESSION_HISTORY_BUDGET')
 expect(Reflect.get(view,'capturedBodyGap')).toBeUndefined()
 const first=await f.client.readConversationChanges(input)
 expect(first.window.complete).toBe(false);expect(first.nextCursor).toBeTypeOf('string')
 expect(first.coverage.find(row=>row.source.kind==='captured')?.gaps).toContainEqual(expect.objectContaining({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'}))
 expect(Reflect.get(view,'capturedBodyGap')).toBeUndefined()
 const abort=new AbortController(),reason=new Error('cancel this original partial frame');abort.abort(reason)
 await expect(f.client.readConversationChanges({...input,cursor:first.nextCursor!},{signal:abort.signal})).rejects.toBe(reason)
 await expect(f.client.readConversationChanges({...input,cursor:first.nextCursor!+'tampered'})).rejects.toBeDefined()
 expect(Reflect.get(view,'capturedBodyGap')).toBeUndefined()
 const acceptedOriginal=await complete(query=>f.client.readAgentConversation(query),{...f.reference,view:opened.window.view!})
 expect(acceptedOriginal.coverage).toEqual(opened.coverage)
 let result=consumeConversationWindowPage(first),cursor=first.nextCursor
 for(let count=0;result.kind!=='complete'&&count<100;count++){
  const page=await f.client.readConversationChanges({...input,cursor:cursor!});result=consumeConversationWindowPage(page,result.pending);cursor=page.nextCursor
 }
 expect(result.kind).toBe('complete');if(result.kind!=='complete')throw Error('Original bounded frame did not finish')
 expect(Reflect.get(view,'capturedBodyGap')).toMatchObject({code:'AGENT_CONVERSATION_VERSION_UNAVAILABLE'})
 expect(()=>state.get(view.id,f.reference,{sources:opened.scope.sources.map(source=>source.kind==='captured'?{kind:'captured',epoch:'another-original-epoch'}:source)})).toThrow(expect.objectContaining({code:'AGENT_SESSION_HISTORY_SOURCE_CHANGED'}))
 const parked=await complete(query=>f.client.readAgentConversation(query),{...f.reference,view:result.snapshot.window.view!,limit:1,maxBytes:16384})
 expect(parked.coverage).toEqual(result.snapshot.coverage)
 const independent=await complete(query=>f.client.readAgentConversation(query),{...f.reference,limit:1,maxBytes:16384})
 expect(independent.coverage.find(row=>row.source.kind==='captured')?.gaps).toEqual([])
 expect((await f.client.releaseConversationView({...f.reference,view:result.snapshot.window.view!})).released).toBe(true)
 expect(()=>state.get(view.id,f.reference,opened.scope)).toThrow(expect.objectContaining({code:'AGENT_CONVERSATION_VIEW_EXPIRED'}))
 expect(f.rawInput).not.toHaveBeenCalled();expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
