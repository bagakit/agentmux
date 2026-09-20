import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProviderHookActivationContext } from '../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { withCodexNativeRead } from '../src/providers/codex-native-read.js'

let root: string, client: AgentMuxClient
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-hook-activation-')))
  client = new AgentMuxClient({ hookInstaller: new AgentManagedHookInstaller(join(root, 'receipts')), store: new AgentMuxMemoryAgentSessionStore() })
})
afterEach(async () => { await client.dispose(); await rm(root, { recursive: true, force: true }) })

async function nativeFixture(mode = 'normal') {
  const plan = (new AgentProviderRegistry().get('codex').planManagedHooks?.({ workspacePath: root, env: {} }) ?? null)!
  for (const mutation of plan.mutations) { await mkdir(join(root, '.codex'), { recursive: true }); await writeFile(mutation.path, mutation.content) }
  const hooks: Record<string, unknown>[] = []
  for (const mutation of plan.mutations) for (const [event, groups] of Object.entries(JSON.parse(mutation.content).hooks) as [string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]][]) {
    for (const group of groups) for (const hook of group.hooks) hooks.push({ source: 'project', sourcePath: mutation.path,
      handlerType: 'command', eventName: event[0]!.toLowerCase() + event.slice(1), command: hook.command,
      matcher: group.matcher ?? null, timeoutSec: hook.timeout, async: false, enabled: true, currentHash: 'synthetic-native-hash', trustStatus: 'trusted' })
  }
  expect(hooks.length).toBeGreaterThan(0)
  const result = { data: [{ cwd: root, hooks, errors: [] as string[], warnings: [] as string[] }] }
  const responses = join(root, 'responses.json'), requests = join(root, 'requests.jsonl'), pids = join(root, 'pids.jsonl'), script = join(root, 'native.mjs')
  await writeFile(responses, JSON.stringify(result))
  await writeFile(script, `
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
appendFileSync(process.env.HOOK_PIDS, JSON.stringify({pid:process.pid,cwd:process.cwd(),home:process.env.CODEX_HOME,args:process.argv.slice(2)})+'\\n')
const input=createInterface({input:process.stdin})
input.on('line',line=>{
 const call=JSON.parse(line);appendFileSync(process.env.HOOK_REQUESTS,JSON.stringify(call)+'\\n')
 if(call.method==='initialize'&&process.env.HOOK_MODE==='invalid-utf8') process.stdout.write(Buffer.concat([Buffer.from('{"id":'+call.id+',"result":{"userAgent":"'),Buffer.from([255]),Buffer.from('"}}\\n')]))
 else if(call.method==='initialize') process.stdout.write(JSON.stringify({id:call.id,result:{userAgent:'synthetic-private-native'}})+'\\n')
 else if(call.method==='hooks/list') {
  if(process.env.HOOK_MODE==='pending') return
  if(process.env.HOOK_MODE==='stderr-large') process.stderr.write('x'.repeat(4*1024*1024+1))
  if(process.env.HOOK_MODE==='wrong-id') {process.stdout.write(JSON.stringify({id:999,result:{}})+'\\n');return}
  if(process.env.HOOK_MODE==='nonzero') process.exitCode=1
  process.stdout.write(JSON.stringify({id:call.id,result:JSON.parse(readFileSync(process.env.HOOK_RESPONSES,'utf8'))})+'\\n')
 } else if(call.id) process.stdout.write(JSON.stringify({id:call.id,result:{}})+'\\n')
})
`)
  const options = { workspacePath: root, command: '  ' + process.execPath + '  ', args: [script, 'configured-arg'],
    env: { CODEX_HOME: join(root, 'private-codex'), HOOK_MODE: mode, HOOK_RESPONSES: responses, HOOK_REQUESTS: requests, HOOK_PIDS: pids } }
  const calls = async () => (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as {method: string; params?: unknown}[]
  const assertCleanup = async () => {
    const helpers = (await readFile(pids, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as {pid:number;cwd:string;home:string;args:string[]}[]
    expect(helpers.length).toBeGreaterThan(0)
    for (const helper of helpers) {
      expect(helper).toMatchObject({cwd:root,home:options.env.CODEX_HOME,args:['configured-arg','-s','read-only','-a','never','app-server','--stdio']})
      await vi.waitFor(() => expect(() => process.kill(helper.pid, 0)).toThrowError(/ESRCH/), {timeout:4000,interval:10})
    }
  }
  return { hooks, result, options, calls, assertCleanup, update: async () => writeFile(responses, JSON.stringify(result)) }
}

describe('native Hook activation through public scoped Core API', () => {
  it('confirms exact generated source, event, command, matcher and timeout through a private read-only native helper', async () => {
    const fixture = await nativeFixture()
    const controls = [vi.spyOn(client, 'connect'), vi.spyOn(client, 'createAgent'), vi.spyOn(client, 'stopAgent')]
    const result = await client.inspectManagedHooks('codex', fixture.options)
    expect(result).toMatchObject({ status: 'installed', code: 'HOOK_NATIVE_CURRENT_AND_TRUSTED', workspacePath: root,
      targets: [{path:join(root,'.codex/hooks.json'),status:'current'}] })
    expect((await fixture.calls()).map(call=>call.method)).toEqual(['initialize','initialized','hooks/list'])
    expect((await fixture.calls())[2]!.params).toEqual({cwds:[root]})
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    await fixture.assertCleanup()
  })

  it.each(['sourcePath','source','handlerType','eventName','command','matcher','timeoutSec','async','omitted','duplicate'] as const)('rejects native %s mismatch instead of counting enabled unrelated Hooks as installed', async field => {
    const fixture = await nativeFixture()
    if (field === 'omitted') fixture.hooks.pop()
    else if (field === 'duplicate') fixture.hooks.push({...fixture.hooks[0]})
    else fixture.hooks[0]![field] = field === 'timeoutSec' ? 999 : field === 'async' ? true : 'foreign-native-value'
    await fixture.update()
    const result = await client.inspectManagedHooks('codex', fixture.options)
    expect(result).toMatchObject({status:'partial',code:'HOOK_NATIVE_DEFINITIONS_UNCONFIRMED'})
    expect(result.targets).toEqual([{path:join(root,'.codex/hooks.json'),status:'current'}])
    expect(JSON.stringify(result)).not.toContain('foreign-native-value')
    await fixture.assertCleanup()
  })

  it.each(['untrusted','stale','disabled','feature-off','invalid-enabled','invalid-hash','errors','wrong-cwd'] as const)('honestly exposes native %s while retaining current disk facts', async mode => {
    const fixture = await nativeFixture()
    if(mode==='untrusted'||mode==='stale') fixture.hooks[0]!.trustStatus=mode
    if(mode==='disabled') fixture.hooks[0]!.enabled=false
    if(mode==='feature-off') fixture.hooks.splice(0)
    if(mode==='invalid-enabled') fixture.hooks[0]!.enabled='true'
    if(mode==='invalid-hash') fixture.hooks[0]!.currentHash=''
    if(mode==='errors') fixture.result.data[0]!.errors.push('private-native-secret')
    if(mode==='wrong-cwd') fixture.result.data[0]!.cwd='/other-private-scope'
    await fixture.update()
    const result=await client.inspectManagedHooks('codex',fixture.options)
    expect(result.status).toBe(mode.startsWith('invalid')||mode==='errors'||mode==='wrong-cwd'?'error':'partial')
    expect(result.code).toBe(mode==='untrusted'||mode==='stale'?'HOOK_NATIVE_TRUST_UNCONFIRMED':mode==='disabled'?'HOOK_NATIVE_DISABLED'
      :mode==='feature-off'?'HOOK_NATIVE_DEFINITIONS_UNCONFIRMED':'HOOK_ACTIVATION_CHECK_FAILED')
    expect(result.targets).toEqual([{path:join(root,'.codex/hooks.json'),status:'current'}])
    expect(JSON.stringify(result)).not.toContain('private-native-secret')
    await fixture.assertCleanup()
  })

  it.each(['invalid-utf8','stderr-large','wrong-id','nonzero'])('isolates %s read failure and reaps only its helper',async mode=>{
    const fixture=await nativeFixture(mode)
    expect(await client.inspectManagedHooks('codex',fixture.options)).toMatchObject({status:'error',code:'HOOK_ACTIVATION_CHECK_FAILED'})
    await fixture.assertCleanup()
  })

  it('shares read admission and disconnect cancellation without touching Agent lifecycle',async()=>{
    const fixture=await nativeFixture('pending')
    const reads=[0,1,2,3].map(()=>client.inspectManagedHooks('codex',fixture.options))
    await vi.waitFor(async()=>expect((await readFile(join(root,'pids.jsonl'),'utf8')).trim().split('\n').length).toBe(4))
    expect(await client.inspectManagedHooks('codex',fixture.options)).toMatchObject({status:'error',code:'AGENT_HOOK_READ_BUSY'})
    client.disconnect()
    expect((await Promise.all(reads)).map(result=>result.status)).toEqual(['error','error','error','error'])
    await fixture.assertCleanup()
    await client.dispose()
    expect(await client.inspectManagedHooks('codex',fixture.options)).toMatchObject({status:'error',code:'AGENT_HOOK_READ_CANCELLED'})
  })

  it('shares a runtime method allowlist which cannot send a thread or trust mutation',async()=>{
    const fixture=await nativeFixture()
    await expect(withCodexNativeRead({...fixture.options,command:process.execPath,signal:new AbortController().signal},'hooks', request=>
      request('turn/start' as 'hooks/list',{}))).rejects.toMatchObject({code:'INVALID_AGENT_HOOK_RESPONSE'})
    expect((await fixture.calls()).map(call=>call.method)).toEqual(['initialize','initialized'])
    await fixture.assertCleanup()
  })

  it('bounds a Provider which ignores cancellation, retains its live slots and recovers admission only after real settlement', async () => {
    vi.useFakeTimers()
    const completions: Array<(value: {active:boolean;code:string;action:null}) => void> = []
    const base = new AgentProviderRegistry().get('claude')
    const activation = vi.fn((_context: AgentProviderHookActivationContext) => new Promise<{active:boolean;code:string;action:null}>(resolve => completions.push(resolve)))
    const installer = new AgentManagedHookInstaller(join(root,'receipts'))
    const other = new AgentMuxClient({ providers:[{...base,inspectHookActivation:activation}],hookInstaller:installer,store:new AgentMuxMemoryAgentSessionStore() })
    await installer.ensure((new AgentProviderRegistry().get('claude').planManagedHooks?.({ workspacePath: root, env: {} }) ?? null)!)
    const controls = [vi.spyOn(other,'connect'),vi.spyOn(other,'createAgent'),vi.spyOn(other,'stopAgent')]
    try {
      const reads = [0,1,2,3].map(()=>other.inspectManagedHooks('claude',{workspacePath:root}))
      let returned = false
      const completed = Promise.all(reads).then(results => { returned = true; return results })
      await vi.waitFor(()=>expect(activation).toHaveBeenCalledTimes(4))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(returned).toBe(true)
      expect((await completed).map(result=>[result.status,result.code])).toEqual([
        ['error','AGENT_HOOK_READ_TIMEOUT'],['error','AGENT_HOOK_READ_TIMEOUT'],['error','AGENT_HOOK_READ_TIMEOUT'],['error','AGENT_HOOK_READ_TIMEOUT']
      ])
      let blockedReturned = false
      const blocked = other.inspectManagedHooks('claude',{workspacePath:root}).then(result => { blockedReturned = true; return result })
      await vi.waitFor(() => expect(blockedReturned || activation.mock.calls.length > 4).toBe(true))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await blocked).toMatchObject({status:'error',code:'AGENT_HOOK_READ_BUSY'})
      expect(activation).toHaveBeenCalledTimes(4)
      completions[0]!({active:true,code:'PRIVATE_CURRENT',action:null})
      await Promise.resolve()
      const fresh = other.inspectManagedHooks('claude',{workspacePath:root})
      await vi.waitFor(()=>expect(activation).toHaveBeenCalledTimes(5))
      completions[4]!({active:true,code:'PRIVATE_CURRENT',action:null})
      expect(await fresh).toMatchObject({status:'installed',code:'PRIVATE_CURRENT'})
      for (const control of controls) expect(control).not.toHaveBeenCalled()
    } finally {
      for (const complete of completions) complete({active:true,code:'PRIVATE_CURRENT',action:null})
      await other.dispose();vi.useRealTimers()
    }
  })

  it.each([['claude','disableAllHooks'],['droid','hooksDisabled']] as const)('reads %s native disabled flag from the same scoped target',async(providerId,key)=>{
    const env=providerId==='droid'?{FACTORY_HOME_OVERRIDE:root}:{}
    const plan=(new AgentProviderRegistry().get(providerId).planManagedHooks?.({ workspacePath: root, env: env }) ?? null)!
    await new AgentManagedHookInstaller(join(root,'receipts')).ensure(plan)
    const path=plan.mutations[0]!.path
    const parsed=JSON.parse(await readFile(path,'utf8'))
    parsed[key]=true;await writeFile(path,JSON.stringify(parsed))
    expect(await client.inspectManagedHooks(providerId,{workspacePath:root,env})).toMatchObject({status:'partial',code:'HOOK_CONFIGURATION_DISABLED'})
    parsed[key]=false;await writeFile(path,JSON.stringify(parsed))
    expect(await client.inspectManagedHooks(providerId,{workspacePath:root,env})).toMatchObject({status:'installed'})
    parsed[key]='true';await writeFile(path,JSON.stringify(parsed))
    expect(await client.inspectManagedHooks(providerId,{workspacePath:root,env})).toMatchObject({status:'error'})
  })
})
