import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunInfo, RunSpec } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxPreparedTerminal } from '../src/terminal-preparation.js'
import { fixturePath } from './helpers/fixture-values.js'

const clients: AgentMuxClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function request(): RunSpec & { cwd: string } {
  return {
    program: process.execPath,
    args: ['capsule-runtime-entry', 'serve'],
    cwd: fixturePath('capsule-service'),
    env: { AGENTMUX_LIFECYCLE_OPERATION_ID: 'original-create', CAPSULE_VALUE: 'frozen' },
    initial_size: { cols: 92, rows: 31 },
    declared_inputs: [],
  }
}
function prepared(spec = request()): AgentMuxPreparedTerminal {
  return {
    createOperationId: 'original-create',
    workspacePath: spec.cwd,
    launch: JSON.stringify({ createOperationId: 'original-create', request: spec }),
  }
}
function info(id: string, spec: RunSpec = request()): RunInfo {
  return {
    id,
    spec: structuredClone(spec),
    lineage: null,
    backend: { type: 'native' },
    capabilities: {
      input: true,
      resize: true,
      signal: true,
      stop: true,
      fork_level_a: false,
      fork_level_b: false,
      replay: 'raw_from_start',
    },
    pid: 4321,
    state: { type: 'running' },
    latest_output_bytes: 0,
    durable_output_bytes: 0,
    first_available_byte: 0,
    attachments: 0,
    applied_input_bytes: 0,
    current_size: { cols: 92, rows: 31 },
    native_service: null,
  }
}
/** Only the Native SDK boundary is controlled; Client and adapter remain production code. */
async function fixture(stored?: AgentMuxStoredAgentSession, prepareExecutionEnvironment?: () => Promise<void>) {
  const store = new AgentMuxMemoryAgentSessionStore()
  if (stored) await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store, ...(prepareExecutionEnvironment ? { prepareExecutionEnvironment } : {}) })
  clients.push(client)
  const inner = client as unknown as {
    connected: boolean
    kernel: CtxmuxRunAdapter
    registry: AgentMuxAgentSessionRegistry
    stopRequestedRuns: Set<string>
  }
  await inner.registry.load('local')
  inner.connected = true
  const runs = new Map<string, RunInfo>()
  const close = vi.fn()
  const sdk = {
    list: vi.fn(async () => { throw new Error('Unrelated inventory must not be consulted.') }),
    observeCreation: vi.fn(async (operationKey: string) => ({ observation: runs.has('original-run')
      ? { outcome: 'retained', operation_key: operationKey, run: structuredClone(runs.get('original-run')!) }
      : { outcome: 'not_retained', operation_key: operationKey } })),
    status: vi.fn(async (id: string): Promise<RunInfo> => {
      const found = runs.get(id)
      if (!found) throw new AgentMuxError('The exact native Run is absent.', 'CTXMUX_run_not_found')
      return structuredClone(found)
    }),
    start: vi.fn(async (spec: RunSpec, _operationKey: string) => {
      const run = info('original-run', spec)
      runs.set(run.id, run)
      return structuredClone(run)
    }),
    attachRecoverableStop: vi.fn(async (_operation: unknown, _afterByte: number) => ({
      attachment: { close },
    })),
  }
  const native = inner.kernel as unknown as {
    client: unknown
    runtime: { daemonInstanceId: string }
  }
  native.client = sdk
  native.runtime = { daemonInstanceId: 'original-native-owner' }
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => events.push(event))
  return { client, inner, adapter: inner.kernel, sdk, runs, native, close, events }
}

describe('Capsule terminal preparation consumes the original Native seams', () => {
  it('captures the complete launch once and starts exactly those bytes after the Host environment changes', async () => {
    // Keep a frozen launch assertion from printing unrelated inherited Host secrets.
    for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined)
    vi.stubEnv('CAPSULE_CAPTURE_MARKER', 'original-environment')
    const f = await fixture()
    const args = ['original-entry', 'serve']
    const env = { CAPSULE_VALUE: 'original-value' }
    const captured = await f.client.prepareTerminal({
      command: process.execPath,
      args,
      env,
      workspacePath: fixturePath('capsule-service'),
      cols: 92,
      rows: 31,
      createOperationId: 'original-create',
    })
    const frozen = JSON.parse(captured.launch) as { request: RunSpec }
    args.push('later-argument')
    env.CAPSULE_VALUE = 'later-value'
    vi.stubEnv('CAPSULE_CAPTURE_MARKER', 'later-environment')
    const started = await f.client.createPreparedTerminal(captured)
    expect(started).toMatchObject({ runId: 'original-run', kind: 'terminal', pid: 4321 })
    expect(f.sdk.start).toHaveBeenCalledTimes(1)
    expect(f.sdk.start.mock.calls[0]?.[0]).toEqual(frozen.request)
    expect(f.sdk.start.mock.calls[0]?.[1]).toBe('original-create')
    expect(frozen.request.env.CAPSULE_CAPTURE_MARKER).toBe('original-environment')
    expect(frozen.request.env.CAPSULE_VALUE).toBe('original-value')
    expect(frozen.request.initial_size).toEqual({ cols: 92, rows: 31 })
    expect(f.sdk.list).not.toHaveBeenCalled()
  })

  it('observes only the original creation key and requires its complete frozen RunSpec', async () => {
    const f = await fixture(),
      launch = prepared()
    expect(await f.client.inspectPreparedTerminal(launch)).toBeNull()
    f.runs.set('original-run', info('original-run'))
    expect(await f.client.inspectPreparedTerminal(launch)).toMatchObject({ runId: 'original-run' })
    const changed = request()
    changed.env.CAPSULE_VALUE = 'different-hidden-environment'
    f.runs.set('original-run', info('original-run', changed))
    await expect(f.client.inspectPreparedTerminal(launch)).rejects.toMatchObject({
      code: 'TERMINAL_CREATION_UNCONFIRMED',
    })
    f.runs.set('original-run', info('original-run'))
    for (let index = 0; index < 1514; index += 1) f.runs.set('unrelated-' + index, info('unrelated-' + index))
    f.sdk.status.mockRejectedValue(new Error('Unrelated status must not affect the original creation.'))
    expect(await f.client.inspectPreparedTerminal(launch)).toMatchObject({ runId: 'original-run' })
    expect(f.sdk.observeCreation.mock.calls).toEqual(Array.from({ length: 4 }, () => ['original-create']))
    expect(f.sdk.list).not.toHaveBeenCalled()
    expect(f.sdk.status).not.toHaveBeenCalled()
    expect(f.sdk.start).not.toHaveBeenCalled()
    expect(f.sdk.attachRecoverableStop).not.toHaveBeenCalled()
  })

  it('reads only the exact bound Run and rejects matching program arguments with another full specification', async () => {
    const f = await fixture(),
      launch = prepared()
    f.runs.set('original-run', info('original-run'))
    f.sdk.list.mockRejectedValue(new Error('Unrelated inventory must not be consulted.'))
    const observed = await f.client.inspectPreparedTerminal(launch, { runId: 'original-run' }).then(
      (run) => ({ status: 'observed', runId: run?.runId }),
      (error: AgentMuxError) => ({ status: 'failed', code: error.code }),
    )
    expect(observed).toEqual({ status: 'observed', runId: 'original-run' })
    const changed = request()
    changed.initial_size = { cols: 120, rows: 40 }
    f.runs.set('original-run', info('original-run', changed))
    expect(
      await f.client.inspectPreparedTerminal(launch, { runId: 'original-run' }).then(
        () => null,
        (error: AgentMuxError) => error.code,
      ),
    ).toBe('TERMINAL_PREPARATION_RUN_MISMATCH')
    changed.initial_size = request().initial_size
    changed.env.AGENTMUX_LIFECYCLE_OPERATION_ID = 'foreign-create'
    f.runs.set('original-run', info('original-run', changed))
    expect(
      await f.client.inspectPreparedTerminal(launch, { runId: 'original-run' }).then(
        () => null,
        (error: AgentMuxError) => error.code,
      ),
    ).toBe('TERMINAL_PREPARATION_RUN_MISMATCH')
    expect(f.sdk.status.mock.calls).toEqual([['original-run'], ['original-run'], ['original-run']])
    expect(f.sdk.list).not.toHaveBeenCalled()
    expect(f.sdk.start).not.toHaveBeenCalled()
  })

  it('keeps exact native absence separate from failed observation and rejects an unfenced creation marker', async () => {
    const f = await fixture(),
      launch = prepared()
    expect(await f.client.inspectPreparedTerminal(launch, { runId: 'missing-run' })).toBeNull()
    f.sdk.status.mockRejectedValueOnce(
      new AgentMuxError('Original Native observation unavailable.', 'CTXMUX_UNAVAILABLE'),
    )
    await expect(
      f.client.inspectPreparedTerminal(launch, { runId: 'missing-run' }),
    ).rejects.toMatchObject({ code: 'CTXMUX_UNAVAILABLE' })
    const changed = request()
    changed.env.AGENTMUX_LIFECYCLE_OPERATION_ID = 'foreign-create'
    await expect(
      f.client.inspectPreparedTerminal(prepared(changed), { runId: 'missing-run' }),
    ).rejects.toMatchObject({ code: 'INVALID_TERMINAL_PREPARATION' })
    expect(f.sdk.status).toHaveBeenCalledTimes(2)
    expect(f.sdk.list).not.toHaveBeenCalled()
    expect(f.sdk.start).not.toHaveBeenCalled()
  })

  it('rejects a changed original creation marker before Start rather than launching an unrecoverable Run', async () => {
    const f = await fixture(),
      changed = request()
    changed.env.AGENTMUX_LIFECYCLE_OPERATION_ID = 'foreign-create'
    await expect(f.client.createPreparedTerminal(prepared(changed))).rejects.toMatchObject({
      code: 'INVALID_TERMINAL_PREPARATION',
    })
    expect(f.sdk.start).not.toHaveBeenCalled()
    expect(f.sdk.status).not.toHaveBeenCalled()
    expect(f.sdk.list).not.toHaveBeenCalled()
  })

  it('rejects a Native Status response for a different Run even when the frozen launch matches', async () => {
    const f = await fixture()
    f.sdk.status.mockResolvedValueOnce(info('foreign-run'))
    await expect(
      f.client.inspectPreparedTerminal(prepared(), { runId: 'original-run' }),
    ).rejects.toMatchObject({ code: 'TERMINAL_PREPARATION_RUN_MISMATCH' })
    expect(f.sdk.status.mock.calls).toEqual([['original-run']])
    expect(f.sdk.list).not.toHaveBeenCalled()
    expect(f.sdk.start).not.toHaveBeenCalled()
    expect(f.sdk.attachRecoverableStop).not.toHaveBeenCalled()
  })

  it('refuses to relabel a current Agent Session Run as a prepared raw Terminal', async () => {
    const stored: AgentMuxStoredAgentSession = {
      kind: 'agent',
      agentSessionId: 'original-agent',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: request().cwd,
      run: { runId: 'original-run' },
      retiredRuns: [],
      hookBindingId: 'original-binding',
      hookToken: 'original-token',
      createdAt: 1,
      updatedAt: 1,
    }
    const f = await fixture(stored)
    f.runs.set('original-run', info('original-run'))
    await expect(f.client.inspectPreparedTerminal(prepared(), stored.run)).rejects.toMatchObject({
      code: 'RUN_KIND_MISMATCH',
    })
    expect(f.sdk.start).not.toHaveBeenCalled()
    expect(f.sdk.attachRecoverableStop).not.toHaveBeenCalled()
  })

  it('prepares Stop without effects and submits the original owner operation and exact Run unchanged', async () => {
    const f = await fixture()
    const token = await f.client.prepareTerminalStop({ runId: 'original-run' })
    expect(token).toMatchObject({
      run: { runId: 'original-run' },
      ownerInstanceId: 'original-native-owner',
    })
    expect(token.operationId).toEqual(expect.any(String))
    expect(f.sdk.attachRecoverableStop).not.toHaveBeenCalled()
    f.native.runtime = { daemonInstanceId: 'replacement-native-owner' }
    await f.client.stopPreparedTerminal(structuredClone(token))
    expect(f.sdk.attachRecoverableStop.mock.calls).toEqual([
      [
        {
          runId: 'original-run',
          daemonInstance: 'original-native-owner',
          operationKey: token.operationId,
        },
        0,
      ],
    ])
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.events.filter((event) => event.type === 'run-removed')).toMatchObject([
      { run: { runId: 'original-run' } },
    ])
    expect(f.sdk.start).not.toHaveBeenCalled()
  })

  it('retains an unknown original Stop without a replacement key, retry, or false removal event', async () => {
    const f = await fixture()
    const token = await f.client.prepareTerminalStop({ runId: 'original-run' })
    const failure = new AgentMuxError(
      'The original Stop ACK was lost.',
      'CTXMUX_UNAVAILABLE',
      undefined,
      { disposition: 'unknown', confirmedInputBytes: null },
    )
    f.sdk.attachRecoverableStop.mockRejectedValueOnce(failure)
    await expect(f.client.stopPreparedTerminal(token)).rejects.toBe(failure)
    expect(f.sdk.attachRecoverableStop.mock.calls).toEqual([
      [
        {
          runId: token.run.runId,
          daemonInstance: token.ownerInstanceId,
          operationKey: token.operationId,
        },
        0,
      ],
    ])
    expect(f.inner.stopRequestedRuns.has(token.run.runId)).toBe(false)
    expect(f.events.some((event) => event.type === 'run-removed')).toBe(false)
    expect(f.close).not.toHaveBeenCalled()
    expect(f.sdk.start).not.toHaveBeenCalled()
  })

  it('rejects malformed original launch and Stop envelopes before any Native effect', async () => {
    const f = await fixture()
    await expect(
      f.client.createPreparedTerminal({ ...prepared(), workspacePath: fixturePath('other-cwd') }),
    ).rejects.toMatchObject({ code: 'INVALID_TERMINAL_PREPARATION' })
    await expect(
      f.client.createPreparedTerminal({ ...prepared(), launch: '{invalid' }),
    ).rejects.toMatchObject({ code: 'INVALID_TERMINAL_PREPARATION' })
    const token = await f.client.prepareTerminalStop({ runId: 'original-run' })
    for (const malformed of [
      { ...token, operationId: '' },
      { ...token, run: { runId: 'wrong\0run' } },
      { ...token, authorHuman: true },
    ])
      await expect(f.client.stopPreparedTerminal(malformed)).rejects.toMatchObject({
        code: 'INVALID_TERMINAL_PREPARATION',
      })
    expect(f.sdk.start).not.toHaveBeenCalled()
    expect(f.sdk.attachRecoverableStop).not.toHaveBeenCalled()
  })
})

it('waits only for new execution capture while original prepared creation remains readable', async () => {
  let ready = Promise.resolve(), release!: () => void
  const f = await fixture(undefined, () => ready)
  const original = await f.client.prepareTerminal({ command: '/bin/sh', workspacePath: fixturePath('original'), createOperationId: 'original' })
  const run = await f.client.createPreparedTerminal(original)
  ready = new Promise<void>(resolve => { release = resolve })
  const args = ['original-argument'], input = { command: '/bin/sh', workspacePath: fixturePath('new'), args, createOperationId: 'new-original-operation' }
  let completed = false
  const pending = f.client.prepareTerminal(input).then(value => { completed = true; return value })
  args.push('later-mutation')
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(await f.client.inspectPreparedTerminal(original, { runId: run.runId })).toMatchObject({ runId: run.runId })
  expect(f.sdk.start).toHaveBeenCalledTimes(1)
  vi.stubEnv('PREPARATION_EXPORT', 'complete-export')
  release()
  const captured = await pending, request = JSON.parse(captured.launch).request
  expect(captured.createOperationId).toBe('new-original-operation')
  expect(request.args).toContain('original-argument')
  expect(request.args).not.toContain('later-mutation')
  expect(request.env.PREPARATION_EXPORT).toBe('complete-export')
})
