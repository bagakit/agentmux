import { describe, expect, it, vi } from 'vitest'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestAgentMuxControl } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitToolFields, type ToolkitScriptSnapshot } from '@agentmux/core/control'
import { nativeMain, until, oneCli, record, terminalMetadata } from './toolkit-main.fixture.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { TOOLKIT_ENDED_CHANNEL } from '../src/shared/contracts.js'

async function add(m: Awaited<ReturnType<typeof nativeMain>>, id = 'quota', script = "console.log('真实工具_ACK')") {
  const fields: ToolkitToolFields = { name: 'Quota', icon: 'terminal', enabled: true, statusBar: 'icon',
    workspacePath: join(m.directory, 'work'), script, args: [], actions: [] }
  const path = join(m.directory, id + '-fields.json'); await writeFile(path, JSON.stringify(fields))
  return { fields, definition: (await oneCli('toolkit', 'add', id, '--input', path)).result.definition }
}
async function get(id = 'quota'): Promise<ToolkitScriptSnapshot> {
  return (await oneCli('toolkit', 'get', id)).result.snapshot
}

describe('registered Main custom Toolkit actual CLI vertical', () => {
  it('actual compiled CLI creates a configured local script and receives fast exit0 complete UTF8 without LF', async () => {
    const m = await nativeMain(), { definition } = await add(m, 'quota', "process.stdout.write('真实工具_ACK')")
    const before = await m.core.listRuns()
    expect(await get()).toMatchObject({ kind: 'script', state: 'idle', latestConfirmed: null, definition: { revision: definition.revision } })
    expect(await m.core.listRuns()).toEqual(before)
    const response = await oneCli('toolkit', 'run', 'quota')
    expect(response.result.snapshot.kind).toBe('script')
    let finished!: ToolkitScriptSnapshot
    await until(async () => { finished = await get(); expect(finished.admission).toBeNull(); expect(finished.state).toBe('succeeded') })
    expect(finished.latestConfirmed).toMatchObject({ text: '真实工具_ACK', exitCode: 0, definition: { revision: definition.revision },
      target: { workspacePath: join(m.directory, 'work') }, run: { hostId: 'local', runId: expect.any(String) } })
    const retained = finished.latestConfirmed!, input = join(m.directory, 'captured-run.json')
    await writeFile(input, JSON.stringify({ invocationId: retained.invocationId, expectedRevision: retained.definition.revision,
      expectedLatestExecutionId: retained.expectedLatestExecutionId }))
    const repeated = (await oneCli('toolkit', 'run', 'quota', '--input', input)).result.snapshot as ToolkitScriptSnapshot
    expect(repeated.latestConfirmed).toEqual(retained)
    expect(repeated.admission).toBeNull()
    expect((await m.core.listRuns()).map(run => run.runId)).toEqual(before.map(run => run.runId))
    await record('custom-first-vertical', { definition, response, finished, before, after: await m.core.listRuns() })
  })
  it('actual CLI expected conflict preserves the durable configuration through the same Main owner', async () => {
    const m = await nativeMain(), beforeAdd = await m.store.get(), { fields, definition } = await add(m)
    const prefs = await m.invoke('config:save', { ...beforeAdd, toolkit: { performance: { enabled: false } } }, beforeAdd)
    expect(prefs.toolkit.tools).toEqual([definition])
    expect(prefs.toolkit.performance.enabled).toBe(false)
    const update = join(m.directory, 'update.json'); await writeFile(update, JSON.stringify({ changes: { name: 'Changed' }, expected: { name: fields.name } }))
    const after = (await oneCli('toolkit', 'update', 'quota', '--input', update)).result.definition
    expect(after).toMatchObject({ name: 'Changed' }); expect(after.revision).not.toBe(definition.revision)
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(join(m.directory, 'config.json')))
    let rejected: unknown
    try {
      await requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(),
        operation: 'toolkit.update', toolId: 'quota', changes: { name: 'Wrong' }, expected: { name: fields.name } }, m.controlPath)
    } catch (error) { rejected = error }
    expect(rejected).toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect((await m.store.get()).toolkit!.tools![0]!.name).toBe('Changed')
    expect(await import('node:fs/promises').then(fs => fs.readFile(join(m.directory, 'config.json')))).toEqual(bytes)
    await record('custom-expected', { definition, after, rejected: String(rejected) })
  })
  it('actual multi-chunk script publishes no snapshots without consumers and writes only durable keypoints', async () => {
    const m = await nativeMain()
    await add(m, 'stream', "for (const text of ['one','two','three']) { await new Promise(r=>setTimeout(r,300)); process.stdout.write(text) }")
    const snapshots = vi.spyOn(CustomToolkitOwner.prototype as any, 'current')
    const accepted = vi.spyOn(CustomToolkitOwner.prototype as any, 'accept')
    const saves = vi.spyOn(ToolkitReceiptStore.prototype, 'save')
    const started = (await oneCli('toolkit', 'run', 'stream')).result.snapshot
    expect(started.admission?.run?.runId).toBeTruthy()
    snapshots.mockClear()
    await until(async () => expect(await m.core.listRuns()).toEqual([]))
    const chunks = accepted.mock.calls.filter(call => (call[1] as any).type === 'terminal-output')
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(snapshots).not.toHaveBeenCalled()
    expect(saves).toHaveBeenCalledTimes(4)
    const finished = await get('stream')
    expect(finished).toMatchObject({ consumerCount: 0, state: 'succeeded', admission: null, latestConfirmed: { text: 'onetwothree' } })
    expect(finished.sequence).toBeGreaterThanOrEqual(started.sequence + 3)
    expect(snapshots).toHaveBeenCalledOnce()
    await record('custom-unobserved-cost', { chunks: chunks.length, snapshotsBeforeGet: 0, durableWrites: saves.mock.calls.length, started, finished })
  })
  it('actual config save cannot delete an admitted script and disable affects only its next invocation', async () => {
    const m = await nativeMain(), { definition } = await add(m, 'quota', "process.stdout.write('inflight_ACK'); await new Promise(()=>{setInterval(()=>{},1000)})")
    const seen: unknown[] = []
    await m.invoke('toolkit:observe', 'quota', 'reader')
    expect(await m.core.listRuns()).toEqual([])
    const started = (await oneCli('toolkit', 'run', 'quota')).result.snapshot as ToolkitScriptSnapshot
    expect(started.admission).toMatchObject({ state: 'running', definition: { revision: definition.revision } })
    const before = await m.store.get(), bytes = await readFile(join(m.directory, 'config.json'))
    await expect(m.invoke('config:save', { ...before, toolkit: { ...before.toolkit, tools: [] } }, before)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    expect(await readFile(join(m.directory, 'config.json'))).toEqual(bytes)
    await m.invoke('toolkit:release', 'reader')
    const captured = { invocationId: crypto.randomUUID(), expectedRevision: definition.revision, expectedLatestExecutionId: null }
    await expect(requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(),
      operation: 'toolkit.run', toolId: 'quota', input: captured }, m.controlPath)).rejects.toMatchObject({ code: 'SETTING_RESOURCE_IN_USE' })
    const changed = await m.invoke('config:save', { ...before, copyPathsAsAbsolute: !before.copyPathsAsAbsolute,
      toolkit: { ...before.toolkit, tools: [{ ...definition, enabled: false }] } }, before)
    expect(changed.copyPathsAsAbsolute).toBe(!before.copyPathsAsAbsolute)
    const running = await get()
    expect(running).toMatchObject({ definition: { enabled: false }, admission: { executionId: started.admission!.executionId, definition: { enabled: true } } })
    expect((await m.core.listRuns()).find(run => run.runId === started.admission!.run!.runId)?.state).toBe('running')
    expect(running.consumerCount).toBe(0)
    const stopping = await m.invoke('toolkit:stop', 'quota', started.admission!.executionId)
    expect(stopping.snapshot.toolId).toBe('quota')
    let stopped!: ToolkitScriptSnapshot
    await until(async () => { stopped = await get(); expect(stopped.admission).toBeNull() })
    expect(stopped).toMatchObject({ state: 'disabled', admission: null, latestConfirmed: { state: 'stopped', definition: { enabled: true } } })
    expect(await m.core.listRuns()).toEqual([])
    const final = await m.store.get()
    await m.invoke('config:save', { ...final, toolkit: { ...final.toolkit, tools: [] } }, final)
    expect((await m.store.get()).toolkit!.tools).toEqual([])
    seen.push(...m.sender.events.filter(event => event.channel.includes('toolkit')))
    expect(seen.length).toBeGreaterThan(0)
    await record('custom-config-admission', { definition, started, running, stopped, observationCount: seen.length })
  })
  it('ordinary private Main restart restores captured configuration and result while a healthy terminal remains usable', async () => {
    const m = await nativeMain(), { definition } = await add(m)
    const healthy = await m.runtime.launchTerminal({ hostId: 'local', workspacePath: join(m.directory, 'work'), shellCommand: 'cat' }, m.config)
    const original = (await m.core.listRuns()).find(run => run.runId === healthy.control.run.runId)
    expect(original?.state).toBe('running'); expect(original?.pid).toBeGreaterThan(0)
    const instance = await m.sdk.daemonInstance()
    await oneCli('toolkit', 'run', 'quota')
    let confirmed!: ToolkitScriptSnapshot
    await until(async () => { confirmed = await get(); expect(confirmed.admission).toBeNull(); expect(confirmed.state).toBe('succeeded') })
    const configBytes = await readFile(join(m.directory, 'config.json')), receiptBytes = await readFile(join(m.directory, 'toolkit-receipts.json'))
    const before = (await m.core.listRuns()).map(run => run.runId)
    expect(before).toEqual([healthy.control.run.runId])
    await m.restart()
    expect(await m.sdk.daemonInstance()).toBe(instance)
    expect(await readFile(join(m.directory, 'config.json'))).toEqual(configBytes)
    expect(await readFile(join(m.directory, 'toolkit-receipts.json'))).toEqual(receiptBytes)
    expect((await m.store.get()).toolkit!.tools).toEqual([definition])
    const restored = await get()
    expect(restored.latestConfirmed).toEqual(confirmed.latestConfirmed)
    expect(restored.admission).toBeNull()
    const after = await m.core.listRuns()
    expect(after.map(run => run.runId)).toEqual(before)
    expect(after[0]!.pid).toBe(original!.pid)
    await m.core.attachTerminal(healthy.control.run.runId)
    const beforeInput = (await m.sdk.status(healthy.control.run.runId as any)).applied_input_bytes!
    const ack = await m.core.writeTerminal(healthy.control.run, { ownerInstanceId: instance, operationId: crypto.randomUUID(), expectedByte: beforeInput, data: 'healthy-after-main-restart\n' })
    await until(async () => expect((await m.core.readRunReplay(healthy.control.run)).replay.map(chunk => Buffer.from(chunk.dataBytes).toString()).join('')).toContain('healthy-after-main-restart'))
    expect(ack.acceptedThroughByte).toBeGreaterThan(beforeInput)
    expect((await m.core.listRuns())[0]!.pid).toBe(original!.pid)
    await record('custom-private-main-restart', { instance, before, original, definition, confirmed, restored, after, ack,
      boundary: 'Main durable configuration/results and exact healthy Run; visible workbench belongs to the UI qualification.' })
    await m.core.stopTerminal(healthy.control.run); await m.core.releaseRunAttachment(healthy.control.run); await m.core.removeTerminal(healthy.control.run)
  })
  it('actual exit0 confirmation failure keeps the old durable result and exact Run without blocking another tool', async () => {
    const m = await nativeMain()
    await add(m, 'quota', "process.stdout.write('first')")
    await oneCli('toolkit', 'run', 'quota')
    let first!: ToolkitScriptSnapshot
    await until(async () => { first = await get(); expect(first.admission).toBeNull(); expect(first.state).toBe('succeeded') })
    const update = join(m.directory, 'second.json')
    await writeFile(update, JSON.stringify({ changes: { script: "process.stdout.write('second')" }, expected: { script: "process.stdout.write('first')" } }))
    await oneCli('toolkit', 'update', 'quota', '--input', update)
    const save = ToolkitReceiptStore.prototype.save
    let rejectedConfirmation = false
    vi.spyOn(ToolkitReceiptStore.prototype, 'save').mockImplementation(function(id, receipt: any) {
      if (id === 'quota' && receipt.latestConfirmed && receipt.latestConfirmed.executionId !== first.latestConfirmed!.executionId && !rejectedConfirmation) {
        rejectedConfirmation = true
        return Promise.reject(new Error('owned-confirmation-save-failed'))
      }
      return save.call(this, id, receipt)
    })
    await oneCli('toolkit', 'run', 'quota')
    let unknown!: ToolkitScriptSnapshot
    await until(async () => { unknown = await get(); expect(unknown.state).toBe('unknown'); expect(rejectedConfirmation).toBe(true) })
    expect(unknown.latestConfirmed).toEqual(first.latestConfirmed)
    expect(unknown.admission?.text).toBe('second')
    expect(unknown.admission?.run?.runId).toBeTruthy()
    const retained = await m.core.listRuns()
    expect(retained).toHaveLength(1)
    expect(retained[0]).toMatchObject({ runId: unknown.admission!.run!.runId, state: 'exited', exitCode: 0 })
    const durable = JSON.parse(await readFile(join(m.directory, 'toolkit-receipts.json'), 'utf8')).tools.quota
    expect(durable.latestConfirmed).toEqual(first.latestConfirmed)
    expect(durable.admission.run.runId).toBe(retained[0]!.runId)
    await add(m, 'other', "process.stdout.write('other_ACK')")
    await oneCli('toolkit', 'run', 'other')
    let other!: ToolkitScriptSnapshot
    await until(async () => { other = await get('other'); expect(other.admission).toBeNull(); expect(other.state).toBe('succeeded') })
    expect(other.latestConfirmed?.text).toBe('other_ACK')
    const before = await m.store.get()
    await m.invoke('config:save', { ...before, copyPathsAsAbsolute: !before.copyPathsAsAbsolute }, before)
    expect((await m.store.get()).copyPathsAsAbsolute).toBe(!before.copyPathsAsAbsolute)
    expect((await m.core.listRuns()).map(run => run.runId)).toEqual([retained[0]!.runId])
    await record('custom-confirmation-failure', { first, unknown, durable, retained, other })
  })
  it('actual complete malformed or encoded-over-budget output fails honestly with a bounded result and exact cleanup', async () => {
    const m = await nativeMain()
    for (const [id, script] of [
      ['malformed', 'process.stdout.write(Buffer.from([0xe4]))'],
      ['oversized', "process.stdout.write('\\u0001'.repeat(10000))"]
    ]) {
      await add(m, id, script)
      await oneCli('toolkit', 'run', id!)
      let value!: ToolkitScriptSnapshot
      try {
        await until(async () => { value = await get(id); expect(value.admission).toBeNull(); expect(value.state).toBe('failed') })
      } catch (error) {
        const runId = value?.admission?.run?.runId
        await record('custom-output-pending', { id, script, value, error: String(error),
          runs: await m.core.listRuns(), receipt: JSON.parse(await readFile(join(m.directory, 'toolkit-receipts.json'), 'utf8')),
          exactStatus: runId ? await m.sdk.status(runId as any) : null,
          metadata: terminalMetadata(m.core), resources: await m.core.runtimeResourceSnapshot() })
        throw error
      }
      expect(value.latestConfirmed?.state).toBe('failed')
      expect(Buffer.byteLength(value.latestConfirmed!.text)).toBeLessThanOrEqual(32 * 1024)
      expect(Buffer.byteLength(JSON.stringify(value.latestConfirmed!.text))).toBeLessThanOrEqual(48 * 1024)
      expect(await m.core.listRuns()).toEqual([])
      await record('custom-output-failure', { id, script, value })
    }
  })
  it('actual IPC reader failure cannot falsify a durable deletion or leave Main launch reservations held', async () => {
    const m = await nativeMain()
    await add(m)
    const listenerBaseline = m.sender.listenerCount('destroyed')
    await m.invoke('toolkit:observe', 'quota', 'one')
    await m.invoke('toolkit:observe', 'quota', 'two')
    const send = m.sender.send
    vi.spyOn(m.sender, 'send').mockImplementation(function(channel, value) {
      if (channel === TOOLKIT_ENDED_CHANNEL && value.id === 'one') throw new Error('owned-renderer-went-away')
      return send.call(this, channel, value)
    })
    const before = await m.store.get()
    const saved = await m.invoke('config:save', { ...before, toolkit: { ...before.toolkit, tools: [] } }, before)
    expect(saved.toolkit.tools).toEqual([])
    expect((await m.store.get()).toolkit!.tools).toEqual([])
    expect(JSON.parse(await readFile(join(m.directory, 'config.json'), 'utf8')).toolkit.tools).toEqual([])
    expect(m.sender.events.some(event => event.channel === TOOLKIT_ENDED_CHANNEL && event.value.id === 'two')).toBe(true)
    expect(m.sender.listenerCount('destroyed')).toBe(listenerBaseline)
    expect(await m.core.listRuns()).toEqual([])
    const healthy = await m.runtime.launchTerminal({ hostId: 'local', workspacePath: join(m.directory, 'work'), shellCommand: 'cat' }, m.config)
    expect((await m.core.listRuns()).find(run => run.runId === healthy.control.run.runId)?.state).toBe('running')
    await record('custom-reader-failure', { saved, listeners: m.sender.listenerCount('destroyed'), listenerBaseline, healthy })
    await m.core.stopTerminal(healthy.control.run); await m.core.releaseRunAttachment(healthy.control.run); await m.core.removeTerminal(healthy.control.run)
  })
  it('ten actual manual runs retire exact metadata while an unrelated healthy terminal keeps its PID and accepts Input', async () => {
    const m = await nativeMain()
    const healthy = await m.runtime.launchTerminal({ hostId: 'local', workspacePath: join(m.directory, 'work'), shellCommand: 'cat' }, m.config)
    const attached = await m.core.attachTerminal(healthy.control.run.runId)
    expect(attached.run.runId).toBe(healthy.control.run.runId)
    expect(attached.run.state).toBe('running')
    const original = (await m.core.listRuns()).find(run => run.runId === healthy.control.run.runId)
    expect(original?.state).toBe('running'); expect(original?.pid).toBeGreaterThan(0)
    const baseline = (await m.core.listRuns()).map(run => run.runId).sort(), metadata = terminalMetadata(m.core)
    const resourceBaseline = await m.core.runtimeResourceSnapshot()
    expect(baseline).toEqual([healthy.control.run.runId])
    expect(resourceBaseline.runCount).toBe(1); expect(resourceBaseline.attachments).toBeGreaterThan(0)
    await add(m)
    for (let n = 0; n < 10; n++) {
      const started = (await oneCli('toolkit', 'run', 'quota')).result.snapshot
      let value!: ToolkitScriptSnapshot
      await until(async () => { value = await get(); expect(value.admission).toBeNull(); expect(value.state).toBe('succeeded') })
      expect(value.latestConfirmed?.text).toContain('真实工具_ACK')
      expect(value.latestConfirmed?.run?.runId).toBeTruthy()
      const final = await m.core.listRuns()
      expect(final.map(run => run.runId).sort()).toEqual(baseline)
      expect(final.find(run => run.runId === healthy.control.run.runId)?.pid).toBe(original!.pid)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(terminalMetadata(m.core)).toEqual(metadata)
      const resources = await m.core.runtimeResourceSnapshot()
      expect(resources.runCount).toBe(resourceBaseline.runCount)
      expect(resources.attachments).toBe(resourceBaseline.attachments)
      await record('custom-cycles', { n, started, confirmed: value.latestConfirmed, metadata: terminalMetadata(m.core), baselineMetadata: metadata, resources, resourceBaseline, baseline })
    }
    const beforeInput = (await m.sdk.status(healthy.control.run.runId as any)).applied_input_bytes!
    const ack = await m.core.writeTerminal(healthy.control.run, { ownerInstanceId: await m.sdk.daemonInstance(), operationId: crypto.randomUUID(), expectedByte: beforeInput, data: 'healthy-after-custom\n' })
    expect(ack.acceptedThroughByte).toBeGreaterThan(beforeInput)
    await until(async () => expect((await m.core.readRunReplay(healthy.control.run)).replay.map(chunk => Buffer.from(chunk.dataBytes).toString()).join('')).toContain('healthy-after-custom'))
    expect((await m.core.listRuns()).find(run => run.runId === healthy.control.run.runId)?.pid).toBe(original!.pid)
    await record('custom-healthy-input', { healthy, original, ack, metadata: terminalMetadata(m.core) })
    await m.core.stopTerminal(healthy.control.run); await m.core.releaseRunAttachment(healthy.control.run); await m.core.removeTerminal(healthy.control.run)
  })
})
