import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc, observeAgent, type ContinuousProgressLoop } from '@agentmux/core'
import { ContinuousProgressLoopStore } from '../../src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../../src/continuous-progress-loop-manager.js'
import { WorkbenchUserStateStore } from '../../../desktop/src/main/workbench-user-state.js'
import { runSourceObjectCli } from '../../../../packages/core/test/helpers/source-object-cli.js'

const [root, role, phase] = process.argv.slice(2)
const store = new ContinuousProgressLoopStore(join(root!, 'loops.json')), observed = join(root!, 'observations.ndjson')
const now = 100
if (role === 'writer' && phase === 'client-started') {
  const input = { target: { hostId: 'local', agentSessionId: 'original-agent', providerId: 'private-provider', workspacePath: root! },
    intervalMs: 60_000, prompt: 'Original independent request', operationId: 'original-create-before-api' }
  const request = { kind: 'create', input, dispatch: 'started' }, document = new WorkbenchUserStateStore(join(root!, 'user-document.json'))
  const writer = {}, key = 'progress-update:' + JSON.stringify([input.target.hostId, input.target.agentSessionId, input.target.providerId, input.target.workspacePath])
  const value = (dispatch: string) => JSON.stringify({ state: {}, version: 1, desktopFragments: { launcher: JSON.stringify({ state: { drafts: { [key]: { browser: '', note: '', progressRequest: { ...request, dispatch } } } }, version: 0 }) } })
  await document.writeFromRenderer(writer, { value: value('prepared'), writeRevision: 1 }, () => true)
  await document.writeFromRenderer(writer, { value: value('started'), writeRevision: 2 }, () => true)
  await writeFile(join(root!, 'request.json'), JSON.stringify(input)); await writeFile(join(root!, 'effects.ndjson'), '')
  process.stdout.write(JSON.stringify({ pid: process.pid, role, phase, receivedReply: false, request }) + '\n', () => process.exit(0))
  await new Promise(() => {})
}
if (role === 'writer') {
  const original: ContinuousProgressLoop = { loopId: 'original-loop', hostId: 'local', agentSessionId: 'original-agent', providerId: 'private-provider',
    workspacePath: root!, intervalMs: 60_000, prompt: 'Original request stays unchanged', nextCheckAt: 60_100, status: 'active', revision: 1 }
  await store.save([original])
  const { hostId, agentSessionId, providerId, workspacePath } = original
  await writeFile(join(root!, 'request.json'), JSON.stringify({ target: { hostId, agentSessionId, providerId, workspacePath }, loopId: original.loopId,
    expectedLoop: original, action: 'check', operationId: 'original-check-operation' }))
}
const save = store.save.bind(store)
if (role === 'writer' && phase === 'prepared') store.save = async records => {
  await save(records)
  if (records[0]?.lastMutation?.action !== 'update' && records[0]?.lastMutation?.phase === 'prepared') {
    process.stdout.write(JSON.stringify({ pid: process.pid, role, phase, receivedReply: false, loop: records[0] }) + '\n', () => process.exit(0))
    await new Promise(() => {})
  }
}
const manager = new ContinuousProgressLoopManager(store, async () => { throw new Error('A working original Agent must receive no automatic input.') }, () => now, async (loop, tickId) => {
  await appendFile(observed, JSON.stringify({ pid: process.pid, agentSessionId: loop.agentSessionId, tickId }) + '\n')
  const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: now }
  return { session: { ...loop, run: { runId: 'original-run' }, semanticStatus: status }, tickId, now, inputByte: 0,
    observation: observeAgent({ process: 'running', status, timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, now) }
})
const server = new AgentMuxControlServer({ socketPath: join(root!, role + '.sock'), coreClients: () => [], progress: { call: manager.callProgress.bind(manager) } })
await server.start()
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
try {
  const request = JSON.parse(await readFile(join(root!, 'request.json'), 'utf8'))
  await manager.start()
  if (role === 'reader' && phase === 'prepared') await manager.check(1_000_000)
  if (phase === 'client-started') {
    const document = await new WorkbenchUserStateStore(join(root!, 'user-document.json')).read()
    const launcher = JSON.parse(JSON.parse(document!).desktopFragments.launcher)
    const restoredRequest = (Object.values(launcher.state.drafts)[0] as { progressRequest: unknown }).progressRequest
    const result = await rpc.call('agent.progress.list', { target: request.target, operationId: request.operationId })
    const live = await rpc.call('agent.progress.list', { target: request.target })
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'progress', 'list', '--data', '-'], process.env,
      JSON.stringify({ target: request.target, operationId: request.operationId }), 15_000, new URL('../helpers/continuous-progress-source-loader.mjs', import.meta.url))
    if (cli.code !== 0) throw new Error(cli.stderr)
    process.stdout.write(JSON.stringify({ pid: process.pid, role, phase, restoredRequest, result, live, cli: JSON.parse(cli.stdout) }) + '\n')
  } else {
  const result = await rpc.call('agent.progress.action', request)
  const cli = role === 'reader' ? await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'progress', 'list', '--data', '-'],
    process.env, JSON.stringify({ target: request.target, operationId: request.operationId }), 15_000, new URL('../helpers/continuous-progress-source-loader.mjs', import.meta.url)) : undefined
  if (cli && cli.code !== 0) throw new Error('The original public progress CLI failed: ' + cli.stderr)
  process.stdout.write(JSON.stringify({ pid: process.pid, role, phase, receivedReply: true, result, ...(cli ? { cli: JSON.parse(cli.stdout) } : {}) }) + '\n')
  }
} finally { await rpc.dispose(); await server.stop(); await manager.stop() }
