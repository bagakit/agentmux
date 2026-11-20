import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '@agentmux/browser/operations'
import { BrowserStepEvidenceStore } from '@agentmux/browser/operations'
import { BrowserResultArtifactStore } from '@agentmux/browser/operations'
import { BrowserProgramOwner } from '@agentmux/browser/operations'
import type { BrowserProgramPort, BrowserProgramTarget } from '@agentmux/browser/operations'
import type { BrowserPageContext } from '@agentmux/browser/page'

const captured=vi.hoisted(()=>({context:null as BrowserPageContext|null}))
vi.mock('../../../packages/browser/src/browser-page-dispatch.ts',async original=>{
  const module=await original<typeof import('@agentmux/browser/page')>()
  return {...module,createBrowserPageDispatch:(context:BrowserPageContext)=>{captured.context=context;return module.createBrowserPageDispatch(context)}}
})
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup()})
it('the shared owned/external program consumes the original runner budget before sending a huge native hold',async()=>{
  const root=await mkdtemp(join(tmpdir(),'amux-program-budget-'))
  cleanups.push(()=>rm(root,{recursive:true,force:true}))
  const target:BrowserProgramTarget={id:'b',workspaceId:null,navigationId:'nav',url:'https://example.test/',title:'Fixture',status:'ready',connection:{id:'original'}}
  const sent:string[]=[], observers=new Set<(method:string,params:unknown)=>void>()
  const port:BrowserProgramPort={has:id=>id==='b',require:()=>target,stopOperation:()=>{},recordLedger:()=>{},observe:()=>()=>{},observeAvailability:()=>()=>{},dispose:async()=>{},
    attach:async()=>({frames:new Map(),endedReason:null,frameDiscoveryFailure:null,detach:async()=>undefined,observe:fn=>{observers.add(fn);return()=>observers.delete(fn)},sendCommand:async(method)=>{sent.push(method);return {}}})}
  const owner=new BrowserProgramOwner(port,{journal:new BrowserOperationJournal(new BrowserOperationFileStore(join(root,'operations.json'))),refs:{read:async()=>null,write:async()=>{}},evidence:new BrowserStepEvidenceStore(join(root,'evidence')),results:new BrowserResultArtifactStore(join(root,'results')),validateScreenshot:()=>{}})
  const observed=await owner.runScript('b','return await pageInfo()')
  expect(observed.outcome.kind).toBe('completed')
  expect(captured.context?.remainingMillis,'The real ProgramOwner must pass the original script budget').toBeTypeOf('function')
  expect(captured.context!.remainingMillis!()).toBeGreaterThan(0)
  expect(captured.context!.remainingMillis!()).toBeLessThanOrEqual(30_000)
  const held=await owner.runScript('b',`try{await longPress('@e1',{durationMs:2147483648});return 'completed'}catch(error){return error.message}`)
  expect(held.outcome.kind).toBe('completed')
  expect(held.result).toContain('remaining execution time')
  expect(sent.filter(method=>method.startsWith('Input.'))).toEqual([])
  await owner.dispose()
},10_000)
