import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, vi } from 'vitest'
import * as core from '../../dist/index.js'
import { createWorkspaceLayout } from '../../dist/spatial-layout.js'
import type { AgentMuxSpatialGraph } from '../../src/spatial-state.js'
import { headlessFixture, until } from './headless-runtime-fixture.js'
import { runCompiledObjectCli } from './object-cli-rpc.js'

const exec = promisify(execFile)
export async function processWitness(pid: number) {
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,stat=,command='])
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/u)
  if (!match) throw new Error('Owned process identity is unavailable: ' + stdout)
  return { pid: Number(match[1]), parent: Number(match[2]), birth: match[3]!, state: match[4]!, command: match[5]! }
}
export async function signalOwned(original: Awaited<ReturnType<typeof processWitness>>, signal: NodeJS.Signals) {
  const current = await processWitness(original.pid)
  expect({ ...current, state: original.state }, 'signal must still address the exact fixture PID/birth/owner').toEqual(original)
  process.kill(original.pid, signal)
}
export const operationRows = async (state: string) => (await readFile(join(state, 'fault-native-operations.ndjson'), 'utf8'))
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

/** One qualified Native and the existing default FileStore; no substitute Store or Runtime. */
export async function extremeFixture(options: { ownerNodeArgs?: string[] } = {}) {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, '../fixtures/extreme-event-owner.mjs'))
  const scope = await headlessFixture(options)
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  for (const [key, value] of Object.entries(scope.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, value)
  const state = scope.env.AGENTMUX_STATE_DIRECTORY!, cleanups: Array<() => Promise<void>> = []
  const cleanup = async () => {
    const errors: unknown[] = []
    // A failed assertion may leave either exact child stopped. Release it before
    // invoking cleanup, without asking the stopped or dead semantic owner to act.
    for (const witness of owned) try {
      try { const current = await processWitness(witness.pid)
        if (current.birth === witness.birth && current.command === witness.command && current.state.includes('T')) await signalOwned(current, 'SIGCONT')
      } catch (error: any) { if (error.code !== 1) throw error }
    } catch (error) { errors.push(error) }
    for (const close of cleanups.reverse()) try { await close() } catch (error) { errors.push(error) }
    try { await scope.cleanup() } catch (error) { errors.push(error) }
    for (const witness of owned) {
      const remaining = await processWitness(witness.pid).catch(() => null)
      expect(remaining !== null && remaining.birth === witness.birth && remaining.command === witness.command, 'all exact owned processes must be released').toBe(false)
    }
    console.info('EXTREME_CLEANUP=' + JSON.stringify({ pids: owned.map(value => value.pid), released: true }))
    if (errors.length) throw new AggregateError(errors, 'Extreme-event fixture cleanup failed')
  }
  const owned: Array<Awaited<ReturnType<typeof processWitness>>> = []
  try {
    owned.push(await processWitness(scope.ownerProcess.pid!), await processWitness(scope.nativeProcessId!))
    const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanups.push(() => rpc.dispose())
    const sdk = await scope.client(rpc)
    const output = join(scope.root, 'stdout-marker'), program = join(scope.root, 'output-cli.mjs')
    await writeFile(output, 'original-durable-output')
    await writeFile(program, `#!/usr/bin/env node
      import {readFileSync} from 'node:fs'
      let last='';setInterval(()=>{const text=readFileSync(${JSON.stringify(output)},'utf8');if(text!==last){last=text;console.log(text)}},10)
      await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../fixtures/fake-codex-cli.mjs')).href)})
    `, { mode: 0o700 })
    await writeFile(join(state, 'not-dispatched-reply'), 'one original optional reply is not dispatched')
    let original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'extreme-original-session',
      createOperationId: 'extreme-original-create', workspacePath: scope.root, commandOverride: program, args: [], injectAgentMuxGuide: false,
      env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_PRESERVE: '1',
        AGENTMUX_FAKE_NATIVE_CONTEXT: 'Original retained conversation and decision.', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(scope.root, 'native') } })
    const native = sdk.runtimeIdentity()
    const authority = { ownerInstanceId: native.instanceId, operationId: 'extreme-authorized-protocol', expectedByte: 0, data: '\x1b[?0u' }
    const originalAck = await sdk.writeTerminal(original.run, authority)
    original = await until(() => sdk.readAgentSession(original.agentSessionId), value => Boolean(value?.nativeHandle), 'original native context') as core.AgentMuxAgentSession
    const before = await sdk.statusAgent(original.agentSessionId)
    const inputCursor = before.run.acceptedInputBytes
    if (inputCursor === null) throw new Error('Original Native input cursor is unconfirmed before fault admission.')
    expect(inputCursor).toBe(originalAck.acceptedThroughByte)
    owned.push(await processWitness(before.run.pid!))
    const store = new core.AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
    const metadata = (await until(() => store.readMetadata(original.agentSessionId).catch(error => {
      // Before injecting any fault, wait for an actual concurrent Hook write to
      // release SQLite. Every other Store error fails this fixture unchanged.
      if (error.code === 'AGENT_SESSION_STORE_UNAVAILABLE' && JSON.parse(error.detail ?? '{}').cause?.errcode === 5) return null
      throw error
    }), value => Boolean(value?.nativeHandle), 'original durable native metadata checkpoint'))!
    expect(metadata.terminalHandshake?.acknowledged).toBe(false)
    const nativePath = join(scope.root, 'native', `rollout-${original.agentSessionId}.jsonl`)
    const nativeRecords = (await readFile(nativePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    const bodies = nativeRecords.filter(row => row.type === 'response_item')
    expect(bodies.map(row => row.payload.role)).toEqual(['user', 'assistant'])
    const graph: AgentMuxSpatialGraph = { spaces: [{ spaceId: 'original-space', kind: 'topic', name: 'Original', hostId: 'local', directoryPath: scope.root, projectId: 'original-project' }],
      zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: scope.root, branch: null }],
      tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region'] }],
      regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: original.agentSessionId,
        runId: original.run.runId, execution: { hostId: 'local', cwd: scope.root } }],
      bindings: [{ zoneId: 'original-zone', spaceId: 'original-space' }],
      layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
      tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } },
      resources: { 'original-tab': { draft: 'Unsent original draft; not an acknowledged input.' } } }
    const spatial = await rpc.call('space.commit', { expectedRevision: 0, graph })
    const observer = new core.AgentMuxClient({ store }); cleanups.push(() => observer.dispose()); await observer.connectRuntime()
    expect(observer.runtimeIdentity(), 'independent observer must address this exact owned Native').toEqual(native)
    const runs = await observer.listRuns()
    await until(() => observer.readRunReplay(original.run), value => value.replay.map(chunk => chunk.data).join('').includes('original-durable-output'), 'first original bytes')
    console.info('EXTREME_CHECKPOINT=' + JSON.stringify({ owned, original, originalAck, inputCursor: before.run.acceptedInputBytes,
      native, nativeBodies: bodies, workface: spatial }))
    return { scope, sdk, rpc, original, before, inputCursor, native, originalAck, metadata, store, spatial, nativePath, bodies, observer, runs,
      state, owned, cleanup, cleanups, output,
      async assertOriginal(reader = sdk, readerRpc = rpc) {
        const current = await reader.statusAgent(original.agentSessionId)
        expect(current.run, 'fault cannot replace or terminate the original healthy Run').toMatchObject({ runId: original.run.runId,
          pid: before.run.pid, state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
        expect(current.session.nativeHandle).toEqual(original.nativeHandle)
        expect((await store.readMetadata(original.agentSessionId))!.terminalHandshake).toEqual(metadata.terminalHandshake)
        expect((await readerRpc.call('space.state', {})).state).toEqual(spatial.state)
        const records = (await readFile(nativePath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        expect(records.filter(row => row.type === 'response_item')).toEqual(bodies)
        const afterRuns = await observer.listRuns()
        expect(afterRuns.map(value => value.runId).sort(), 'authoritative Native catalog cannot gain a replacement Start').toEqual(runs.map(value => value.runId).sort())
        expect(await reader.readRunReplay(original.run)).toMatchObject({ run: original.run })
        const cli = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect', '--session', original.agentSessionId], scope.env)
        expect(cli.code, cli.stderr).toBe(0)
        expect(JSON.parse(cli.stdout).result.status.run).toMatchObject({ runId: original.run.runId, pid: before.run.pid })
        return current
      } }
  } catch (error) { await cleanup(); throw error }
}
