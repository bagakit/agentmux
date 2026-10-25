import { afterEach, expect, it } from 'vitest'
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Private initialization cleanup failed')
})
const rows = async (path: string): Promise<any[]> => (await readFile(path, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error
})).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

it.runIf(process.platform === 'darwin')('public CLI observes a slow original preflight across Core owners, then delivers only the saved initial input and preserves unknown input', async () => {
  const scope = await headlessFixture(); cleanups.push(scope.cleanup)
  const sdk = await scope.client(), store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const command = join(scope.root, 'native.mjs'), gate = join(scope.root, 'account-gate'), calls = join(scope.root, 'calls.ndjson')
  const heartbeat = join(scope.root, 'heartbeat'), transcript = join(scope.root, 'rollout-private.jsonl')
  const nativeId = '00000000-0000-4000-8000-000000000093', originalPrompt = 'SAVED_INITIAL_PROMPT_ONCE'
  await writeFile(gate, 'retain the original response')
  await writeFile(command, `#!/usr/bin/env node
import {appendFileSync,existsSync,openSync,writeSync,writeFileSync} from 'node:fs'
import WS from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
const args=process.argv.slice(2),nativeId=${JSON.stringify(nativeId)}
if(args.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')){console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')){
  setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},JSON.stringify({pid:process.pid,at:Date.now()})),30)
  const server=new WS.WebSocketServer({port:0,host:'127.0.0.1'})
  server.on('connection',(ws,request)=>{
    if(request.headers.authorization!=='Bearer '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN)return ws.close()
    ws.on('message',async bytes=>{
      const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
      appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:p.method,params:p.params,at:Date.now()})+'\\n')
      if(p.method==='account/read')while(existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,10))
      const thread={id:nativeId,sessionId:'same-original-native-object',canAcceptDirectInput:true,status:{type:'idle'}}
      if(p.method==='thread/start'){
        const fd=openSync(${JSON.stringify(transcript)},'a')
        writeSync(fd,JSON.stringify({type:'session_meta',payload:{id:nativeId,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
      }
      if(p.method==='turn/start'&&p.params.input.some(part=>part.text?.includes('UNKNOWN_INPUT_ONCE')))return ws.close()
      const result=p.method==='account/read'?{account:null,requiresOpenaiAuth:false}:p.method==='thread/read'?{thread}:
        p.method==='thread/start'?{thread,cwd:p.params.cwd,model:p.params.model,approvalPolicy:p.params.approvalPolicy,sandbox:{type:p.params.sandbox==='read-only'?'readOnly':p.params.sandbox==='workspace-write'?'workspaceWrite':'dangerFullAccess'}}:
        p.method==='turn/start'?{turn:{id:'original-initial-turn'}}:{}
      ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result}))
    })
  })
}else{
  appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'frontend',args,pid:process.pid,at:Date.now()})+'\\n')
  process.stdin.setRawMode(true)
  process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u'))process.stdout.write('\\x1b[?2026h› \\x1b[?2026l')})
  setTimeout(()=>process.stdout.write('\\x1b[?u'),0)
}
`, { mode: 0o700 })
  const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'slow-initialization-original',
    createOperationId: 'create-original', workspacePath: scope.root, commandOverride: command, prompt: originalPrompt, injectAgentMuxGuide: false })
  cleanups.push(async () => {
    const reader = await scope.client(), current = await reader.statusAgent(original.agentSessionId)
    if (current.run.state === 'running') await reader.stopAgent(original.agentSessionId, current.session.run)
  })
  const firstRead = await until(() => rows(calls), values => values.some(value => value.method === 'account/read'), 'original preflight request')
  const requestedAt = firstRead.find(value => value.method === 'account/read').at
  await new Promise(resolve => setTimeout(resolve, Math.max(0, requestedAt + 10_600 - Date.now())))
  const before = await sdk.statusAgent(original.agentSessionId), saved = await store.readMetadata(original.agentSessionId)
  expect(before.session.terminalFrontend?.initialization).toMatchObject({ phase: 'unknown', native: { state: 'not-created' }, failure: { step: 'preflight' } })
  expect(saved?.initialInput).toMatchObject({ state: 'prepared', delivery: 'post-launch', prompt: originalPrompt })
  const originalActor = saved!.nativeActor!, originalInput = structuredClone(saved!.initialInput)
  const backend = JSON.parse(await readFile(heartbeat, 'utf8'))
  const loaded = await promisify(execFile)('ps', ['-p', String(before.run.pid), '-o', 'args='])
  const managedArtifact = resolve(import.meta.dirname, '../dist/providers/codex-managed-run.js')
  expect(loaded.stdout).toContain(managedArtifact)
  expect(scope.ownerProcess.spawnargs).toContain(resolve(import.meta.dirname, 'fixtures/frontend-recovery-owner.mjs'))
  const cliArgs = ['--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect', '--session', original.agentSessionId]
  const cliBefore = await runCompiledObjectCli(cliArgs, scope.env)
  expect(cliBefore.code, cliBefore.stdout + cliBefore.stderr).toBe(0)
  expect(JSON.parse(cliBefore.stdout).result.session.terminalFrontend.initialization).toMatchObject({ phase: 'unknown', native: { state: 'not-created' } })
  const resume = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'agent', 'resume', '--session', original.agentSessionId,
    '--operation-id', 'observe-original-startup'], scope.env)
  expect(resume.code, resume.stdout + resume.stderr).toBe(1)
  const resumeReceipt = JSON.parse((resume.stdout + resume.stderr).trim().split('\n').find(line => line.startsWith('{'))!)
  expect(resumeReceipt).toMatchObject({ ok: false, operationId: 'observe-original-startup', error: { code: 'AGENT_NATIVE_INITIALIZATION_OBSERVATION_UNCONFIRMED' } })
  expect(JSON.parse(resumeReceipt.error.detail)).toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed', previousRun: original.run,
    continuity: { operationId: 'observe-original-startup', initializationRecovery: { actorId: originalActor.actorId, lifecycleOperationId: originalActor.lifecycleOperationId } } })
  expect((await rows(calls)).filter(value => value.method === 'account/read')).toHaveLength(1)
  expect((await rows(calls)).filter(value => value.method === 'thread/start')).toHaveLength(0)
  const exhausted = await until(() => sdk.statusAgent(original.agentSessionId), value => {
    const operation = value.session.continuityOperations?.['observe-original-startup']
    return operation?.rechecks === 3 && operation.nextActionAt === undefined
  }, 'original bounded rechecks exhausted while its read stays pending', 30_000)
  const exhaustedOperation = structuredClone(exhausted.session.continuityOperations!['observe-original-startup'])
  expect(exhaustedOperation!.initializationRecovery!.observation.initialization).toMatchObject({ phase: 'unknown', native: { state: 'not-created' } })
  const firstOwner = scope.owner, firstOwnerPid = scope.ownerProcess.pid
  await sdk.dispose(); await scope.restart(); const reader = await scope.client()
  expect(scope.owner.runtimeId).toBe(firstOwner.runtimeId)
  expect(scope.owner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
  expect(scope.ownerProcess.pid).not.toBe(firstOwnerPid)
  expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
  const retained = await store.readMetadata(original.agentSessionId)
  expect(retained!.run).toEqual(original.run)
  expect(retained!.nativeActor).toEqual(originalActor)
  expect(retained!.initialInput).toEqual(originalInput)
  expect(retained!.continuityOperations!['observe-original-startup']).toEqual(exhaustedOperation)
  expect((await reader.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  const secondOwner = scope.owner, secondOwnerPid = scope.ownerProcess.pid
  const preflightHeldMs = Date.now() - requestedAt
  await rm(gate)
  const ready = await until(() => reader.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.initialization?.phase === 'ready' && value.session.nativeHandle?.sessionId === nativeId, 'late original response after Core owner restart')
  await until(() => reader.inspectAgentPromptSubmission(originalInput!.key!),
    value => value?.admission?.transport === 'native' && value.admission.native.outcome === 'admitted', 'saved initial input admitted once')
  await until(() => reader.statusAgent(original.agentSessionId), value => value.session.creation?.initialPrompt === 'confirmed',
    'original initial input receipt committed to its Session')
  const admitted = await store.readMetadata(original.agentSessionId)
  expect(admitted!.initialInput!.state).toBe('native-admitted')
  expect(ready.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  expect(ready.session.terminalFrontend!.initialization!.lifecycleOperationId).toBe(originalActor.lifecycleOperationId)
  expect(JSON.parse(await readFile(heartbeat, 'utf8')).pid).toBe(backend.pid)
  const cliAfter = await runCompiledObjectCli(cliArgs, scope.env)
  expect(cliAfter.code, cliAfter.stdout + cliAfter.stderr).toBe(0)
  expect(JSON.parse(cliAfter.stdout).result.session.terminalFrontend.initialization).toMatchObject({ phase: 'ready', native: { state: 'confirmed', sessionId: nativeId } })
  const unknownOperation = 'unknown-input-original'
  await reader.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: unknownOperation,
    execution: 'immediate', admissionIntent: { kind: 'native-conversation', source: { providerId: 'codex', nativeSessionId: nativeId } }, prompt: 'UNKNOWN_INPUT_ONCE', authorHuman: true })
  const inputKey = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: unknownOperation }
  const unknown = await until(() => reader.inspectAgentPromptSubmission(inputKey), value => value?.admission?.transport === 'native' && value.admission.native.outcome === 'unknown', 'original unknown native input')
  await reader.dispose(); await scope.restart(); const finalReader = await scope.client()
  expect(scope.owner.ownerInstanceId).not.toBe(secondOwner.ownerInstanceId)
  expect(scope.ownerProcess.pid).not.toBe(secondOwnerPid)
  expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
  expect((await finalReader.statusAgent(original.agentSessionId)).run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  expect(await finalReader.inspectAgentPromptSubmission(inputKey)).toEqual(unknown)
  expect((await store.readMetadata(original.agentSessionId))!.initialInput).toEqual(admitted!.initialInput)
  const freshOperation = 'fresh-after-late-preflight'
  await finalReader.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: freshOperation,
    execution: 'immediate', admissionIntent: { kind: 'native-conversation', source: { providerId: 'codex', nativeSessionId: nativeId } }, prompt: 'FRESH_INPUT_AFTER_LATE_PREFLIGHT', authorHuman: true })
  await until(() => finalReader.inspectAgentPromptSubmission({ ...inputKey, submissionId: freshOperation }),
    value => value?.admission?.transport === 'native' && value.admission.native.outcome === 'admitted', 'fresh input after retained unknown input')
  const requests = await rows(calls), turns = requests.filter(value => value.method === 'turn/start')
  expect(requests.filter(value => value.method === 'account/read')).toHaveLength(1)
  expect(requests.filter(value => value.method === 'thread/start')).toHaveLength(1)
  expect(requests.filter(value => value.method === 'frontend')).toHaveLength(1)
  expect(turns.filter(value => value.params.input.some((part: any) => part.text?.includes(originalPrompt)))).toHaveLength(1)
  expect(turns.filter(value => value.params.input.some((part: any) => part.text?.includes('UNKNOWN_INPUT_ONCE')))).toHaveLength(1)
  expect(turns.filter(value => value.params.input.some((part: any) => part.text?.includes('FRESH_INPUT_AFTER_LATE_PREFLIGHT')))).toHaveLength(1)
  if (process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE) {
    const paths = ['src/providers/codex-managed-run.ts', 'src/providers/codex-native-rpc.ts', 'dist/providers/codex-managed-run.js',
      'dist/providers/codex-native-rpc.js', 'dist/agentmux.js', 'dist/hosted-runtime-service.js', 'test/fixtures/frontend-recovery-owner.mjs']
    const artifacts = await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(import.meta.dirname, '..', path))).digest('hex') })))
    await appendFile(process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE, JSON.stringify({ schema: 'agentmux.initialization-public-proof.v1', artifacts,
      original: { agentSessionId: original.agentSessionId, runId: original.run.runId, pid: before.run.pid, backendPid: backend.pid,
        actorId: originalActor.actorId, lifecycleOperationId: originalActor.lifecycleOperationId },
      owners: [{ pid: firstOwnerPid, identity: firstOwner }, { pid: secondOwnerPid, identity: secondOwner }, { pid: scope.ownerProcess.pid, identity: scope.owner }],
      preflightHeldMs, originalRechecksExhausted: exhaustedOperation!.rechecks, cliBeforePhase: 'unknown', cliAfterPhase: 'ready',
      readCount: 1, nativeCreationCount: 1, initialInputCount: 1, unknownInputCount: 1, freshInputCount: 1, unknownInputReceiptUnchanged: true }) + '\n')
  }
}, 90_000)

it.runIf(process.platform === 'darwin')('public CLI continues a settled original resume after a post-load rejection without replacing its Run or backend', async () => {
  const scope = await headlessFixture(); cleanups.push(scope.cleanup)
  const sdk = await scope.client(), store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const command = join(scope.root, 'resume-native.mjs'), rejected = join(scope.root, 'resume-rejected'), calls = join(scope.root, 'resume-calls.ndjson')
  const loaded = join(scope.root, 'resume-loaded.json'), transcript = join(scope.root, 'rollout-original.jsonl')
  const nativeId = '00000000-0000-4000-8000-000000000094'
  await writeFile(command, `#!/usr/bin/env node
import {appendFileSync,existsSync,writeFileSync} from 'node:fs'
import WS from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
const args=process.argv.slice(2),nativeId=${JSON.stringify(nativeId)}
if(args.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')){console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')){
 let effective,thread
 const server=new WS.WebSocketServer({port:0,host:'127.0.0.1'})
 server.on('connection',(ws,request)=>{
  if(request.headers.authorization!=='Bearer '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN)return ws.close()
  ws.on('message',bytes=>{
   const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
   appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:p.method,params:p.params,pid:process.pid})+'\\n')
   if(p.method==='thread/start'||p.method==='thread/resume'){
    if(!thread){
     thread={id:nativeId,sessionId:'loaded-execution-'+process.pid,canAcceptDirectInput:true,status:{type:'idle'}}
     effective={thread,cwd:p.params.cwd,model:p.params.model,approvalPolicy:p.params.approvalPolicy,sandbox:{type:p.params.sandbox==='read-only'?'readOnly':p.params.sandbox==='workspace-write'?'workspaceWrite':'dangerFullAccess'}}
     writeFileSync(${JSON.stringify(loaded)},JSON.stringify({pid:process.pid,thread,effective}))
    }
    if(p.method==='thread/start')appendFileSync(${JSON.stringify(transcript)},JSON.stringify({type:'session_meta',payload:{id:nativeId,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
    if(p.method==='thread/resume'&&existsSync(${JSON.stringify(rejected)}))return ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,error:{code:-32600,message:'Private response hydration failed after loading the original object'}}))
   }
   const result=p.method==='account/read'?{account:null,requiresOpenaiAuth:false}:p.method==='thread/read'?{thread}:p.method==='thread/start'||p.method==='thread/resume'?effective:p.method==='turn/start'?{turn:{id:'private-original-turn'}}:{}
   ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result}))
  })
 })
}else{
 appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'frontend',args,pid:process.pid})+'\\n')
 process.stdin.setRawMode(true)
 process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u'))process.stdout.write('\\x1b[?2026h› \\x1b[?2026l')})
 setTimeout(()=>process.stdout.write('\\x1b[?u'),0)
}
`, { mode: 0o700 })
  const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'settled-resume-original',
    createOperationId: 'create-original', workspacePath: scope.root, commandOverride: command, prompt: 'PRIVATE_ORIGINAL_SETUP', injectAgentMuxGuide: false })
  cleanups.push(async () => {
    const current = await sdk.statusAgent(original.agentSessionId)
    if (current.run.state === 'running') await sdk.stopAgent(original.agentSessionId, current.session.run)
  })
  await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.nativeHandle?.sessionId === nativeId && value.session.terminalHandshake?.acknowledged === true, 'private original thread and frontend').catch(async error => {
    if (process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE) {
      const value = await sdk.statusAgent(original.agentSessionId)
      await appendFile(process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE, JSON.stringify({ failedStage: 'original-private-bootstrap', run: value.run, frontend: value.session.terminalFrontend, handshake: value.session.terminalHandshake, native: value.session.nativeHandle, creation: value.session.creation, calls: await rows(calls) }) + '\n')
    }
    throw error
  })
  await sdk.stopTerminal(original.run)
  await until(() => sdk.listRuns(), values => values.find(value => value.runId === original.run.runId)?.state !== 'running', 'private original Run ended before authorized resume')
  await writeFile(rejected, 'reject the response after loading the original thread')
  await sdk.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'original-native-resume', trigger: 'manual', commandOverride: command, policy: { retryMaxAttempts: 0, recheckMaxAttempts: 0 } })
  const failed = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.initialization?.phase === 'failed', 'settled native resume rejection')
  expect(failed.session.terminalFrontend!.initialization).toMatchObject({ native: { state: 'unknown' }, failure: { step: 'native-session', code: -32600 } })
  expect(failed.run.state).toBe('running'); expect(failed.run.runId).not.toBe(original.run.runId)
  const originalActor = (await store.readMetadata(original.agentSessionId))!.nativeActor!, loadedBefore = await readFile(loaded, 'utf8')
  const backend = JSON.parse(loadedBefore), beforeCalls = await rows(calls)
  const exactResumes = beforeCalls.filter(value => value.method === 'thread/resume' && value.pid === backend.pid)
  expect(exactResumes.length).toBeGreaterThan(0)
  expect(beforeCalls.filter(value => value.method === 'frontend')).toHaveLength(1)
  const inspectArgs = ['--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect', '--session', original.agentSessionId]
  const cliBefore = await runCompiledObjectCli(inspectArgs, scope.env)
  expect(cliBefore.code, cliBefore.stdout + cliBefore.stderr).toBe(0)
  expect(JSON.parse(cliBefore.stdout).result.session.terminalFrontend.initialization).toMatchObject({ phase: 'failed', native: { state: 'unknown' }, failure: { code: -32600 } })
  const beforeReadCount = (await rows(calls)).filter(value => value.method === 'thread/resume').length
  expect(beforeReadCount).toBe(beforeCalls.filter(value => value.method === 'thread/resume').length)
  await rm(rejected)
  const resumed = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'agent', 'resume', '--session', original.agentSessionId,
    '--operation-id', 'continue-original-initialization'], scope.env)
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0)
  const ready = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.initialization?.phase === 'ready' && value.session.terminalHandshake?.acknowledged === true, 'same original resume frontend ready')
  expect(ready.run).toMatchObject({ runId: failed.run.runId, pid: failed.run.pid, state: 'running' })
  expect(ready.session.nativeHandle!.sessionId).toBe(nativeId)
  expect((await store.readMetadata(original.agentSessionId))!.nativeActor).toEqual(originalActor)
  expect(await readFile(loaded, 'utf8')).toBe(loadedBefore)
  expect(ready.session.terminalFrontend!.initialization!.lifecycleOperationId).toBe(originalActor.lifecycleOperationId)
  const cliAfter = await runCompiledObjectCli(inspectArgs, scope.env)
  expect(cliAfter.code, cliAfter.stdout + cliAfter.stderr).toBe(0)
  expect(JSON.parse(cliAfter.stdout).result.session.terminalFrontend.initialization).toMatchObject({ phase: 'ready', native: { state: 'confirmed', sessionId: nativeId } })
  const finalCalls = await rows(calls), finalResumes = finalCalls.filter(value => value.method === 'thread/resume' && value.pid === backend.pid)
  expect(finalResumes).toHaveLength(exactResumes.length + 1)
  for (const call of finalResumes) expect(call.params).toEqual(exactResumes[0].params)
  expect(finalCalls.filter(value => value.method === 'thread/start')).toHaveLength(1)
  expect(finalCalls.filter(value => value.method === 'frontend')).toHaveLength(2)
  expect(finalCalls.filter(value => value.method === 'turn/start')).toHaveLength(1)
  expect(finalCalls.filter(value => value.method === 'turn/start')).toEqual(beforeCalls.filter(value => value.method === 'turn/start'))
  expect(finalCalls.some(value => ['turn/steer', 'thread/queue/add'].includes(value.method))).toBe(false)
  const loadedCommand = await promisify(execFile)('ps', ['-p', String(ready.run.pid), '-o', 'args='])
  expect(loadedCommand.stdout).toContain(resolve(import.meta.dirname, '../dist/providers/codex-managed-run.js'))
  if (process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE) {
    const paths = ['src/providers/codex-managed-run.ts', 'src/providers/codex-native-rpc.ts', 'dist/providers/codex-managed-run.js',
      'dist/providers/codex-native-rpc.js', 'dist/agentmux.js', 'dist/hosted-runtime-service.js', 'test/fixtures/frontend-recovery-owner.mjs']
    const artifacts = await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(import.meta.dirname, '..', path))).digest('hex') })))
    await appendFile(process.env.AGENTMUX_INITIALIZATION_PUBLIC_EVIDENCE, JSON.stringify({ schema: 'agentmux.settled-resume-public-proof.v1', artifacts,
      original: { agentSessionId: original.agentSessionId, runId: failed.run.runId, pid: failed.run.pid, backendPid: backend.pid,
        actorId: originalActor.actorId, lifecycleOperationId: originalActor.lifecycleOperationId, nativeSessionId: nativeId },
      owner: scope.owner, cliBeforePhase: 'failed', nativeBeforeState: 'unknown', cliAfterPhase: 'ready', sameRun: true,
      sameActor: true, sameLoadedObject: true, originalResumeCount: exactResumes.length, finalResumeCount: finalResumes.length,
      nativeCreationCount: 1, frontendCount: 2, setupTurnCount: 1, resumedTurnCount: 0, userRuntimeTouched: false }) + '\n')
  }
}, 60_000)
