import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { extremeFixture, operationRows } from './helpers/extreme-event-fixture.js'
import { exhaustOwnedSemantic } from './helpers/extreme-oom.js'
import { until } from './helpers/headless-runtime-fixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('cold exact recovery retains the first files and original healthy Run after actual bounded semantic-owner heap OOM', async () => {
  const f = await extremeFixture({ ownerNodeArgs: ['--max-old-space-size=96', '--max-semi-space-size=4'] }); cleanup.push(f.cleanup)
  const { sdk, rpc } = await exhaustOwnedSemantic(f)
  const retained = await sdk.readAgentSession(f.original.agentSessionId)
  expect(retained!.terminalCapability).toMatchObject({ reason: 'handshake-unconfirmed', state: 'unknown', run: f.original.run })
  expect(retained!.terminalHandshake).toEqual(f.metadata.terminalHandshake)
  const result = await sdk.ensureAgentContinuity({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run,
    operationId: 'original-after-oom', trigger: 'manual' })
  expect(result, 'cold OOM recovery must return the original live Run').toMatchObject({ kind: 'reattachable', session: { run: f.original.run }, run: { pid: f.before.run.pid } })
  const attached = await sdk.reattachAgent(f.original.agentSessionId)
  expect(attached.attachment.replay.map(value => value.data).join('')).toContain('original-durable-output')
  await writeFile(f.output, 'ordered-original-after-oom')
  await until(() => sdk.readRunReplay(f.original.run), value => value.replay.map(chunk => chunk.data).join('').includes('ordered-original-after-oom'), 'same original stdout after OOM')
  await f.assertOriginal(sdk, rpc)
  const ack = await sdk.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, source: 'user', data: 'new-authorized-after-oom' })
  expect(ack.appliedByteRange).toEqual({ startByte: f.inputCursor,
    endByte: f.inputCursor + Buffer.byteLength('new-authorized-after-oom') })
  const operations = await operationRows(f.state)
  expect(operations.filter(value => value.method === 'start' && value.phase === 'ack')).toHaveLength(1)
  expect(operations.filter(value => value.method === 'input' && value.phase === 'ack')).toHaveLength(2)
  expect(operations.filter(value => value.method === 'start' && value.pid === f.scope.owner.processId)).toEqual([])
  console.info('EXTREME_OOM_CONTINUATION=' + JSON.stringify({ result, ack, operations }))
}, 60_000)
