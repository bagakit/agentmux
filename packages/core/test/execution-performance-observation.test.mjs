import test from 'node:test'
import assert from 'node:assert/strict'
import { waitForProducerOutput, nativeConcurrencyWindow } from '../scripts/fixtures/cross-host-execution-performance.mjs'

function fixture({ gap = null, runId = 'original-run' } = {}) {
  const wire = Buffer.from('\n' + JSON.stringify({ type: 'response', generation: 'original-generation', payload: {
    method: 'process/output', params: { chunk: Buffer.from('s'.repeat(64)).toString('base64') }
  } }) + '\n')
  const calls = [], order = []
  let read = 0
  const client = {
    runtimeSubject: async target => { assert.deepEqual(target, { kind: 'terminal-run', runId: 'original-run' }); order.push('cut'); return { run: { runId, latestOutputBytes: 1001 } } },
    readRunReplay: async (ref, cursor, view) => {
      assert.deepEqual(ref, { runId: 'original-run' }); assert.equal(view, 'raw')
      const expected = read === 0 ? 1000 : 1007
      assert.equal(cursor, expected, 'A new read must not repeat old Replay bytes')
      calls.push(cursor)
      const dataBytes = read++ === 0 ? wire.subarray(0, 7) : wire.subarray(7)
      return { run: { runId }, gap, replay: [{ startByte: cursor, endByte: cursor + dataBytes.length, dataBytes }] }
    }
  }
  const until = async fn => { for (let i = 0; i < 3; i++) if (await fn()) return; throw Error('No actual producer output') }
  const release = async () => { order.push('release') }
  return { client, until, release, calls, order, wire }
}

test('takes an exact cut before release and only reads new bytes across split original frames', async () => {
  const f = fixture(), result = await waitForProducerOutput(f.client, 'original-run', f.until, f.release)
  assert.deepEqual(f.order, ['cut', 'release'])
  assert.deepEqual(f.calls, [1000, 1007])
  assert.deepEqual(result, { startByte: 1000, endByte: 1000 + f.wire.length, readCount: 2, bytes: f.wire.length })
})

test('does not treat a Replay Gap or another Run as original producer progress', async () => {
  for (const options of [{ gap: { afterByte: 1000, firstAvailableByte: 2000 } }, { runId: 'another-run' }]) {
    const f = fixture(options)
    await assert.rejects(() => waitForProducerOutput(f.client, 'original-run', f.until, f.release))
  }
})


test('uses original resource command times even when a yielded tool reply arrives later', () => {
  const producer = { startedAt: 100, completedAt: 200, outputBytes: 4 * 1024 * 1024 }
  const samples = Array.from({ length: 6 }, (_, index) => ({ label: 'under-load', index, callId: 'original-' + index,
    emittedAt: 500, completedAt: 600, roundtripMs: 100 }))
  const commands = [[110, 150], [100, 200], [90, 120], [190, 201], [210, 220], [80, 90]]
    .map(([startedAt, completedAt], index) => ({ label: 'under-load', index, startedAt, completedAt }))
  const window = nativeConcurrencyWindow(producer, samples, commands)
  assert.deepEqual(window.overlappingCallIds, ['original-0', 'original-1'])
  assert.equal(window.overlapCount, 2)
  assert.deepEqual(window.nativeCommands.map(row => row.callId), samples.map(row => row.callId))
  assert.equal(window.excludedSamples.length, 4)
  assert.throws(() => nativeConcurrencyWindow(producer, samples, commands.map(row => ({ ...row, startedAt: 201, completedAt: 202 }))))
  assert.throws(() => nativeConcurrencyWindow(producer, samples, commands.map(row => ({ ...row, index: 0 }))))
})
