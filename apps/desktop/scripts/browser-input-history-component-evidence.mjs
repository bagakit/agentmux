import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = (rows, label) => assert.ok(Array.isArray(rows) && rows.length > 0, label + ' is nonempty')
async function original(root, row, compressed = false) {
  assert.ok(row && typeof row.path === 'string' && row.path && !isAbsolute(row.path), 'Original path is relative')
  const path = resolve(root, row.path)
  assert.ok(relative(root, path) && !relative(root, path).startsWith('..'), 'Original path stays in its receipt directory')
  assert.ok(Number.isInteger(row.bytes) && row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256), 'Original byte identity is nonempty')
  const stored = await readFile(path), bytes = compressed ? gunzipSync(stored) : stored
  assert.equal(bytes.length, row.bytes, 'Original byte count matches: ' + row.path)
  assert.equal(hash(bytes), row.sha256, 'Original hash matches: ' + row.path)
  return bytes
}
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

/** Consume only the actual partial producer. This cannot certify the full T026 Native acceptance. */
export async function consumeHistoryComponentEvidence(receipt, identity, root, reviewOriginal, report) {
  assert.equal(receipt.scope, 'actual-shared-component-private-bridge-store-native-overlay')
  assert.equal(receipt.taskComplete, false, 'A component probe must not claim task completion')
  nonempty(receipt.phases, 'Actual private phases')
  assert.deepEqual(receipt.phases.map(row => row.phase), ['first', 'second'], 'Two actual private phases are present')
  const phases = []
  for (const row of receipt.phases) {
    assert.ok(Number.isInteger(row.process?.pid) && row.process.pid > 0)
    assert.equal(row.process.exit, 0); assert.equal(row.process.timedOut, false)
    const phase = json(await original(root, row.original))
    assert.equal(phase.pid, row.process.pid, 'Raw PID matches the actual process')
    assert.equal(phase.phase, row.phase); assert.equal(phase.phaseCompleted, true)
    assert.equal(phase.productCallerNativeMounted, false); assert.equal(phase.fullDesktopRestore, false)
    phases.push(phase)
  }
  assert.notEqual(phases[0].pid, phases[1].pid, 'Durable recovery has two different actual Native PIDs')
  const [first, second] = phases
  if (reviewOriginal) {
    const review = reviewOriginal.receipt
    assert.equal(review.schema, 'agentmux.browser-input-history-independent-visual-review.v1')
    assert.equal(review.author, receipt.author, 'Visual review binds the actual producer author')
    assert.ok(typeof review.reviewer === 'string' && review.reviewer && review.reviewer !== review.author, 'The visual reviewer is separate from the author')
    assert.equal(review.receipt?.sha256, identity.sha256, 'Visual review binds this exact receipt')
    assert.equal(review.receipt.bytes, identity.bytes)
    assert.deepEqual(review.candidate, receipt.source?.candidate, 'Visual review binds this candidate metadata')
    nonempty(review.images, 'Actually reviewed original images')
    nonempty(first.images, 'Actual captured original images')
    assert.equal(review.images.length, first.images.length)
    assert.equal(new Set(review.images.map(row => row.path)).size, review.images.length, 'Reviewed original paths are unique')
    assert.equal(new Set(first.images.map(row => row.path)).size, first.images.length, 'Captured original paths are unique')
    for (const row of review.images) {
      assert.equal(row.actuallyViewed, true); assert.equal(row.viewedUsing, 'view_image')
      const captured = first.images.find(image => image.path === row.path)
      assert.ok(captured)
      assert.deepEqual(['phase', 'label', 'kind', 'path', 'sha256', 'bytes'].map(key => row[key]),
        ['phase', 'label', 'kind', 'path', 'sha256', 'bytes'].map(key => captured[key]), 'Reviewed image binds the actual case/phase/kind original')
      await original(root, captured)
    }
    assert.equal(typeof review.passed, 'boolean'); assert.equal(typeof review.originalPageComposedVisibilityPassed, 'boolean')
    if (review.originalPageComposedVisibilityPassed) {
      const osKinds = ['actual-exact-pid-composed-window', 'actual-native-window-screencapture']
      const osImages = first.images.filter(image => osKinds.includes(image.kind))
      assert.deepEqual([...new Set(osImages.map(image => image.label))].sort(), ['narrow', 'normal', 'short'], 'Three current cases have actual OS composed-window originals')
      for (const image of osImages) {
        assert.equal(image.phase, first.phase); assert.equal(image.pid, first.pid)
        assert.ok(Number.isInteger(image.windowId) && image.windowId > 0)
        const viewed = review.images.find(row => row.path === image.path)
        assert.equal(viewed.originalPageComposedVisibilityPassed, true); assert.equal(viewed.pid, image.pid); assert.equal(viewed.windowId, image.windowId)
        const metadata = json(await original(root, image.metadata))
        if (image.kind === 'actual-exact-pid-composed-window') {
          assert.equal(metadata.listed.result.app.pid, image.pid)
          assert.equal(metadata.captured.result.snapshot.app.pid, image.pid); assert.equal(metadata.captured.result.snapshot.window.id, image.windowId)
          assert.equal(metadata.captured.result.screenshotStatus.state, 'captured')
          assert.equal(metadata.captured.result.screenshotStatus.metadata.windowId, image.windowId)
        } else {
          assert.equal(metadata.api, '/usr/sbin/screencapture'); assert.equal(metadata.pid, image.pid); assert.equal(metadata.windowId, image.windowId)
          assert.equal(metadata.mediaSourceId.split(':')[1], String(image.windowId))
        }
      }
    }
    report.visualReview = { ...reviewOriginal.identity, passed: review.passed, originalPageComposedVisibilityPassed: review.originalPageComposedVisibilityPassed,
      passedHistoryListAesthetics: review.passedHistoryListAesthetics === true, reviewedImages: review.images.length }
  }
  // The older immutable passed:true probe is deliberately not promoted to this partial behavior contract.
  assert.equal(receipt.passed, false, 'The component producer does not sign overall Native acceptance')
  assert.equal(receipt.behaviorPassed, true, 'Actual component behavior completed')
  assert.equal(receipt.sourceMutation, undefined, 'A mutated producer cannot be consumed as behavior evidence')
  assert.deepEqual(receipt.source.drift, [], 'The actual related Source did not drift during execution')
  nonempty(receipt.source.inputs, 'Actual emitted Source originals')
  const sourcePaths = new Set()
  for (const row of receipt.source.inputs) {
    assert.ok(typeof row.sourcePath === 'string' && row.sourcePath); assert.ok(!sourcePaths.has(row.sourcePath))
    sourcePaths.add(row.sourcePath); assert.equal(row.compression, 'gzip')
    await original(root, { ...row, path: row.snapshot }, true)
  }
  nonempty(receipt.compiled, 'Actual compiled originals')
  const compiled = new Map()
  for (const row of receipt.compiled) {
    assert.ok(typeof row.name === 'string' && row.name && !compiled.has(row.name)); compiled.set(row.name, row)
    await original(root, { ...row, path: row.snapshot }, true)
  }
  const missingInAnyPhase = new Set()
  for (const phase of phases) {
    assert.equal(phase.behaviorPassed, true); assert.equal(phase.passed, false)
    assert.ok(phase.owner?.scope?.workspaceId && phase.owner.scope.profileId && phase.owner.navigationId)
    assert.ok(phase.owner.pageWebContentsId > 0 && phase.owner.rendererWebContentsId > 0)
    assert.notEqual(phase.owner.pageWebContentsId, phase.owner.rendererWebContentsId)
    for (const frame of [phase.owner.pageFrame, phase.owner.rendererFrame]) assert.ok(frame?.processId > 0 && frame.routingId > 0)
    nonempty(phase.loaded, 'Actual process-loaded artifact identities')
    const loadedNames = new Set(phase.loaded.map(row => row.name))
    for (const name of compiled.keys()) {
      if (!loadedNames.has(name)) missingInAnyPhase.add(name)
      if (name !== 'index.html') assert.ok(loadedNames.has(name), 'Every actually executed bundle has a process-loaded identity')
    }
    for (const loaded of phase.loaded) {
      const artifact = compiled.get(loaded.name); assert.ok(artifact, 'The actual loaded artifact was archived')
      assert.equal(loaded.sha256, artifact.sha256, 'Actual loaded hash matches compiled original')
      assert.equal(loaded.bytes, artifact.bytes)
    }
    nonempty(phase.calls, 'Actual history IPC calls')
    for (const call of phase.calls) {
      assert.equal(call.senderWebContentsId, phase.owner.rendererWebContentsId, 'History IPC uses the actual Renderer owner')
      assert.deepEqual(call.scope, phase.owner.scope, 'History IPC uses the actual resource scope')
      assert.ok(call.returnedAt >= call.at, 'Actual IPC returned')
    }
    nonempty(phase.actions, 'Actual Native input actions')
    for (const action of phase.actions) {
      assert.equal(action.api, 'actual-renderer-CDP'); assert.equal(action.webContentsId, phase.owner.rendererWebContentsId)
    }
  }
  assert.deepEqual([...new Set(phases.flatMap(phase => phase.calls.map(call => call.method)))].sort(),
    ['clearInputHistory', 'listInputHistory', 'recordInputHistory', 'removeInputHistory'])
  assert.deepEqual(second.owner.scope, first.owner.scope)
  nonempty(first.durable?.saved?.entries, 'Actual saved history')
  assert.deepEqual(first.durable.saved, second.durable?.recovered, 'Second actual Native process recovered the original history')
  assert.deepEqual(second.durable.afterDeletion.entries, [], 'Actual deletion persisted an empty history')
  for (const [phase, outcome, descriptor] of [[first, 'saved', 'file'], [second, 'recovered', 'file'], [second, 'afterDeletion', 'afterDeletionFile']]) {
    const saved = json(await original(root, phase.durable[descriptor]))
    assert.deepEqual(saved.scope, phase.owner.scope); assert.deepEqual(saved.entries, phase.durable[outcome].entries, 'Durable file matches actual observed outcome')
  }
  nonempty(first.assertions, 'Actual component observations')
  const late = first.assertions.find(row => row.label === 'late-main-list-keeps-draft-selection-focus')
  assert.ok(late?.before?.value && Array.isArray(late.before.selection) && late.before.selection.length === 2)
  assert.equal(late.after.value, late.before.value); assert.deepEqual(late.after.selection, late.before.selection, 'Late response preserved selection')
  assert.equal(late.after.focused, late.before.focused)
  const ime = first.assertions.find(row => row.label === 'actual-CDP-composition-no-implicit-submit')
  assert.ok(ime); nonempty(ime.composition, 'Actual CDP composition events')
  assert.ok(ime.composition.some(event => event.type === 'compositionstart' && event.trusted === true), 'Actual composition start was trusted')
  const composingEnter = ime.during.events.filter(event => event.type === 'keydown' && event.key === 'Enter' && event.isComposing === true && event.trusted === true)
  nonempty(composingEnter, 'Actual composing Enter events')
  assert.ok(!ime.during.submissions.some(submission => submission.at >= composingEnter[0].at), 'Actual composing Enter did not submit')
  assert.equal(ime.trustedCommitObserved, false); assert.equal(ime.osNativeImeCommit, 'not-tested')
  const cases = first.assertions.filter(row => row.label.startsWith('actual-') && row.label.endsWith('-history'))
  assert.deepEqual(cases.map(row => row.label), ['actual-normal-history', 'actual-narrow-history', 'actual-short-history'])
  nonempty(first.actualNativeInput, 'Actual Native overlay publications')
  for (const row of cases) {
    assert.ok(row.facts.options.length > 0 && row.facts.panel.width > 0 && row.facts.panel.height > 0)
    assert.equal(row.publication.pageOwner.width, Math.ceil(row.geometry.paneWidth))
    assert.equal(row.publication.pageOwner.height, row.geometry.contentHeight - 118)
    assert.ok(row.publication.result.projected > 0)
    assert.ok(first.actualNativeInput.some(publication => publication.at === row.publication.at && publication.kind === 'overlay-publication'))
    nonempty(row.publication.regions, 'Current geometry overlay regions')
    assert.ok(row.publication.regions.some(region => ['x', 'y', 'width', 'height'].every(key => Math.abs(region.bounds[key] - row.facts.panel[key]) < 1)))
    const label = row.label.slice(7, -8)
    assert.deepEqual(first.images.filter(image => image.label === label && ['renderer-chrome', 'original-native-page'].includes(image.kind)).map(image => image.kind),
      ['renderer-chrome', 'original-native-page'], 'This case has both actual WC originals')
  }
  nonempty(first.images, 'Actual component PNG originals')
  for (const row of first.images) await original(root, row)
  report.component = { behaviorVerified: true, scope: receipt.scope, actualPids: phases.map(phase => phase.pid), sourceOriginalCount: sourcePaths.size,
    compiledOriginalCount: compiled.size, loadedArtifactsNotBoundInBothPhases: [...missingInAnyPhase], imagesVerified: first.images.length,
    actualHistoryScope: first.owner.scope, durableRecoveredAndDeleted: true, lateDraftSelectionPreserved: true, cdpCompositionEnterBoundary: true,
    productCallerNativeMounted: false, productionRegisterIpc: false, osNativeImeCommit: 'not-tested', composedPageVisibility: report.visualReview?.originalPageComposedVisibilityPassed ?? 'not-reviewed' }
}
