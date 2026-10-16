import { EventEmitter } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { extremeFixture } from '../../../packages/core/test/helpers/extreme-event-fixture.js'
import { exhaustOwnedSemantic } from '../../../packages/core/test/helpers/extreme-oom.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import type { AppConfig, RuntimeEvent } from '../src/shared/contracts.js'
import type { WebContents } from 'electron'

vi.mock('electron', async () => { const { fixturePath } = await import('../../../test/fixture-values.mjs'); return { app: { getPath: () => fixturePath('unused-extreme-fixture') } } })
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Main extreme-event cleanup failed')
})

it('actual Main restores the same original Agent workface and ordered attachment after actual semantic-owner oom', async () => {
  const f = await extremeFixture({ ownerNodeArgs: ['--max-old-space-size=96', '--max-semi-space-size=4'] }); cleanups.push(f.cleanup)
  const { sdk: reader, rpc: readerRpc } = await exhaustOwnedSemantic(f)
  // Production Main consumes an actual Unix Hosted SDK, not a mocked recovery
  // receipt. Only its connector endpoint is private to this test-owned Runtime.
  const controller = new RuntimeController(f.store, async () => f.scope.client()); cleanups.push(() => controller.dispose())
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Original' }],
    workspaces: [{ id: 'original-workspace', hostId: 'local', kind: 'folder', name: 'Original', path: f.scope.root }] }
  controller.commit(await controller.prepare(config))
  const delivered: RuntimeEvent[] = [], contents = Object.assign(new EventEmitter(), { id: 89, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => delivered.push(event) }) as unknown as WebContents
  cleanups.push(controller.attach(contents))
  const snapshot = await controller.snapshot(config), projected = snapshot.sessions.find(value => value.id === f.original.agentSessionId)!
  expect(projected, 'Main must keep original durable Agent identity after the fault').toMatchObject({ kind: 'agent', id: f.original.agentSessionId,
    processState: 'running', control: { kind: 'agent', hostId: 'local', agentSessionId: f.original.agentSessionId, run: f.original.run } })
  const recovered = await controller.recoverSession(projected.control, config, undefined, 'main-original-after-fault', { trigger: 'manual' })
  expect(recovered, 'Main recovery must deliver the original retained Run').toMatchObject({ kind: 'reattachable', session: { id: projected.id, control: { run: f.original.run } } })
  const attached = await controller.attachSession(contents.id, projected.control, 0, config)
  try {
    const restore = attached.terminal.type === 'basic-vt' ? new TextDecoder().decode(attached.terminal.restoreBytes) : ''
    expect(restore + attached.replay.map(value => value.data).join('')).toContain('original-durable-output')
    const cut = delivered.length
    await writeFile(f.output, 'main-ordered-after-fault')
    const events = await until(() => delivered.slice(cut).flatMap(event => event.type === 'core' && event.event.type === 'terminal-output' &&
      event.event.run.runId === f.original.run.runId ? [event.event] : []), value => value.map(row => row.data).join('').includes('main-ordered-after-fault'), 'same original ordered Main output')
    let cursor = attached.session.latestOutputBytes
    for (const event of events) { expect(event.evidence.outputByteRange.startByte).toBe(cursor); cursor = event.evidence.outputByteRange.endByte }
    expect(cursor).toBeGreaterThan(attached.session.latestOutputBytes)
    await f.assertOriginal(reader, readerRpc)
    console.info('EXTREME_MAIN=' + JSON.stringify({ session: projected.id, run: f.original.run, pid: f.before.run.pid,
      workface: f.spatial.state.graph.regions[0], initialCursor: attached.session.latestOutputBytes, outputCursor: cursor }))
  } finally { await controller.detachSession(contents.id, attached.attachmentId) }
}, 60_000)
