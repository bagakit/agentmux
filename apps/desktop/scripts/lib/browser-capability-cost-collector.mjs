import assert from 'node:assert/strict'

const integer = (value, message) => assert.ok(Number.isSafeInteger(value) && value >= 0, message)
const nonempty = (values, message) => assert.ok(Array.isArray(values) && values.length > 0, message)
const terminal = event => event.event.type === 'phase-changed' && event.event.phase === 'completed'

/** Exact physical reads and returned slices from the original saved extraction. */
export function summarizeBrowserOutcomeCollection(recorded, operation) {
  assert.equal(operation.phase, 'completed', 'Consume an already completed producer')
  assert.equal(recorded.artifact.operationId, operation.id, 'Artifact belongs to another producer')
  assert.equal(recorded.artifact.browserId, operation.browserId, 'Artifact belongs to another Browser')
  assert.equal(recorded.source.operationId, operation.id)
  assert.deepEqual(recorded.document.source, recorded.source)
  assert.equal(recorded.document.schema, 'browser-structured-output.v1')
  assert.equal(recorded.byteLength, recorded.artifact.byteLength)
  nonempty(operation.steps, 'Require actual original producer steps')
  const extracts = operation.steps.filter(step => step.method === 'extractStructured')
  nonempty(extracts, 'Require actual extraction calls, not property read counts')
  assert.ok(extracts.every(step => step.status === 'completed'))
  assert.equal(new Set(extracts.map(step => step.sequence)).size, extracts.length)
  const work = recorded.document.work
  for (const key of ['reads', 'readBytes', 'visitedElements', 'elementWalkSteps', 'selectorChecks', 'textNodes', 'textWalkSteps']) integer(work[key], `Require actual DOM work: ${key}`)
  assert.ok(work.reads > 0 && work.visitedElements > 0)
  nonempty(recorded.chunks, 'Require actual raw artifact read chunks')
  let offset = 0, returnedBytes = 0, physicalMetadataBytes = 0, physicalPayloadBytes = 0
  for (const chunk of recorded.chunks) {
    assert.equal(chunk.offset, offset, 'Raw returned chunks must cover the saved payload in order')
    assert.ok(Number.isSafeInteger(chunk.returnedBytes) && chunk.returnedBytes > 0)
    integer(chunk.readCost.metadataBytes, 'Require actual physical metadata bytes')
    integer(chunk.readCost.payloadBytes, 'Require actual physical payload bytes')
    assert.ok(chunk.readCost.metadataBytes > 0 && chunk.readCost.payloadBytes >= chunk.returnedBytes, 'Physical reads cannot be replaced by returned slice length')
    offset += chunk.returnedBytes; returnedBytes += chunk.returnedBytes
    physicalMetadataBytes += chunk.readCost.metadataBytes; physicalPayloadBytes += chunk.readCost.payloadBytes
    assert.equal(chunk.nextOffset, offset === recorded.artifact.byteLength ? null : offset)
  }
  assert.equal(offset, recorded.artifact.byteLength, 'Actual raw reads must consume the complete saved payload')
  return { extractCalls: extracts.length, extractStepSequences: extracts.map(step => step.sequence),
    visitedElements: work.visitedElements, attributeReads: work.reads, attributeReadBytes: work.readBytes,
    persistedPayloadBytes: recorded.artifact.byteLength, returnedBytes, physicalMetadataBytes, physicalPayloadBytes }
}

function validateJournalSample(sample, expectedOperationId) {
  assert.equal(sample.operationId, expectedOperationId)
  assert.ok(sample.opened && sample.opened.runOperation?.id === expectedOperationId, 'Require an actual public stream opening')
  assert.equal(sample.opened.runOperation.browserId, sample.browserId)
  integer(sample.afterSequence, 'Require an actual subscription cursor')
  assert.equal(sample.opened.gap, null, 'A stream gap cannot sign a complete observation')
  assert.ok(Array.isArray(sample.events) && Array.isArray(sample.ends))
  let last = sample.afterSequence
  for (const item of sample.events) {
    assert.equal(item.event.operationId, expectedOperationId, 'A stream callback belongs to another operation')
    assert.ok(Number.isSafeInteger(item.sequence) && item.sequence > last, 'Actual delivered event sequence must be ordered and unique')
    last = item.sequence
  }
  nonempty(sample.ends, 'Require the observed public stream close after disposal')
  assert.ok(sample.ends.every(end => end.reason === 'closed' && !end.error), 'Public stream errors cannot sign zero delivery')
  assert.ok(Number.isSafeInteger(sample.opened.at) && Number.isSafeInteger(sample.disposedAt) && sample.disposedAt >= sample.opened.at)
}

/** Shared exact consumer of the Native collector packet; no manual aggregate is trusted. */
export function assertNativeBrowserMeasurements(value) {
  assert.equal(value.schema, 'agentmux.browser-capability-native-measurements.v1')
  assert.equal(value.passed, true)
  assert.equal(value.boundary, 'native-producer-and-public-journal')
  assert.match(value.candidateCommit, /^[a-f0-9]{40}$/)
  assert.ok(value.sourceIdentity && Object.keys(value.sourceIdentity).length > 0)
  assert.deepEqual(value.producer.totals, summarizeBrowserOutcomeCollection(value.producer.recordedResult, value.producer.operation), 'Collection totals must derive from raw original facts')
  const { preparation, related, unrelated, window } = value.journal
  validateJournalSample(preparation, unrelated.operationId)
  validateJournalSample(related, value.producer.operation.id)
  validateJournalSample(unrelated, unrelated.operationId)
  assert.notEqual(related.operationId, unrelated.operationId, 'An unrelated sample must be another real operation')
  assert.notEqual(related.browserId, unrelated.browserId, 'An unrelated sample must be another actual Browser')
  nonempty(preparation.events, 'The unrelated cursor must come from a real nonempty prior replay')
  assert.equal(preparation.afterSequence, 0, 'Require the complete prior replay from its actual beginning')
  assert.ok(terminal(preparation.events.at(-1)), 'The actual prior replay must finish with the completed operation')
  assert.equal(unrelated.afterSequence, preparation.events.at(-1).sequence, 'Use the actual prior final sequence, not an array index')
  assert.equal(related.afterSequence, 0)
  nonempty(related.events, 'Require actual related public callback deliveries')
  assert.ok(related.events.some(terminal), 'Require actual completed producer replay')
  assert.equal(unrelated.events.length, 0, 'Unrelated actual callbacks must remain zero in the observed window')
  assert.ok(Number.isSafeInteger(window.startedAt) && Number.isSafeInteger(window.endedAt) && window.endedAt > window.startedAt)
  assert.equal(window.fixedQuietWindowMs, 100)
  assert.ok(window.endedAt - window.bothOpenedAt >= window.fixedQuietWindowMs, 'Require the complete actual fixed observation window')
  assert.ok(window.bothOpenedAt >= window.startedAt && related.opened.at <= window.bothOpenedAt && unrelated.opened.at <= window.bothOpenedAt)
  assert.ok(related.disposedAt >= window.endedAt && unrelated.disposedAt >= window.endedAt)
}

/** Read original facts and subscribe through the actual scoped Core public boundary; never execute an extraction or start an App/Run. */
export async function collectBrowserCapabilityMeasurements(ctx, { relatedOperationId, siblingBrowserId }) {
  const recordedResult = ctx.receipt.browserOutcome.recordedResult
  assert.equal(recordedResult.artifact.operationId, relatedOperationId)
  const reply = await ctx.requestControl({ operation: 'browser.operation', operationId: relatedOperationId })
  assert.equal(reply.ok, true); assert.equal(reply.operation, 'browser.operation')
  const operation = reply.result.runOperation
  const history = await ctx.requestControl({ operation: 'browser.history', browserId: siblingBrowserId })
  assert.equal(history.ok, true); assert.equal(history.operation, 'browser.history')
  nonempty(history.result.operations, 'Require an existing actual sibling operation; the caller owns any explicit baseline observation')
  const sibling = history.result.operations.find(item => item.browserId === siblingBrowserId && item.phase === 'completed')
  assert.ok(sibling, 'Require an existing completed sibling operation')
  const open = async (actual, afterSequence) => {
    const sample = { operationId: actual.id, browserId: actual.browserId, afterSequence, events: [], ends: [] }
    const stream = await ctx.subscribeControl({ operation: 'browser.subscribe', operationId: actual.id, afterSequence }, {
      onEvent: event => sample.events.push(structuredClone(event)),
      onEnd: (reason, error) => sample.ends.push({ at: Date.now(), reason, ...(error ? { error: String(error.message) } : {}) })
    })
    sample.opened = { at: Date.now(), runOperation: structuredClone(stream.runOperation), gap: structuredClone(stream.gap) }
    return { sample, dispose: () => { sample.disposedAt = Date.now(); stream.dispose() } }
  }
  const close = async item => {
    item.dispose()
    await ctx.waitFor('the actual public cost stream close after disposal', () => item.sample.ends.length ? true : null)
  }
  const preparation = await open(sibling, 0)
  let related, unrelated
  try {
    await ctx.waitFor('the actual prior sibling replay completed', () => preparation.sample.events.some(terminal) ? true : null)
    await close(preparation)
    const afterSequence = preparation.sample.events.at(-1).sequence, startedAt = Date.now()
    unrelated = await open(sibling, afterSequence)
    related = await open(operation, 0)
    const bothOpenedAt = Date.now()
    await ctx.waitFor('the actual original producer callback replay completed', () => related.sample.events.some(terminal) ? true : null)
    while (Date.now() - bothOpenedAt < 100) {
      await new Promise(done => setTimeout(done, 100 - (Date.now() - bothOpenedAt)))
    }
    const endedAt = Date.now()
    await close(related); await close(unrelated)
    const result = { schema: 'agentmux.browser-capability-native-measurements.v1', passed: true,
      boundary: 'native-producer-and-public-journal', candidateCommit: ctx.receipt.sourceCommit, sourceIdentity: ctx.receipt.identityBefore,
      producer: { operation: structuredClone(operation), recordedResult: structuredClone(recordedResult), totals: summarizeBrowserOutcomeCollection(recordedResult, operation) },
      journal: { preparation: preparation.sample, related: related.sample, unrelated: unrelated.sample,
        window: { startedAt, bothOpenedAt, endedAt, fixedQuietWindowMs: 100 } } }
    assertNativeBrowserMeasurements(result)
    return result
  } finally {
    for (const item of [preparation, related, unrelated]) if (item && !item.sample.disposedAt) item.dispose()
  }
}

/** Consume both actual mounted Source scopes; fixture Sessions are never Native healthy-Run facts. */
export function assertSourceBrowserConsumers(value) {
  assert.equal(value.schema, 'agentmux.browser-capability-source-consumer-reports.v1')
  nonempty(value.reports, 'Require actual mounted Source reports')
  assert.deepEqual(value.reports.map(report => report.case).sort(), ['actual-workspace-projections', 'selected-tab-session-observers'], 'Consume both production Workspace and selector scopes')
  for (const report of value.reports) {
    assert.equal(report.schema, 'agentmux.browser-capability-source-consumers.v1')
    assert.equal(report.passed, true, 'A failed actual Source consumer cannot sign costs')
    assert.deepEqual(report.sourceAfter, report.sourceIdentity, 'Source consumer bytes changed during measurement')
    assert.deepEqual(report.producer, { kind: 'source-real-useAppStore', browserProducerInvoked: false, nativeAppLaunched: false }, 'Source consumer scope must remain explicit')
    assert.ok(typeof report.conditions.observation === 'string' && report.conditions.observation.trim(), 'Require actual fixed Source observation conditions')
    const tabs = Object.values(report.conditions.fixtureTabs)
    nonempty(tabs, 'Require actual nonempty mounted Tab subjects')
    nonempty(report.conditions.fixtureSessions, 'Require actual nonempty Source Session subjects')
    const browserRegions = tabs.flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'browser')
    assert.ok(browserRegions.some(region => region.browserId === report.conditions.browserUpdateId) &&
      browserRegions.some(region => region.browserId !== report.conditions.browserUpdateId), 'Require mounted related and unrelated Browser subjects')
    assert.ok(report.conditions.fixtureSessions.length >= 2 && report.conditions.fixtureSessions.every(session => session.kind === 'agent'), 'Require two real mounted Source Agent subjects')
    nonempty(report.rawEvents, 'Require actual raw mount and update observations')
    assert.ok(Number.isSafeInteger(report.mountEndSequence) && report.mountEndSequence > 0 && report.updateEndSequence > report.mountEndSequence)
    let sequence = 0
    for (const event of report.rawEvents) {
      assert.equal(event.sequence, ++sequence, 'Require actual ordered raw Source observations')
      assert.equal(event.window, event.sequence <= report.mountEndSequence ? 'mount' : 'update', 'Source event belongs to another observation window')
    }
    assert.equal(report.rawEvents.at(-1).sequence, report.updateEndSequence, 'Require the complete actual Source window')
    const updated = report.rawEvents.filter(event => event.window === 'update')
    assert.equal(report.globalStoreNotifications, updated.filter(event => event.kind === 'global-store-notify').length, 'Global notifications must derive from raw events')
    assert.ok(report.globalStoreNotifications > 0, 'A mounted Store update must really notify; do not handwrite global zero')
    nonempty(report.samples, 'Require actual sampled Source consumers')
    assert.equal(new Set(report.samples.map(sample => sample.id)).size, report.samples.length)
    if (report.case === 'selected-tab-session-observers') {
      const subjects = [...Object.keys(report.conditions.fixtureTabs).map(id => `tab:${id}`), ...report.conditions.fixtureSessions.map(session => `session:${session.id}`)]
      assert.deepEqual(report.samples.map(sample => `${sample.kind}:${sample.subjectId}`).sort(), subjects.sort(), 'Every actual mounted Tab and Session must be sampled')
    } else {
      assert.deepEqual(report.samples.map(sample => sample.id).sort(), Object.keys(report.conditions.fixtureLayouts).sort(), 'Every actual mounted Workspace must be sampled')
    }
    assert.ok(report.rawEvents.every(event => report.samples.some(sample => sample.id === event.consumerId) || event.kind === 'global-store-notify'), 'Raw consumer events must belong to an actual sampled consumer')
    const related = report.samples.filter(sample => sample.related === true), unrelated = report.samples.filter(sample => sample.related === false)
    nonempty(related, 'Require actual related Source consumers'); nonempty(unrelated, 'Require actual unrelated Source consumers')
    for (const sample of report.samples) {
      const mounted = report.rawEvents.filter(event => event.window === 'mount' && event.consumerId === sample.id)
      nonempty(mounted, 'Every sampled Source consumer must actually be mounted')
      const events = updated.filter(event => event.consumerId === sample.id)
      if (report.case === 'selected-tab-session-observers') {
        const subject = sample.kind === 'tab' ? report.conditions.fixtureTabs[sample.subjectId] : report.conditions.fixtureSessions.find(session => session.id === sample.subjectId)
        assert.ok(subject, 'Source selector must bind an actual mounted subject')
        const isRelated = sample.kind === 'tab' && Object.values(subject.regions).some(region => region.kind === 'browser' && region.browserId === report.conditions.browserUpdateId)
        assert.equal(sample.related, isRelated, 'Source consumer relation must derive from its actual subject')
        assert.equal(sample.selectorCalls, events.filter(event => event.kind === 'selector-call').length, 'Selector calls must derive from actual raw observations')
        assert.equal(sample.renders, events.filter(event => event.kind === 'observer-render').length, 'Observer renders must derive from actual raw observations')
        assert.ok(sample.selectorCalls > 0, 'The actual subscribed selector must be visited')
        if (!sample.related) assert.equal(sample.renders, 0, 'Unrelated Source observer renders must remain zero')
      } else {
        assert.ok(report.conditions.fixtureLayouts[sample.id], 'Workspace sample must bind its actual mounted layout')
        const isRelated = tabs.some(tab => tab.workspaceId === sample.id && Object.values(tab.regions).some(region => region.kind === 'browser' && region.browserId === report.conditions.browserUpdateId))
        assert.equal(sample.related, isRelated, 'Workspace relation must derive from its actual subjects')
        assert.equal(sample.commits, events.filter(event => event.kind === 'workspace-commit').length, 'Workspace commits must derive from actual raw observations')
        if (!sample.related) assert.equal(sample.commits, 0, 'Unrelated production Workspace commits must remain zero')
      }
    }
    assert.ok(related.some(sample => report.case === 'actual-workspace-projections' ? sample.commits > 0 : sample.renders > 0), 'Require actual nonempty related render work')
  }
}
