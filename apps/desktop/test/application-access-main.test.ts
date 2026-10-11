import { expect,it,vi } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { AgentMuxError, AgentMuxControlServer,connectAgentMuxRpc } from '@agentmux/core'
import { sessionInputOperationResult } from '../src/shared/session-input-result.js'
import { assertSenderTrusted,senderTrust } from '../src/main/ipc-sender-trust.js'
import { isApplicationAccessMethod,parseApplicationAccessParams } from '@agentmux/core/application-access'
import { createDesktopApplicationAccessOwner } from '../src/main/application-access-owner.js'
import { LocalExecutionHost } from '@agentmux/core'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { tmpdir,userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

it('actual registered applications IPC consumes the public service and preserves typed denial without affecting other work',async()=>{
  const root=await mkdtemp(join(tmpdir(),'amux-access-main-')), calls: string[]=[], owner={async call(method:string){calls.push(method);if(method==='settings.applications.ls')return {configurations:[],operations:[]};throw new AgentMuxError('Original plan changed.','APPLICATION_ACCESS_PLAN_CHANGED')}}
  const server=new AgentMuxControlServer({socketPath:join(root,'access.sock'),coreClients:()=>[],applicationAccess:owner as never});await server.start()
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
  try {
    const source=ts.createSourceFile('ipc.ts',readFileSync(new URL('../src/main/ipc.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
    const matches: ts.Expression[]=[];function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='handleWithEvent'&&node.arguments[0]&&ts.isStringLiteral(node.arguments[0])&&node.arguments[0].text==='applications:call')matches.push(node.arguments[1]!);ts.forEachChild(node,visit)}visit(source);expect(matches).toHaveLength(1)
    const trusted={},guard=(channel:'applications:call',event:{sender:unknown})=>assertSenderTrusted(senderTrust(channel,event.sender,trusted))
    const expression=ts.transpileModule('('+matches[0]!.getText(source)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    const handler=new Function('requireTrustedSender','sessionInputOperationResult','isApplicationAccessMethod','parseApplicationAccessParams','AgentMuxError','callUserRpc','return '+expression)(guard,sessionInputOperationResult,isApplicationAccessMethod,parseApplicationAccessParams,AgentMuxError,rpc.call.bind(rpc))
    expect(await handler({sender:trusted},'settings.applications.ls',{})).toEqual({ok:true,value:{configurations:[],operations:[]}})
    expect(await handler({sender:trusted},'settings.applications.apply',{profileId:'p',planId:'plan',operationId:'op'})).toMatchObject({ok:false,error:{code:'APPLICATION_ACCESS_PLAN_CHANGED'}})
    await expect(handler({sender:{}},'settings.applications.ls',{})).rejects.toThrow('Untrusted');expect(calls).toEqual(['settings.applications.ls','settings.applications.apply'])
    expect(await handler({sender:trusted},'settings.applications.ls',{})).toMatchObject({ok:true})
  } finally {await rpc.dispose();await server.stop();await rm(root,{recursive:true,force:true})}
})
it('Main resolver borrows the original Host client and detects route replacement without owning any Agent lifecycle',async()=>{
  const root=await mkdtemp(join(tmpdir(),'amux-access-resolver-')), execution=new LocalExecutionHost(), healthyStop=vi.fn(), currentOwner={runtimeId:'r',availability:'connected'}, client={connect:vi.fn(async()=>{}),runtimeOwnerIdentity:()=>currentOwner,stopAgent:healthyStop}
  let current=client;const runtime={rpcClients:()=>[{hostId:'target',client:current}],executionHost:()=>execution}
  const owner=createDesktopApplicationAccessOwner(runtime as never,join(root,'access.sqlite'))
  try {
    const fixture=fileURLToPath(new URL('../../../packages/core/test/fixtures/application-access-connector.mjs',import.meta.url)),endpoint=(side:string)=>({hostId:'target',runtimeId:'r',osAccount:userInfo().username,command:process.execPath,args:[fixture,join(root,side+'.json')]})
    for (const side of ['source','target']) await writeFile(join(root,side+'.json'),JSON.stringify({applicationId:'app',accountId:side==='source'?'account':null,scopes:side==='source'?['read']:[],revision:0,token:'controlled-test-material'}),{mode:0o600})
    const c=await owner.call('settings.applications.configure',{profileId:'p',expectedRevision:null,profile:{label:'App',applicationId:'app',source:endpoint('source'),target:endpoint('target'),accountId:'account',scopes:['read']}})
    const first=await owner.call('settings.applications.plan',{profileId:'p',expectedRevision:c.revision});expect(first.disposition).toBe('transfer');expect(first.source.runtimeId).toBe('r');expect(client.connect).toHaveBeenCalled()
    client.connect.mockImplementation(async()=>{current={...client}})
    const changed=await owner.call('settings.applications.plan',{profileId:'p',expectedRevision:c.revision});expect(changed.disposition).toBe('unknown');expect(changed.source.status).toBe('unknown');expect(healthyStop).not.toHaveBeenCalled()
  } finally {await owner.dispose();await rm(root,{recursive:true,force:true})}
})
