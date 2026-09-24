import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import ts from 'typescript'
import { assertNativeBrowserMeasurements, assertSourceBrowserConsumers } from './browser-capability-cost-collector.mjs'

export const BROWSER_CLOSEOUT_TASKS = Object.freeze(['T-001', 'T-005', 'T-006', 'T-007', 'T-009', 'T-010',
  'T-011', 'T-012', 'T-014', 'T-015', 'T-016', 'T-017', 'T-018', 'T-019', 'T-020', 'T-021'])
const historicalIds = ['T-002', 'T-003', 'T-004', 'T-008']
const nativeCases = ['default', 'overlay', 'browser-tools', 'demonstration', 'frames', 'outcome', 'task-assets',
  'task-outcome-download', 'upload', 'local-recovery:locator', 'local-recovery:navigation']
const completionFields = { overlay: 'overlay', 'browser-tools': 'browserTools', demonstration: 'demonstration', frames: 'frames',
  outcome: 'browserOutcome', 'task-assets': 'taskAssets', 'task-outcome-download': 'taskDownload', upload: 'uploads' }
// These two current producer schemas mutate a single fixed owner and omit per-case file.
const packetOwners = { 'agentmux.browser-download-outcome-source-mutations.v1': 'apps/desktop/src/main/browser-outcome-criteria.ts',
  'agentmux.browser-completion-source-mutations.v1': 'packages/core/src/browser-completion-facts.ts' }
const mutationSchemas = new Set(['agentmux.renderer-source-mutation.v1', 'agentmux.browser-download-outcome-source-mutations.v1',
  'agentmux.browser-completion-source-mutations.v1', 'agentmux.browser-task-outcome-manager-source-mutations.v1',
  'agentmux.browser-frame-probe-source-mutations.v1', 'agentmux.browser-frame-sanitizer-increment-mutations.v1',
  'agentmux.browser-local-recovery-source-mutations.v1', 'agentmux.browser-checked-stream-source-mutations.v1',
  'agentmux.browser-canonical-independent-increment3-source-mutations.v1'])
const joinSources = ['apps/desktop/scripts/lib/browser-capability-proof-join.mjs', 'apps/desktop/scripts/verify-browser-task-capabilities.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const nonemptyObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
const nonempty = (values, message) => assert.ok(Array.isArray(values) && values.length > 0, message)

export async function verifyIntegratedCandidateSources({ candidate, readCommit }) {
  const sources = Object.keys(candidate.identity).filter(path => path.includes('/src/') || path.includes('/scripts/'))
  nonempty(sources, 'Require integrated source inputs')
  for (const path of sources) {
    assert.equal(hash(await readCommit(candidate.commit, path)), candidate.identity[path], `Candidate source is not from its recorded main commit: ${path}`)
  }
}

// Validate the actual PersistedWorkbench artifact, without projecting it into a second DTO.
function assertPersistedWorkbench(workbench) {
  assert.ok(nonemptyObject(workbench.tabs) && nonemptyObject(workbench.layouts), 'Require actual persisted tabs and workspace layouts')
  const leaves = (node, field) => {
    assert.ok(node && ['leaf', 'split'].includes(node.type), 'Require the actual persisted split tree')
    if (node.type === 'leaf') {
      assert.ok(typeof node[field] === 'string' && node[field], 'Require a real split tree leaf identity')
      return [node[field]]
    }
    assert.ok(['horizontal', 'vertical'].includes(node.direction) && Number.isFinite(node.ratio) && node.ratio > 0 && node.ratio < 1, 'Require actual split direction and ratio')
    return [...leaves(node.first, field), ...leaves(node.second, field)]
  }
  const members = []
  for (const [workspaceId, layout] of Object.entries(workbench.layouts)) {
    nonempty(layout.groups, 'Require actual workspace Tab Groups')
    const groupIds = layout.groups.map(group => group.id)
    assert.equal(new Set(groupIds).size, groupIds.length, 'Require unique Tab Groups')
    assert.deepEqual(leaves(layout.root, 'groupId').sort(), [...groupIds].sort(), 'Workspace tree must contain its actual Tab Groups')
    assert.ok(groupIds.includes(layout.activeGroupId), 'Require the actual active Tab Group')
    for (const group of layout.groups) {
      assert.ok(group.id && Array.isArray(group.tabOrder) && Array.isArray(group.recentTabIds), 'Require actual ordered Group membership')
      assert.ok(group.activeTabId === null || group.tabOrder.includes(group.activeTabId), 'Require actual Group active Tab')
      for (const id of group.recentTabIds) assert.ok(group.tabOrder.includes(id), 'Recent Tabs must belong to their Group')
      for (const id of group.tabOrder) {
        assert.equal(workbench.tabs[id]?.workspaceId, workspaceId, 'Group must contain its real workspace Tabs')
        members.push(id)
      }
    }
  }
  assert.deepEqual(members.sort(), Object.keys(workbench.tabs).sort(), 'Every original Tab must have one actual Group owner')
  for (const [id, tab] of Object.entries(workbench.tabs)) {
    assert.equal(tab.id, id, 'Require the actual original Tab identity')
    assert.ok(nonemptyObject(tab.regions), 'Require actual original Regions')
    assert.deepEqual(leaves(tab.layout?.root, 'regionId').sort(), Object.keys(tab.regions).sort(), 'Region tree must contain its actual Regions')
    assert.ok(tab.regions[tab.layout.activeRegionId] && tab.regions[tab.titleRegionId], 'Require actual active and title Regions')
  }
}

function callerProgram(sources) {
  const files = new Map(sources.map(([path, source]) => ['/' + path, ts.createSourceFile('/' + path, source, ts.ScriptTarget.Latest, true)]))
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve, allowJs: true, noLib: true, baseUrl: '/', paths: { '@agentmux/*': ['packages/*/src/index.ts'] } }
  const host = { getSourceFile: path => files.get(path), getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '/',
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    fileExists: path => files.has(path), readFile: path => files.get(path)?.text,
    directoryExists: path => [...files.keys()].some(file => file.startsWith(path.replace(/\/$/, '') + '/')) }
  return ts.createProgram([...files.keys()], options, host)
}

function actualCaller(source, caller, program) {
  if (caller.kind === 'css-import') {
    assert.ok(caller.path.endsWith('.css') && caller.definition.endsWith('.css'))
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
    return [...css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)]
      .some(match => posix.normalize(posix.join(posix.dirname(caller.path), match[1])) === caller.definition)
  }
  const file = program.getSourceFile('/' + caller.path)
  assert.ok(file, 'Caller must belong to the candidate TypeScript program')
  assert.equal(file.parseDiagnostics.length, 0, 'Caller source must parse')
  const checker = program.getTypeChecker()
  const resolved = symbol => symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
  const inDefinition = symbol => resolved(symbol)?.declarations?.some(declaration => declaration.getSourceFile().fileName === '/' + caller.definition)
  const bound = expression => {
    const member = ts.isPropertyAccessExpression(expression)
    const symbol = resolved(checker.getSymbolAtLocation(member ? expression.name : expression))
    if (!symbol?.declarations?.length) return false
    if ((member ? expression.name.text : symbol?.name) !== caller.symbol) return false
    if (inDefinition(symbol)) return true
    if (!member) return false
    let root = expression.expression
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression
    return ts.isIdentifier(root) && inDefinition(checker.getSymbolAtLocation(root))
  }
  let found = false
  const visit = node => {
    if (caller.kind === 'jsx-class') {
      if (ts.isJsxAttribute(node) && node.name.getText(file) === 'className' && node.initializer) {
        const literals = value => {
          if ((ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text.split(/\s+/).includes(caller.symbol)) found = true
          ts.forEachChild(value, literals)
        }
        literals(node.initializer)
      }
    } else if (((ts.isCallExpression(node) || ts.isNewExpression(node)) && bound(node.expression)) ||
      ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && bound(node.tagName))) found = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** One complete Native validator, shared by final join and explicit canonical receipt consumption. */
export async function validateNativeReceipt({ receipt, candidate, frames, readArtifact }) {
  assert.equal(receipt.schema, 'agentmux.browser-recovery-restart.v1')
  assert.equal(receipt.completeGate, true, 'Native failure cannot become a successful join')
  assert.equal(receipt.passed, true, 'Require the actual successful Native receipt')
  assert.equal(receipt.failure, null, 'Native failure must remain a failure')
  assert.equal(receipt.sourceCommit, candidate.commit, 'Native belongs to another recorded candidate commit')
  assert.equal(receipt.cleanup.privateProcessesReaped, true)
  assert.deepEqual(receipt.cleanup.errors, [], 'Native cleanup errors cannot pass')
  assert.deepEqual(receipt.cleanup.remaining, [], 'Native processes must actually be reaped')
  assert.equal(receipt.cleanup.temporaryRootRemoved, true, 'Native temporary root must actually be removed')
  assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
  assert.ok(nonemptyObject(receipt.identityBefore), 'Require actual Native source inputs')
  for (const [path, expected] of Object.entries(receipt.identityBefore)) assert.equal(candidate.identity[path], expected, `Proof names a different candidate: ${path}`)
  assert.ok(Number.isSafeInteger(receipt.first.pid) && Number.isSafeInteger(receipt.second.pid) && receipt.first.pid > 0 && receipt.second.pid > 0 && receipt.first.pid !== receipt.second.pid, 'Require two ordinary processes with real process identities')
  for (const exit of [receipt.firstExit, receipt.secondExit]) {
    assert.equal(exit.exitCode, 0, 'Require ordinary successful App quit')
    assert.equal(exit.signal, null, 'Forced termination is not ordinary restart')
  }
  const expected = receipt.firstUi.expected, restored = receipt.secondUi.restored
  assert.ok(nonemptyObject(receipt.firstUi.restored) && nonemptyObject(restored), 'Require actual nonempty before/after workbench')
  assert.deepEqual(restored, receipt.firstUi.restored, 'Original Group, split layout and work surface must survive')
  assertPersistedWorkbench(receipt.firstUi.restored)
  assertPersistedWorkbench(restored)
  assert.ok(Array.isArray(receipt.firstUi.sessions) && Array.isArray(receipt.secondUi.sessions), 'Require actual original Session projections, including an observed empty private projection')
  assert.deepEqual(receipt.secondUi.sessions, receipt.firstUi.sessions, 'Original Session projection must survive')
  assert.ok(expected.tabId && expected.focus && expected.regions.length >= 2, 'Require the original nonempty split work surface')
  const tab = restored.tabs[expected.tabId]
  assert.equal(tab.layout.activeRegionId, expected.focus)
  assert.equal(Object.keys(tab.regions).length, expected.regions.length)
  for (const region of expected.regions) {
    const actual = tab.regions[region.regionId]
    assert.equal(actual.kind, 'browser')
    assert.equal(actual.browserId, region.browserId)
    assert.equal(actual.url, region.url)
  }
  let name = receipt.case ?? 'default'
  if (name === 'local-recovery') {
    assert.ok(['locator', 'navigation'].includes(receipt.localRecovery.kind))
    assert.equal(receipt.localRecovery.complete, true, 'Require the actual local failure and retained facts')
    name += `:${receipt.localRecovery.kind}`
  } else if (name === 'default') {
    assert.equal(receipt.visual.operations.completed.phase, 'completed')
    assert.equal(receipt.visual.operations.failed.phase, 'failed')
    assert.ok(receipt.visual.states.running.operation.id && receipt.visual.states.waiting.operation.id && receipt.visual.states.human.operation.id)
  } else {
    assert.ok(completionFields[name], 'Unknown Native scenario')
    assert.equal(receipt[completionFields[name]].complete, true, 'Require actual scenario completion')
  }
  nonempty(receipt.visual.frames, 'Require nonempty actual Native frames')

  nonempty(frames, 'Require preserved actual Native frame artifacts')
  assert.equal(new Set(receipt.visual.frames.map(frame => frame.label)).size, receipt.visual.frames.length, 'Require unique actual frame labels')
  assert.equal(frames.length, receipt.visual.frames.length, 'Preserve every actual captured frame')
  const bytes = async reference => {
    assert.ok(reference && reference.path && /^[a-f0-9]{64}$/.test(reference.sha256), 'Require a real preserved image reference')
    const value = await readArtifact(reference)
    assert.ok(value.length > 0, 'Require nonempty actual image bytes')
    assert.equal(hash(value), reference.sha256, 'Preserved actual image bytes changed')
  }
  for (const actual of receipt.visual.frames) {
    const matching = frames.filter(frame => frame.label === actual.label)
    assert.equal(matching.length, 1, 'Preserved artifact must bind its unique actual frame label')
    const frame = matching[0]
    assert.equal(frame.renderer.sha256, actual.sha256, 'Preserved Renderer image belongs to another frame')
    await bytes(frame.renderer)
    if (actual.nativePage.captureSource === 'native-browser-parked') {
      assert.equal(frame.native, undefined, 'A parked Native owner has no captured Native PNG')
      assert.deepEqual(frame.parkedOwners, actual.nativePage.owners, 'Preserve the original parked owner facts')
      nonempty(actual.nativePage.owners, 'Require actual parked Native owners')
      assert.equal(actual.nativePage.owners.length, 1, 'Require the original unique parked Native owner')
      const owner = actual.nativePage.owners[0]
      assert.ok(Number.isSafeInteger(owner.webContentsId) && owner.webContentsId > 0, 'Require an actual parked Native owner identity')
      assert.equal(owner.parked, true, 'Native owner must actually be parked')
      assert.ok(typeof owner.visible === 'boolean' && (!owner.visible || owner.bounds.width === 0 || owner.bounds.height === 0), 'Parked owner cannot remain visible with positive geometry')
      assert.ok(typeof owner.browserUrl === 'string' && owner.browserUrl, 'Require actual historical parked owner URL')
      assert.ok(receipt.visual.frames.some(shown => shown.nativePage.captureSource === 'native-browser-webcontents' &&
        shown.nativePage.webContentsId === owner.webContentsId), 'Require original parked owner restored with actual Native pixels')
    } else {
      assert.equal(actual.nativePage.captureSource, 'native-browser-webcontents')
      assert.ok(Number.isSafeInteger(actual.nativePage.webContentsId) && actual.nativePage.webContentsId > 0, 'Require actual shown Native owner identity')
      assert.ok(Array.isArray(actual.nativeBounds) && actual.nativeBounds.length === 1, 'Require the unique actual owner context for this historical frame')
      assert.equal(actual.nativePage.webContentsId, actual.nativeBounds[0].webContentsId, 'Shown pixels must bind this frame owner context')
      assert.ok(typeof actual.nativePage.browserUrl === 'string' && actual.nativePage.browserUrl, 'Require actual historical shown owner URL')
      assert.equal(actual.nativePage.browserUrl, actual.nativeBounds[0].browserUrl, 'Shown pixels must bind this frame URL context')
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isFinite(actual.nativeBounds[0][key]) && Math.abs(actual.nativePage.bounds[key] - actual.nativeBounds[0][key]) <= 2, 'Shown pixels must bind this frame actual owner bounds')
      assert.ok(actual.nativePage.bounds.width > 0 && actual.nativePage.bounds.height > 0 && actual.nativePage.size.width > 0 && actual.nativePage.size.height > 0, 'Require actual positive Native pixel geometry')
      assert.equal(frame.native.sha256, actual.nativePage.sha256, 'Preserved Native image belongs to another frame')
      await bytes(frame.native)
    }
  }
  return { name, receipt }
}

/** Consume existing proofs; this function never starts an App or changes a tracker. */
export async function joinBrowserCapabilityProof({ manifest, tasks, historicalTasks, read }) {
  assert.equal(manifest.schema, 'agentmux.browser-capability-closeout.v1')
  assert.equal(manifest.feature, 'f-2fm8f5q39')
  assert.equal(manifest.candidate.branch, 'main')
  assert.match(manifest.candidate.commit, /^[a-f0-9]{40}$/)
  const candidate = manifest.candidate.identity
  assert.ok(Object.keys(candidate).length > 0, 'Candidate identity must contain actual source and build inputs')
  assert.ok(Object.keys(candidate).some(path => path.endsWith('/out/main/index.js')))
  assert.ok(Object.keys(candidate).some(path => path.startsWith('apps/desktop/src/')))
  for (const path of joinSources) assert.ok(candidate[path], 'Candidate must bind its owning proof join and canonical scripts')
  const candidateBytes = new Map()
  for (const [path, expected] of Object.entries(candidate)) {
    const bytes = await read(path)
    assert.equal(hash(bytes), expected, `Current candidate changed: ${path}`)
    candidateBytes.set(path, bytes)
  }
  const program = callerProgram([...candidateBytes].filter(([path]) => path.includes('/src/') && /\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('/')).map(([path, bytes]) => [path, bytes.toString()]))
  const artifact = async reference => {
    assert.ok(reference.path.startsWith('docs/reviews/'), 'Evidence must be preserved outside temporary directories')
    const bytes = await read(reference.path)
    assert.ok(bytes.length > 0, `Empty evidence: ${reference.path}`)
    assert.equal(hash(bytes), reference.sha256, `Evidence changed: ${reference.path}`)
    return bytes
  }
  const sourceIdentity = identity => {
    assert.ok(Object.keys(identity).length > 0, 'A proof must name its actual source inputs')
    for (const [path, expected] of Object.entries(identity)) assert.equal(candidate[path], expected, `Proof names a different candidate: ${path}`)
  }
  const boundSource = value => {
    assert.equal(value.candidateCommit, manifest.candidate.commit, 'Measurement belongs to another candidate')
    sourceIdentity(value.sourceIdentity)
  }
  const consumeEvidence = async proof => {
    nonempty(proof.evidence, 'Require actual preserved evidence')
    const entries = new Map()
    for (const reference of proof.evidence) {
      assert.ok(!entries.has(reference.path), 'Duplicate evidence path')
      entries.set(reference.path, await artifact(reference))
    }
    let mutations = 0, currentSubjects = 0
    for (const [path, bytes] of entries) {
      if (!path.endsWith('.json')) continue
      const value = JSON.parse(bytes)
      if (Object.hasOwn(value, 'passed')) assert.equal(value.passed, true, `Failed task evidence: ${path}`)
      if (!mutationSchemas.has(value.schema)) continue
      mutations++
      assert.equal(value.passed, true)
      nonempty(value.cases, 'Source mutation packet must have actual cases')
      assert.ok(nonemptyObject(value.sourceBefore), 'Mutation packet must preserve source identity')
      if (value.sourceAfter) assert.deepEqual(value.sourceAfter, value.sourceBefore)
      if (value.copyAfter) assert.deepEqual(value.copyAfter, value.sourceBefore)
      for (const item of value.cases) {
        const file = Object.hasOwn(packetOwners, value.schema) ? packetOwners[value.schema] : item.file
        assert.ok(file && value.sourceBefore[file] && item.label, 'Mutation must name a real owning source')
        if (proof.sourceIdentity[file] === value.sourceBefore[file] && candidate[file] === value.sourceBefore[file]) currentSubjects++
        const local = value.schema === 'agentmux.browser-local-recovery-source-mutations.v1'
        const red = local ? item.red : { exit: item.exit, log: item.log }
        const green = local ? item.restoredGreen : item.restore
        assert.ok(Number.isInteger(red.exit) && red.exit > 0, 'Require actual Source Assertion RED')
        assert.equal(green.exit, 0, 'Require restored Source GREEN')
        const redPath = posix.join(posix.dirname(path), red.log), greenPath = posix.join(posix.dirname(path), green.log)
        assert.ok(entries.has(redPath) && entries.has(greenPath), 'Mutation logs must be hash-bound evidence')
        assert.match(entries.get(redPath).toString(), /AssertionError/, 'Assembly failure is not behavior RED')
        assert.match(entries.get(greenPath).toString(), /Tests\s+[1-9]\d* passed/, 'Restored GREEN must execute nonempty tests')
      }
    }
    return { mutations, currentSubjects }
  }
  assert.deepEqual(manifest.tasks.map(task => task.id).sort(), [...BROWSER_CLOSEOUT_TASKS].sort(), 'Consume every required task exactly once')
  for (const proof of manifest.tasks) {
    const task = tasks.find(task => task.id === proof.id)
    assert.ok(task, `Missing canonical task: ${proof.id}`)
    assert.equal(task.status, 'done', `${proof.id} is not formally done`)
    assert.equal(task.gate_result, 'pass', `${proof.id} did not pass its own gate`)
    const commands = task.verification.filter(item => item.kind === 'command').map(item => item.ref)
    assert.ok(commands.length > 0)
    assert.deepEqual(task.last_gate_commands.map(item => item.command), commands)
    for (const command of task.last_gate_commands) assert.equal(command.exit_code, 0)
    sourceIdentity(proof.sourceIdentity)
    const consumed = await consumeEvidence(proof)
    assert.ok(consumed.mutations > 0, 'Every delivered task must consume Source mutation evidence')
    assert.ok(consumed.currentSubjects > 0, 'Old mutations cannot sign a changed current subject')
    assert.ok(proof.callers.length > 0, `No definition-excluded caller proof: ${proof.id}`)
    for (const caller of proof.callers) {
      assert.notEqual(caller.path, caller.definition)
      assert.ok(caller.path.includes('/src/') && !/test|fixture/.test(caller.path))
      assert.ok(candidate[caller.path] && candidate[caller.definition], 'Caller and definition must belong to the candidate')
      assert.ok(actualCaller((await read(caller.path)).toString(), caller, program), `Caller disappeared: ${caller.symbol}`)
    }
  }
  assert.deepEqual(manifest.historical.map(task => task.id).sort(), historicalIds)
  for (const proof of manifest.historical) {
    assert.equal(historicalTasks.find(task => task.id === proof.id)?.status, 'done', 'Preserve the original historical done fact')
    sourceIdentity(proof.sourceIdentity)
    await consumeEvidence(proof)
  }
  const observedCases = new Set(), nativeBySha = new Map()
  assert.ok(manifest.native.length > 0)
  for (const reference of manifest.native) {
    const receipt = JSON.parse(await artifact(reference))
    const { name } = await validateNativeReceipt({ receipt, candidate: manifest.candidate, frames: reference.frames, readArtifact: artifact })
    assert.ok(!nativeBySha.has(reference.sha256), 'Local failure shapes need independent actual receipts')
    nativeBySha.set(reference.sha256, { name, receipt }); observedCases.add(name)
  }
  for (const name of nativeCases) assert.ok(observedCases.has(name), `Missing actual Native case: ${name}`)
  const reviewedCases = new Set()
  assert.ok(manifest.visualReviews.length > 0)
  for (const review of manifest.visualReviews) {
    assert.equal(review.decision, 'passed')
    assert.ok(review.reviewer && review.reviewer !== review.author, 'Image review must be independent')
    nonempty(review.frames, 'Require actually reviewed Renderer and Native images')
    const record = JSON.parse(await artifact(review))
    assert.equal(record.schema, 'agentmux.browser-closeout-visual-review.v1')
    assert.equal(record.approved, true, 'The preserved independent review must actually approve')
    assert.equal(record.reviewer, review.reviewer); assert.equal(record.author, review.author)
    nonempty(record.receipts, 'Require actual image review receipt associations')
    const association = record.receipts.filter(item => item.case === review.case && item.nativeReceiptSha256 === review.nativeReceiptSha256)
    assert.equal(association.length, 1, 'Manifest cannot relabel an old independent review')
    assert.deepEqual(association[0].frames, review.frames, 'Manifest cannot invent reviewed images')
    const observed = nativeBySha.get(review.nativeReceiptSha256)
    assert.ok(observed && review.case === observed.name, 'Image review must bind its actual Native receipt and case')
    for (const frame of review.frames) {
      const actual = observed.receipt.visual.frames.filter(item => item.label === frame.label)
      assert.equal(actual.length, 1, 'Review must name a unique actual Native frame label')
      assert.equal(frame.renderer.sha256, actual[0].sha256, 'Reviewed Renderer image belongs to another frame')
      if (actual[0].nativePage.captureSource === 'native-browser-parked') {
        assert.equal(frame.native, undefined, 'Review cannot invent a Native PNG for a parked owner')
        assert.deepEqual(frame.parkedOwners, actual[0].nativePage.owners, 'Review must preserve actual parked Native owner facts')
      } else {
        assert.equal(frame.native.sha256, actual[0].nativePage.sha256, 'Reviewed Native image belongs to another frame')
        await artifact(frame.native)
      }
      await artifact(frame.renderer)
    }
    reviewedCases.add(review.case)
  }
  for (const name of nativeCases) assert.ok(reviewedCases.has(name), `Missing independent image review: ${name}`)
  const costs = JSON.parse(await artifact(manifest.costs))
  assert.equal(costs.schema, 'agentmux.browser-capability-costs.v1'); boundSource(costs)
  const measured = JSON.parse(await artifact(costs.measurement))
  assert.equal(measured.schema, 'agentmux.browser-capability-measurements.v1'); boundSource(measured)
  const nativeMeasurements = JSON.parse(await artifact(measured.nativeProducer))
  assertNativeBrowserMeasurements(nativeMeasurements); boundSource(nativeMeasurements)
  const outcomes = [...nativeBySha.values()].filter(item => item.name === 'outcome')
  assert.equal(outcomes.length, 1, 'Costs must consume one actual validated Native outcome producer')
  const outcome = outcomes[0].receipt
  assert.deepEqual(nativeMeasurements, outcome.capabilityMeasurements, 'Native costs must be the actual validated receipt measurement facts')
  assert.equal(nativeMeasurements.producer.operation.id, outcome.browserOutcome.initial.id, 'Native costs must bind the original outcome operation')
  assert.equal(nativeMeasurements.producer.operation.browserId, outcome.browserOutcome.initial.browserId, 'Native costs must bind the original outcome Browser')
  assert.deepEqual(nativeMeasurements.producer.recordedResult, outcome.browserOutcome.recordedResult, 'Native costs must bind the original saved result bytes')
  const sourceMeasurements = JSON.parse(await artifact(measured.sourceConsumers))
  assertSourceBrowserConsumers(sourceMeasurements)
  for (const report of sourceMeasurements.reports) boundSource(report)
  const continuity = JSON.parse(await artifact(costs.continuity))
  assert.equal(continuity.schema, 'agentmux.browser-capability-public-continuity.v1'); boundSource(continuity)
  assert.deepEqual(continuity.healthyRunBoundary, { kind: 'public-selected-original-agent-session' }, 'Public healthy Run continuity is separate from private Native restart')
  assert.equal(continuity.workbenchBoundary.kind, 'private-native-ordinary-restart', 'Workbench continuity must name the actual private ordinary restart boundary')
  const workbenchReceipt = nativeBySha.get(continuity.workbenchBoundary.nativeReceiptSha256)
  assert.ok(workbenchReceipt, 'Workbench continuity must bind an already validated actual Native receipt')
  // Exact selected Core list.sessions entry; this is not a Renderer SessionSnapshot DTO.
  const before = JSON.parse(await artifact(continuity.before.status)), after = JSON.parse(await artifact(continuity.after.status))
  assert.ok(continuity.subject.agentSessionId && continuity.subject.runId, 'Require an explicit original public Session and Run')
  for (const status of [before, after]) {
    assert.equal(status.session.kind, 'agent', 'Require the actual public Agent Session')
    for (const key of ['providerId', 'executorId', 'hostId', 'workspacePath']) assert.ok(typeof status.session[key] === 'string' && status.session[key].trim(), 'Require the actual original public Session identity fields')
    assert.ok(Number.isSafeInteger(status.session.createdAt) && status.session.createdAt >= 0, 'Require the actual original public Session creation time')
    assert.equal(status.session.agentSessionId, continuity.subject.agentSessionId, 'Public observation belongs to another Session')
    assert.equal(status.run.agentSessionId, continuity.subject.agentSessionId, 'Public Run belongs to another Session')
    assert.equal(status.session.run.runId, continuity.subject.runId, 'The original healthy Run identity must survive')
    assert.equal(status.run.runId, continuity.subject.runId, 'The original healthy Run identity must survive')
    assert.equal(status.run.state, 'running', 'The original public Run must remain running')
    assert.equal(status.observation.process, 'running', 'Public process observation must confirm running')
    assert.ok(Number.isInteger(status.run.pid) && status.run.pid > 0, 'Require an actual public process identity')
  }
  assert.equal(after.run.pid, before.run.pid, 'A replacement process cannot sign original Run continuity')
  for (const key of ['providerId', 'executorId', 'hostId', 'workspacePath', 'createdAt']) assert.equal(after.session[key], before.session[key], 'Original public Session identity must survive')
  if (before.session.nativeHandle) assert.deepEqual(after.session.nativeHandle, before.session.nativeHandle, 'Original Provider native handle must survive')
  const original = JSON.parse(await artifact(continuity.before.workbench)), restored = JSON.parse(await artifact(continuity.after.workbench))
  assert.deepEqual(restored, original, 'Original work surface must survive cost observation')
  assertPersistedWorkbench(original)
  assertPersistedWorkbench(restored)
  assert.deepEqual(original, workbenchReceipt.receipt.firstUi.restored, 'Cost workbench before must be the actual original private Native workbench')
  assert.deepEqual(restored, workbenchReceipt.receipt.secondUi.restored, 'Cost workbench after must be the actual restored private Native workbench')
  for (const path of Object.keys(candidate)) assert.equal(hash(await read(path)), candidate[path], `Candidate moved during proof consumption: ${path}`)
  return { passed: true, feature: manifest.feature, candidate: manifest.candidate.commit,
    tasks: manifest.tasks.map(task => task.id), historical: manifest.historical.map(task => task.id), nativeCases: [...observedCases] }
}
