import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// These are contract fixtures for the actual delivery consumer. They never sign Native product delivery.
import { BROWSER_CLOSEOUT_TASKS, joinBrowserCapabilityProof, validateNativeReceipt, verifyIntegratedCandidateSources } from '../scripts/lib/browser-capability-proof-join.mjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const names = ['default', 'overlay', 'browser-tools', 'demonstration', 'frames', 'outcome', 'task-assets',
  'task-outcome-download', 'upload', 'local-recovery:locator', 'local-recovery:navigation']
const fields: Record<string, string> = { overlay: 'overlay', 'browser-tools': 'browserTools', demonstration: 'demonstration',
  frames: 'frames', outcome: 'browserOutcome', 'task-assets': 'taskAssets', 'task-outcome-download': 'taskDownload', upload: 'uploads' }
function fixture() {
  const files = new Map<string, string>()
  const source = 'apps/desktop/src/main/browser-view-manager.ts'
  const caller = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
  const build = 'apps/desktop/out/main/index.js'
  files.set(source, 'export function owner() {}')
  const ownerImport = "import { owner } from '../../../main/browser-view-manager'\n"
  files.set(caller, ownerImport + 'owner()')
  files.set(build, 'compiled contract fixture')
  files.set('apps/desktop/scripts/lib/browser-capability-proof-join.mjs', 'export function joinBrowserCapabilityProof() {}')
  files.set('apps/desktop/scripts/verify-browser-task-capabilities.mjs', 'joinBrowserCapabilityProof()')
  const identity = Object.fromEntries([...files].map(([path, value]) => [path, hash(value)]))
  const put = (name: string, value: unknown) => {
    const path = `docs/reviews/evidence/closeout-contract/${name}`
    const bytes = typeof value === 'string' ? value : JSON.stringify(value)
    files.set(path, bytes)
    return { path, sha256: hash(bytes) }
  }
  const red = put('behavior-red.log', 'AssertionError: expected behavior\nTests 1 failed')
  const green = put('restored-green.log', 'Tests 2 passed')
  const packet = { schema: 'agentmux.renderer-source-mutation.v1', passed: true,
    sourceBefore: { [source]: identity[source] }, sourceAfter: { [source]: identity[source] }, copyAfter: { [source]: identity[source] },
    cases: [{ label: 'owner-disabled', file: source, exit: 1, log: 'behavior-red.log', restore: { exit: 0, log: 'restored-green.log' } }] }
  const evidence = [put('source-proof.json', packet), red, green]
  const tasks = BROWSER_CLOSEOUT_TASKS.map((id: string) => ({ id, status: 'done', gate_result: 'pass',
    verification: [{ kind: 'command', ref: `verify ${id}` }], last_gate_commands: [{ command: `verify ${id}`, exit_code: 0 }] }))
  const historicalTasks = ['T-002', 'T-003', 'T-004', 'T-008'].map(id => ({ id, status: 'done' }))
  const workbench = { layouts: { workspace: { root: { type: 'leaf', groupId: 'group' },
    groups: [{ id: 'group', tabOrder: ['tab'], recentTabIds: ['tab'], activeTabId: 'tab' }], activeGroupId: 'group' } },
    tabs: { tab: { id: 'tab', workspaceId: 'workspace', titleRegionId: 'one', layout: { activeRegionId: 'one', root: { type: 'split', direction: 'horizontal',
      first: { type: 'leaf', regionId: 'one' }, second: { type: 'leaf', regionId: 'two' }, ratio: 0.4 } }, regions: {
      one: { kind: 'browser', browserId: 'a', url: 'https://example.test/a' },
      two: { kind: 'browser', browserId: 'b', url: 'https://example.test/b' } } } } }
  const projection = [{ id: 'session', kind: 'agent' }]
  const native = names.map(name => {
    const renderer = put(`${name}-renderer.png`, `renderer contract pixels ${name}`), image = put(`${name}-native.png`, `native contract pixels ${name}`)
    const reference = put(`${name}.json`, { schema: 'agentmux.browser-recovery-restart.v1', case: name.split(':')[0], completeGate: true,
      passed: true, failure: null, sourceCommit: 'a'.repeat(40),
      cleanup: { privateProcessesReaped: true, errors: [], remaining: [], temporaryRootRemoved: true }, identityBefore: identity, identityAfter: identity,
      first: { pid: 100 }, second: { pid: 200 }, firstExit: { exitCode: 0, signal: null }, secondExit: { exitCode: 0, signal: null },
      firstUi: { restored: workbench, sessions: projection, expected: { tabId: 'tab', focus: 'one', regions: [
        { regionId: 'one', browserId: 'a', url: 'https://example.test/a' }, { regionId: 'two', browserId: 'b', url: 'https://example.test/b' }] } },
      secondUi: { restored: workbench, sessions: projection },
      ...(name.startsWith('local-recovery:') ? { localRecovery: { kind: name.split(':')[1], complete: true } } : fields[name] ? { [fields[name]!]: { complete: true } } : {}),
      visual: { operations: { completed: { phase: 'completed' }, failed: { phase: 'failed' } },
        states: { running: { operation: { id: 'run' } }, waiting: { operation: { id: 'wait' } }, human: { operation: { id: 'human' } } },
        frames: [{ label: 'restored-normal', path: renderer.path, sha256: renderer.sha256,
          nativeBounds: [{ x: 0, y: 0, width: 600, height: 400, webContentsId: 2, browserUrl: 'https://example.test/a' }], nativePage: {
          ...image, captureSource: 'native-browser-webcontents', webContentsId: 2, browserUrl: 'https://example.test/a',
          bounds: { x: 0, y: 0, width: 600, height: 400 }, size: { width: 1200, height: 800 } } }] }
    })
    return { ...reference, frames: [{ label: 'restored-normal', renderer, native: image }] }
  })
  const visualReviews = native.map((receipt, index) => {
    const actual = JSON.parse(files.get(receipt.path)!), frame = actual.visual.frames[0]
    const frames = [{ label: frame.label, renderer: { path: frame.path, sha256: frame.sha256 }, native: frame.nativePage }]
    const record = { schema: 'agentmux.browser-closeout-visual-review.v1', approved: true, reviewer: 'reviewer', author: 'author',
      receipts: [{ nativeReceiptSha256: receipt.sha256, case: names[index], frames }] }
    return { ...put(`${names[index]}-review.json`, record), decision: 'passed', reviewer: 'reviewer', author: 'author',
      nativeReceiptSha256: receipt.sha256, case: names[index], frames }
  })
  const bound = { candidateCommit: 'a'.repeat(40), sourceIdentity: identity }
  const measuredOperation = { id: 'measured-producer', browserId: 'related-browser', phase: 'completed', steps: [{ method: 'extractStructured', sequence: 1, status: 'completed' }] }
  const measuredSource = { operationId: measuredOperation.id, browserId: measuredOperation.browserId }
  const recordedResult = { artifact: { ...measuredSource, id: 'artifact', byteLength: 64 }, source: measuredSource, byteLength: 64,
    document: { schema: 'browser-structured-output.v1', source: measuredSource, work: { reads: 1, readBytes: 1, visitedElements: 1, elementWalkSteps: 1, selectorChecks: 1, textNodes: 1, textWalkSteps: 1 } },
    chunks: [{ offset: 0, returnedBytes: 64, nextOffset: null, readCost: { metadataBytes: 17, payloadBytes: 64 } }] }
  const sibling = { ...measuredOperation, id: 'sibling', browserId: 'unrelated-browser' }
  const sample = (operation: typeof measuredOperation, cursor: number, events: any[]) => ({ operationId: operation.id, browserId: operation.browserId, afterSequence: cursor,
    opened: { at: 10, runOperation: operation, gap: null }, events, ends: [{ at: 113, reason: 'closed' }], disposedAt: 112 })
  const nativeMeasurement = put('native-measurements.json', { schema: 'agentmux.browser-capability-native-measurements.v1', ...bound, passed: true, boundary: 'native-producer-and-public-journal',
    producer: { operation: measuredOperation, recordedResult, totals: { extractCalls: 1, extractStepSequences: [1], visitedElements: 1, attributeReads: 1, attributeReadBytes: 1,
      persistedPayloadBytes: 64, returnedBytes: 64, physicalMetadataBytes: 17, physicalPayloadBytes: 64 } },
    journal: { preparation: sample(sibling, 0, [{ sequence: 3, event: { operationId: sibling.id, type: 'phase-changed', phase: 'completed' } }]),
      related: sample(measuredOperation, 0, [{ sequence: 8, event: { operationId: measuredOperation.id, type: 'phase-changed', phase: 'completed' } }]), unrelated: sample(sibling, 3, []),
      window: { startedAt: 9, bothOpenedAt: 11, endedAt: 111, fixedQuietWindowMs: 100 } } })
  const outcomeReference = native[5]!, outcomeReceipt = JSON.parse(files.get(outcomeReference.path)!)
  outcomeReceipt.capabilityMeasurements = JSON.parse(files.get(nativeMeasurement.path)!)
  outcomeReceipt.browserOutcome.initial = measuredOperation; outcomeReceipt.browserOutcome.recordedResult = recordedResult
  files.set(outcomeReference.path, JSON.stringify(outcomeReceipt)); outcomeReference.sha256 = hash(files.get(outcomeReference.path)!)
  visualReviews[5]!.nativeReceiptSha256 = outcomeReference.sha256
  const outcomeReview = JSON.parse(files.get(visualReviews[5]!.path)!)
  outcomeReview.receipts[0].nativeReceiptSha256 = outcomeReference.sha256
  files.set(visualReviews[5]!.path, JSON.stringify(outcomeReview)); visualReviews[5]!.sha256 = hash(files.get(visualReviews[5]!.path)!)
  const fixtureTabs = { 'related-tab': { workspaceId: 'related-workspace', regions: { browser: { kind: 'browser', browserId: 'related-browser' } } },
    'unrelated-tab': { workspaceId: 'unrelated-workspace', regions: { browser: { kind: 'browser', browserId: 'unrelated-browser' } } },
    'agent-tab-one': { workspaceId: 'unrelated-workspace', regions: { agent: { kind: 'agent', sessionId: 'agent-one' } } },
    'agent-tab-two': { workspaceId: 'unrelated-workspace', regions: { agent: { kind: 'agent', sessionId: 'agent-two' } } } }
  const observers = [{ id: 'related-browser-tab', related: true, kind: 'tab', subjectId: 'related-tab' },
    { id: 'unrelated-browser-tab', related: false, kind: 'tab', subjectId: 'unrelated-tab' },
    { id: 'agent-tab-one', related: false, kind: 'tab', subjectId: 'agent-tab-one' }, { id: 'agent-tab-two', related: false, kind: 'tab', subjectId: 'agent-tab-two' },
    { id: 'agent-session-one', related: false, kind: 'session', subjectId: 'agent-one' }, { id: 'agent-session-two', related: false, kind: 'session', subjectId: 'agent-two' }]
  const sourceReport = (workspace: boolean) => {
    const samples = workspace ? [{ id: 'related-workspace', related: true, commits: 1 }, { id: 'unrelated-workspace', related: false, commits: 0 }] :
      observers.map(item => ({ ...item, selectorCalls: 1, renders: item.related ? 1 : 0 }))
    const mounted = samples.flatMap(item => workspace ? [{ kind: 'workspace-commit', consumerId: item.id }] :
      [{ kind: 'selector-call', consumerId: item.id }, { kind: 'observer-render', consumerId: item.id }])
    const updates = [{ kind: 'global-store-notify', consumerId: 'global-store' }, ...samples.flatMap(item => workspace ?
      item.related ? [{ kind: 'workspace-commit', consumerId: item.id }] : [] :
      [{ kind: 'selector-call', consumerId: item.id }, ...(item.related ? [{ kind: 'observer-render', consumerId: item.id }] : [])])]
    return { schema: 'agentmux.browser-capability-source-consumers.v1', ...bound, passed: true, sourceAfter: identity,
      case: workspace ? 'actual-workspace-projections' : 'selected-tab-session-observers',
      producer: { kind: 'source-real-useAppStore', browserProducerInvoked: false, nativeAppLaunched: false },
      conditions: { observation: 'Explicit consumer contract model, not a real mounted product measurement', browserUpdateId: 'related-browser', consumers: observers,
        fixtureTabs, fixtureSessions: [{ id: 'agent-one', kind: 'agent' }, { id: 'agent-two', kind: 'agent' }], fixtureLayouts: { 'related-workspace': { group: 'related' }, 'unrelated-workspace': { group: 'unrelated' } } },
      rawEvents: [...mounted.map(event => ({ ...event, window: 'mount' })), ...updates.map(event => ({ ...event, window: 'update' }))].map((event, index) => ({ ...event, sequence: index + 1 })),
      samples, mountEndSequence: mounted.length, updateEndSequence: mounted.length + updates.length, globalStoreNotifications: 1 }
  }
  const sourceMeasurement = put('source-consumers.json', { schema: 'agentmux.browser-capability-source-consumer-reports.v1', reports: [sourceReport(false), sourceReport(true)] })
  const measurement = put('measurement.json', { schema: 'agentmux.browser-capability-measurements.v1', ...bound, nativeProducer: nativeMeasurement, sourceConsumers: sourceMeasurement })
  const status = { session: { kind: 'agent', agentSessionId: 'original-agent', run: { runId: 'original-run' }, providerId: 'codex',
    executorId: 'codex', hostId: 'host', workspacePath: '/contract', createdAt: 1, nativeHandle: { kind: 'provider-native', sessionId: 'original-native' } },
    run: { runId: 'original-run', agentSessionId: 'original-agent', state: 'running', pid: 123 }, capabilities: { timeline: 'complete-events' },
    observation: { process: 'running', semantic: 'active', readiness: 'ready', source: 'native-hook', observedAt: 1, stale: false } }
  const continuity = put('continuity.json', { schema: 'agentmux.browser-capability-public-continuity.v1', ...bound,
    healthyRunBoundary: { kind: 'public-selected-original-agent-session' },
    workbenchBoundary: { kind: 'private-native-ordinary-restart', nativeReceiptSha256: native[0]!.sha256 },
    subject: { agentSessionId: 'original-agent', runId: 'original-run' },
    before: { status: put('before-status.json', status), workbench: put('before-workbench.json', workbench) },
    after: { status: put('after-status.json', status), workbench: put('after-workbench.json', workbench) } })
  const costs = put('costs.json', { schema: 'agentmux.browser-capability-costs.v1', ...bound, measurement, continuity })
  const manifest: any = { schema: 'agentmux.browser-capability-closeout.v1', feature: 'f-2fm8f5q39',
    candidate: { branch: 'main', commit: bound.candidateCommit, identity },
    tasks: BROWSER_CLOSEOUT_TASKS.map((id: string) => ({ id, sourceIdentity: { [source]: identity[source] }, evidence,
      callers: [{ path: caller, definition: source, symbol: 'owner' }] })),
    historical: historicalTasks.map(task => ({ id: task.id, sourceIdentity: { [source]: identity[source] }, evidence })), native, visualReviews, costs }
  const read = async (path: string) => {
    const bytes = files.get(path)
    if (bytes === undefined) throw new Error(`Missing file ${path}`)
    return Buffer.from(bytes)
  }
  const update = (ref: { path: string; sha256: string }, change: (value: any) => void) => {
    const value = JSON.parse(files.get(ref.path)!); change(value)
    const bytes = JSON.stringify(value); files.set(ref.path, bytes); ref.sha256 = hash(bytes)
    if (ref.path === nativeMeasurement.path || ref.path === sourceMeasurement.path) {
      update(measurement, r => { r[ref.path === nativeMeasurement.path ? 'nativeProducer' : 'sourceConsumers'] = ref })
    }
    if (ref.path === measurement.path || ref.path === continuity.path) {
      const receipt = JSON.parse(files.get(costs.path)!)
      receipt[ref.path === measurement.path ? 'measurement' : 'continuity'] = ref
      const updated = JSON.stringify(receipt); files.set(costs.path, updated); costs.sha256 = hash(updated)
    }
    const nativeIndex = native.findIndex(item => item.path === ref.path)
    if (nativeIndex !== -1) {
      const review = visualReviews[nativeIndex]!
      review.nativeReceiptSha256 = ref.sha256
      update(review, r => { r.receipts[0].nativeReceiptSha256 = ref.sha256 })
      if (nativeIndex === 0) update(continuity, r => { r.workbenchBoundary.nativeReceiptSha256 = ref.sha256 })
    }
  }
  const syncIdentity = () => {
    native.forEach((ref, index) => { update(ref, r => { r.identityBefore = identity; r.identityAfter = identity; if (r.capabilityMeasurements) r.capabilityMeasurements.sourceIdentity = identity }); visualReviews[index]!.nativeReceiptSha256 = ref.sha256
      update(visualReviews[index]!, r => { r.receipts[0].nativeReceiptSha256 = ref.sha256 }) })
    update(nativeMeasurement, r => { r.sourceIdentity = identity })
    update(sourceMeasurement, r => { for (const report of r.reports) report.sourceIdentity = report.sourceAfter = identity })
    update(measurement, r => { r.sourceIdentity = identity }); update(continuity, r => { r.sourceIdentity = identity })
    update(costs, r => { r.sourceIdentity = identity })
  }
  const setCaller = (value: string) => {
    const code = value.includes('import ') || /^function owner\b/.test(value) ? value : ownerImport + value
    files.set(caller, code); identity[caller] = hash(code); syncIdentity()
  }
  const syncReview = () => { const review = visualReviews[0]!; update(review, r => { r.receipts = [{ case: review.case, nativeReceiptSha256: review.nativeReceiptSha256, frames: review.frames }] }) }
  return { manifest, tasks, historicalTasks, read, files, source, caller, put, packet, update, measurement, nativeMeasurement, sourceMeasurement, continuity, setCaller, syncIdentity, syncReview }
}
const join = (input: ReturnType<typeof fixture>) => joinBrowserCapabilityProof(input)
const rejects = async (change: (x: ReturnType<typeof fixture>) => void, message?: string) => {
  const x = fixture(); change(x); await expect(join(x)).rejects.toThrow(message)
}
// Raw-fact guard counterexamples must remain the exact facts captured by their Native receipt.
// Detached packet counterexamples deliberately use update() directly instead.
const changeCapturedNativeMeasurements = (x: ReturnType<typeof fixture>, change: (r: any) => void) => {
  x.update(x.nativeMeasurement, change)
  const captured = JSON.parse(x.files.get(x.nativeMeasurement.path)!)
  x.update(x.manifest.native[5], r => {
    r.capabilityMeasurements = captured
    r.browserOutcome.recordedResult = captured.producer.recordedResult
  })
}

describe('Browser exact-candidate proof join', () => {
  it('consumes sixteen task contracts, four historical facts and eleven distinct observed cases', async () => {
    const result = await join(fixture())
    expect(result.tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
    expect(result.historical).toEqual(['T-002', 'T-003', 'T-004', 'T-008'])
    expect(result.nativeCases).toEqual(names)
  })
  it('uses the complete shared Native validator without requiring unrelated task gates to be done', async () => {
    const x = fixture(); x.tasks[0]!.status = 'in_progress'
    const reference = x.manifest.native[0], receipt = JSON.parse(x.files.get(reference.path)!)
    expect((await validateNativeReceipt({ receipt, candidate: x.manifest.candidate, frames: reference.frames,
      readArtifact: (ref: any) => x.read(ref.path) })).name).toBe('default')
    await expect(join(x)).rejects.toThrow('not formally done')
  })
  it('requires original Native owner identity and every preserved frame byte', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.frames[0].nativePage.webContentsId = r.visual.frames[0].nativeBounds[0].webContentsId = 0 }), 'shown Native owner identity')
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.frames[0].nativePage.browserUrl = 'https://elsewhere.test/' }), 'frame URL context')
    await rejects(x => { x.manifest.native[0].frames = [] }, 'actual Native frame artifacts')
    await rejects(x => { x.files.set(x.manifest.native[0].frames[0].renderer.path, 'changed image') }, 'Evidence changed')
    const x = fixture(), reference = x.manifest.native[0], receipt = JSON.parse(x.files.get(reference.path)!)
    x.files.set(reference.frames[0].renderer.path, 'changed actual image')
    await expect(validateNativeReceipt({ receipt, candidate: x.manifest.candidate, frames: reference.frames,
      readArtifact: (ref: any) => x.read(ref.path) })).rejects.toThrow('actual image bytes changed')
  })
  it('requires each historical shown frame to bind its unique original owner, URL and bounds', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.frames[0].nativeBounds = [] }), 'unique actual owner context')
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.frames[0].nativeBounds[0].webContentsId = 99 }), 'frame owner context')
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.frames[0].nativeBounds[0].x = 50 }), 'actual owner bounds')
  })
  it('preserves historical frame URL and owner context independently of the final restart URL', async () => {
    const x = fixture()
    x.update(x.manifest.native[0], r => {
      r.visual.frames[0].nativePage.browserUrl = r.visual.frames[0].nativeBounds[0].browserUrl = 'https://example.test/historical-navigation?stage=earlier'
    })
    expect((await join(x)).nativeCases).toEqual(names)
  })
  it('consumes actual Search parked owners without inventing Native PNGs and requires restored original pixels', async () => {
    const setup = () => {
      const x = fixture(), reference = x.manifest.native[2], renderer = x.put('parked-renderer.png', 'actual parked contract pixels')
      const owner = { webContentsId: 2, browserUrl: 'https://example.test/a', visible: false, parked: true, bounds: { x: 0, y: 0, width: 600, height: 400 } }
      reference.frames.unshift({ label: 'search-parked', renderer, parkedOwners: [owner] })
      x.update(reference, r => r.visual.frames.unshift({ label: 'search-parked', sha256: renderer.sha256,
        nativePage: { captureSource: 'native-browser-parked', owners: [owner] } }))
      const review = x.manifest.visualReviews[2]; review.frames = structuredClone(reference.frames)
      x.update(review, r => { r.receipts[0].frames = review.frames })
      return x
    }
    expect((await join(setup())).nativeCases).toEqual(names)
    for (const change of [(r: any) => { r.owners[0].parked = false }, (r: any) => { r.owners.push(structuredClone(r.owners[0])) },
      (r: any) => { r.owners[0].visible = true }]) {
      const x = setup(), reference = x.manifest.native[2]
      x.update(reference, r => change(r.visual.frames[0].nativePage))
      const receipt = JSON.parse(x.files.get(reference.path)!)
      reference.frames[0].parkedOwners = receipt.visual.frames[0].nativePage.owners
      await expect(validateNativeReceipt({ receipt, candidate: x.manifest.candidate, frames: reference.frames,
        readArtifact: (ref: any) => x.read(ref.path) })).rejects.toThrow()
    }
  })
  it('rejects empty, duplicate and substituted required task sets', async () => {
    await rejects(x => { x.manifest.tasks = [] }, 'Consume every required task')
    await rejects(x => { x.manifest.tasks[0].id = 'T-999' }, 'Consume every required task')
    await rejects(x => { x.manifest.tasks[0].id = x.manifest.tasks[1].id }, 'Consume every required task')
  })
  it('rejects Source milestones and failed or different formal gates', async () => {
    await rejects(x => { x.tasks[0]!.status = 'in_progress' }, 'not formally done')
    await rejects(x => { x.tasks[0]!.gate_result = 'fail' })
    await rejects(x => { x.tasks[0]!.last_gate_commands[0]!.exit_code = 1 })
    await rejects(x => { x.tasks[0]!.last_gate_commands[0]!.command = 'another gate' })
  })
  it('retains the actual four historical done facts', async () => {
    await rejects(x => { x.historicalTasks[0]!.status = 'in_progress' })
    await rejects(x => { x.manifest.historical.pop() })
  })
  it('rejects current source drift, old proof identity and missing compiled input', async () => {
    await rejects(x => { x.files.set(x.source, 'export function owner() { return "changed" }') }, 'Current candidate changed')
    await rejects(x => { x.manifest.tasks[0].sourceIdentity[x.source] = 'b'.repeat(64) }, 'different candidate')
    await rejects(x => { delete x.manifest.candidate.identity['apps/desktop/out/main/index.js'] })
  })
  it('rejects evidence changed on disk and explicitly failed task evidence', async () => {
    await rejects(x => { x.files.set(x.manifest.tasks[0].evidence[0].path, 'changed') }, 'Evidence changed')
    await rejects(x => { x.manifest.tasks[0].evidence.push(x.put('failed-evidence.json', { passed: false, failure: 'Assertion RED' })) }, 'Failed task evidence')
  })
  it('requires actual nonempty Source mutations and both hash-bound behavioral logs', async () => {
    await rejects(x => { x.manifest.tasks[0].evidence.push(x.put('empty-source-proof.json', { ...x.packet, cases: [] })) }, 'actual cases')
    await rejects(x => { x.manifest.tasks[0].evidence = [x.put('boolean-proof.json', { passed: true })] }, 'Source mutation evidence')
    await rejects(x => { x.update(x.manifest.tasks[0].evidence[0], r => { r.cases[0].exit = 0 }) }, 'Assertion RED')
    await rejects(x => { x.update(x.manifest.tasks[0].evidence[0], r => { r.cases[0].restore.exit = 1 }) }, 'restored Source GREEN')
    await rejects(x => { x.update(x.manifest.tasks[0].evidence[0], r => { r.sourceBefore[x.source] = 'b'.repeat(64); r.sourceAfter = r.copyAfter = r.sourceBefore }) }, 'changed current subject')
    await rejects(x => { x.manifest.tasks[0].evidence = x.manifest.tasks[0].evidence.slice(0, 1) }, 'hash-bound')
    await rejects(x => { const ref = x.manifest.tasks[0].evidence[1]; x.files.set(ref.path, 'Module not found'); ref.sha256 = hash('Module not found') }, 'behavior RED')
    await rejects(x => { const ref = x.manifest.tasks[0].evidence[2]; x.files.set(ref.path, 'Tests 0 passed'); ref.sha256 = hash('Tests 0 passed') }, 'nonempty tests')
  })
  it('consumes the current nested local recovery mutation packet format', async () => {
    const x = fixture()
    x.update(x.manifest.tasks[0].evidence[0], r => { r.schema = 'agentmux.browser-local-recovery-source-mutations.v1';
      r.cases[0].red = { exit: r.cases[0].exit, log: r.cases[0].log }; r.cases[0].restoredGreen = r.cases[0].restore;
      delete r.cases[0].exit; delete r.cases[0].log; delete r.cases[0].restore })
    expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
  })
  it('consumes the exact current frame sanitizer increment packet schema', async () => {
    const x = fixture()
    x.update(x.manifest.tasks[0].evidence[0], r => { r.schema = 'agentmux.browser-frame-sanitizer-increment-mutations.v1'; r.kind = 'marker'; r.expectedTests = 26 })
    expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
  })
  it('rejects an invented mutation schema even when it contains source-mutations', async () => {
    await rejects(x => x.update(x.manifest.tasks[0].evidence[0], r => { r.schema = 'foreign-source-mutations.v1' }), 'Source mutation evidence')
  })
  it('consumes the current fixed-owner completion and download packet formats', async () => {
    for (const [schema, owner] of [['agentmux.browser-completion-source-mutations.v1', 'packages/core/src/browser-completion-facts.ts'],
      ['agentmux.browser-download-outcome-source-mutations.v1', 'apps/desktop/src/main/browser-outcome-criteria.ts']]) {
      const x = fixture(); x.files.set(owner!, 'export function completionOwner() {}')
      const digest = hash(x.files.get(owner!)!); x.manifest.candidate.identity[owner!] = digest
      for (const task of x.manifest.tasks) task.sourceIdentity = { [owner!]: digest }
      x.update(x.manifest.tasks[0].evidence[0], r => { r.schema = schema; delete r.cases[0].file;
        r.sourceBefore = r.sourceAfter = r.copyAfter = { [owner!]: digest } })
      expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
    }
  })
  it('requires definition-excluded real Call, New or JSX consumers', async () => {
    for (const code of ['owner()', 'new owner()', "import { owner as Owner } from '../../../main/browser-view-manager'; <Owner />",
      "import { owner as Owner } from '../../../main/browser-view-manager'; <Owner></Owner>", "import * as api from '../../../main/browser-view-manager'; api.owner()"] ) {
      const x = fixture(); x.setCaller(code); expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
    }
    await rejects(x => { x.manifest.tasks[0].callers = [] }, 'caller proof')
    await rejects(x => { for (const task of x.manifest.tasks) task.callers[0].definition = x.caller; x.setCaller('function owner() {}\nowner()') })
    for (const code of ['// owner()', 'const text = "owner()"', 'export { owner }', 'const alias = owner', '/* <owner /> */']) {
      await rejects(x => x.setCaller(code), 'Caller disappeared')
    }
    await rejects(x => { x.manifest.tasks[0].callers[0].symbol = 'missingCapability' }, 'Caller disappeared')
  })
  it('resolves actual imported aliases, reexports and member root owners while rejecting local homonyms', async () => {
    await rejects(x => x.setCaller('function owner() {}\nowner()'), 'Caller disappeared')
    await rejects(x => x.setCaller('function invoke(owner: () => void) { owner() }'), 'Caller disappeared')
    const x = fixture(), bridge = 'apps/desktop/src/main/browser-owner-bridge.ts'
    x.files.set(bridge, "export { owner as publicOwner } from './browser-view-manager'")
    x.manifest.candidate.identity[bridge] = hash(x.files.get(bridge)!)
    x.setCaller("import { publicOwner as invoke } from '../../../main/browser-owner-bridge'; invoke()")
    expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
    const y = fixture(), api = 'apps/desktop/src/renderer/src/lib/api.ts', contracts = 'apps/desktop/src/renderer/src/lib/contracts.d.ts'
    y.files.set(api, "import type { Api } from './contracts'; export const api = {} as Api")
    y.files.set(contracts, 'export type Api = { browser: { owner(): void } }')
    for (const path of [api, contracts]) y.manifest.candidate.identity[path] = hash(y.files.get(path)!)
    for (const task of y.manifest.tasks) task.callers = [{ definition: api, path: y.caller, symbol: 'owner' }]
    y.setCaller("import { api } from '../lib/api'; api.browser.owner()")
    expect((await join(y)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
  })
  it('resolves production callers only through source barrels, excluding compiled candidate assets', async () => {
    await rejects(x => {
      const compiled = 'apps/desktop/out/owner-bridge.js'
      x.files.set(compiled, "export { owner } from '../src/main/browser-view-manager'")
      x.manifest.candidate.identity[compiled] = hash(x.files.get(compiled)!)
      x.setCaller("import { owner } from '../../../../out/owner-bridge'; owner()")
    }, 'Caller disappeared')
  })
  it('consumes actual CSS import and JSX class entrypoints while rejecting comments', async () => {
    for (const [code, kind, symbol] of [['@import "./browser.css";', 'css-import', 'unused'], ['<div className="browser-body other" />', 'jsx-class', 'browser-body']]) {
      const x = fixture(), definition = 'apps/desktop/src/renderer/src/styles/browser.css'
      const path = kind === 'css-import' ? 'apps/desktop/src/renderer/src/styles/index.css' : x.caller
      x.files.set(definition, '.browser-body { display: flex; }'); x.manifest.candidate.identity[definition] = hash(x.files.get(definition)!)
      x.files.set(path, code!); x.manifest.candidate.identity[path] = hash(code!)
      for (const task of x.manifest.tasks) task.callers = [{ definition, path, symbol, kind }]
      x.syncIdentity()
      expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
      x.files.set(path, kind === 'css-import' ? `/* ${code} */` : `// ${code}`); x.manifest.candidate.identity[path] = hash(x.files.get(path)!)
      x.syncIdentity()
      await expect(join(x)).rejects.toThrow('Caller disappeared')
    }
  })
  it('rejects failed Native, empty frames, lost focus and absent ordinary restart', async () => {
    for (const change of [(r: any) => { r.completeGate = false }, (r: any) => { r.second.pid = r.first.pid },
      (r: any) => { r.visual.frames = [] }, (r: any) => { r.firstUi.expected.regions = [] },
      (r: any) => { r.firstUi.expected.focus = 'other' }]) await rejects(x => x.update(x.manifest.native[0], change))
    await rejects(x => { x.manifest.native = [] })
  })
  it('requires successful ordinary first and second App quits, never signal or crash', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.firstExit.signal = 'SIGKILL' }), 'Forced termination')
    await rejects(x => x.update(x.manifest.native[0], r => { r.secondExit.exitCode = 9 }), 'successful App quit')
  })
  it('preserves actual Group, split tree and Session projection across restart', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => {
      const layout = r.secondUi.restored.layouts.workspace
      layout.groups[0].id = layout.activeGroupId = layout.root.groupId = 'replacement-group'
    }), 'Group, split layout')
    await rejects(x => x.update(x.manifest.native[0], r => { r.secondUi.restored.tabs.tab.layout.root.ratio = 0.6 }), 'Group, split layout')
    await rejects(x => x.update(x.manifest.native[0], r => { r.secondUi.sessions = [] }), 'Session projection')
    await rejects(x => x.update(x.manifest.native[0], r => { r.firstUi.restored = {} }), 'nonempty before/after')
  })
  it('rejects explicit Native failure independently of scenario completion', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.passed = false }), 'successful Native receipt')
    await rejects(x => x.update(x.manifest.native[0], r => { r.failure = { phase: 'cleanup', message: 'EPERM' } }), 'Native failure must remain')
  })
  it('rejects actual Native cleanup errors, retained processes and an unremoved temporary root', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.cleanup.errors = ['EPERM'] }), 'cleanup errors')
    await rejects(x => x.update(x.manifest.native[0], r => { r.cleanup.remaining = [201] }), 'actually be reaped')
    await rejects(x => x.update(x.manifest.native[0], r => { r.cleanup.temporaryRootRemoved = false }), 'actually be removed')
  })
  it('rejects a Native receipt from another recorded source commit', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.sourceCommit = 'b'.repeat(40) }), 'another recorded candidate commit')
  })
  it('requires actual Session projection arrays even when both private observations are empty', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { delete r.firstUi.sessions; delete r.secondUi.sessions }), 'actual original Session projections')
    const x = fixture(); x.manifest.native.forEach((ref: any) => x.update(ref, r => { r.firstUi.sessions = []; r.secondUi.sessions = [] }))
    expect((await join(x)).nativeCases).toEqual(names)
  })
  it('requires real workspace Group and Region tree artifacts even when both sides are equally incomplete', async () => {
    for (const change of [(r: any) => { delete r.layouts }, (r: any) => { delete r.tabs.tab.layout.root },
      (r: any) => { delete r.layouts.workspace.groups }, (r: any) => { delete r.layouts.workspace.activeGroupId },
      (r: any) => { r.layouts.workspace.groups[0].tabOrder = [] }, (r: any) => { r.layouts.workspace.root.groupId = 'foreign-group' },
      (r: any) => { r.tabs.tab.layout.root.direction = 'unknown' }]) {
      await rejects(x => x.update(x.manifest.native[0], r => { change(r.firstUi.restored); change(r.secondUi.restored) }))
    }
  })
  it('requires actual completion fields for every Native scenario', async () => {
    for (let index = 1; index < 9; index++) await rejects(x => x.update(x.manifest.native[index], r => { r[fields[names[index]!]!].complete = false }), 'scenario completion')
    await rejects(x => x.update(x.manifest.native[0], r => { r.visual.operations.completed.phase = 'failed' }))
  })
  it('requires completed locator and navigation recovery from independent receipts', async () => {
    await rejects(x => x.update(x.manifest.native[9], r => { r.localRecovery.complete = false }), 'actual local failure')
    await rejects(x => { x.manifest.native.pop(); x.manifest.visualReviews.pop() }, 'Missing actual Native case: local-recovery:navigation')
    await rejects(x => { x.manifest.native[10] = x.manifest.native[9] }, 'independent actual receipts')
  })
  it('binds independently reviewed Renderer and Native pixels to the actual receipt, case and label', async () => {
    await rejects(x => { x.manifest.visualReviews[0].reviewer = 'author'; x.update(x.manifest.visualReviews[0], r => { r.reviewer = 'author' }) }, 'independent')
    await rejects(x => { x.manifest.visualReviews[0].frames = [] }, 'actually reviewed')
    await rejects(x => { x.manifest.visualReviews[0].nativeReceiptSha256 = 'b'.repeat(64); x.syncReview() }, 'actual Native receipt')
    await rejects(x => { x.manifest.visualReviews[0].case = 'overlay'; x.syncReview() }, 'actual Native receipt')
    await rejects(x => { x.manifest.visualReviews[0].frames[0].label = 'old-label'; x.syncReview() }, 'unique actual Native frame')
    await rejects(x => { x.manifest.visualReviews[0].frames[0].renderer = x.put('old-unrelated-renderer.png', 'old pixels'); x.syncReview() }, 'another frame')
    await rejects(x => { x.manifest.visualReviews[0].frames[0].native = x.put('old-unrelated-native.png', 'old pixels'); x.syncReview() }, 'another frame')
    await rejects(x => { x.manifest.visualReviews.pop() }, 'Missing independent image review')
  })
  it('consumes the preserved independent decision and prevents manifest relabeling of it', async () => {
    await rejects(x => x.update(x.manifest.visualReviews[0], r => { r.approved = false }), 'actually approve')
    await rejects(x => x.update(x.manifest.visualReviews[0], r => { r.receipts[0].nativeReceiptSha256 = 'b'.repeat(64) }), 'relabel an old independent review')
    await rejects(x => { x.manifest.visualReviews[0].case = 'overlay' }, 'relabel an old independent review')
    await rejects(x => x.update(x.manifest.visualReviews[0], r => { r.receipts[0].frames[0].renderer = x.put('old-reviewed.png', 'old pixels') }), 'invent reviewed images')
    await rejects(x => { x.manifest.visualReviews[0].frames[0].renderer = x.put('unreviewed.png', 'new pixels') }, 'invent reviewed images')
  })
  it('requires typed costs and exact current candidate for both actual observation groups', async () => {
    await rejects(x => x.update(x.manifest.costs, r => { r.schema = 'manual-healthy-booleans' }))
    await rejects(x => x.update(x.manifest.costs, r => { r.candidateCommit = 'b'.repeat(40) }), 'another candidate')
    await rejects(x => x.update(x.manifest.costs, r => { r.sourceIdentity[x.source] = 'b'.repeat(64) }), 'different candidate')
    await rejects(x => changeCapturedNativeMeasurements(x, r => { r.candidateCommit = 'b'.repeat(40) }), 'another candidate')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].candidateCommit = 'b'.repeat(40) }), 'another candidate')
  })
  it('requires preserved raw Native producer and complete public related/unrelated observations', async () => {
    await rejects(x => changeCapturedNativeMeasurements(x, r => { r.journal.related.events = [] }), 'related public callback')
    await rejects(x => changeCapturedNativeMeasurements(x, r => { r.journal.unrelated.events = [{ sequence: 4, event: { operationId: 'sibling', type: 'phase-changed', phase: 'completed' } }] }), 'Unrelated actual callbacks')
    await rejects(x => changeCapturedNativeMeasurements(x, r => { r.producer.totals.physicalPayloadBytes = 1 }), 'derive from raw original facts')
    await rejects(x => changeCapturedNativeMeasurements(x, r => { r.producer.recordedResult.chunks[0].readCost = undefined }))
  })
  it('binds Native cost facts to the actual validated outcome receipt and original producer', async () => {
    await rejects(x => x.update(x.nativeMeasurement, r => {
      const operation = r.producer.operation
      operation.id = 'foreign-native-cost-operation'; operation.browserId = 'foreign-native-browser'
      for (const source of [r.producer.recordedResult.artifact, r.producer.recordedResult.source, r.producer.recordedResult.document.source]) {
        source.operationId = operation.id; source.browserId = operation.browserId
      }
      const related = r.journal.related
      related.operationId = related.opened.runOperation.id = operation.id
      related.browserId = related.opened.runOperation.browserId = operation.browserId
      for (const event of related.events) event.event.operationId = operation.id
    }), 'actual validated receipt measurement facts')
    await rejects(x => x.update(x.manifest.native[5], r => { r.browserOutcome.initial.id = 'foreign-original-operation' }), 'original outcome operation')
    await rejects(x => x.update(x.manifest.native[5], r => { r.browserOutcome.initial.browserId = 'foreign-original-browser' }), 'original outcome Browser')
    await rejects(x => x.update(x.manifest.native[5], r => { r.browserOutcome.recordedResult.artifact.id = 'foreign-saved-artifact' }), 'original saved result bytes')
  })
  it('requires the complete prior Native sibling replay from cursor zero through actual completion', async () => {
    const mutate = (change: (r: any) => void, message: string) => rejects(x => changeCapturedNativeMeasurements(x, change), message)
    await mutate(r => { r.journal.preparation.events.at(-1).event.phase = 'running' }, 'prior replay must finish')
    await mutate(r => { r.journal.preparation.afterSequence = 2 }, 'prior replay from its actual beginning')
  })
  it('requires both observed public Session identities rather than equal missing fields', async () => {
    const mutate = (keys: string[]) => rejects(x => {
      const continuity = JSON.parse(x.files.get(x.continuity.path)!)
      for (const side of ['before', 'after']) x.update(continuity[side].status, r => { for (const key of keys) delete r.session[key] })
      x.update(x.continuity, r => { r.before.status = continuity.before.status; r.after.status = continuity.after.status })
    }, 'actual original public Session')
    await mutate(['providerId', 'executorId', 'hostId', 'workspacePath', 'createdAt'])
    await mutate(['createdAt'])
  })
  it('requires positive integral Native process identities for ordinary restart', async () => {
    await rejects(x => x.update(x.manifest.native[0], r => { r.first.pid = 0.5; r.second.pid = 0.75 }), 'real process identities')
  })
  it('requires both actual Source consumer scopes and raw nonempty mounted subjects', async () => {
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports.pop() }), 'both production Workspace and selector scopes')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[1].passed = false }), 'failed actual Source consumer')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].conditions.fixtureSessions = [] }), 'Session subjects')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].rawEvents = [] }), 'raw mount and update')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].conditions.observation = '' }), 'fixed Source observation conditions')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].producer.nativeAppLaunched = true }), 'scope must remain explicit')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].sourceAfter = { changed: 'b'.repeat(64) } }), 'bytes changed during measurement')
  })
  it('derives Source counts from raw observations and rejects unrelated production commits', async () => {
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].globalStoreNotifications = 99 }), 'derive from raw events')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].samples[0].selectorCalls = 99 }), 'derive from actual raw')
    await rejects(x => x.update(x.sourceMeasurement, r => {
      const report = r.reports[1]; report.samples[1].commits = 1
      report.rawEvents.push({ sequence: ++report.updateEndSequence, window: 'update', kind: 'workspace-commit', consumerId: 'unrelated-workspace' })
    }), 'Unrelated production Workspace commits')
  })
  it('requires raw Source counts for both observer and Workspace scopes', async () => {
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[0].samples[0].renders = 99 }), 'derive from actual raw')
    await rejects(x => x.update(x.sourceMeasurement, r => { r.reports[1].samples[0].commits = 99 }), 'derive from actual raw')
    await rejects(x => x.update(x.sourceMeasurement, r => {
      const report = r.reports[0]; report.samples[1].renders = 1
      report.rawEvents.push({ sequence: ++report.updateEndSequence, window: 'update', kind: 'observer-render', consumerId: report.samples[1].id })
    }), 'Unrelated Source observer renders')
  })
  it('requires complete actual mounted subjects rather than a selected subset', async () => {
    await rejects(x => x.update(x.sourceMeasurement, r => {
      const report = r.reports[0], omitted = report.samples.pop()
      report.rawEvents = report.rawEvents.filter((event: any) => event.consumerId !== omitted.id)
      report.rawEvents.forEach((event: any, index: number) => { event.sequence = index + 1 })
      report.mountEndSequence = report.rawEvents.filter((event: any) => event.window === 'mount').length
      report.updateEndSequence = report.rawEvents.length
    }), 'Every actual mounted Tab and Session')
    await rejects(x => x.update(x.sourceMeasurement, r => {
      r.reports[1].conditions.fixtureLayouts['omitted-workspace'] = { root: { type: 'leaf', groupId: 'omitted-group' } }
    }), 'Every actual mounted Workspace')
    await rejects(x => x.update(x.sourceMeasurement, r => {
      const report = r.reports[1]
      report.rawEvents.push({ sequence: ++report.updateEndSequence, window: 'update', kind: 'workspace-commit', consumerId: 'unrecorded-workspace' })
    }), 'Raw consumer events')
  })
  it('requires the actual selected public Session/Run entry and original durable surface', async () => {
    const status = (x: ReturnType<typeof fixture>, when: 'before' | 'after', change: (r: any) => void) => {
      const receipt = JSON.parse(x.files.get(x.continuity.path)!); x.update(receipt[when].status, change)
      x.update(x.continuity, r => { r[when].status = receipt[when].status })
    }
    await rejects(x => status(x, 'before', r => { r.session = {} }), 'actual public Agent Session')
    await rejects(x => status(x, 'after', r => { r.session.run.runId = 'new-run' }), 'original healthy Run')
    await rejects(x => status(x, 'after', r => { r.run.runId = 'new-run' }), 'original healthy Run')
    await rejects(x => status(x, 'after', r => { r.run.state = 'exited' }), 'must remain running')
    await rejects(x => {
      const receipt = JSON.parse(x.files.get(x.continuity.path)!); x.update(receipt.after.workbench, r => { r.tabs.tab.layout.root.ratio = 0.6 })
      x.update(x.continuity, r => { r.after.workbench = receipt.after.workbench })
    }, 'Original work surface')
  })
  it('requires real persisted Group and split trees for both cost workbench observations', async () => {
    for (const change of [(r: any) => { delete r.layouts }, (r: any) => { delete r.tabs.tab.layout.root }]) {
      await rejects(x => {
        const receipt = JSON.parse(x.files.get(x.continuity.path)!)
        x.update(receipt.before.workbench, change); x.update(receipt.after.workbench, change)
        x.update(x.continuity, r => { r.before.workbench = receipt.before.workbench; r.after.workbench = receipt.after.workbench })
      })
    }
  })
  it('keeps public healthy Run continuity separate from actual private ordinary restart workbench facts', async () => {
    await rejects(x => x.update(x.continuity, r => { r.healthyRunBoundary.kind = 'user-app-restarted' }), 'separate from private Native restart')
    await rejects(x => x.update(x.continuity, r => { r.workbenchBoundary.kind = 'invented-renderer-dto' }), 'private ordinary restart boundary')
    await rejects(x => x.update(x.continuity, r => { r.workbenchBoundary.nativeReceiptSha256 = 'b'.repeat(64) }), 'validated actual Native receipt')
    await rejects(x => {
      const receipt = JSON.parse(x.files.get(x.continuity.path)!)
      for (const side of ['before', 'after']) x.update(receipt[side].workbench, r => { r.layouts.workspace.groups[0].recentTabIds = [] })
      x.update(x.continuity, r => { r.before.workbench = receipt.before.workbench; r.after.workbench = receipt.after.workbench })
    }, 'actual original private Native workbench')
  })
  it('accepts a real public observation with natural semantic activity change and no Renderer DTO', async () => {
    const x = fixture(), receipt = JSON.parse(x.files.get(x.continuity.path)!)
    x.update(receipt.after.status, r => { r.observation.semantic = 'idle'; r.observation.observedAt = 2; r.session.updatedAt = 2 })
    x.update(x.continuity, r => { r.after.status = receipt.after.status })
    expect((await join(x)).tasks).toEqual([...BROWSER_CLOSEOUT_TASKS])
  })
  it('rejects public status from another Session, unknown process, replacement PID and changed native handle', async () => {
    const status = (change: (r: any) => void, message: string) => rejects(x => {
      const receipt = JSON.parse(x.files.get(x.continuity.path)!); x.update(receipt.after.status, change)
      x.update(x.continuity, r => { r.after.status = receipt.after.status })
    }, message)
    await status(r => { r.session.agentSessionId = 'another-session' }, 'another Session')
    await status(r => { r.run.agentSessionId = 'another-session' }, 'another Session')
    await status(r => { r.observation.process = 'unknown' }, 'confirm running')
    await status(r => { r.run.pid = 0 }, 'actual public process identity')
    await status(r => { r.run.pid = 456 }, 'replacement process')
    await status(r => { r.session.nativeHandle.sessionId = 'new-native' }, 'native handle')
    await status(r => { r.session.workspacePath = '/another-workspace' }, 'Session identity')
  })
  it('rejects the old invented Renderer-shaped public observation', async () => {
    await rejects(x => {
      const receipt = JSON.parse(x.files.get(x.continuity.path)!)
      receipt.after.status = x.put('old-renderer-dto.json', { sessions: [{ id: 'original-agent', kind: 'agent', processState: 'running', control: { run: { runId: 'original-run' } } }] })
      x.update(x.continuity, r => { r.after.status = receipt.after.status })
    })
  })
  it('rejects source changing during consumption even after an initially matching identity', async () => {
    const x = fixture(), firstRead = x.read; let reads = 0
    x.read = async path => { if (path === x.source && ++reads === 2) x.files.set(path, 'late changed source'); return firstRead(path) }
    await expect(join(x)).rejects.toThrow('Candidate moved during proof consumption')
  })
  it('reads the preserved four done facts from the sole official transferred tracker path', () => {
    const path = new URL('../scripts/verify-browser-task-capabilities.mjs', import.meta.url)
    const source = readFileSync(path, 'utf8'), file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const found: string[] = []
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'readFile') {
        const target = node.arguments[0]
        if (target && ts.isCallExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'resolve') {
          for (const argument of target.arguments) if (ts.isStringLiteral(argument) && argument.text.endsWith('f-2ew8fzgff/tasks.json')) found.push(argument.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(found).toEqual(['.bagakit/feature-tracker/features-transferred/f-2ew8fzgff/tasks.json'])
  })
  it('verifies exact recorded ancestor bytes independently of later Main work', async () => {
    const x = fixture(), candidate = x.manifest.candidate
    const committed = async (_commit: string, path: string) => x.read(path)
    await expect(verifyIntegratedCandidateSources({ candidate, readCommit: committed })).resolves.toBeUndefined()
    await expect(verifyIntegratedCandidateSources({ candidate, readCommit: async () => Buffer.from('older committed source') })).rejects.toThrow('recorded main commit')
    const movingMain = new Map(x.files); movingMain.set(x.source, 'later legal Main work'); movingMain.set('apps/desktop/scripts/verify-browser-task-capabilities.mjs', 'later canonical work')
    const reads: string[] = []
    await expect(verifyIntegratedCandidateSources({ candidate, readCommit: async (commit: string, path: string) => {
      expect(commit).toBe(candidate.commit); reads.push(path); return committed(commit, path)
    } })).resolves.toBeUndefined()
    expect(movingMain.get(x.source)).not.toBe(x.files.get(x.source))
    expect(reads.sort()).toEqual(Object.keys(candidate.identity).filter(path => path.includes('/src/') || path.includes('/scripts/')).sort())
  })
  it('binds the owning proof join and canonical scripts to candidate bytes', async () => {
    await rejects(x => { delete x.manifest.candidate.identity['apps/desktop/scripts/lib/browser-capability-proof-join.mjs']; x.syncIdentity() }, 'owning proof join and canonical scripts')
    await rejects(x => { delete x.manifest.candidate.identity['apps/desktop/scripts/verify-browser-task-capabilities.mjs']; x.syncIdentity() }, 'owning proof join and canonical scripts')
  })
  it('verifies actual canonical script bytes from the recorded main commit, not only src', async () => {
    const x = fixture(), candidate = x.manifest.candidate, script = 'apps/desktop/scripts/verify-browser-task-capabilities.mjs'
    const committed = async (_commit: string, path: string) => path === script ? Buffer.from('older canonical script') : x.read(path)
    await expect(verifyIntegratedCandidateSources({ candidate, readCommit: committed })).rejects.toThrow('recorded main commit')
  })
})
