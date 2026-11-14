const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { observe, requestOriginalStop, paintObservation, movingMiddle, verifyClockSample, verifyPaintedAdvance } = require('./list-feedback.cjs')

const labels = ['list-feedback-wide-dark-message-middle', 'list-feedback-stop-failed']
const prefix = 'apps/desktop/scripts/fixtures/agent-collaboration-graph/'
const requiredHarness = [prefix + 'list-feedback-visual-refresh.cjs', prefix + 'list-feedback.cjs', prefix + 'main.cjs', prefix + 'entry.tsx', 'apps/desktop/scripts/capture-agent-collaboration-graph.mjs']
const productFiles = ['components/GlobalFocusSurface.tsx', 'components/FocusContextCards.tsx', 'components/FocusContextCardBody.tsx', 'components/FocusContextRow.tsx',
  'components/AgentOperationFeedback.tsx', 'lib/focus-list-activity.ts', 'lib/use-collaboration-reading.ts', 'styles/focus.css', 'styles/agent-operation-feedback.css']
  .map(file => 'apps/desktop/src/renderer/src/' + file)
const digest = value => createHash('sha256').update(value).digest('hex')
const mapDigest = value => digest(JSON.stringify(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)))
const cardSelector = subject => `.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`

function detailObservation(subject, operationId) {
  const card = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`)
  const item = [...card?.querySelectorAll('.agent-operation-feedback__item') ?? []].find(value => value.querySelector('code')?.textContent === operationId)
  if (!item) return null
  const summary = item.querySelector('summary.agent-operation-feedback__label'), detail = item.querySelector('.agent-operation-feedback__detail'), actions = detail?.querySelector('.agent-operation-feedback__actions')
  const owners = []; let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
  for (let owner = item.parentElement; owner; owner = owner.parentElement) {
    const style = getComputedStyle(owner), bounds = owner.getBoundingClientRect()
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right) }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom) }
    if (/auto|scroll/.test(style.overflowY)) owners.push({ className: owner.className, scrollTop: owner.scrollTop, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight })
  }
  const target = element => {
    if (!element) return null
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element)
    const hits = [.1, .5, .9].flatMap(horizontal => [.1, .5, .9].map(vertical => {
      const point = { x: bounds.left + bounds.width * horizontal, y: bounds.top + bounds.height * vertical }, hit = document.elementFromPoint(point.x, point.y)
      return { ...point, hit: element.contains(hit), top: hit ? { tag: hit.tagName, className: hit.getAttribute('class') } : null }
    }))
    return { bounds: bounds.toJSON(), visible: element.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
      opacity: style.opacity, hits, text: element.textContent, insideClip: bounds.left >= clip.left - .5 && bounds.top >= clip.top - .5 && bounds.right <= clip.right + .5 && bounds.bottom <= clip.bottom + .5 }
  }
  return { hostId: subject.hostId, agentSessionId: subject.agentSessionId, operationId, phase: item.dataset.phase, open: item.open, viewport: [innerWidth, innerHeight], theme: getComputedStyle(document.documentElement).colorScheme,
    expanded: summary?.getAttribute('aria-expanded'), describedDetail: summary?.getAttribute('aria-controls'), detailId: detail?.id,
    inert: detail?.inert, ariaHidden: detail?.getAttribute('aria-hidden'), summary: target(summary), detail: target(detail), actions: target(actions),
    buttons: [...actions?.querySelectorAll('button') ?? []].map(button => ({ text: button.textContent.trim(), disabled: button.disabled, ...target(button) })),
    finiteAnimations: item.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation => ({ name: animation.animationName, state: animation.playState })),
    clip, owners, readerPresent: Boolean(document.querySelector('.agent-information-reader')), footers: [...document.querySelectorAll('.focus-project-lanes__footer')].map(element => element.getBoundingClientRect().toJSON()) }
}

function verifyMiddle(data) {
  assert.equal(data.failure, undefined, data.failure)
  verifyPaintedAdvance(data.previous, data.before); verifyClockSample(data.after)
  assert.ok(data.originalMarksRetainedAcrossRAF && data.originalAnimationsRetainedAcrossRAF && data.after.at >= data.before.at)
  for (const name of ['sender', 'recipient']) {
    const before = data.before.clocks[name], after = data.after.clocks[name]
    assert.notEqual(data.before.cards[name].feedback.pulseId, data.previousPulseIds[name])
    assert.equal(data.before.cards[name].feedback.pulseId, data.after.cards[name].feedback.pulseId)
    assert.equal(before.startTime, after.startTime); assert.equal(before.delay, after.delay); assert.equal(before.duration, after.duration)
    assert.ok(after.currentTime >= before.currentTime)
  }
  assert.equal(data.event.live, true); assert.ok(data.event.wallAfter >= data.event.wallBefore)
}

function verifyDetail(value, request) {
  assert.ok(value && value.open && !value.inert && value.ariaHidden === 'false' && value.expanded === 'true')
  assert.equal(value.operationId, request.operationId); assert.equal(value.hostId, request.control.hostId); assert.equal(value.agentSessionId, request.control.agentSessionId)
  assert.equal(value.phase, 'failed'); assert.ok(value.detailId && value.detailId === value.describedDetail)
  assert.equal(value.theme, 'dark'); assert.deepEqual(value.viewport, [1440, 900])
  for (const target of [value.summary, value.detail, value.actions]) assert.ok(target?.visible && target.insideClip && Number(target.opacity) > 0 && target.hits.length === 9 && target.hits.every(point => point.hit), 'The same original failed detail and actions must be completely exposed and hit-testable')
  assert.ok(value.detail.text.includes(request.operationId)); assert.ok(value.detail.text.includes(request.control.run.runId))
  assert.ok(value.buttons.some(button => button.text === '核对原操作' && !button.disabled && button.visible && button.insideClip && button.hits.every(point => point.hit)))
}

function qualification(receipt) {
  assert.equal(receipt.schema, 'agentmux.collaboration-graph-capture.v1'); assert.equal(receipt.scenario, 'focus-map-list-feedback')
  assert.equal(receipt.compilation?.phase, 'complete'); assert.ok(receipt.compilation.sourceOverlay?.revision)
  assert.ok(Object.keys(receipt.inputs ?? {}).length > 0 && Object.keys(receipt.outputs ?? {}).length > 0 && Object.keys(receipt.harness ?? {}).length > 0)
  const sources = Object.fromEntries(productFiles.map(file => {
    assert.ok(/^[a-f\d]{64}$/.test(receipt.inputs[file])); assert.equal(receipt.compilation.sourceOverlay.files[file]?.sha256, receipt.inputs[file]); return [file, receipt.inputs[file]]
  }))
  const harness = Object.fromEntries(requiredHarness.map(file => { assert.ok(/^[a-f\d]{64}$/.test(receipt.harness[file]), 'Declare the exact visual refresh harness: ' + file); return [file, receipt.harness[file]] }))
  for (const file of productFiles.filter(file => file.endsWith('.css'))) {
    const css = receipt.compilation.cssSourceProof?.loaded?.[file]
    assert.equal(css?.sourceSHA256, sources[file]); assert.ok(css.reads?.length > 0)
  }
  return { productRevision: receipt.compilation.sourceOverlay.revision, sources, sourceInputsSHA256: mapDigest(receipt.inputs), compiledOutputsSHA256: mapDigest(receipt.outputs),
    cssQualificationSHA256: digest(JSON.stringify(receipt.compilation.cssSourceProof)), harness, harnessManifestSHA256: mapDigest(receipt.harness) }
}

function verify(data, captured, receipt) {
  assert.equal(data?.schema, 'agentmux.focus-list-visual-refresh.v1'); assert.equal(data.passed, true)
  assert.deepEqual(data.identity, qualification(receipt)); assert.deepEqual(data.identityAfter, data.identity)
  assert.deepEqual(captured.map(frame => frame.label), labels); assert.deepEqual(data.frames.map(frame => frame.label), labels)
  for (let index = 0; index < labels.length; index++) {
    assert.equal(captured[index].file, labels[index] + '.png'); assert.deepEqual(captured[index].viewport, [1440, 900])
    assert.equal(data.frames[index].file, captured[index].file); assert.ok(/^[a-f\d]{64}$/.test(data.frames[index].sha256))
    if (captured[index].sha256 !== undefined) assert.equal(captured[index].sha256, data.frames[index].sha256)
  }
  assert.equal(data.window.afterShow.focused, data.window.beforeShow.focused, 'showInactive must not take native focus')
  assert.equal(data.window.afterShow.visible, true); verifyMiddle(data.middle)
  assert.deepEqual(data.beforeStop.controls, data.original.controls, 'Preparing the new middle performs no lifecycle request')
  const failed = data.failed, request = failed.request
  assert.equal(failed.summaryClicked, true); assert.equal(failed.opened.operationId, request.operationId)
  assert.equal(failed.opened.detailId, failed.before.detailId); verifyDetail(failed.before, request); verifyDetail(failed.after, request)
  assert.equal(failed.statusAfter.calls.length, failed.statusBefore.calls.length + (failed.sentOriginalRequest ? 1 : 0))
  const capturedCall = failed.statusAfter.calls.find(call => call.operationId === request.operationId)
  assert.ok(capturedCall?.settled); assert.deepEqual(capturedCall.control, request.control)
  const operation = Object.values(failed.statusAfter.operations).find(value => value.operationId === request.operationId && value.control?.hostId === request.control.hostId && value.control?.agentSessionId === request.control.agentSessionId)
  assert.equal(operation?.phase, 'failed'); assert.deepEqual(operation.control, request.control)
  assert.deepEqual(failed.statusBefore.originalRuns.find(control => control.hostId === request.control.hostId && control.agentSessionId === request.control.agentSessionId), request.control)
  assert.deepEqual(failed.statusAfter.originalRuns, failed.statusBefore.originalRuns)
  assert.equal(failed.statusAfter.draft, failed.statusBefore.draft)
  assert.deepEqual(data.after.controls, [...data.original.controls, ...(failed.sentOriginalRequest ? ['stop'] : [])])
  for (const field of ['sameTabs', 'layoutsPreserved', 'sameDrafts', 'draftMounted', 'sameDraft']) assert.equal(data.after[field], true)
  for (const field of ['draft', 'storedDraft', 'range', 'originalRun']) assert.deepEqual(data.after[field], data.original[field])
}

module.exports = async function visualRefresh(ctx) {
  const { win, result, read, click, frame, check, facts, until, settle, evidence } = ctx
  assert.equal(result.frames.length, 0, 'This independent refresh captures only two new PNGs; it does not rerun or adopt the old full scene')
  const root = path.resolve(__dirname, '../../../../..'), receiptFile = path.join(evidence, 'receipt.json')
  for (const name of [...labels.map(label => label + '.png'), 'list-feedback-visual-refresh.json']) {
    try { await fs.lstat(path.join(evidence, name)); assert.fail('Preserve prior visual evidence; use a new refresh directory: ' + name) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const parent = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
  const data = result.listFeedbackVisualRefresh = { schema: 'agentmux.focus-list-visual-refresh.v1', passed: false, identity: qualification(parent), frames: [],
    boundary: 'Only two new full-window native PNGs, independently qualified current product/harness and this fixture original Stop. No old PNG/operation adoption, cost execution, animation manipulation, Reader/footer hiding, focus assignment or Provider/Run completion claim.' }
  const checkHarness = async () => { for (const [file, hash] of Object.entries(data.identity.harness)) assert.equal(digest(await fs.readFile(path.join(root, file))), hash) }
  await checkHarness()
  const subjects = await read('window.graphCapture.listSubjects()'), probe = `(${paintObservation.toString()})(${observe.toString()},${JSON.stringify(subjects)})`
  const detailProbe = operationId => `(${detailObservation.toString()})(${JSON.stringify(subjects.neighbor)},${JSON.stringify(operationId)})`
  data.original = await facts()
  const guarded = async (name, action) => { await check(name, action); if (result.failures.length) throw Error('Visual refresh stops at the first original observation failure: ' + name) }
  const collectFrame = async label => {
    const descriptor = result.frames.find(value => value.label === label)
    assert.ok(descriptor); data.frames.push({ ...descriptor, sha256: digest(await fs.readFile(path.join(evidence, descriptor.file))) })
  }
  try {
    await click('button.surface-navigation__focus'); await click('[aria-label="List"]')
    await read('window.graphCapture.appearance("dark")'); win.setContentSize(1440, 900)
    data.window = { beforeShow: { visible: win.isVisible(), focused: win.isFocused() } }
    win.showInactive(); result.conditions.privateWindowShown = true
    data.window.afterShow = { visible: win.isVisible(), focused: win.isFocused() }
    assert.equal(data.window.afterShow.focused, data.window.beforeShow.focused)
    await until('original shown List ready', () => read(`(()=>{const element=document.querySelector(${JSON.stringify(cardSelector(subjects.sender))});return !document.hidden&&Boolean(element?.querySelector('button.focus-context'))})()`))
    await read(`document.querySelector(${JSON.stringify(cardSelector(subjects.sender))}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`); await settle()
    await guarded('list-visual-refresh-painted-middle', async () => {
      data.middle = await read(`(${movingMiddle.toString()})(${observe.toString()},${paintObservation.toString()},${JSON.stringify(subjects)})`)
      assert.equal(data.middle.failure, undefined, data.middle.failure)
      verifyPaintedAdvance(data.middle.previous, data.middle.before)
      data.middle.after = await frame(labels[0], { motion: true, immediateObservation: probe })
      verifyMiddle(data.middle); await collectFrame(labels[0])
    })
    await guarded('list-visual-refresh-original-failed-detail', async () => {
      data.beforeStop = await facts()
      const before = await read('window.graphCapture.listStopStatus()'), subject = subjects.neighbor
      const held = before.calls.filter(call => call.control.hostId === subject.hostId && call.control.agentSessionId === subject.agentSessionId)
      data.failed = { statusBefore: before, sentOriginalRequest: held.length === 0 }
      let request
      if (held.length) {
        assert.equal(held.length, 1, 'Do not replay or choose among existing Stop requests')
        request = held[0]
        const operation = Object.values(before.operations).find(value => value.operationId === request.operationId && value.control?.hostId === subject.hostId && value.control?.agentSessionId === subject.agentSessionId)
        assert.ok(request.settled && operation?.phase === 'failed', 'Keep any existing pending/unconfirmed original request; a visual refresh must not resend or settle it')
      } else {
        assert.ok(!Object.values(before.operations).some(operation => operation.kind === 'stop' && operation.subject.hostId === subject.hostId && operation.subject.agentSessionId === subject.agentSessionId), 'Keep an existing original Stop reference without manufacturing a new request')
        request = await requestOriginalStop(ctx, subjects, 'neighbor')
        data.failed.rejection = { code: 'STALE_AGENT_SESSION', message: 'Private typed Stop result identifies this original Run as stale.' }
        await read(`window.graphCapture.listRejectStop(${JSON.stringify(request.operationId)},${JSON.stringify(data.failed.rejection)})`)
      }
      data.failed.request = request
      await until('same original failed operation', async () => (await read(detailProbe(request.operationId)))?.phase === 'failed')
      const marked = await read(`(()=>{const card=document.querySelector(${JSON.stringify(cardSelector(subject))}),item=[...card.querySelectorAll('.agent-operation-feedback__item')].find(item=>item.querySelector('code')?.textContent===${JSON.stringify(request.operationId)});if(!item||item.open)return false;item.setAttribute('data-list-visual-refresh-operation',${JSON.stringify(request.operationId)});item.querySelector('summary').scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return true})()`)
      assert.equal(marked, true, 'Click open the same closed original operation, not another request or pre-opened reader')
      await settle()
      await click(`[data-list-visual-refresh-operation=${JSON.stringify(request.operationId)}] summary.agent-operation-feedback__label`)
      data.failed.summaryClicked = true; data.failed.opened = await read(detailProbe(request.operationId))
      assert.ok(data.failed.opened?.open)
      data.failed.reveal = await read(`(()=>{const item=document.querySelector('[data-list-visual-refresh-operation='+${JSON.stringify(JSON.stringify(request.operationId))}+']'),detail=item.querySelector('.agent-operation-feedback__detail'),actions=detail.querySelector('.agent-operation-feedback__actions');const before={item:item.getBoundingClientRect().toJSON(),detail:detail.getBoundingClientRect().toJSON(),actions:actions.getBoundingClientRect().toJSON()};item.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});detail.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});actions.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return before})()`)
      data.failed.revealSamples = []
      await until('same detail and original actions are exposed', async () => {
        const current = await read(detailProbe(request.operationId))
        if (data.failed.revealSamples.length < 8) data.failed.revealSamples.push(current)
        data.failed.lastReveal = current
        if (!current || current.finiteAnimations.some(animation => animation.state === 'running')) return false
        try { verifyDetail(current, request); return true } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; data.failed.lastRevealIssue = error.message; return false }
      })
      data.failed.before = await read(detailProbe(request.operationId)); verifyDetail(data.failed.before, request)
      await frame(labels[1]); data.failed.after = await read(detailProbe(request.operationId)); verifyDetail(data.failed.after, request)
      data.failed.statusAfter = await read('window.graphCapture.listStopStatus()'); await collectFrame(labels[1])
    })
    data.after = await facts(); await checkHarness(); data.identityAfter = qualification(JSON.parse(await fs.readFile(receiptFile, 'utf8')))
    data.passed = true
    try { verify(data, result.frames, parent) } catch (error) { data.passed = false; throw error }
  } finally { await fs.writeFile(path.join(evidence, 'list-feedback-visual-refresh.json'), JSON.stringify(data, null, 2) + '\n') }
}
module.exports.verify = verify
module.exports.verifyClockSample = verifyClockSample
module.exports.verifyPaintedAdvance = verifyPaintedAdvance
module.exports.paintObservation = paintObservation
module.exports.verifyMiddle = verifyMiddle
module.exports.verifyDetail = verifyDetail
module.exports.labels = labels
module.exports.requiredHarness = requiredHarness
