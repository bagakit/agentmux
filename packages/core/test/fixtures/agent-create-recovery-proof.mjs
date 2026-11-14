import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '../../src/errors.ts'
import { issueAgentCapability, hashAgentCapability, hookBindingIdentity } from '../../src/agent-capability.ts'
import { AgentMuxClient } from '../../src/index.ts'
import { defineAgentProvider } from '../../src/agent-provider.ts'
import { AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.ts';
import { agentLifecycleOperationIdentity } from "../../src/agent-session-identity.ts";
import { decodePreparedRun } from '../../src/prepared-run.ts'
import { parseCreationInspection, parseCreationInspectionResult } from '../../src/agent-creation-inspection.ts'
import { parseRpcNativeResult } from '../../src/rpc-native-codec.ts'

process.umask(0o077)
const root = process.env.AGENTMUX_CREATE_PROOF_ROOT, stage = process.argv[2] ?? 'all'
assert.ok(root)
for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !/^(AGENTMUX_CREATE_PROOF_|AGENTMUX_SOURCE_)/u.test(key)) delete process.env[key]
process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'r'); process.env.AGENTMUX_STATE_DIRECTORY = join(root, 's')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.ndjson')
const file = fileURLToPath(import.meta.url), core = join(dirname(file), '../..')
const loader = fileURLToPath(new URL('../../scripts/helpers/core-source-loader.mjs', import.meta.url))
if (!process.execArgv.includes(loader)) process.execArgv.push('--import', loader)
// Production deliberately starts its listener asset with execArgv:[], so load the freshly
// transpiled exact worker body at this one asset leaf; never borrow another checkout's dist.
const childProcess = createRequire(import.meta.url)('node:child_process'), actualFork = childProcess.fork
childProcess.fork = (path, args, options) => actualFork(String(path).endsWith('/control-endpoint-listener-worker.js')
  ? process.env.AGENTMUX_SOURCE_LISTENER_ASSET : path, args, options)
syncBuiltinESMExports()
const storePath = join(root, 'sessions.sqlite'), check = (value, message) => assert.ok(value, `T005: ${message}`)
const sha = value => createHash('sha256').update(value).digest('hex')
const delivery = process.env.AGENTMUX_CREATE_PROOF_DELIVERY ?? 'post-launch-only'
const provider = defineAgentProvider({ catalog: { id: 'creation-proof', label: 'Private creation proof', executable: process.execPath,
  expectedProcess: 'node', promptDelivery: delivery, readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
  hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
  buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])], hook: { rules: [] },
  // This tiny Provider consumes an actual machine packet emitted only after the private Node
  // CLI installs its input listener. Double-check the same file and Native PID before binding.
  discoverNativeSession: async context => {
    const path = join(context.workspacePath, 'native-protocol.json')
    let packet
    try { packet = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (packet.schema !== 'amux-proof-native-v1' || packet.phase !== 'input-ready' || packet.pid !== context.processId || packet.sid !== request.agentSessionId) return null
    const assertCurrent = async () => { assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), packet) }
    return { handle: { kind: 'provider', providerId: 'creation-proof', sessionId: packet.nativeId }, assertCurrent }
  },
  readSessionHistoryPage: async context => {
    // The selected owner has no received messages at this initial binding cut. Reading
    // history uses the actual Core process witness consumer rather than a fabricated binding.
    const packet = JSON.parse(await readFile(join(context.workspacePath, 'native-protocol.json'), 'utf8'))
    assert.equal(packet.nativeId, context.source.nativeSessionId)
    const bytes = await readFile(join(context.workspacePath, 'native-history.log')).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
    return { source: context.source, items: bytes.length ? [{ id: 'received-input', kind: 'message', role: 'user', content: bytes.toString('utf8') }] : [], nextCursor: null }
  } })
const request = { providerId: provider.id, executorId: 'private-node', workspacePath: root, createOperationId: 'original-create', agentSessionId: 'original-sid',
  injectAgentMuxGuide: false, prompt: 'the old frozen first task', args: ['-e', "const fs=require('node:fs'),crypto=require('node:crypto');const at=process.argv.indexOf('--proof-resume');let nativeId=crypto.randomUUID();if(at>=0){const old=JSON.parse(fs.readFileSync('native-protocol.json'));if(old.nativeId!==process.argv[at+1])process.exit(2);nativeId=old.nativeId;}process.stdin.setRawMode(true);process.stdin.on('data',d=>{fs.appendFileSync('native-history.log',d);process.stdout.write('INPUT:'+d)});fs.writeFileSync('native-protocol.json',JSON.stringify({schema:'amux-proof-native-v1',phase:'input-ready',pid:process.pid,sid:process.env.AGENTMUX_AGENT_SESSION_ID,lifecycleOperationId:process.env.AGENTMUX_LIFECYCLE_OPERATION_ID,nativeId}),{mode:0o600});console.log('READY');setInterval(()=>{},1000)"],
  env: { ORIGINAL_CREATE_PROOF: 'exact-environment' }, cols: 81, rows: 25 }
const clients = [], children = [], resources = { daemonPid: null, childPids: [], runPids: [], cleanupErrors: [] }
const journal = () => writeFileSync(join(root, 'resource-journal.json'), JSON.stringify(resources), { mode: 0o600 })
const checkpoint = value => console.error(`T005 checkpoint ${stage}: ${value}`)
async function reader(store = new AgentMuxFileAgentSessionStore(storePath), connect = true) {
  const client = new AgentMuxClient({ store, providers: [provider] })
  Object.defineProperty(client.hookServer, 'port', { value: 0 }); clients.push(client)
  if (connect) await client.connect()
  return { client, store }
}
const wait = async (read, predicate, label) => {
  for (let i = 0; i < 120; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)) }
  assert.fail(`T005: ${label}`)
}
async function receive(child, kind) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not reach ${kind}: ${child.proofError ?? ''}`)), 20_000)
    const exit = code => { clearTimeout(timer); reject(new Error(`Child exited ${code}: ${child.proofError ?? ''}`)) }
    const message = value => { if (value.kind === kind) { clearTimeout(timer); child.off('exit', exit); child.off('message', message); resolve(value) } }
    child.once('exit', exit); child.on('message', message)
  })
}
function child(mode) {
  const process = fork(file, [mode], { env: globalThis.process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  process.proofError = ''; process.stderr.on('data', value => { process.proofError += value }); children.push(process); resources.childPids.push(process.pid)
  journal()
  return process
}
async function kill(child) { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended } }
const pause = async kind => { process.send({ kind }); await new Promise(() => {}) }

async function publicConsumers(f, expected) {
  const { AgentMuxHostedRuntimeService } = await import('../../src/hosted-runtime-service.ts')
  const { connectHostedAgentMux } = await import('../../src/hosted-client.ts')
  const { AgentMuxControlServer } = await import('../../src/public-rpc-server.ts')
  const { AgentMuxRpcService } = await import('../../src/public-rpc-service.ts')
  const { connectAgentMuxRpc } = await import('../../src/public-rpc-client.ts')
  const hosted = new AgentMuxHostedRuntimeService(f.client, storePath, () => ({ runtimeId: 'private-semantic-owner', ownerInstanceId: 'private-owner-instance',
    protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  const socket = join(root, 'proof-control.sock')
  const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  let rpc, remote
  const same = value => {
    assert.equal(value.kind, expected.kind); assert.equal(value.agentSessionId, expected.agentSessionId)
    if (expected.kind === 'agent') { assert.deepEqual(value.run, expected.run); assert.deepEqual(value.creation.resolution, expected.creation.resolution) }
    else assert.deepEqual(value, expected)
  }
  try {
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
    remote = await connectHostedAgentMux({ rpc, connectOnDemand: true })
    const input = { createOperationId: request.createOperationId, operationId: 'resolve-original' }
    same(await remote.inspectAgentCreation({ createOperationId: input.createOperationId }))
    same(await remote.resolveAgentCreation(input))
    const result = await rpc.call('agent.creation.resolve', { hostId: 'local', ...input })
    same(result.inspection)
    same((await rpc.call('agent.creation.inspect', { hostId: 'local', createOperationId: input.createOperationId })).inspection)
    check(!JSON.stringify(result).includes('exact-environment') && !JSON.stringify(result).includes(request.prompt), 'public/Hosted receipts never expose the private launch or frozen input')
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
    let denied = false
    try { await service.call('agent.creation.resolve', { hostId: 'local', ...input }, { caller: { agentSessionId: 'managed', capability: 'forbidden' }, principal: { kind: 'user', id: 'person' } }) }
    catch (error) { denied = error.code === 'CONTROL_PERMISSION_DENIED' }
    check(denied, 'a managed caller cannot borrow explicit resolve authority')
    const cli = async args => {
      const process = spawn(globalThis.process.execPath, ['--import', loader, join(core, 'src/agentmux.ts'), '--endpoint', `unix:${socket}`, ...args], { env: globalThis.process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(process); resources.childPids.push(process.pid)
      let stdout = '', stderr = ''; process.stdout.on('data', value => { stdout += value }); process.stderr.on('data', value => { stderr += value })
      const timeout = setTimeout(() => process.kill('SIGKILL'), 20_000)
      const [code] = await once(process, 'exit'); clearTimeout(timeout)
      check(code === 0, `actual transpiled CLI exits successfully: ${stderr}`)
      return stdout
    }
    const inspected = JSON.parse(await cli(['agent', 'creation', 'inspect', '--host', 'local', '--operation-id', input.createOperationId]))
    const resolved = JSON.parse(await cli(['agent', 'creation', 'resolve', '--host', 'local', '--create-operation-id', input.createOperationId, '--operation-id', input.operationId]))
    same(inspected.result.inspection); same(resolved.result.inspection)
    const help = await cli(['agent', 'creation', 'resolve', '--help'])
    check(help.includes('--create-operation-id') && help.includes('CONTROL_ID') && help.includes('No Start'), 'actual CLI discovery retains the explicit original operation and no-input contract')
    rowsPublic.push({ realHostedSdk: true, realUnixRpc: true, actualTranspiledCliProcess: true, compiledDistributionClaimed: false, managedCallerRefused: true, helpDiscovered: true })
  } finally { await remote?.dispose(); await rpc?.dispose(); await server.stop(); await hosted.dispose() }
}
const rowsPublic = []

if (stage.startsWith('child-')) {
  const f = await reader(undefined, stage !== 'child-resolve-legacy')
  if (stage === 'child-observe') await pause('cold-observed')
  else if (stage === 'child-resolve-legacy') {
    const admit = f.client.registry.admitCreationResolution.bind(f.client.registry)
    f.client.registry.admitCreationResolution = async (...args) => { const pending = await admit(...args); await pause('legacy-admitted'); return pending }
    await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' })
  }
  else if (stage === 'child-resolve') {
    f.client.kernel.retirePreparedStart = async () => await pause('before-retire')
    await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, agentSessionId: request.agentSessionId, operationId: 'resolve-original' })
  } else {
    const originalPrepare = f.client.registry.prepareCreate.bind(f.client.registry)
    f.client.registry.prepareCreate = async (...args) => {
      const prepared = await originalPrepare(...args)
      const saved = await f.store.loadCreationCorrelation(request.agentSessionId)
      check(saved?.preparedDispatch, 'new writer freezes its full request and original Runtime before dispatch')
      if (stage === 'child-prepare') await pause('prepared')
      return prepared
    }
    const start = f.client.kernel.startPrepared.bind(f.client.kernel)
    f.client.kernel.startPrepared = async (...args) => { const run = await start(...args); if (stage === 'child-dispatch') await pause('dispatched'); return run }
    if (stage === 'child-commit') {
      const commit = f.client.registry.commitLifecycle.bind(f.client.registry)
      f.client.registry.commitLifecycle = async (...args) => { const result = await commit(...args); await pause('committed'); return result }
    }
    await f.client.createAgentWithDelivery(request)
    assert.fail('T005: child must interrupt the original call at its actual owner boundary')
  }
} else {
  let daemon, secondDaemon
  const rows = []
  try {
    await mkdir(join(root, 'r'), { recursive: true }); await mkdir(join(root, 's'), { recursive: true })
    daemon = spawn(process.env.AGENTMUX_CREATE_PROOF_DAEMON, ['--socket', join(root, 'r/ctxmux.sock'), '--state-dir', join(root, 's/ctxmux'), '--readiness-fd', '3'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }); resources.daemonPid = daemon.pid
    journal()
    let error = ''; daemon.stderr.on('data', value => { error += value })
    await Promise.race([once(daemon.stdio[3], 'data'), once(daemon, 'exit').then(() => { throw new Error(error) })])
    const originalStage = ['dispatch', 'mismatch', 'hold', 'namespace', 'legacy'].includes(stage) ? 'dispatch' : stage === 'commit' ? 'commit' : 'prepare'
    const creator = child(`child-${originalStage}`)
    await receive(creator, { prepare: 'prepared', dispatch: 'dispatched', commit: 'committed' }[originalStage])
    checkpoint('creator boundary reached')
    const liveObserver = await reader(undefined, false)
    let refused = false
    try { await liveObserver.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'live-owner-control' }) }
    catch (error) { refused = error.code === 'AGENT_SESSION_BUSY' || originalStage === 'commit' }
    if (originalStage !== 'commit') check(refused, 'an expired lease never authorizes taking over a live creator')
    await liveObserver.client.dispose(); await kill(creator)
    checkpoint('original owner exited')
    const f = await reader(undefined, false)
    let original = await f.store.loadCreationCorrelation(request.agentSessionId)
    if (originalStage !== 'commit') {
      check(original?.preparedCreation && original.preparedDispatch, 'full original preparation survived a real owner-process interruption')
      const { request: frozen } = decodePreparedRun(original.preparedDispatch.prepared)
      check(frozen.env.ORIGINAL_CREATE_PROOF === request.env.ORIGINAL_CREATE_PROOF && frozen.initial_size.cols === 81 && frozen.initial_size.rows === 25, 'actual env and terminal dimensions frozen')
      check(original.preparedCreation.initialInput.prompt === request.prompt && original.preparedCreation.initialInput.state === 'prepared', 'old input kept without an invented receipt')
    }
    if (stage === 'legacy' || stage === 'legacy-missing') {
      // Controlled historical representation: remove only the newer pre-dispatch field
      // from this isolated original owner; the real Native Start and full seed are unchanged.
      delete original.preparedDispatch
      const db = new DatabaseSync(storePath)
      db.prepare('UPDATE reservations SET json=? WHERE id=?').run(JSON.stringify(original), original.agentSessionId); db.close()
      check(!(await f.store.loadCreationCorrelation(request.agentSessionId)).preparedDispatch, 'historical fixture does not invent a pre-dispatch request')
    }
    await f.client.connectRuntime()
    resources.runtimeIdentity = f.client.kernel.creationRuntimeIdentity(); journal()
    checkpoint('exact reader connected')
    if (stage === 'legacy-missing') {
      let unavailable = false, retires = 0
      const retire = f.client.kernel.retirePreparedStart.bind(f.client.kernel)
      f.client.kernel.retirePreparedStart = async (...args) => { retires++; return await retire(...args) }
      try { await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' }) }
      catch (error) { unavailable = error.code === 'AGENT_CREATION_RESOLUTION_UNAVAILABLE' }
      check(unavailable && retires === 0 && isDeepStrictEqual(await f.store.loadCreationCorrelation(request.agentSessionId), original), 'legacy missing evidence cannot manufacture preparation or retirement authority')
      rows.push({ realNoRetainedRun: true, preservedHistoricalSeed: true, inventedPreparation: false, retirements: retires })
    } else if (stage === 'runtime') {
      await mkdir(join(root, 'r2')); await mkdir(join(root, 's2'))
      secondDaemon = spawn(process.env.AGENTMUX_CREATE_PROOF_DAEMON, ['--socket', join(root, 'r2/ctxmux.sock'), '--state-dir', join(root, 's2'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
      await once(secondDaemon.stdio[3], 'data')
      const foreign = await reader(undefined, false)
      Object.defineProperty(foreign.client.kernel, 'socketPath', { value: join(root, 'r2/ctxmux.sock'), configurable: true })
      await foreign.client.connectRuntime()
      check(foreign.client.kernel.creationRuntimeIdentity().runtimeId !== original.preparedDispatch.runtime.runtimeId, 'the second real Native has an independent persistent lineage')
      let rejected = false
      try { await foreign.client.inspectAgentCreation(request.agentSessionId) } catch (error) { rejected = error.code === 'PREPARED_START_RUNTIME_MISMATCH' }
      check(rejected, 'another real Runtime cannot confirm the original prepared creation')
      check((await foreign.client.kernel.list()).length === 0, 'wrong Runtime observation never starts a process')
      rows.push({ realDifferentRuntimeRefused: true })
    } else if (stage === 'concurrency') {
      for (const type of ['memory', 'file']) {
        const store = type === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'concurrent.sqlite'))
        const candidates = ['contender-a', 'contender-b'].map(sid => {
          const seed = structuredClone(original.preparedCreation), dispatch = structuredClone(original.preparedDispatch)
          const operationId = agentLifecycleOperationIdentity('create', sid, request.createOperationId), capability = issueAgentCapability(), token = issueAgentCapability()
          seed.agentSessionId = sid; seed.hookBindingId = hookBindingIdentity(operationId); seed.hookToken = token; seed.capabilityHash = hashAgentCapability(capability)
          seed.initialInput.lifecycleOperationId = operationId; seed.initialInput.input.submissionId = `launch-prompt:${operationId}`
          const { request: launch } = decodePreparedRun(dispatch.prepared)
          Object.assign(launch.env, { AGENTMUX_AGENT_SESSION_ID: sid, AGENTMUX_LIFECYCLE_OPERATION_ID: operationId, AGENTMUX_HOOK_TOKEN: token, AGENTMUX_AGENT_CAPABILITY: capability })
          dispatch.prepared = { createOperationId: operationId, workspacePath: root, launch: JSON.stringify({ createOperationId: operationId, request: launch }) }
          const reservation = { kind: 'create', agentSessionId: sid, operationId, ownerId: sid, ownerPid: process.pid, expiresAt: 1, reservationId: sid }
          return { reservation, seed, dispatch }
        })
        for (const value of candidates) await store.reserveLifecycle(value.reservation)
        const results = await Promise.allSettled(candidates.map(value => store.prepareCreate(value.reservation, value.seed, value.dispatch)))
        // Both provisional bindings already exist at this controlled cut. Their disagreement is
        // unknown; never choose an original SID by arrival order or start both candidates.
        check(results.filter(value => value.status === 'fulfilled').length <= 1 && results.some(value => value.status === 'rejected' && value.reason.code === 'AGENT_CREATION_OPERATION_CONFLICT'), `${type} original CID preparation rejects a concurrent distinct SID atomically`)
      }
      rows.push({ realMemoryAndFileConcurrentPrepare: true, physicalStarts: 0, controlledCompetingCompleteSeeds: true })
    } else if (stage === 'subject') {
      const changed = structuredClone(original), captured = decodePreparedRun(changed.preparedDispatch.prepared)
      captured.request.env.AGENTMUX_AGENT_SESSION_ID = 'foreign-sid'
      changed.preparedDispatch.prepared.launch = JSON.stringify({ createOperationId: changed.operationId, request: captured.request })
      let rejected = false
      try { await new AgentMuxMemoryAgentSessionStore().reserveLifecycle(changed) } catch (error) { rejected = error.code === 'INVALID_AGENT_SESSION_STORE' }
      check(rejected, 'the actual launch subject must equal the prepared SID before admission')
      const wrongCid = structuredClone(original); wrongCid.preparedCreation.creation.createOperationId = 'foreign-create'
      let cidRejected = false
      try { await new AgentMuxMemoryAgentSessionStore().reserveLifecycle(wrongCid) } catch (error) { cidRejected = error.code === 'INVALID_AGENT_SESSION_STORE' }
      check(cidRejected, 'the original caller CID and SID must derive the actual lifecycle key')
      rows.push({ changedLaunchSubjectRefused: true })
    } else if (stage === 'mismatch') {
      const changed = structuredClone(original), captured = decodePreparedRun(changed.preparedDispatch.prepared)
      captured.request.args.push('foreign-argument')
      changed.preparedDispatch.prepared.launch = JSON.stringify({ createOperationId: changed.operationId, request: captured.request })
      changed.preparedCreation.initialInput.launchPlan.argsDigest = createHash('sha256').update(JSON.stringify(captured.request.args)).digest('base64url')
      const memory = new AgentMuxMemoryAgentSessionStore(); await memory.reserveLifecycle(changed)
      const foreign = await reader(memory, false); await foreign.client.connectRuntime()
      let rejected = false
      await foreign.client.connect()
      check(await memory.readMetadata(request.agentSessionId) === null, 'cold reconcile cannot commit a same-key mismatching full request')
      try { await foreign.client.inspectAgentCreation(request.agentSessionId) } catch (error) { rejected = error.code === 'PREPARED_START_UNCONFIRMED' }
      check(rejected, 'same key/cwd/subject with a different full actual RunSpec must remain unconfirmed')
      rows.push({ fullRunSpecMismatchRejected: true })
    } else if (stage === 'dispatch' || stage === 'hold' || stage === 'namespace' || stage === 'legacy') {
      const nativeBefore = await f.client.kernel.list(), run = nativeBefore.find(value => value.lifecycleOperationId === original.operationId)
      check(run?.state.type === 'running' && run.acceptedInputBytes === 0, 'the exact original Run survives owner death with no old input')
      let starts = 0, retires = 0
      f.client.kernel.startPrepared = async () => { starts++; throw new Error('No replacement Start') }
      const retire = f.client.kernel.retirePreparedStart.bind(f.client.kernel)
      f.client.kernel.retirePreparedStart = async (...args) => { retires++; return await retire(...args) }
      if (stage === 'legacy') {
        const resolver = child('child-resolve-legacy')
        let admitted = false
        try {
          await receive(resolver, 'legacy-admitted'); await kill(resolver)
          const pending = await f.store.loadCreationCorrelation(request.agentSessionId)
          admitted = !pending.preparedDispatch && pending.creationResolution?.receipt.source.kind === 'observed-retained' &&
            pending.creationResolution.observedRetained.run.runId === run.runId && isDeepStrictEqual(pending.preparedCreation, original.preparedCreation)
          original = pending
        } catch {}
        check(admitted, 'legacy retained observation admission survives owner-process interruption')
        const inspect = f.client.kernel.inspectPreparedStart.bind(f.client.kernel)
        f.client.kernel.inspectPreparedStart = async () => null // Controlled read gap, never a positive Runtime fact.
        let gap
        try { gap = await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' }) } catch {}
        f.client.kernel.inspectPreparedStart = inspect
        check(gap?.kind === 'prepared-agent-creation' && gap.resolution?.source.kind === 'observed-retained' && retires === 0, 'a retained observation read gap cannot authorize retirement')
        rows.push({ realLegacyRetainedWitness: true, realPostAdmissionProcessDeath: true, controlledReadGapCannotFence: true })
      }
      let publications = 0
      const unsubscribe = f.client.onEvent(event => { if (event.type === 'agent-session' && event.session.agentSessionId === request.agentSessionId) publications++ })
      const beforeInspectSHA = sha(await readFile(storePath))
      const observation = await f.client.inspectAgentCreation({ createOperationId: request.createOperationId })
      check(observation.kind === 'prepared-agent-creation' && observation.observation?.retainedRun.runId === run.runId && publications === 0 && retires === 0 &&
        await f.store.readMetadata(request.agentSessionId) === null && sha(await readFile(storePath)) === beforeInspectSHA, 'exact positive inspect is pure read and cannot commit or publish a Session')
      unsubscribe()
      const resolved = await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, agentSessionId: request.agentSessionId, operationId: 'resolve-original' })
      check(resolved.kind === 'agent' && resolved.run.runId === run.runId && resolved.creation.resolution?.outcome === 'retained', 'exact witness resolves to the same SID and original Run')
      await f.client.connect()
      await f.client.sessionHistoryPage(request.agentSessionId, { refreshNativeSource: true, requireCurrentSource: true })
      await f.client.refreshAgentSession(request.agentSessionId, resolved.run)
      await wait(() => f.store.readMetadata(request.agentSessionId), value => value.nativeBinding?.source === 'process-witness', 'real Provider machine packet binds the exact Native identity')
      const current = await f.store.readMetadata(request.agentSessionId)
      await f.client.continueInitialInput(current, run)
      const afterObserver = await f.store.readMetadata(request.agentSessionId)
      const boundState = original.preparedCreation.initialInput.delivery === 'launch' ? 'launch-carried' : 'prepared'
      check(afterObserver.initialInput.state === boundState && afterObserver.creation.initialPrompt === 'unknown', 'resolution does not rewrite old input or ACK')
      check((await f.client.kernel.status(run.runId)).acceptedInputBytes === 0, 'real observer cannot send the held old initial input')
      // A preexisting queued initial-input operation reaches its final authority after a resolve.
      let held = false
      try { await f.client.assertCreationInputCurrent({ ...current, creation: { ...current.creation, resolution: undefined } }, run) }
      catch (error) { held = error.code === 'AGENT_INITIAL_INPUT_SUPERSEDED' }
      check(held, 'queued observer final authority consumes the durable hold')
      if (stage === 'dispatch' || stage === 'legacy') await publicConsumers(f, await f.client.inspectAgentCreation(request.agentSessionId))
      await f.client.writeAgent({ agentSessionId: current.agentSessionId, expectedRun: current.run, source: 'user', data: 'independent-new-input' })
      await wait(() => f.client.kernel.status(run.runId), value => value.acceptedInputBytes > 0, 'healthy independent new input remains available')
      await wait(() => readFile(join(root, 'native-history.log'), 'utf8'), value => value.includes('independent-new-input'), 'the real private CLI receives independent input')
      const again = await f.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' })
      check(again.kind === 'agent' && again.run.runId === run.runId && starts === 0 && retires === 0, 'repeat retained resolution neither starts nor fences a retained Run')
      parseCreationInspection(resolved, { createOperationId: request.createOperationId, operationId: 'resolve-original' })
      const independentBytes = (await f.client.kernel.status(run.runId)).acceptedInputBytes
      await f.client.dispose()
      const cold = child('child-observe'); await receive(cold, 'cold-observed')
      const coldReader = await reader(undefined, false); await coldReader.client.connectRuntime()
      await new Promise(resolve => setTimeout(resolve, 150))
      check((await coldReader.client.kernel.status(run.runId)).acceptedInputBytes === independentBytes &&
        (await coldReader.store.readMetadata(request.agentSessionId)).initialInput.state === boundState, 'a new actual Core process restores the hold without resending the old first input')
      await kill(cold)
      if (stage === 'namespace') {
        await coldReader.client.connect()
        const db = new DatabaseSync(storePath)
        check(db.prepare('PRAGMA user_version').get().user_version === 2, 'the original owner acknowledged schema version 2')
        db.exec('DROP TABLE closed_creations'); db.close()
        let unavailable = false
        try { await coldReader.store.loadCreationSessionId('missing-original-cid') } catch (error) { unavailable = error.code === 'AGENT_CREATION_HISTORY_UNAVAILABLE' }
        check(unavailable && (await coldReader.store.readMetadata(request.agentSessionId)).run.runId === run.runId && await coldReader.store.agentCreationKeyRole(original.operationId, request.agentSessionId) === 'agent' &&
          await coldReader.store.agentCreationKeyRole('unknown-negative-role') === 'unknown', 'v2 missing creation history stays unknown while active identity remains available')
        const stop = { kind: 'stop', agentSessionId: request.agentSessionId, expectedRun: current.run,
          operationId: agentLifecycleOperationIdentity('stop', request.agentSessionId, 'qualified-stop'), ownerId: 'qualified-current-owner', ownerPid: process.pid,
          expiresAt: Date.now() + 30_000, reservationId: 'qualified-stop', stopOperation: await coldReader.client.kernel.prepareStop(run.runId) }
        let stopAdmitted = false
        try {
          await coldReader.store.reserveLifecycle(stop)
          stopAdmitted = (await coldReader.store.readLifecycleReservation(request.agentSessionId))?.kind === 'stop'
        } catch {}
        check(stopAdmitted && (await coldReader.client.kernel.status(run.runId)).state.type === 'running', 'missing creation history cannot block formal control admission on an existing Run')
        await coldReader.store.releaseLifecycle(stop)
        const before = (await coldReader.client.kernel.status(run.runId)).acceptedInputBytes
        await coldReader.client.writeAgent({ agentSessionId: request.agentSessionId, expectedRun: current.run, source: 'user', data: 'after-history-loss' })
        await wait(() => coldReader.client.kernel.status(run.runId), value => value.acceptedInputBytes > before, 'healthy independent input survives a missing history namespace')
        const metadata = await coldReader.store.readMetadata(request.agentSessionId)
        await coldReader.store.compareAndSwapMetadata(metadata, { ...metadata, updatedAt: metadata.updatedAt + 1 })
        const verify = new DatabaseSync(storePath)
        check(!verify.prepare("SELECT 1 FROM sqlite_schema WHERE name='closed_creations'").get(), 'ordinary active input must not reconstruct an empty acknowledged creation history')
        verify.close()
        // Controlled historical v1 fixture, never connected to a Runtime. The only upgrade is
        // the original SQLite transaction; original Session/input/namespace identities survive.
        const legacyPath = join(root, 'legacy.sqlite'), legacy = new AgentMuxFileAgentSessionStore(legacyPath)
        const baseline = structuredClone(await coldReader.store.readMetadata(request.agentSessionId)); delete baseline.creation.resolution
        await legacy.compareAndSwap(null, baseline)
        const old = new DatabaseSync(legacyPath), incarnation = old.prepare('SELECT incarnation FROM identity').get().incarnation
        old.exec('DROP TABLE closed_creations; PRAGMA user_version = 1'); old.close()
        const legacyBefore = await legacy.readMetadata(request.agentSessionId)
        await legacy.compareAndSwapMetadata(legacyBefore, { ...legacyBefore, updatedAt: legacyBefore.updatedAt + 1 })
        const upgraded = new DatabaseSync(legacyPath)
        check(upgraded.prepare('PRAGMA user_version').get().user_version === 2 && upgraded.prepare("SELECT 1 FROM sqlite_schema WHERE name='closed_creations'").get() &&
          upgraded.prepare('SELECT incarnation FROM identity').get().incarnation === incarnation, 'legitimate v1 upgrades once under the original namespace identity')
        upgraded.close()
        const after = await legacy.readMetadata(request.agentSessionId)
        assert.deepEqual({ ...after, updatedAt: legacyBefore.updatedAt }, legacyBefore)
        rows.push({ acknowledgedNamespaceLossRetainedAsUnknown: true, activeInputStillAvailable: true, noEmptyReinitialization: true })
      }
      rows.push({ actualRetainedRun: run.runId, pureInspectNoStoreWrite: true, oldInputBytes: 0, independentNewInputAvailable: true, repeatNoStart: true, finalAuthorityHeld: true, actualColdObserverHeld: true })
    } else if (stage === 'commit') {
      const result = await f.client.inspectAgentCreation({ createOperationId: request.createOperationId, agentSessionId: request.agentSessionId })
      check(result.kind === 'agent' && result.creation.createOperationId === request.createOperationId, 'post-commit process death retains the same original Session')
      rows.push({ postCommitOriginalIdentity: true })
    } else {
      const { AgentMuxRpcService } = await import('../../src/public-rpc-service.ts')
      const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
      let authorityReads = 0, revoked = false
      try { await service.call('agent.creation.resolve', { hostId: 'local', createOperationId: request.createOperationId, operationId: 'revoked-control' }, {
        principal: { kind: 'device', id: 'private-proof-device' }, assertCurrent: () => { authorityReads++; if (authorityReads > 1) throw new AgentMuxError('Device was revoked while waiting for admission', 'CONTROL_PERMISSION_DENIED') }
      }) } catch (error) { revoked = error.code === 'CONTROL_PERMISSION_DENIED' }
      check(revoked && authorityReads >= 2 && !(await f.store.loadCreationCorrelation(request.agentSessionId)).creationResolution, 'current transport authority is rechecked inside the original control admission')
      // A real second resolver dies after durable admission, immediately before its first retirement dispatch.
      await f.client.dispose()
      const resolver = child('child-resolve'); await receive(resolver, 'before-retire'); await kill(resolver)
      const next = await reader(undefined, false); await next.client.connectRuntime()
      let retireCalls = 0
      const retire = next.client.kernel.retirePreparedStart.bind(next.client.kernel)
      next.client.kernel.retirePreparedStart = async (...args) => { retireCalls++; return await retire(...args) }
      const inspected = await next.client.inspectAgentCreation({ createOperationId: request.createOperationId })
      check(inspected.kind === 'prepared-agent-creation' && inspected.resolution.outcome === 'pending' && retireCalls === 0, 'passive inspection cannot spend the original retirement authorization')
      const resolved = await next.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' })
      check(resolved.kind === 'closed-agent-creation' && resolved.resolution.outcome === 'fenced' && resolved.resolution.historicalEffect === 'unknown' && retireCalls === 1, 'same explicit control redrives the exact monotone fence after pre-send death')
      check(await next.store.loadCreationSessionId(request.createOperationId) === request.agentSessionId, 'closed no-Run original creation remains correlated')
      check(await next.store.readLifecycleReservation(request.agentSessionId) === null && (await next.store.loadMetadata()).length === 0, 'closure is retained history without a fake active Run')
      check(await next.store.agentCreationKeyRole(original.operationId, request.agentSessionId) === 'agent', 'closed original key remains an Agent-owned key')
      const closed = await next.store.loadClosedCreation(request.agentSessionId)
      check(isDeepStrictEqual(closed.preparedCreation, original.preparedCreation) && isDeepStrictEqual(closed.preparedDispatch, original.preparedDispatch), 'closure preserves the complete private original without exposing it in assertion output')
      await next.client.dispose()
      // The future fence belongs to persistent Native lineage, not this serving daemon instance.
      const oldInstance = original.preparedDispatch.runtime.instanceId
      const stopped = once(daemon, 'exit'); daemon.kill('SIGTERM'); await stopped
      daemon = spawn(process.env.AGENTMUX_CREATE_PROOF_DAEMON, ['--socket', join(root, 'r/ctxmux.sock'), '--state-dir', join(root, 's/ctxmux'), '--readiness-fd', '3'],
        { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }); resources.restartedDaemonPid = daemon.pid; journal()
      await Promise.race([once(daemon.stdio[3], 'data'), once(daemon, 'exit').then(() => { throw new Error('Private Native failed to restart') })])
      const reopened = await reader(undefined, false)
      const stable = await reopened.client.inspectAgentCreation({ createOperationId: request.createOperationId })
      check(stable.kind === 'closed-agent-creation' && stable.resolution.operationId === 'resolve-original', 'independent Store reopen preserves the same closure receipt')
      await reopened.client.connectRuntime()
      check(reopened.client.kernel.creationRuntimeIdentity().runtimeId === original.preparedDispatch.runtime.runtimeId &&
        reopened.client.kernel.creationRuntimeIdentity().instanceId !== oldInstance, 'the actual Native restart preserves lineage with a fresh serving instance')
      let lateRejected = false
      try { await reopened.client.kernel.startPrepared(decodePreparedRun(original.preparedDispatch.prepared).request, original.operationId, original.preparedDispatch.runtime) }
      catch (error) { lateRejected = error.code === 'CTXMUX_creation_retired' }
      check(lateRejected && (await reopened.client.kernel.list()).length === 0, 'a late original Start cannot cross the real Native permanent fence')
      const repeat = await reopened.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-original' })
      check(repeat.kind === 'closed-agent-creation', 'same control retry reads the original closed receipt')
      parseCreationInspectionResult({ hostId: 'local', inspection: repeat }, { hostId: 'local', createOperationId: request.createOperationId })
      parseRpcNativeResult('agent.creation.inspect', { hostId: 'local', inspection: repeat }, { hostId: 'local', createOperationId: request.createOperationId })
      const memory = new AgentMuxMemoryAgentSessionStore(), packet = structuredClone(original)
      packet.preparedCreation.creation.createdBy = { agentSessionId: 'original-creator', run: { runId: 'creator-run' }, owner: { kind: 'local' } }
      await memory.reserveLifecycle(packet)
      const inMemory = await reader(memory, false)
      const closedMemory = await inMemory.client.resolveAgentCreation({ createOperationId: request.createOperationId, operationId: 'resolve-memory' })
      check(closedMemory.kind === 'closed-agent-creation' && await memory.loadCreationSessionId(request.createOperationId) === request.agentSessionId, 'Memory and File preserve the same no-Run closure semantics')
      const page = await inMemory.client.listAgentSpawns({ participantSessionId: 'original-creator', direction: 'created' })
      check(page.records.length === 1 && page.records[0].phase === 'closed' && page.records[0].currentRun === null, 'public spawn history retains a closed no-Run child without an active Run')
      parseRpcNativeResult('agent.spawn.ls', { hostId: 'local', ...page }, { hostId: 'local', participantSessionId: 'original-creator', direction: 'created' })
      // Controlled invalid import: inventing a Run for the closed SID must be refused by both
      // Store entry points before any Runtime authority or new resource could be acquired.
      const attempted = { ...structuredClone(original.preparedCreation), run: { runId: 'unqualified-import' }, retiredRuns: [] }
      delete attempted.initialInput
      for (const [type, store] of [['file', reopened.store], ['memory', memory]]) for (const method of ['compareAndSwap', 'compareAndSwapMetadata']) {
        let denied = false
        try { await store[method](null, attempted) } catch (error) { denied = error.code === 'AGENT_CREATION_CLOSED' }
        check(denied, `${type} closed SID cannot be reactivated through ${method}`)
      }
      await publicConsumers(reopened, repeat)
      rows.push({ realPreparedOwnerDeath: true, realPreRetireOwnerDeath: true, sameControlRedrive: true, originalHistoryRetained: true, lateOriginalStartRejected: true })
    }
    console.log('AMUX_PROOF_JSON:' + JSON.stringify({ pass: true, stage, rows, public: rowsPublic, realPrivateNative: true, runtimeId: f.client.kernel.isConnected() ? f.client.kernel.creationRuntimeIdentity().runtimeId : null }))
  } finally {
    checkpoint('closing owned resources')
    for (const child of children) await kill(child)
    for (const client of clients.reverse()) {
      try { if (client.kernel.isConnected()) for (const run of await client.kernel.list()) if (run.state.type === 'running') { resources.runPids.push(run.pid); await client.kernel.stop(await client.kernel.prepareStop(run.runId)) } }
      catch (error) { resources.cleanupErrors.push(String(error)) }
      try { await client.dispose() } catch (error) { resources.cleanupErrors.push(String(error)) }
    }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) { const ended = once(daemon, 'exit'); daemon.kill('SIGTERM'); await ended }
    if (secondDaemon && secondDaemon.exitCode === null && secondDaemon.signalCode === null) { const ended = once(secondDaemon, 'exit'); secondDaemon.kill('SIGTERM'); await ended }
    await writeFile(join(root, 'cleanup.json'), JSON.stringify(resources, null, 2), { mode: 0o600 })
    check(resources.cleanupErrors.length === 0, 'all private resources settle and close')
  }
}
