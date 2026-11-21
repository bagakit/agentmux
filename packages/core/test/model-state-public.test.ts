import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { openModelStateMainChild } from './fixtures/model-state-child.mjs'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

// These product consumers require the gate's exact compiled candidate, not the default unit environment.
const product = it.skipIf(!['native', 'integration'].includes(process.env.AMX_MODEL_SYNC_MODE ?? ''))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'amx-model-pub-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function start(path: string, options?: any) {
  const child = await openModelStateMainChild(path, options)
  cleanup.push(child.close)
  const env = objectCliEnvironment(path, { AGENTMUX_TEST_OBJECT_CLI: join(process.env.AMX_INFORMATION_CANDIDATE!, 'core/bin/amux') })
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + child.ready.endpoint, ...args], env,
      input === undefined ? '' : JSON.stringify(input), 15000)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  return { ...child, cli, env }
}
const configArgs = (control: any) => ['agent', 'configuration', 'inspect', '--host', control.hostId,
  '--session', control.agentSessionId, '--run', control.run.runId]

product('compiled configuration and cached agent CLI consume the ordered original sample with no account read', async () => {
  const f = await start(await directory()), control = f.ready.control
  const configuration = await f.cli(configArgs(control))
  expect(configuration).toMatchObject({ kind: 'configuration', target: { agentSessionId: control.agentSessionId, expectedRun: control.run } })
  await f.call('emit', { current: 'model-large', sequence: 5, observedAt: 1000 })
  const inspected = await f.cli(['agent', 'inspect', '--session', control.agentSessionId])
  expect(inspected.session).toMatchObject({ agentSessionId: control.agentSessionId, run: control.run,
    nativeConfiguration: { options: [{ currentValue: 'model-large' }], observation: { sequence: 5, observedAt: 1000, state: 'confirmed' } } })
  expect((await f.call('stats')).informationReads).toBe(0)
  expect((await f.call('stats')).runtimeWrites).toBe(0)
})

product('compiled configuration set confirms its exact original operation and replay does not dispatch twice', async () => {
  const f = await start(await directory()), control = f.ready.control, initial = await f.cli(configArgs(control))
  const input = { target: initial.target, operationId: 'public-original-model-operation', configId: 'model', value: 'model-large', expectedRevision: initial.snapshot.revision }
  const args = ['agent', 'configuration', 'set', '--input', '-']
  const applied = await f.cli(args, input)
  expect(applied).toMatchObject({ operationId: input.operationId, target: input.target, outcome: 'applied',
    acknowledgement: { options: [{ currentValue: 'model-large' }] } })
  expect(await f.cli(args, input)).toEqual(applied)
  expect((await f.call('stats')).nativeWrites).toHaveLength(1)
  expect((await f.call('stats')).runtimeWrites).toBe(0)
})

product('a replacement Core process reopens the original FileStore and Run and reattaches to the same native source', async () => {
  const path = await directory()
  const agent = fork('-e', ['process.send({ready:true});process.on("message",m=>{if(m==="close")process.exit()})'], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ended = new Promise(resolve => agent.once('exit', resolve))
  cleanup.push(async () => { if (agent.exitCode === null && agent.signalCode === null) agent.send('close'); await ended })
  await new Promise(resolve => agent.once('message', resolve))
  const observation = { revision: 'revision-model-large', options: [{ id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: 'model-large', choices: [{ value: 'model-small', name: 'model-small' }, { value: 'model-large', name: 'model-large' }] }],
    observation: { nativeSessionId: 'information-native-original', sourceId: 'same-original-machine-source', sequence: 6, observedAt: 1000, state: 'confirmed' } }
  const first = await start(path, { processId: agent.pid, initialObservation: observation })
  const original = await first.cli(['agent', 'inspect', '--session', first.ready.control.agentSessionId])
  await first.close()
  expect(agent.exitCode).toBeNull()
  const before = await new AgentMuxFileAgentSessionStore(join(path, 'sessions.json')).readMetadata(first.ready.control.agentSessionId)
  const second = await start(path, { restore: true, processId: agent.pid, initialObservation: observation })
  expect(second.child.pid).not.toBe(first.child.pid)
  const restored = await second.cli(['agent', 'inspect', '--session', second.ready.control.agentSessionId])
  expect(second.ready.control).toEqual(first.ready.control)
  expect(restored.session.nativeHandle).toEqual(original.session.nativeHandle)
  expect(restored.session.nativeConfiguration).toEqual(observation)
  expect(restored.session.run).toEqual(original.session.run)
  expect(before?.run).toEqual(original.session.run)
  expect(before?.nativeHandle).toEqual(original.session.nativeHandle)
  expect((await second.call('stats')).runtimeWrites).toBe(0)
})

product('the actual compiled agent skill explains independent configuration reads and ordered native model observations', async () => {
  const f = await start(await directory())
  const result = await runCompiledObjectCli(['--endpoint', 'unix:' + f.ready.endpoint, 'agent', '--skill'], f.env, '', 15000)
  expect(result.code, result.stderr).toBe(0)
  const guidance = result.stdout.replace(/\s+/gu, ' ')
  expect(guidance).toContain('agent configuration inspect')
  expect(guidance).toContain('agent configuration set')
  expect(guidance).toContain('without polling accounts or reloading the model directory')
  expect(result.stdout).toContain('nativeConfiguration')
  expect((await f.call('stats')).runtimeWrites).toBe(0)
})
