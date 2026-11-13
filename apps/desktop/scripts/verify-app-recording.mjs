import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { runAppCaptureProof } from './app-capture-proof.mjs'

const root = resolve(import.meta.dirname, '../../..'), entry = join(import.meta.dirname, 'fixtures/app-capture/recording.ts')
const extraEntries = { recovery: join(import.meta.dirname, 'fixtures/app-capture/recording-recovery.ts') }
const baseline = await runAppCaptureProof({ entry, extraEntries, label: 'recording' })
assert.ok(baseline.checks.length >= 10, 'Recording proof must exercise real consumers')
const boundaryEntry = join(import.meta.dirname, 'fixtures/app-capture/recording-boundaries.ts')
const boundaries = await runAppCaptureProof({ entry: boundaryEntry, label: 'recording-boundaries' })
assert.ok(boundaries.checks.length >= 7, 'Pending observation and original owner facts require real consumers')
const mutants = [
  { id: 'frozen-video', file: 'apps/desktop/src/main/app-recording.ts', before: "await observed(encoder.append(frame), active.abort.signal, 'Frame encoding', ENCODER_WAIT_MS)", after: 'void frame', oracle: 'recording output must decode multiple changing Renderer colors' },
  { id: 'lost-intent', file: 'apps/desktop/src/main/app-recording.ts', before: 'if (!isDeepStrictEqual({ operationId: original.operationId, target: original.target, durationMs: original.durationMs, fps: original.fps }, input))', after: 'if (false)', oracle: 'recording operation must retain its original intent' },
  { id: 'lost-actor', file: 'apps/desktop/src/main/app-recording.ts', before: 'recording.operationId !== id || !isDeepStrictEqual(recording.actor, context.actor)', after: 'recording.operationId !== id', oracle: 'recording original actor must be enforced' },
  { id: 'lost-stop', file: 'apps/desktop/src/main/app-recording.ts', before: "active.stop = true; active.recording.state = 'stopping'; active.wake?.()", after: "active.recording.state = 'stopping'", oracle: 'recording stop must end the original sampler early' },
  { id: 'lost-recovery', file: 'apps/desktop/src/main/app-recording.ts', before: "recording.state = 'interrupted'", after: "recording.state = 'recording'", oracle: 'native owner restart must retain interrupted state' },
  { id: 'false-producer-end', entry: boundaryEntry, file: 'apps/desktop/src/main/app-recording.ts', before: 'if (!ended)', after: 'if (false)', oracle: 'a live original producer cannot be declared interrupted' },
  { id: 'late-duration-frame', entry: boundaryEntry, file: 'apps/desktop/src/main/app-recording.ts', before: 'if (active.stop || active.interrupted || performance.now() - start >= record.durationMs) break', after: 'if (active.interrupted) break', oracle: 'A frame delivered after the original duration deadline cannot be appended' },
  { id: 'lost-dispose', entry: boundaryEntry, file: 'apps/desktop/src/main/app-recording.ts', before: "active.abort.abort(new RecordingObservationEnded('The original Desktop recording owner was disposed; any in-flight source observation remains unconfirmed.'))", after: 'void active.abort', oracle: 'disposal ends only this recording observer and retains unknown native completion' },
  { id: 'lost-frame-gap', entry: boundaryEntry, file: 'apps/desktop/src/main/app-recording.ts', before: "if ((error as { code?: string }).code !== 'APP_CAPTURE_FRAME_CHANGED') throw error", after: 'throw error', oracle: 'A same-document frame gap must retain the original recording' },
  { id: 'lost-SDK-checksum', file: 'packages/core/src/app-capture.ts', before: "if (createHash('sha256').update(data).digest('hex') !== recording.sha256)", after: 'if (false)', oracle: 'SDK WebM checksum must reject changed original bytes' }
]
const killed = []
for (const mutation of mutants) {
  try {
    await runAppCaptureProof({ entry: mutation.entry ?? entry, mutation, ...(mutation.entry ? {} : { extraEntries }), label: `recording-mutant-${mutation.id}` })
    assert.fail(`Recording mutation survived: ${mutation.id}`)
  } catch (error) {
    assert.equal(error.proofReport?.passed, false, `Mutation must reach the real product oracle: ${mutation.id}; ${error.message}`)
    assert.match(error.proofReport.error ?? '', new RegExp(mutation.oracle), `Mutation failed outside its intended oracle: ${mutation.id}`)
    killed.push({ id: mutation.id, file: mutation.file, oracle: mutation.oracle })
  }
}
assert.equal(killed.length, mutants.length)
const evidence = join(root, '.local/bootstrap-capture/recording')
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'mutations.json'), JSON.stringify({ passed: true, tested: mutants.length, killed }, null, 2))
console.log(JSON.stringify({ passed: true, checks: [...baseline.checks, ...boundaries.checks], mutations: killed.length, evidence }))
