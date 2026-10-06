import { describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { join } from 'node:path'
import type { ToolkitScriptSnapshot } from '@agentmux/core/control'
import { nativeMain, oneCli, record, until } from './toolkit-main.fixture.js'

describe('rejected Toolkit Stop through actual Core and Native', () => {
  it.each(['explicit', 'output-budget'] as const)('%s Stop restores the original detached observer and consumes later Native exit', async mode => {
    const m = await nativeMain(), id = 'rejected-' + mode
    const prefix = mode === 'explicit' ? JSON.stringify('original_before_ACK') : "'\\u0001'.repeat(10000)"
    // The test controls an input gate, never a terminal fact or time-based exit.
    const script = `process.stdout.write(${prefix}); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause(); await new Promise(resolve => process.stdout.write('original_after_ACK', resolve)); process.exit(0)`
    await m.rpc.call('toolkit.create', { toolId: id, value: { name: id, icon: 'terminal', enabled: true,
      statusBar: 'icon', workspacePath: join(m.directory, 'work'), script, args: [], actions: [] } })
    const kernel = (m.core as unknown as { kernel: { hasAttachment(id: string): boolean; client: typeof m.sdk } }).kernel
    const refusal = new AgentMuxError('Controlled original Stop transport refusal.', 'CTXMUX_permission_denied')
    const rejected: unknown[] = [], replays: unknown[] = []
    const read = m.core.readRunReplay.bind(m.core)
    const replay = vi.spyOn(m.core, 'readRunReplay').mockImplementation(async (...args) => {
      const result = await read(...args)
      replays.push({ ref: args[0], run: result.run, gap: result.gap, ranges: result.replay.map(c => [c.startByte, c.endByte]) })
      return result
    })
    // This is the real SDK submission after the real adapter has detached.
    const stop = vi.spyOn(kernel.client, 'attachRecoverableStop').mockImplementation(async operation => {
      const fact = { operation, detached: !kernel.hasAttachment(operation.runId), native: await m.sdk.status(operation.runId) }
      rejected.push(fact)
      expect(fact.detached).toBe(true)
      expect(fact.native.state.type).toBe('running')
      throw refusal
    })
    const started = (await oneCli('toolkit', 'run', id)).result.snapshot as ToolkitScriptSnapshot
    const captured = started.admission!
    expect(captured.run?.runId).toBeTruthy()
    const runId = captured.run!.runId
    if (mode === 'explicit') {
      expect(kernel.hasAttachment(runId)).toBe(true)
      await expect(m.invoke('toolkit:stop', id, captured.executionId)).rejects.toBe(refusal)
    }
    await until(() => expect(rejected).toHaveLength(1))
    await until(() => expect(replays.length).toBeGreaterThan(0))
    const pending = (await m.rpc.call('toolkit.inspect', { toolId: id })).snapshot as ToolkitScriptSnapshot
    const restored = kernel.hasAttachment(runId)
    expect(pending).toMatchObject({ state: 'unknown', admission: { executionId: captured.executionId, run: captured.run,
      definition: captured.definition, invocationId: captured.invocationId, target: captured.target }, latestConfirmed: null })
    stop.mockRestore()
    // A separate SDK reader proves the original Native exit/output even when
    // old Source has no Core observer. It cannot heal the Core attachment.
    const observer = await m.sdk.attach(runId as any, 0)
    const events: unknown[] = []
    const terminal = (async () => {
      for await (const event of observer.events()) {
        events.push(event)
        if (event.type === 'exited') return event.state
      }
      throw new Error('Native observer ended without an authoritative exit')
    })()
    try {
      const status = await m.sdk.status(runId as any)
      await m.core.writeTerminal({ runId }, { ownerInstanceId: await m.sdk.daemonInstance(), operationId: crypto.randomUUID(),
        expectedByte: status.applied_input_bytes!, data: 'continue\n' })
      expect(await terminal).toMatchObject({ type: 'exited', code: 0 })
      const afterExit = (await m.rpc.call('toolkit.inspect', { toolId: id })).snapshot
      await record('rejected-stop-causal', { mode, captured, rejected, replays, pending, restored,
        afterExit, runtime: await m.sdk.runtimeInfo(), originalSnapshot: observer.snapshot, laterNativeEvents: events })
      expect(replays[0]).toMatchObject({ ref: { runId }, run: { runId, state: 'running' }, gap: null })
      // An immediate business assertion makes the old Source failure precise;
      // it does not rely on extending a product or test timeout.
      expect(restored).toBe(true)
      let final!: ToolkitScriptSnapshot
      await until(async () => { final = (await oneCli('toolkit', 'inspect', id)).result.snapshot; expect(final.admission).toBeNull() })
      expect(final.latestConfirmed).toMatchObject({ executionId: captured.executionId, invocationId: captured.invocationId,
        definition: captured.definition, target: captured.target, run: captured.run,
        state: mode === 'explicit' ? 'succeeded' : 'failed', exitCode: 0 })
      if (mode === 'explicit') expect(final.latestConfirmed!.text).toContain('original_after_ACK')
      else {
        expect(Buffer.byteLength(JSON.stringify(final.latestConfirmed!.text))).toBeLessThanOrEqual(48 * 1024)
        expect(final.latestConfirmed!.reason).toBeTruthy()
      }
      expect(await m.sdk.list()).toEqual([])
      await record('rejected-stop-result', { mode, final, rejected, replays, originalRun: runId })
    } finally { observer.close(); replay.mockRestore(); stop.mockRestore() }
  })
})
