import { afterEach, expect, it } from 'vitest'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentStartupDiagnosticPage, AgentStartupDiagnosticRecord } from '../src/startup-diagnostic.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }; if (errors.length) throw new AggregateError(errors) })
const rows = async (path: string): Promise<Array<{ method: string; mode: string }>> => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

it.runIf(process.platform === 'darwin')('two actual Core owners discover original startup failures without SID through Hosted API and compiled CLI', async () => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  const sdk = await scope.client(), gate = join(scope.root, 'slow-response'), calls = join(scope.root, 'calls.jsonl')
  await writeFile(gate, 'original pending response'); await writeFile(calls, '')
  const makeCommand = async (mode: 'slow' | 'rejected') => {
    const command = join(scope.root, `${mode}.mjs`), transcript = join(scope.root, `${mode}.jsonl`)
    const nativeId = mode === 'slow' ? '00000000-0000-4000-8000-000000000094' : '00000000-0000-4000-8000-000000000095'
    await writeFile(command, `#!/usr/bin/env node
import {appendFileSync,existsSync,writeFileSync} from 'node:fs'
import WS from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
const mode=${JSON.stringify(mode)},args=process.argv.slice(2),nativeId=${JSON.stringify(nativeId)}
if(args.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')){console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')){
 const server=new WS.WebSocketServer({port:0,host:'127.0.0.1'})
 server.on('connection',(ws,request)=>{
  if(request.headers.authorization!=='Bearer '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN)return ws.close()
  ws.on('message',async bytes=>{
   const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
   appendFileSync(${JSON.stringify(calls)},JSON.stringify({mode,method:p.method})+'\\n')
   if(p.method==='account/read'){
    if(mode==='rejected'){ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,error:{code:0,message:'PRIVATE_DENIAL '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN}}));return}
    while(existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,10))
   }
   const thread={id:nativeId,sessionId:'original-native-object',canAcceptDirectInput:true,status:{type:'idle'}}
   if(p.method==='thread/start')writeFileSync(${JSON.stringify(transcript)},JSON.stringify({type:'session_meta',payload:{id:nativeId,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
   const result=p.method==='account/read'?{account:null,requiresOpenaiAuth:false}:p.method==='thread/read'?{thread}:
    p.method==='thread/start'?{thread,cwd:p.params.cwd,model:p.params.model,approvalPolicy:p.params.approvalPolicy,sandbox:{type:p.params.sandbox==='read-only'?'readOnly':p.params.sandbox==='workspace-write'?'workspaceWrite':'dangerFullAccess'}}:{}
   ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result}))
  })
 })
}else{
 process.stdin.setRawMode(true)
 process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u'))process.stdout.write('\\x1b[?2026h› \\x1b[?2026l')})
 setTimeout(()=>process.stdout.write('\\x1b[?u'),0)
}
`, { mode: 0o700 })
    return command
  }
  const originals = []
  for (const mode of ['slow', 'rejected'] as const) {
    const commandOverride = await makeCommand(mode)
    const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: `diagnostic-${mode}`,
      createOperationId: `create-${mode}`, commandOverride, workspacePath: scope.root, injectAgentMuxGuide: false })
    originals.push(original)
    cleanup.push(async () => { const reader = await scope.client(), state = await reader.statusAgent(original.agentSessionId); if (state.run.state === 'running') await reader.stopAgent(original.agentSessionId, state.session.run) })
  }
  const target = { domain: 'agent.startup' as const, hostId: 'local', recent: {} }
  const first = await until(async () => (await sdk.findAgentStartupDiagnostics(target)).data as AgentStartupDiagnosticPage,
    page => page.items.some(item => item.observation.phase === 'unknown') && page.items.some(item => item.observation.phase === 'failed') && page.coverage.pendingWrites === 0,
    'actual Core accepted both native protocol shapes and persisted their diagnostics')
  const denied = first.items.find(item => item.observation.phase === 'failed')!.observation
  const pending = first.items.find(item => item.observation.phase === 'unknown')!.observation
  expect(denied.failure).toEqual({ step: 'preflight', code: 0 }); expect(pending.event).toBe('unconfirmed')
  expect(pending.failure?.code).toBe('AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED')
  const firstOwner = scope.owner, firstPid = scope.ownerProcess.pid
  expect(denied.ownerInstanceId).toBe(firstOwner.ownerInstanceId); expect(denied.authority).toEqual({ kind: 'core-runtime', id: firstOwner.runtimeId, lifetime: 'durable' })
  const beforeRuns = await Promise.all(originals.map(session => sdk.statusAgent(session.agentSessionId)))
  const stored = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const privateDenied = await stored.readMetadata(denied.agentSessionId)
  const cli = async (args: string[]) => {
    const receipt = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'system', 'diagnostics', 'inspect', ...args], scope.env)
    expect(receipt.code, receipt.stdout + receipt.stderr).toBe(0)
    return JSON.parse(receipt.stdout).result
  }
  expect((await cli(['--list'])).capabilities).toEqual(expect.arrayContaining([
    { domain: 'agent.startup', target: 'recent', raw: false, read: 'supported' }, { domain: 'agent.startup', target: 'log-id', raw: true, read: 'supported' },
  ]))
  const cliFirst = await cli(['--domain', 'agent.startup', '--host-id', 'local', '--recent'])
  expect(cliFirst.reads[0].data.items.map((item: any) => item.observation.logId)).toContain(denied.logId)
  expect(cliFirst.reads[0].data.items.find((item: any) => item.observation.logId === pending.logId)?.observation.failure.code).toBe('AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED')
  expect(JSON.stringify(cliFirst)).not.toContain('PRIVATE_DENIAL')
  await sdk.dispose(); await scope.restart(); const second = await scope.client()
  expect(scope.owner.runtimeId).toBe(firstOwner.runtimeId); expect(scope.owner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
  expect(scope.ownerProcess.pid).not.toBe(firstPid); expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
  const secondPage = (await second.findAgentStartupDiagnostics(target)).data as AgentStartupDiagnosticPage
  expect(secondPage.items.find(item => item.observation.logId === denied.logId)?.observation).toEqual(denied)
  const exact = { domain: 'agent.startup' as const, hostId: 'local', logId: denied.logId, authority: { kind: 'core-runtime', id: firstOwner.runtimeId } }
  const sdkRaw = await second.readAgentStartupDiagnostic({ target: exact, includeRaw: true })
  const raw = sdkRaw.data as AgentStartupDiagnosticRecord
  expect(raw.original).toEqual({ code: 0, message: 'PRIVATE_DENIAL [redacted]' })
  // This Provider already removed its token before publishing the accepted fact;
  // the Core journal must not invent a second local redaction operation.
  expect(raw.material.redacted).toBe(false)
  expect(JSON.stringify(sdkRaw)).not.toContain(privateDenied!.nativeActor!.token)
  const cliSafe = await cli(['--domain', 'agent.startup', '--host-id', 'local', '--logid', denied.logId, '--authority', firstOwner.runtimeId])
  expect(cliSafe.reads[0].data).toEqual({ ...raw, original: null }); expect(cliSafe.reads[0].persistence).toBe('observed')
  const cliRaw = await cli(['--domain', 'agent.startup', '--host-id', 'local', '--logid', denied.logId, '--authority', firstOwner.runtimeId, '--include-raw'])
  expect(cliRaw.reads[0].data.original).toEqual(raw.original)
  for (let index = 0; index < originals.length; index++) {
    const state = await second.statusAgent(originals[index]!.agentSessionId)
    expect(state.run).toMatchObject({ runId: beforeRuns[index]!.run.runId, pid: beforeRuns[index]!.run.pid, state: 'running' })
  }
  await rm(gate)
  const final = await until(async () => (await second.findAgentStartupDiagnostics(target)).data as AgentStartupDiagnosticPage,
    page => page.items.some(item => item.observation.event === 'recovered') && page.coverage.pendingWrites === 0,
    'original late response becomes ready and records recovery')
  const recovered = final.items.find(item => item.observation.event === 'recovered')!.observation
  expect(recovered).toMatchObject({ runId: pending.runId, agentSessionId: pending.agentSessionId, actorId: pending.actorId,
    lifecycleOperationId: pending.lifecycleOperationId, previousLogId: pending.logId, ownerInstanceId: scope.owner.ownerInstanceId })
  expect(final.items.find(item => item.observation.logId === pending.logId)?.observation).toEqual(pending)
  const requests = await rows(calls)
  expect(requests.filter(row => row.mode === 'slow' && row.method === 'account/read')).toHaveLength(1)
  expect(requests.filter(row => row.mode === 'slow' && row.method === 'thread/start')).toHaveLength(1)
  expect(requests.filter(row => row.mode === 'rejected' && row.method === 'account/read')).toHaveLength(1)
  expect(requests.filter(row => row.mode === 'rejected' && row.method === 'thread/start')).toHaveLength(0)
  expect(requests.filter(row => row.method === 'turn/start')).toHaveLength(0)
  if (process.env.AGENTMUX_STARTUP_DIAGNOSTIC_PROOF) {
    const owners = ['client', 'startup-diagnostic', 'startup-diagnostic-journal', 'headless-runtime', 'hosted-client',
      'hosted-runtime-service', 'public-rpc-service', 'diagnostic-evidence-codec', 'diagnostic-evidence-service', 'agentmux-cli-commands']
    const paths = [...owners.flatMap(name => [`src/${name}.ts`, `dist/${name}.js`]),
      'bin/amux', 'dist/agentmux.js', 'dist/index.js', 'test/fixtures/frontend-recovery-owner.mjs',
      `vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
    const artifacts = await Promise.all(paths.map(async path => ({ path: resolve(import.meta.dirname, '..', path), sha256: createHash('sha256').update(await readFile(resolve(import.meta.dirname, '..', path))).digest('hex') })))
    await appendFile(process.env.AGENTMUX_STARTUP_DIAGNOSTIC_PROOF, JSON.stringify({ firstOwner, secondOwner: scope.owner,
      ownerPids: [firstPid, scope.ownerProcess.pid], originalRuns: beforeRuns.map(value => ({ runId: value.run.runId, pid: value.run.pid })),
      workerArguments: scope.ownerProcess.spawnargs, denied, pending, recovered, requests, artifacts }) + '\n')
  }
}, 90_000)
