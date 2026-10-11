import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ts from 'typescript'
const root = resolve(import.meta.dirname, '../../..'), output = join(root, '.tmp/recovery-robustness-actions/recovery-actions')
const hash = value => createHash('sha256').update(value).digest('hex'), exec = promisify(execFile)
const helper = 'apps/desktop/src/renderer/src/lib/session-recovery-actions.ts', spatial = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const sourceFiles = ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/SessionRecoveryActions.tsx', helper, spatial,
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/continuity-failure-notice.ts', 'apps/desktop/src/shared/space-addresses.ts',
  'apps/desktop/src/renderer/src/styles/session-recovery-actions.css', 'apps/desktop/src/renderer/src/styles/index.css',
  'apps/desktop/test/session-recovery-actions.test.tsx', 'apps/desktop/test/fixtures/recovery-actions/vitest.mutation.config.mts',
  'apps/desktop/scripts/verify-session-recovery-actions.mjs', 'apps/desktop/scripts/fixtures/recovery-actions/presentation.mjs',
  'apps/desktop/scripts/fixtures/recovery-actions/presentation-cases.tsx',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/lib/session-recovery-banner.ts',
  'apps/desktop/test/continuity-failure-notice.test.ts', 'apps/desktop/test/session-recovery-presentation.test.ts',
  'apps/desktop/test/runtime-controller.test.ts']
await mkdir(output, { recursive: true })
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
const inputsBefore = await pins()
const mutations = [
  { id: 'missing-identity-is-start-new', file: sourceFiles[5], replacements: [["remedy: { kind: 'refresh' },\n        actionLabel: 'Re-read original'", "remedy: { kind: 'start-new' },\n        actionLabel: 'Re-read original'"]], test: 'scopes a missing resume token to this one Agent' },
  { id: 'continuity-overwrites-exit', file: sourceFiles[0], replacements: [['const exitNotice = sessionExitPresentation(session)', 'const exitNotice = null']], test: 'confirmed exit remains primary and original output is explicitly read-only during recovery' },
  { id: 'recheck-resumes', file: sourceFiles[0], replacements: [['try { await refreshSession(sessionId) }', 'try { await recoverSession(sessionId) }']], test: 'rechecks the exact original Session through its actual button with zero lifecycle or input' },
  { id: 'recheck-only-terminal', file: sourceFiles[0], replacements: [['try { await refreshSession(sessionId) }', 'try { if (observationRefreshRef.current) await observationRefreshRef.current(); else await refreshSession(sessionId) }']], test: 'identity recheck bypasses a mounted terminal-only observation callback' },
  { id: 'stale-canonical-read', file: 'apps/desktop/src/main/runtime-controller.ts', replacements: [['await client.refreshAgentSession(control.agentSessionId)', 'await client.refreshAgentSession(control.agentSessionId, control.run)']], test: 'canonical original Session recheck reads a rebound Run without lifecycle or input' },
  { id: 'drop-original-view-read-fence', file: sourceFiles[4], replacements: [["return !!view && isSessionSurface(view) && view.phase === 'attached' && view.sessionId === sessionId", 'return true']], test: 'a late read cannot adopt into a replaced original Region even if another view still shows the Session' },
  { id: 'forget-closed-original-view', file: sourceFiles[4], replacements: [['retainedOriginalViews.delete(view)', 'void view']], test: 'closing all original bindings and reopening the same Region and SID does not revive its old pending read' },
  { id: 'hide-retained-output', file: sourceFiles[0], replacements: [['pendingAgentRestore && !readingRetainedOutput ? (inlineHistory', 'pendingAgentRestore ? (inlineHistory']], test: 'confirmed exit remains primary and original output is explicitly read-only during recovery' },
  { id: 'remount-mints-fresh-operation', file: helper, replacements: [["return 'recovery:' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')", "return 'recovery:' + crypto.randomUUID()"]] },
  { id: 'drop-original-host-scope', file: helper, replacements: [['source.hostId, source.agentSessionId, source.workspaceId, source.tabId, source.regionId, mode', 'source.agentSessionId, source.workspaceId, source.tabId, source.regionId, mode']] },
  { id: 'drop-separate-reference-note', file: spatial, replacements: [["...(options?.agentMuxNote === undefined ? {} : { agentMuxNote: options.agentMuxNote }),", '']] },
  { id: 'remove-late-mote-fence', file: helper, replacements: [["const deliveredBefore = await readRecoveryDelivery(target, requestId)\n  assertTarget()", "const deliveredBefore = await readRecoveryDelivery(target, requestId)"]] },
  { id: 'ignore-core-delivery-witness', file: helper, replacements: [["return timeline.items.some(item => item.id === `prompt:${requestId}` && item.agentSessionId === target.agentSessionId && item.kind === 'user_message' && item.status === 'complete')", 'return false']] },
  { id: 'adopt-another-create-operation', file: spatial, replacements: [["if (created.creation?.createOperationId !== binding.requestId) throw new Error('Core has not confirmed this original creation operation identity. Its healthy Session is retained without attaching a replacement.')", '']] },
  { id: 'empty-history-is-delivery', file: helper, replacements: [["return timeline.items.some(item => item.id === `prompt:${requestId}` && item.agentSessionId === target.agentSessionId && item.kind === 'user_message' && item.status === 'complete')", "return timeline.items.length === 0 || timeline.items.some(item => item.id === `prompt:${requestId}` && item.agentSessionId === target.agentSessionId && item.kind === 'user_message' && item.status === 'complete')"]] },
  { id: 'stale-placement-after-creation-read', file: spatial, replacements: [[';({ state, catalog, to, atTarget, snapshot } = currentLocation())', '']] }
]
async function run(name, config = './vitest.config.ts', env = process.env, filter) {
  let groups = [
    { id: 'ui', files: ['apps/desktop/test/session-recovery-actions.test.tsx', 'apps/desktop/test/continuity-failure-notice.test.ts', 'apps/desktop/test/session-recovery-presentation.test.ts'], filter },
    { id: 'main', files: ['apps/desktop/test/runtime-controller.test.ts'], filter: filter?.startsWith('canonical original Session recheck') ? filter : 'canonical original Session recheck' }
  ]
  if (filter) groups = groups.filter(group => group.id === (filter.startsWith('canonical original Session recheck') ? 'main' : 'ui'))
  let code = 0, raw = ''; const suites = []
  for (const group of groups) {
    const report = join(output, `${name}-${group.id}.json`)
    await rm(report, { force: true })
    try {
      const result = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--root', '.', ...group.files,
        '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + report, ...(group.filter ? ['-t', group.filter] : [])],
        { cwd: root, env, maxBuffer: 8 * 1024 * 1024 })
      raw += result.stdout + result.stderr
    } catch (error) { code = Number.isInteger(error.code) ? error.code : -1; raw += (error.stdout ?? '') + (error.stderr ?? '') + String(error.message) }
    await writeFile(join(output, `${name}-${group.id}.log`), raw)
    let parsed
    try { parsed = JSON.parse(await readFile(report, 'utf8')) }
    catch (error) { throw new Error(`${name}/${group.id} did not produce a fresh test report; inspect its child log.`, { cause: error }) }
    assert.equal(parsed.testResults.length, group.files.length, 'Every scoped owning suite must be collected.')
    assert.ok(parsed.testResults.every(file => file.assertionResults.length > 0 && !file.message), 'No empty collection or setup error may qualify.')
    suites.push(...parsed.testResults)
  }
  await writeFile(join(output, name + '.log'), raw)
  assert.doesNotMatch(raw, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const all = suites.flatMap(file => file.assertionResults), cases = all.filter(test => test.status === 'passed' || test.status === 'failed')
  assert.ok(cases.length >= (filter ? 1 : 19), 'Actual scoped business cases were not executed.')
  const result = { testResults: suites, numTotalTests: cases.length, numPassedTests: cases.filter(test => test.status === 'passed').length,
    numFailedTests: cases.filter(test => test.status === 'failed').length, success: code === 0,
    scope: 'All recovery-action, continuity classification and new process-presentation tests; only the two canonical recheck cases from the broader RuntimeController suite.' }
  await writeFile(join(output, name + '.json'), JSON.stringify(result, null, 2) + '\n')
  return { code, tests: cases.length, passed: result.numPassedTests,
    assertionRed: cases.filter(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message))).map(test => test.fullName) }
}
const ast = new Map(await Promise.all(sourceFiles.filter(file => /\.(ts|tsx)$/.test(file) && !file.includes('/test/')).map(async file => [file, ts.createSourceFile(file, await readFile(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)])))
function calls(file, target, jsx = false) {
  const results = [], tree = ast.get(file)
  const visit = node => { const expression = jsx && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) ? node.tagName : ts.isCallExpression(node) ? node.expression : null
    const name = expression && (ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '')
    if (name === target) results.push({ file, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1, symbol: target }); ts.forEachChild(node, visit) }
  visit(tree); return results
}
const callers = { pane: calls(sourceFiles[0], 'SessionRecoveryActions', true), takeover: calls(sourceFiles[1], 'createRecoveryAgent'), analysis: calls(sourceFiles[1], 'analyzeWithRecoveryMote'),
  correlationRead: calls(sourceFiles[1], 'inspectRecoveryRequest'), spatialCreate: calls(helper, 'executeControl'), coreLaunch: calls(spatial, 'launch'),
  publicLaunchTransport: calls(sourceFiles[4], 'launchAgent'), moteQueue: calls(helper, 'enqueueAgentSteer'), moteDeliveryOwner: calls(helper, 'sendQueuedAgentSteer'), originalDeliveryRead: calls(helper, 'timeline'), messageIntent: calls(helper, 'retainRecoveryMessageIntent') }
callers.identityRecheck = calls(sourceFiles[0], 'refreshOriginal'); callers.confirmedExit = calls(sourceFiles[0], 'sessionExitPresentation'); callers.canonicalCoreRead = calls('apps/desktop/src/main/runtime-controller.ts', 'refreshAgentSession')
assert.ok(Object.values(callers).every(group => group.length), 'An owning production AST caller group is empty.')
await writeFile(join(output, 'production-callers.json'), JSON.stringify({ callers }, null, 2) + '\n')
const baseline = await run('baseline-source-green'); assert.equal(baseline.code, 0); assert.equal(baseline.tests, baseline.passed)
let prior
try { prior = JSON.parse(await readFile(join(output, 'source-qualification.json'), 'utf8')) } catch {}
if (JSON.stringify(prior?.inputsAfter) !== JSON.stringify(inputsBefore)) prior = undefined
const receipts = []
for (const mutation of mutations) {
  const original = await readFile(join(root, mutation.file), 'utf8'); let variant = original
  for (const [from, to] of mutation.replacements) { assert.equal(variant.split(from).length, 2, mutation.id); variant = variant.replace(from, to) }
  const priorReceipt = prior?.mutations?.find(item => item.id === mutation.id && item.loaded.sourceSha256 === hash(original) && item.loaded.loadedVariantSha256 === hash(variant))
  if (priorReceipt?.assertionRed.length) {
    const raw = JSON.parse(await readFile(join(output, mutation.id + '-red.json'), 'utf8'))
    assert.ok(raw.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)))))
    receipts.push({ ...priorReceipt, reusedExactProducer: true }); continue
  }
  const specFile = join(output, mutation.id + '-spec.json'), witness = join(output, mutation.id + '-loaded.json')
  await rm(witness, { force: true })
  await writeFile(specFile, JSON.stringify({ ...mutation, witness }))
  const result = await run(mutation.id + '-red', 'apps/desktop/test/fixtures/recovery-actions/vitest.mutation.config.mts', { ...process.env, AGENTMUX_RECOVERY_ACTION_MUTANT: specFile }, mutation.test)
  const loaded = JSON.parse(await readFile(witness, 'utf8'))
  assert.equal(loaded.sourceSha256, hash(original)); assert.equal(loaded.loadedVariantSha256, hash(variant)); assert.notEqual(result.code, 0); assert.ok(result.assertionRed.length, mutation.id + ' lacks actual assertion RED')
  if (mutation.test) assert.ok(result.assertionRed.some(name => name.endsWith(mutation.test)), mutation.id + ' must fail its owning behavior assertion')
  const restored = await run(mutation.id + '-restored-green'); assert.equal(restored.code, 0); assert.equal(restored.tests, restored.passed)
  assert.equal(hash(await readFile(join(root, mutation.file))), hash(original), 'Disk Source changed.')
  receipts.push({ id: mutation.id, ...result, loaded, restored })
}
const current = await run('current-source-green'); assert.equal(current.code, 0); assert.equal(current.tests, current.passed)
const inputsAfter = await pins(); assert.deepEqual(inputsAfter, inputsBefore)
const sourceQualification = { schema: 'agentmux.session-recovery-actions-source.v1', passed: true, inputsBefore, inputsAfter, baseline, current, mutations: receipts, callers,
  userRuntimeTouched: false, limitations: ['Mounted production SessionPane, Store and API seams use explicit private synthetic Core replies. No original-user native restore or CLI input is claimed.', 'Counterexamples transform the actual loaded production module in memory; no Core/Source bytes or compiled dist are changed.', 'Byte-readable intent correlation is not a disk fsync durability claim.'] }
await writeFile(join(output, 'source-qualification.json'), JSON.stringify(sourceQualification, null, 2) + '\n')
if (process.argv.includes('--source-only')) { console.log(`Source qualified: ${current.tests} mounted GREEN, ${receipts.length} loaded assertion RED, ${Object.keys(callers).length} nonempty production caller groups; independent visual review pending.`); process.exit(0) }
if (process.argv.includes('--capture')) {
  await exec('node', ['apps/desktop/scripts/fixtures/recovery-actions/presentation.mjs'], { cwd: root, env: { ...process.env, AGENTMUX_RECOVERY_ACTION_PRESENTATION: join(output, 'presentation.json'), AGENTMUX_RECOVERY_RECHECK_PRESENTATION: '1' }, maxBuffer: 8 * 1024 * 1024 })
  console.log('Candidate PNG captured. Independent actual-image approval pending.'); process.exit(0)
}
const sceneBytes = await readFile(join(output, 'presentation.json')), scene = JSON.parse(sceneBytes), review = JSON.parse(await readFile(join(output, 'visual-review.json'), 'utf8'))
assert.equal(scene.passed, true); assert.equal(scene.userRuntimeTouched, false)
assert.equal(review.sceneSha256, hash(sceneBytes)); assert.equal(review.actualImagesOpened, true); assert.equal(review.verdict, 'approved'); assert.ok(review.reviewedBy && !review.reviewedBy.endsWith('/reopen_final_review')); assert.deepEqual(review.unresolvedMustFix, [])
for (const frame of scene.images) { assert.equal(hash(await readFile(frame.path)), frame.sha256); assert.ok(review.images.some(item => item.path === frame.path && item.sha256 === frame.sha256 && item.opened === true)) }
assert.ok(scene.images.length >= (scene.recheckOnly ? 2 : 5))
for (const [file, sha] of Object.entries(scene.sourcePins)) assert.equal(hash(await readFile(join(root, file))), sha, 'Visual Source changed: ' + file)
await writeFile(join(output, 'qualification.json'), JSON.stringify({ ...sourceQualification, presentationSha256: hash(sceneBytes), independentReview: review }, null, 2) + '\n')
console.log(`Recovery actions qualified: ${current.tests} mounted GREEN, ${receipts.length} loaded counterexamples, independent review of ${scene.images.length} actual frames.`)
