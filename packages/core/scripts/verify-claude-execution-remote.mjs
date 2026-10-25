import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../dist/hosted-client.js'
import { createClaudeExecutionProofModel, CLAUDE_PROOF_PNG_BASE64 } from './fixtures/claude-execution-proof-model.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 4, 'Use --installation exact-private-installation.json --authorized-target user@host')
assert.equal(args[0], '--installation')
assert.equal(args[2], '--authorized-target')
const authorizedTarget = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9.:-]*)$/u.exec(args[3])
assert(authorizedTarget, 'An explicit SSH user@host target is required')
const installation = JSON.parse(await readFile(resolve(args[1]), 'utf8'))
assert.equal(installation.schema, 'agentmux.claude-private-installation.v1')
assert.equal(installation.authorization.role, 'user')
assert.equal(installation.authorization.target, args[3])
const remote = installation.remote, packageRoot = fileURLToPath(new URL('../', import.meta.url))
for (const path of [remote.root, remote.packageRoot, remote.nodePath, remote.claudePath, remote.command]) assert(isAbsolute(path))
assert(remote.root.startsWith('/tmp/amx-claude-'))
assert(remote.packageRoot.startsWith(remote.root + '/') && remote.command.startsWith(remote.root + '/'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const exec = promisify(execFile), sshArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'], target = installation.authorization.target
const ssh = async argv => (await exec('ssh', [...sshArgs, target, argv.map(quote).join(' ')], { maxBuffer: 20 * 1024 * 1024 })).stdout
const root = await realpath(await mkdtemp('/tmp/amx-claude-both-'))
const sourcePaths = ['src/agent-execution-frontend.ts', 'src/agent-execution-helper-run.ts', 'src/agent-execution-bridge.ts', 'src/agent-execution-executor.ts', 'src/agent-execution-coordinator.ts', 'src/agent-execution-protocol.ts', 'src/providers/claude.ts', 'src/providers/claude-tool-execution-launch.ts', 'src/providers/claude-execution-helper.ts', 'src/providers/claude-execution-run.ts', 'src/providers/claude-execution-protocol.ts', 'src/providers/claude-execution-policy.ts', 'src/providers/claude-execution-shell.ts', 'src/providers/claude-execution-operations.ts']
const fingerprint = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(packageRoot, path)))])))
const sourceHashes = await fingerprint(sourcePaths), compiledHashes = await fingerprint(sourcePaths.map(path => path.replace(/^src\//u, 'dist/').replace(/\.ts$/u, '.js')))
const harnessPaths = ['scripts/verify-claude-execution-remote.mjs', 'scripts/fixtures/claude-execution-proof-owner.mjs', 'scripts/fixtures/claude-execution-proof-model.mjs']
const harnessHashes = await fingerprint(harnessPaths)
await mkdir(join(root, 'harness'))
for (const path of harnessPaths) await writeFile(join(root, 'harness', path.split('/').at(-1)), await readFile(join(packageRoot, path)))
const nativeInstallation = JSON.parse(await ssh([remote.nodePath, '-e', `const fs=require('fs'),c=require('crypto');const x=JSON.parse(process.argv[1]);console.log(JSON.stringify({claude:c.createHash('sha256').update(fs.readFileSync(x.claudePath)).digest('hex'),compiled:Object.fromEntries(x.files.map(p=>[p,c.createHash('sha256').update(fs.readFileSync(x.packageRoot+'/'+p)).digest('hex')]))}));`, JSON.stringify({ ...remote, files: Object.keys(compiledHashes) })]))
assert.deepEqual(nativeInstallation.compiled, compiledHashes)
assert.equal(nativeInstallation.claude, '4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594')
await writeFile(join(root, 'inputs.json'), JSON.stringify({ installation, sourceHashes, compiledHashes, harnessHashes, nativeInstallation, actualMachines: 2 }, null, 2))
const wait = async (test, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error(label + ': observation deadline reached') }
const deadline = async (promise, label, ms = 60000) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) } finally { clearTimeout(timer) } }
const results = [], cleanup = [], processes = [], models = []
let primaryFailure
async function startOwner(name, config, modelPort) {
  const fixture = join(packageRoot, 'scripts/fixtures/claude-execution-proof-owner.mjs')
  const configPath = join(root, name + '-' + randomUUID() + '.json')
  let child
  if (name === 'remote') {
    const remoteFixture = join(remote.root, 'owner-' + randomUUID() + '.mjs'), remoteConfig = join(remote.root, 'owner-' + randomUUID() + '.json')
    await ssh([remote.nodePath, '-e', 'const fs=require("fs");fs.writeFileSync(process.argv[1],process.argv[2],{flag:"wx",mode:0o600});fs.writeFileSync(process.argv[3],process.argv[4],{flag:"wx",mode:0o600});', remoteFixture, await readFile(fixture, 'utf8'), remoteConfig, JSON.stringify(config)])
    child = spawn('ssh', [...sshArgs, '-o', 'ExitOnForwardFailure=yes', '-R', `${config.modelPort}:127.0.0.1:${modelPort}`, target, [remote.nodePath, remoteFixture, remoteConfig].map(quote).join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
  } else {
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); child = spawn(process.execPath, [fixture, configPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  }
  const owner = { name, child, base: config.base, lines: [], stderr: '', pending: new Map(), stopped: false }; processes.push(owner)
  child.stderr.on('data', bytes => { owner.stderr += bytes }); const reader = createInterface({ input: child.stdout })
  reader.on('line', line => { const packet = JSON.parse(line); owner.lines.push(packet); if (packet.id) { owner.pending.get(packet.id)?.(packet); owner.pending.delete(packet.id) } })
  await wait(() => owner.lines.some(line => line.socketPath) || child.exitCode !== null, 'Private ' + name + ' owner readiness')
  const receipt = owner.lines.find(line => line.socketPath); assert(receipt, owner.stderr); Object.assign(owner, receipt)
  owner.endpoint = name === 'remote' ? { transport: 'ssh', host: authorizedTarget[2], user: authorizedTarget[1], command: remote.command, socketPath: receipt.socketPath } : { transport: 'unix', path: receipt.socketPath }
  owner.rpc = await connectAgentMuxRpc({ endpoint: owner.endpoint }); owner.client = await connectHostedAgentMux({ rpc: owner.rpc }); await owner.client.connectRuntime()
  owner.hookEvents = []
  owner.releaseHookObservation = owner.client.onEvent(event => { if (event.type === 'agent-status' && event.evidence?.source === 'native-hook') owner.hookEvents.push(event) }, { observeMessages: false })
  return owner
}
async function command(owner, action) {
  const id = randomUUID(), promise = new Promise(resolve => owner.pending.set(id, resolve)); owner.child.stdin.write(JSON.stringify({ id, action }) + '\n'); const packet = await deadline(promise, action); assert(!packet.error, packet.error); return packet.result
}
async function cli(owner, argv, evidence) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', 'unix:' + owner.socketPath, ...argv], { env: { PATH: process.env.PATH, HOME: join(owner.base, 'home'), LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const [code, signal] = await deadline(once(child, 'close'), 'Public CLI reply')
  const packets = [...stdout.split('\n'), ...stderr.split('\n')].flatMap(line => { try { const p = JSON.parse(line); return typeof p.ok === 'boolean' ? [p] : [] } catch { return [] } })
  assert.equal(packets.length, 1); const receipt = { argv, code, signal, packet: packets[0], stderr }; evidence.push(receipt); return receipt
}
async function resourceRead(owner, path) {
  if (owner.name === 'local') return readFile(path, 'utf8')
  return ssh([remote.nodePath, '-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', path])
}
async function assertResourceMissing(owner, file) {
  if (owner.name === 'local') { await assert.rejects(readFile(file), { code: 'ENOENT' }); return }
  const observation = JSON.parse(await ssh([remote.nodePath, '-e', 'const fs=require("fs");try{fs.statSync(process.argv[1]);console.log(JSON.stringify({exists:true}))}catch(error){console.log(JSON.stringify({exists:false,code:error.code}))}', file]))
  assert.deepEqual(observation, { exists: false, code: 'ENOENT' }, 'The exact resource file must be absent; transport errors are not absence')
}
async function runDirection(direction) {
  const evidence = join(root, direction); await mkdir(evidence)
  const localBase = join(root, direction + '-local'), remoteBase = join(remote.root, 'run-' + randomUUID())
  const resourceWorkspace = join(direction === 'remote-agent' ? localBase : remoteBase, 'workspace')
  const model = await createClaudeExecutionProofModel({ root: evidence, workspace: resourceWorkspace, nativeTools: process.env.AGENTMUX_CLAUDE_PROOF_NATIVE_TOOLS === '1' }); models.push(model)
  const remotePort = Number((await ssh([remote.nodePath, '-e', 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'])).trim())
  assert(Number.isInteger(remotePort) && remotePort > 1024)
  const remoteOwner = await startOwner('remote', { base: remoteBase, packageRoot: remote.packageRoot, nodePath: remote.nodePath, claudePath: remote.claudePath, modelPort: remotePort }, model.port)
  const localOwner = await startOwner('local', { base: localBase, packageRoot, nodePath: process.execPath, claudePath: installation.localClaudePath, modelPort: model.port, remote: remoteOwner.endpoint })
  const agent = direction === 'remote-agent' ? remoteOwner : localOwner, resource = direction === 'remote-agent' ? localOwner : remoteOwner, coordinator = localOwner
  const writeResource = async (path, value, encoding = 'utf8') => resource.name === 'local' ? writeFile(path, value, encoding) : ssh([remote.nodePath, '-e', 'require("fs").writeFileSync(process.argv[1],process.argv[2],process.argv[3])', path, value, encoding])
  await writeResource(join(resourceWorkspace, 'fixture.png'), CLAUDE_PROOF_PNG_BASE64, 'base64')
  await writeResource(join(resourceWorkspace, 'input.txt'), 'PRIVATE_RESOURCE_INPUT\n')
  await writeResource(join(resourceWorkspace, 'fixture.ipynb'), JSON.stringify({ cells: [{ cell_type: 'code', id: 'cell-original', metadata: {}, source: ['print("original")'], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
  const configured = await agent.client.configureHostExecutor({ executorId: 'claude-native-proof', config: { label: 'Claude physical-host proof', providerId: 'claude', command: remote.claudePath && agent.name === 'remote' ? remote.claudePath : installation.localClaudePath,
    args: ['--print', '--output-format=stream-json', '--verbose', '--model=claude-sonnet-4-6', '--max-turns=16', process.env.AGENTMUX_CLAUDE_PROOF_NATIVE_TOOLS === '1' ? '--allowedTools=Read,Write,Edit,NotebookEdit,Bash,TaskStop,mcp__amux_exec__*' : '--allowedTools=mcp__amux_exec__*'], env: {}, injectAgentMuxGuide: false } })
  const bindingId = randomUUID(), agentSessionId = randomUUID(), inputPath = join(evidence, 'create.json'), bindingPath = join(evidence, 'binding.json')
  const creation = { bindingId, agentHostId: agent.name, agentRuntimeId: agent.client.runtimeOwnerIdentity().runtimeId, resourceHostId: resource.name, resourceRuntimeId: resource.client.runtimeOwnerIdentity().runtimeId, resourceWorkspacePath: resourceWorkspace,
    resourceGrant: { scope: 'host-user', bindingId }, agent: { agentSessionId, createOperationId: randomUUID(), executorId: configured.executor.executorId, executorRevision: configured.executor.configRevision, workspacePath: join(agent.base, 'workspace'), prompt: 'PRIVATE_CLAUDE_ORIGINAL_CONTEXT: perform the isolated resource tools.' } }
  await writeFile(inputPath, JSON.stringify(creation)); await writeFile(bindingPath, JSON.stringify({ bindingId }))
  const receipts = []
  try {
    let created = await cli(coordinator, ['agent', 'execution', 'create', '--input', inputPath], receipts)
    if (created.code !== 0) {
      assert.equal(created.packet.error?.code, 'EXECUTION_HELPER_UNAVAILABLE'); assert.equal(created.packet.error.controlFailure?.disposition, 'not_applied')
      await wait(async () => { const inspection = await coordinator.rpc.call('agent.execution.binding', { bindingId }); return inspection?.state === 'connected' }, 'Original helper readers ready')
      created = await cli(coordinator, ['agent', 'execution', 'create', '--input', inputPath], receipts)
    }
    assert.equal(created.code, 0, JSON.stringify(created.packet)); const first = created.packet.result.session; assert.equal(first.agentSessionId, agentSessionId)
    await wait(async () => (await resourceRead(resource, join(resourceWorkspace, 'background.txt')).catch(() => null)) === 'background-complete', 'Physical resource effects')
    assert.equal(await resourceRead(resource, join(resourceWorkspace, 'note.txt')), 'modified\n'); assert.equal(await resourceRead(resource, join(resourceWorkspace, 'effect-count.txt')), 'once\n')
    await assertResourceMissing(agent, join(agent.base, 'workspace/note.txt'))
    let original
    await wait(async () => { original = await agent.client.refreshAgentSession(agentSessionId, first.run); return original.nativeHandle?.kind === 'provider' }, 'Exact physical Agent identity')
    const nativeId = original.nativeHandle.sessionId, transcript = original.nativeHandle.transcriptPath
    const joinReply = await cli(coordinator, ['agent', 'execution', 'rejoin', '--input', bindingPath], receipts); assert.equal(joinReply.code, 0)
    const initialInspection = joinReply.packet.result
    const db = new DatabaseSync(join(coordinator.base, 'state/execution-bindings/bindings.sqlite'), { readOnly: true })
    let helpers
    try { const row = db.prepare('SELECT record FROM bindings WHERE id=?').get(bindingId); assert(row); helpers = JSON.parse(row.record).bridge } finally { db.close() }
    const helperRuns = []
    for (const side of ['frontend', 'executor']) {
      const owner = side === 'frontend' ? agent : resource
      helperRuns.push((await owner.client.readRunReplay({ runId: helpers[side].runId }, 0, 'raw')).run)
    }
    const replay = await agent.client.readRunReplay({ runId: helpers.frontend.runId }, 0, 'raw'); assert.equal(replay.gap, null)
    const text = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
    const frames = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const originalEffect = frames.filter(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.name === 'Bash' && frame.payload.params.arguments?.command === model.steps.find(step => step.id === 'toolu_remote_effect').input.command)
    assert.equal(originalEffect.length, 1)
    const operation = await cli(coordinator, ['agent', 'execution', 'inspect', '--host', resource.name, '--binding', bindingId, '--generation', originalEffect[0].generation, '--request-json', JSON.stringify(originalEffect[0].payload.id)], receipts)
    assert.equal(operation.code, 0); assert.equal(operation.packet.result.phase, 'completed'); assert.equal(operation.packet.result.nativeRequestId, originalEffect[0].payload.id)
    await writeFile(join(evidence, 'native-frames.json'), JSON.stringify(frames, null, 2), { mode: 0o600 })
    let backgroundTaskId
    await wait(async () => {
      const pending = await agent.client.readRunReplay({ runId: helpers.frontend.runId }, 0, 'raw'); assert.equal(pending.gap, null)
      const text = Buffer.concat(pending.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
      const requests = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const request = requests.find(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.arguments?.command === model.steps.find(step => step.id === 'toolu_remote_long_background').input.command)
      if (!request) return false
      const replyReplay = await resource.client.readRunReplay({ runId: helpers.executor.runId }, 0, 'raw'); assert.equal(replyReplay.gap, null)
      const responseText = Buffer.concat(replyReplay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
      const replies = responseText.slice(0, responseText.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
      const reply = replies.find(frame => frame.type === 'response' && frame.generation === request.generation && frame.payload?.id === request.payload.id)
      const value = reply?.payload?.result?.content?.find(item => item.type === 'text')?.text
      if (!value) return false
      backgroundTaskId = JSON.parse(value).backgroundTaskId
      return typeof backgroundTaskId === 'string'
    }, 'Physical resource background task receipt')
    const restart = await command(localOwner, 'restart-core'); assert.equal(restart.code, 0)
    await coordinator.client.dispose(); await coordinator.rpc.dispose(); coordinator.rpc = await connectAgentMuxRpc({ endpoint: coordinator.endpoint }); coordinator.client = await connectHostedAgentMux({ rpc: coordinator.rpc }); await coordinator.client.connectRuntime()
    coordinator.releaseHookObservation = coordinator.client.onEvent(event => { if (event.type === 'agent-status' && event.evidence?.source === 'native-hook') coordinator.hookEvents.push(event) }, { observeMessages: false })
    await wait(async () => (await coordinator.rpc.call('agent.execution.binding', { bindingId }))?.state === 'connected', 'Physical original reader restart')
    model.releaseFirstAnswer(); await wait(async () => (await agent.client.statusAgent(agentSessionId)).run.state === 'exited', 'Physical first CLI exit')
    model.stopResourceTask(backgroundTaskId)
    const resumed = await agent.client.resumeAgent({ agentSessionId, operationId: randomUUID(), prompt: 'PRIVATE_CLAUDE_RESUMED_CONTEXT: confirm original resource and conversation.' })
    assert.equal(resumed.agentSessionId, agentSessionId); assert.equal(resumed.nativeHandle?.sessionId, nativeId)
    await wait(async () => (await resourceRead(agent, transcript)).includes(model.finalNames.resumed), 'Physical native conversation resume')
    assert.equal(await resourceRead(resource, join(resourceWorkspace, 'effect-count.txt')), 'once\n')
    const afterReplay = await agent.client.readRunReplay({ runId: helpers.frontend.runId }, 0, 'raw'); assert.equal(afterReplay.gap, null)
    const afterText = Buffer.concat(afterReplay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()
    const afterFrames = afterText.slice(0, afterText.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const stops = afterFrames.filter(frame => frame.type === 'request' && frame.payload?.method === 'tools/call' && frame.payload.params?.name === 'TaskStop' && frame.payload.params.arguments?.task_id === backgroundTaskId)
    assert.equal(stops.length, 1)
    const stopReceipt = await cli(coordinator, ['agent', 'execution', 'inspect', '--host', resource.name, '--binding', bindingId, '--generation', stops[0].generation, '--request-json', JSON.stringify(stops[0].payload.id)], receipts)
    assert.equal(stopReceipt.code, 0); assert.equal(stopReceipt.packet.result.phase, 'completed')
    await writeFile(join(evidence, 'native-frames.json'), JSON.stringify(afterFrames, null, 2), { mode: 0o600 })
    const latest = await cli(coordinator, ['agent', 'execution', 'binding', '--input', bindingPath], receipts); assert.equal(latest.code, 0); assert.equal(latest.packet.result.state, 'connected')
    const afterRuns = (await Promise.all([localOwner.client.listRuns(), remoteOwner.client.listRuns()])).flat()
    for (const run of helperRuns) { const current = afterRuns.find(value => value.runId === run.runId); assert(current); assert.equal(current.pid, run.pid); assert.equal(current.state, 'running') }
    const observedHooks = agent.hookEvents.filter(event => event.agentSessionId === agentSessionId)
    for (const name of ['PreToolUse', 'PostToolUse']) assert(observedHooks.some(event => event.detail === name && typeof event.evidence.hookReceiptId === 'string'), 'Original physical Core must observe ' + name)
    await writeFile(join(evidence, 'core-observer-hooks.json'), JSON.stringify(observedHooks, null, 2), { mode: 0o600 })
    await assertResourceMissing(resource, join(resourceWorkspace, 'long-background-forbidden.txt'))
    const result = { passed: true, direction, resourceBackgroundStopped: true, backgroundStoppedAfterNativeResume: true, backgroundTaskId, coreObserverHooksConfirmed: true, actualMachines: 2, originalCoreSession: agentSessionId, nativeConversationId: nativeId, firstRun: first.run, resumedRun: resumed.run, resourceWorkspace, launchWorkspace: join(agent.base, 'workspace'), originalEffectCount: 1, originalContextRetained: true, originalHelperPidsRetained: true,
      localOwner: { base: localOwner.base, platform: localOwner.platform, node: localOwner.node }, remoteOwner: { base: remoteOwner.base, platform: remoteOwner.platform, node: remoteOwner.node }, initialInspection, finalInspection: latest.packet.result, modelRequests: model.modelRequests.length, errors: [] }
    await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); results.push(result)
  } finally {
    model.releaseFirstAnswer(); await model.close()
    await writeFile(join(evidence, 'cli-receipts.json'), JSON.stringify(receipts, null, 2))
    for (const owner of [localOwner, remoteOwner]) {
      await owner.client.dispose(); await owner.rpc.dispose()
      const closed = once(owner.child, 'close'); owner.child.stdin.write(JSON.stringify({ action: 'stop', id: randomUUID() }) + '\n'); const [code, signal] = await deadline(closed, 'Private owner cleanup')
      const receipt = owner.lines.find(value => value.stopped); assert(receipt, owner.stderr); assert.deepEqual(receipt.errors, []); assert.equal(code, 0); assert.equal(signal, null); owner.stopped = true
      cleanup.push({ name: owner.name, base: owner.base, code, signal, receipt })
    }
    await writeFile(join(evidence, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
  }
}
try {
  for (const direction of ['remote-agent', 'local-agent']) await runDirection(direction)
  assert.deepEqual(await fingerprint(sourcePaths), sourceHashes); assert.deepEqual(await fingerprint(Object.keys(compiledHashes)), compiledHashes); assert.deepEqual(await fingerprint(harnessPaths), harnessHashes)
  await writeFile(join(root, 'summary.json'), JSON.stringify({ passed: true, actualMachines: 2, bothDirectionsPassed: true, sourceHashes, compiledHashes, harnessHashes, results, cleanup, controlledOfflineModel: true, explicitTestToolGrants: { native: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'TaskStop'], transport: 'mcp__amux_exec__*', productionAutoAllowClaim: false }, errors: [] }, null, 2))
} catch (error) {
  primaryFailure = error; await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, processes: processes.map(value => ({ name: value.name, base: value.base, lines: value.lines, stderr: value.stderr })) }, null, 2))
} finally {
  for (const model of models) await model.close()
  for (const owner of processes.filter(value => !value.stopped)) {
    await owner.client?.dispose().catch(() => {}); await owner.rpc?.dispose().catch(() => {})
    if (owner.child.exitCode === null && owner.child.signalCode === null) {
      const closed = once(owner.child, 'close')
      owner.child.stdin.write(JSON.stringify({ action: 'stop', id: randomUUID() }) + '\n')
      try { await deadline(closed, 'Failed private owner graceful cleanup'); const stopped = owner.lines.find(value => value.stopped); if (stopped) cleanup.push({ name: owner.name, base: owner.base, receipt: stopped, failedCandidateCleanup: true }); owner.stopped = Boolean(stopped) }
      catch (error) { owner.child.kill('SIGTERM'); cleanup.push({ name: owner.name, base: owner.base, outcome: 'unknown', error: String(error) }) }
    }
  }
}
await writeFile(join(root, 'cleanup-final.json'), JSON.stringify({ cleanup, remainingUnknown: processes.filter(value => !value.stopped).map(value => ({ name: value.name, base: value.base })) }, null, 2))
if (primaryFailure) throw new Error('Physical Claude execution proof failed; retained evidence: ' + root, { cause: primaryFailure })
console.log(JSON.stringify({ passed: true, root, bothDirectionsPassed: true, summary: join(root, 'summary.json') }))
