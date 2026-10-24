import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const [mode, root] = process.argv.slice(2)
assert.ok(root?.startsWith('/private/tmp/amxtr-native-'))
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_')) delete process.env[key]
process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = join(root, 'state')
process.env.AGENTMUX_AGENT_SESSION_STORE = join(root, 'sessions.sqlite')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.sqlite')
process.env.SHELL = mode === 'reenter-cli' ? '/bin/false' : '/bin/cat'
const { AgentMuxClient } = await import('../../../../../packages/core/src/client.ts')
const { AgentMuxFileAgentSessionStore } = await import('../../../../../packages/core/src/agent-session-store.ts')
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE) })
let server
try {
  await client.connect()
  if (mode === 'start-lost') {
    const old = await client.createTerminal({ workspacePath: root, command: '/bin/cat', createOperationId: 'private-old-creation' })
    await writeFile(join(root, 'owned-runs.json'), JSON.stringify([old.runId]))
    await client.stopTerminal({ runId: old.runId })
    const request = { expectedRun: { runId: old.runId }, runtimeId: client.terminalCreationRuntimeIdentity().runtimeId, workspacePath: root, operationId: 'canonical-private-recovery' }
    const create = client.createPreparedTerminal.bind(client)
    client.createPreparedTerminal = async prepared => {
      const run = await create(prepared)
      await writeFile(join(root, 'owned-runs.json'), JSON.stringify([old.runId, run.runId]))
      await writeFile(join(root, 'native-replacement.json'), JSON.stringify(run))
      throw Error('Private lost Native Start reply')
    }
    const result = await client.recoverTerminal(request)
    assert.equal(result.kind, 'pending'); assert.equal(result.phase, 'dispatched')
    await writeFile(join(root, 'request.json'), JSON.stringify(request))
    process.stdout.write(JSON.stringify({ mode, pid: process.pid, result }) + '\n')
  } else if (mode === 'reenter-cli') {
    const request = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'))
    const replacement = JSON.parse(await readFile(join(root, 'native-replacement.json'), 'utf8'))
    const result = await client.recoverTerminal({ ...request, operationId: 'fresh-process-remount' })
    assert.equal(result.kind, 'recovered'); assert.equal(result.operationId, request.operationId)
    assert.equal(result.run.runId, replacement.runId); assert.equal(result.run.pid, replacement.pid)
    assert.equal((await client.listRuns()).length, 2)
    const { AgentMuxControlServer } = await import('../../../../../packages/core/src/public-rpc-server.ts')
    server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }] })
    await server.start()
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--import', join(import.meta.dirname, 'source-loader.mjs'),
      join(import.meta.dirname, '../../../../../packages/core/src/agentmux.ts'), '--endpoint', 'unix://' + join(root, 'rpc.sock'), 'terminal', 'recover', '--host-id', 'local', '--runtime-id', request.runtimeId,
      '--run', request.expectedRun.runId, '--workspace-path', root, '--operation-id', 'public-cli-remount'], { env: process.env, timeout: 20000, maxBuffer: 262144 })
    const reply = JSON.parse(stdout)
    assert.equal(reply.ok, true); assert.equal(reply.result.run.runId, replacement.runId); assert.equal(reply.result.operationId, request.operationId)
    assert.equal((await client.listRuns()).length, 2)
    const reentryShell = process.env.SHELL
    process.env.SHELL = '/bin/cat'
    const another = await client.createTerminal({ workspacePath: root, command: '/bin/cat', createOperationId: 'private-unapplied-original' })
    await client.stopTerminal({ runId: another.runId })
    const creation = client.createPreparedTerminal.bind(client)
    client.createPreparedTerminal = async () => { throw Error('Private crash boundary before Native Start') }
    const pendingInput = { ...request, expectedRun: { runId: another.runId }, operationId: 'private-unknown-before-start' }
    const unknown = await client.recoverTerminal(pendingInput)
    assert.equal(unknown.kind, 'pending'); assert.equal(unknown.phase, 'dispatched')
    const inspect = await client.recoverTerminal({ ...pendingInput, operationId: 'new-remount-before-start' })
    assert.equal(inspect.kind, 'pending'); assert.equal(inspect.phase, 'dispatched')
    assert.equal((await client.listRuns()).length, 3, 'NOT_RETAINED does not permit automatic Start')
    client.createPreparedTerminal = creation
    const continuation = { ...pendingInput, operationId: 'explicit-private-continuation', action: 'continue' }
    const continued = await client.recoverTerminal(continuation)
    assert.equal(continued.kind, 'recovered'); assert.equal(continued.operationId, pendingInput.operationId)
    const repeated = await client.recoverTerminal(continuation)
    assert.equal(repeated.kind, 'recovered'); assert.equal(repeated.run.runId, continued.run.runId)
    const owned = await client.listRuns()
    await writeFile(join(root, 'owned-runs.json'), JSON.stringify(owned.map(run => run.runId)))
    assert.equal(owned.length, 4)
    const { readdir } = await import('node:fs/promises')
    const intentFiles = await readdir(join(root, 'terminal-recoveries'))
    let intent
    for (const file of intentFiles.filter(file => file.endsWith('.json'))) {
      const candidate = JSON.parse(await readFile(join(root, 'terminal-recoveries', file), 'utf8'))
      if (candidate.expectedRun.runId === another.runId) intent = candidate
    }
    assert.equal(intent.retiredAttempts.length, 1)
    const originalFence = await client.observePreparedTerminalCreationRetirement(intent.retiredAttempts[0].prepared, intent.retiredAttempts[0].runtime)
    assert.equal(originalFence.outcome, 'retired'); assert.equal(originalFence.runtime.runtimeId, request.runtimeId)
    const authority = { unknown, inspect, continued, repeated, originalFence, runCount: owned.length }
    await writeFile(join(root, 'completed.json'), JSON.stringify({ mode, pid: process.pid, result, cli: reply, replacement, authority, reentryShell,
      runtime: await client.runtimeDiagnostics(), privateOnly: true }))
    process.stdout.write(JSON.stringify({ mode, pid: process.pid, result, cli: reply }) + '\n')
  } else if (mode === 'cleanup') {
    const owned = JSON.parse(await readFile(join(root, 'owned-runs.json'), 'utf8'))
    for (const run of await client.listRuns()) if (owned.includes(run.runId) && run.state === 'running') await client.stopTerminal({ runId: run.runId })
  } else throw Error('Unknown private worker mode')
} finally { await server?.stop(); await client.dispose() }
