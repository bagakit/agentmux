import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { verifySourcePins } from './session-capability-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const commonSources = ['apps/desktop/scripts/verify-session-continuity-product.mjs',
  'apps/desktop/scripts/fixtures/session-continuity/main.ts', 'apps/desktop/scripts/fixtures/session-continuity/entry.mjs',
  'apps/desktop/src/renderer/src/components/ContinuitySupervisionNotice.tsx', 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/continuity-supervision.ts', 'packages/core/src/client.ts',
  'packages/core/src/agent-session-continuity-control.ts', 'packages/core/dist/index.js', 'packages/core/bin/amux']

async function readNative(project, receiptFile, schema, scene) {
  const file = path.resolve(project, receiptFile), bytes = await fs.readFile(file), receipt = JSON.parse(bytes), directory = path.dirname(file)
  assert.equal(receipt.schema, schema); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.inputsAfter, receipt.inputs)
  for (const source of [...commonSources, scene]) assert.match(receipt.inputs[source] ?? '', /^[a-f0-9]{64}$/u, 'Original Native source anchor missing')
  const sourceInputs = await verifySourcePins(project, receipt.inputs, commonSources[0])
  assert.deepEqual(receipt.phases.map(one => one.phase), ['seed'])
  const phase = receipt.phases[0], native = await read(path.join(directory, 'seed.json'))
  assert.deepEqual(phase.native, native, 'The parent must retain the original Main result')
  assert.equal(phase.exit.exitCode, 0); assert.equal(phase.exit.exitConfirmed, true); assert.equal(phase.exit.timedOut, false)
  assert.equal(phase.exit.interruption, null); assert.deepEqual(phase.exit.cleanupErrors, [])
  assert.equal(native.passed, true); assert.ok(Number.isSafeInteger(native.pid) && native.pid > 0)
  assert.deepEqual(native.supervision.healthy, receipt.originalHealthy); assert.deepEqual(native.supervision.healthy, receipt.survivingHealthy)
  assert.ok(native.supervision.healthy.runId && Number.isSafeInteger(native.supervision.healthy.pid) && native.supervision.healthy.pid > 0)
  const compiled = await read(path.join(directory, 'compiled.json'))
  assert.deepEqual(compiled, receipt.compiled)
  for (const anchor of ['main/main.mjs', 'renderer/index.html', 'core/dist/index.js', 'core/bin/amux']) assert.ok(compiled[anchor], 'Original compiled consumer missing')
  for (const [name, one] of Object.entries(compiled)) {
    assert.ok(one.bytes > 0); assert.match(one.sha256, /^[a-f0-9]{64}$/u)
    if (name.startsWith('core/')) {
      assert.match(receipt.inputs['packages/' + name] ?? '', /^[a-f0-9]{64}$/u)
      assert.equal(one.sha256, receipt.inputs['packages/' + name])
    } else {
      assert.ok(name.startsWith('main/') || name.startsWith('renderer/'))
      const code = await fs.readFile(path.join(directory, 'compiled', name))
      assert.equal(code.length, one.bytes); assert.equal(hash(code), one.sha256)
    }
  }
  assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.cleanup.temporaryRootRemoved, true)
  return { file, bytes, receipt, directory, sourceInputs, native }
}

/** Read the actual single-generation producer, its raw Main result and retained compiled bytes. */
export async function readSupervisionNativeSurfaceOwner(project, receiptFile) {
  const { file, bytes, directory, sourceInputs, native } = await readNative(project, receiptFile,
    'agentmux.continuity-supervision-surface.v1', 'apps/desktop/scripts/fixtures/session-continuity/supervision-surface.ts')
  const surface = native.supervision
  assert.equal(surface.kind, 'surface'); assert.ok(surface.original.sessionId && surface.original.rootOperationId)
  const continued = surface.controls.continued, cancelled = surface.controls.cancelled
  for (const one of [continued, cancelled]) {
    assert.deepEqual(Object.keys(one.request).sort(), ['agentSessionId', 'intentOperationId', 'expectedRun', 'operationId', 'action', ...(one.request.action === 'continue' ? ['additionalAttempts'] : [])].sort())
    assert.deepEqual(Object.keys(one.request.expectedRun), ['runId'])
    assert.ok(one.request.expectedRun.runId && one.request.operationId)
    assert.equal(one.request.agentSessionId, surface.original.sessionId)
    assert.equal(one.request.intentOperationId, surface.original.rootOperationId)
  }
  assert.equal(continued.request.action, 'continue'); assert.equal(continued.request.additionalAttempts, 1)
  assert.equal(continued.outcome, 'continued'); assert.equal(cancelled.request.action, 'cancel'); assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(cancelled.phaseAtCommit, 'cancelled'); assert.notEqual(continued.request.operationId, cancelled.request.operationId)
  assert.deepEqual(continued.request.expectedRun, cancelled.request.expectedRun)
  assert.equal(surface.controls.originalPacketRetained, true); assert.equal(surface.controls.samePacketReadback, true)
  const calls = native.calls.filter(one => one.operation === 'control-continuity')
  const original = calls.filter(one => one.args[1].operationId === continued.request.operationId)
  assert.equal(original.length, 2); assert.ok(original.every(one => JSON.stringify(one.args[1]) === JSON.stringify(continued.request)))
  assert.deepEqual(original[1].result.result.receipt, continued)
  assert.ok(calls.some(one => one.result?.result.receipt.request.operationId === cancelled.request.operationId && one.result.result.receipt.outcome === 'cancelled'))
  assert.equal(surface.healthyInput.runId, surface.healthy.runId); assert.equal(surface.healthyInput.pid, surface.healthy.pid)
  assert.equal(surface.healthyInput.consumedOnce, true); assert.ok(surface.healthyInput.body)
  const expected = ['supervision-paused-wide.png', 'supervision-paused-narrow.png', 'supervision-unconfirmed-wide.png', 'supervision-unconfirmed-narrow.png', 'supervision-cancelled-wide.png']
  assert.deepEqual(surface.frames.map(one => one.file), expected)
  for (const frame of surface.frames) {
    const image = await fs.readFile(path.join(directory, frame.file))
    assert.ok(image.length > 32); assert.equal(image.subarray(1, 4).toString(), 'PNG'); assert.equal(hash(image), frame.sha256)
    assert.equal(frame.width, frame.file.includes('narrow') ? 920 : 1320)
    assert.deepEqual(frame.originalRun, continued.request.expectedRun)
    assert.equal(frame.healthyTerminal.observation.runId, surface.healthy.runId)
    assert.equal(frame.healthyTerminal.observation.visible, true); assert.equal(frame.healthyTerminal.observation.liveReady, true)
    assert.ok(frame.healthyTerminal.text.includes('codex-ready:')); assert.ok(frame.draft)
  }
  return { task: 'T004-native', receipt: file, sha256: hash(bytes), sourceInputs,
    frames: surface.frames.map(({ file, sha256, width }) => ({ file, sha256, width })), original: surface.original, healthy: surface.healthy }
}

/** The separate initial-wait scene proves mounted cancellation before any Native Start. */
export async function readSupervisionInitialWaitOwner(project, receiptFile) {
  const { file, bytes, directory, sourceInputs, native } = await readNative(project, receiptFile,
    'agentmux.initial-continuity-supervision-surface.v1', 'apps/desktop/scripts/fixtures/session-continuity/initial-wait-surface.ts')
  const surface = native.supervision, { before, after, receipt } = surface
  assert.equal(surface.kind, 'initial-wait'); assert.ok(surface.original.sessionId && surface.original.rootOperationId)
  for (const root of [before, after]) {
    assert.equal(root.agentSessionId, surface.original.sessionId); assert.equal(root.operationId, surface.original.rootOperationId)
    assert.equal(root.kind, 'pending'); assert.equal(root.newRun, undefined); assert.equal(root.intentOperationId, undefined)
    assert.equal(root.supervision.attemptCount, 0); assert.equal(root.supervision.activeAttemptOperationId, root.operationId)
  }
  assert.equal(before.reason, 'active-delay'); assert.ok(before.nextActionAt > before.observedAt)
  assert.equal(after.supervision.phase, 'cancelled'); assert.equal(after.nextActionAt, undefined)
  assert.deepEqual(after.previousRun, before.previousRun)
  assert.equal(receipt.request.action, 'cancel'); assert.equal(receipt.request.agentSessionId, surface.original.sessionId)
  assert.equal(receipt.request.intentOperationId, surface.original.rootOperationId); assert.deepEqual(receipt.request.expectedRun, before.previousRun)
  assert.equal(receipt.outcome, 'cancelled'); assert.equal(receipt.phaseAtCommit, 'cancelled'); assert.equal(receipt.attemptCount, 0)
  assert.deepEqual(after.supervision.controlOperations[receipt.request.operationId], receipt)
  const calls = native.calls.filter(one => one.operation === 'control-continuity')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args[1], receipt.request); assert.deepEqual(calls[0].result.result.receipt, receipt)
  assert.deepEqual(surface.frames.map(one => one.file), ['initial-recovery-waiting-narrow.png', 'initial-recovery-cancelled-narrow.png'])
  for (const frame of surface.frames) {
    const image = await fs.readFile(path.join(directory, frame.file))
    assert.ok(image.length > 32); assert.equal(image.subarray(1, 4).toString(), 'PNG'); assert.equal(hash(image), frame.sha256)
    assert.equal(frame.width, 920); assert.deepEqual(frame.originalRun, before.previousRun)
    assert.equal(frame.healthyTerminal.observation.runId, surface.healthy.runId)
    assert.equal(frame.healthyTerminal.observation.visible, true); assert.equal(frame.healthyTerminal.observation.liveReady, true)
    assert.ok(frame.healthyTerminal.text.includes('codex-ready:')); assert.ok(frame.draft)
  }
  return { task: 'T004-initial-wait-native', receipt: file, sha256: hash(bytes), sourceInputs,
    frames: surface.frames.map(({ file, sha256, width }) => ({ file, sha256, width })), original: surface.original, healthy: surface.healthy }
}
