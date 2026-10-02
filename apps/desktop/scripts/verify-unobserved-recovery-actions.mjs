import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ts from 'typescript'
const root = resolve(import.meta.dirname, '../../..'), output = join(root, '.tmp/recovery-robustness-actions/unobserved-actions')
const hash = value => createHash('sha256').update(value).digest('hex'), exec = promisify(execFile)
const helper = 'apps/desktop/src/renderer/src/lib/session-recovery-actions.ts', spatial = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const store = 'apps/desktop/src/renderer/src/store.ts', pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx', owner = 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts'
const sourceFiles = ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/SessionRecoveryActions.tsx', helper, spatial,
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/continuity-failure-notice.ts', 'apps/desktop/src/shared/space-addresses.ts',
  'apps/desktop/src/renderer/src/styles/session-recovery-actions.css', 'apps/desktop/src/renderer/src/styles/index.css',
  'apps/desktop/test/session-recovery-actions.test.tsx', 'apps/desktop/test/fixtures/recovery-actions/vitest.mutation.config.mts',
  'apps/desktop/scripts/verify-session-recovery-actions.mjs', 'apps/desktop/scripts/fixtures/recovery-actions/presentation.mjs',
  'apps/desktop/scripts/fixtures/recovery-actions/presentation-cases.tsx',
  owner, 'apps/desktop/src/renderer/src/components/SessionConnectingSurface.tsx', 'apps/desktop/scripts/verify-unobserved-recovery-actions.mjs',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts']
await mkdir(output, { recursive: true })
const pins = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
const inputsBefore = await pins()
const mutations = [
  { id: 'original-create-operation-is-ignored', file: helper, replacements: [["  if (originalOperation && canonical.creation?.createOperationId !== originalOperation)\n    throw new Error('The original creation operation is not confirmed. No replacement is attached.')\n", '']] },
  { id: 'unknown-actions-skip-host-refence', file: helper, replacements: [[": source.observation !== 'unconfirmed' || unobservedRecoveryReference(source).source?.hostId === source.hostId)", ": true)"]] },
  { id: 'accepted-early-return-has-no-actions', file: pane, replacements: [['actions={unobservedActions} supplement={launchNotice}', 'supplement={launchNotice}']] },
  { id: 'connecting-early-return-has-no-actions', file: pane, replacements: [['actions={unobservedActions}\n          visible={visible && !parked}', 'visible={visible && !parked}']] },
  { id: 'core-execution-ignores-original-sid', file: store, replacements: [[" && region.agentSessionId === reference.agentSessionId", '']] },
  { id: 'missing-host-skips-original-core-read', file: helper, replacements: [['await rereadAgentRegionExecution(identity)\n    assertSource()', 'assertSource()']] },
  { id: 'conflicting-hosts-select-a-winner', file: helper, replacements: [["  if (hosts.size > 1) return { source: null, issue: 'Original Host references conflict. Re-read the original owner; no replacement Host is selected.' }\n", '']] },
  { id: 'empty-read-erases-confirmed-core-reference', file: owner, replacements: [["    if (observed === null && this.state !== null)\n      throw new Error('The original Core spatial document was not returned. Its confirmed references are retained; re-read the original owner.');\n", '']] },
  { id: 'late-document-read-uses-replacement-owner', file: store, replacements: [["  if (coreSpatialPersistence !== owner) throw new Error('The original Core spatial owner changed during observation. Its Region is retained; re-read the current owner.')\n", '']] },
  { id: 'late-creation-read-skips-source-fence', file: helper, replacements: [['const canonical = await api.sessions.creation(hostId, identity.agentSessionId)\n  assertSource(hostId)', 'const canonical = await api.sessions.creation(hostId, identity.agentSessionId)']] },
  { id: 'late-session-read-skips-intent-fence', file: helper, replacements: [["const session = await api.sessions.refresh({ kind: 'agent', hostId, agentSessionId: identity.agentSessionId, run: canonical.run })\n  assertSource(hostId)", "const session = await api.sessions.refresh({ kind: 'agent', hostId, agentSessionId: identity.agentSessionId, run: canonical.run })"]] }
]
async function run(name, config = './vitest.config.ts', env = process.env) {
  const report = join(output, name + '.json')
  let code = 0, raw = ''
  try { const result = await exec('pnpm', ['--config.verify-deps-before-run=false', 'exec', 'vitest', 'run', '--config', config, '--root', '.', ...(config.includes('mutation') ? ['-t', 'actual unobserved SessionPane'] : []), 'apps/desktop/test/session-recovery-actions.test.tsx', '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: root, env, maxBuffer: 8 * 1024 * 1024 }); raw = result.stdout + result.stderr }
  catch (error) { code = Number.isInteger(error.code) ? error.code : -1; raw = (error.stdout ?? '') + (error.stderr ?? '') + '\nChild exit: ' + String(error.code) + '\n' + String(error.message) }
  await writeFile(join(output, name + '.log'), raw)
  const parsed = JSON.parse(await readFile(report, 'utf8')), cases = parsed.testResults.flatMap(file => file.assertionResults)
  assert.ok(cases.length >= 10, 'Actual mounted cases were not collected.')
  return { code, tests: cases.length, passed: cases.filter(test => test.status === 'passed').length,
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
const callers = { paneActions: calls(pane, 'SessionRecoveryActions', true), paneOriginalReference: calls(pane, 'unobservedRecoveryReference'), paneOriginalRead: calls(pane, 'rereadUnobservedSession'),
  connectingActions: calls(pane, 'SessionConnectingSurface', true), exactCoreTuple: calls(helper, 'agentRegionExecution'), explicitCoreRead: calls(helper, 'rereadAgentRegionExecution'),
  canonicalCreationRead: calls(helper, 'creation'), sameSessionRead: calls(helper, 'refresh'), observedProjection: calls(helper, 'adoptAgentRegionObservation'), existingProjectionOwner: calls(store, 'reduceDetachedAgentLaunch'),
  ipcCreationOwner: calls('apps/desktop/src/main/ipc.ts', 'agentCreation'), ipcRefreshOwner: calls('apps/desktop/src/main/ipc.ts', 'refresh'),
  publicCoreObservation: calls('apps/desktop/src/main/runtime-controller.ts', 'refreshAgentSession') }
assert.ok(Object.values(callers).every(group => group.length), 'An owning production AST caller group is empty.')
await writeFile(join(output, 'production-callers.json'), JSON.stringify({ callers }, null, 2) + '\n')
let prior
try { prior = JSON.parse(await readFile(join(output, 'source-qualification.json'), 'utf8')) } catch {}
const receipts = []
for (const mutation of mutations) {
  const original = await readFile(join(root, mutation.file), 'utf8'); let variant = original
  for (const [from, to] of mutation.replacements) { assert.equal(variant.split(from).length, 2, mutation.id); variant = variant.replace(from, to) }
  const priorReceipt = prior?.mutations?.find(item => item.id === mutation.id && item.testSha256 === inputsBefore['apps/desktop/test/session-recovery-actions.test.tsx'] && item.loaded.sourceSha256 === hash(original) && item.loaded.loadedVariantSha256 === hash(variant))
  if (priorReceipt?.assertionRed.length) {
    const raw = JSON.parse(await readFile(join(output, mutation.id + '-red.json'), 'utf8'))
    assert.ok(raw.testResults.some(file => file.assertionResults.some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .* to /su.test(message)))))
    receipts.push({ ...priorReceipt, reusedExactProducer: true }); continue
  }
  const specFile = join(output, mutation.id + '-spec.json'), witness = join(output, mutation.id + '-loaded.json')
  await writeFile(specFile, JSON.stringify({ ...mutation, witness }))
  const result = await run(mutation.id + '-red', 'apps/desktop/test/fixtures/recovery-actions/vitest.mutation.config.mts', { ...process.env, AGENTMUX_RECOVERY_ACTION_MUTANT: specFile })
  const loaded = JSON.parse(await readFile(witness, 'utf8'))
  assert.equal(loaded.sourceSha256, hash(original)); assert.equal(loaded.loadedVariantSha256, hash(variant)); assert.notEqual(result.code, 0); assert.ok(result.assertionRed.length, mutation.id + ' lacks actual assertion RED')
  const restored = await run(mutation.id + '-restored-green'); assert.equal(restored.code, 0); assert.equal(restored.tests, restored.passed)
  assert.equal(hash(await readFile(join(root, mutation.file))), hash(original), 'Disk Source changed.')
  receipts.push({ id: mutation.id, testSha256: inputsBefore['apps/desktop/test/session-recovery-actions.test.tsx'], ...result, loaded, restored }); console.log(mutation.id + ': actual loaded assertion RED; exact Source restored GREEN')
}
const current = await run('current-source-green'); assert.equal(current.code, 0); assert.equal(current.tests, current.passed)
const inputsAfter = await pins(); assert.deepEqual(inputsAfter, inputsBefore)
const sourceQualification = { schema: 'agentmux.unobserved-recovery-actions-source.v1', passed: true, inputsBefore, inputsAfter, current, mutations: receipts, callers,
  userRuntimeTouched: false, limitations: ['Mounted production SessionPane, Store and API seams use explicit private synthetic Core replies. No original-user native restore or CLI input is claimed.', 'Counterexamples transform the actual loaded production module in memory; no Core/Source bytes or compiled dist are changed.', 'Exact original identity observation does not start a Run or send input. Existing independent actions retain their qualified explicit create/send semantics; no machine power-loss claim is made.'] }
await writeFile(join(output, 'source-qualification.json'), JSON.stringify(sourceQualification, null, 2) + '\n')
if (process.argv.includes('--source-only')) { console.log(`Source qualified: ${current.tests} mounted GREEN, ${receipts.length} loaded assertion RED, ${Object.keys(callers).length} nonempty production caller groups; independent visual review pending.`); process.exit(0) }
if (process.argv.includes('--capture')) {
  await exec('node', ['apps/desktop/scripts/fixtures/recovery-actions/presentation.mjs'], { cwd: root, env: { ...process.env, AGENTMUX_RECOVERY_ACTION_PRESENTATION: join(output, 'presentation.json'), AGENTMUX_RECOVERY_UNOBSERVED_PRESENTATION: '1' }, maxBuffer: 8 * 1024 * 1024 })
  console.log('Candidate PNG captured. Independent actual-image approval pending.'); process.exit(0)
}
const sceneBytes = await readFile(join(output, 'presentation.json')), scene = JSON.parse(sceneBytes), review = JSON.parse(await readFile(join(output, 'visual-review.json'), 'utf8'))
assert.equal(scene.passed, true); assert.equal(scene.userRuntimeTouched, false)
assert.equal(review.sceneSha256, hash(sceneBytes)); assert.equal(review.actualImagesOpened, true); assert.equal(review.verdict, 'approved'); assert.ok(review.reviewedBy && review.reviewedBy !== '/root/main_build_integrity'); assert.deepEqual(review.unresolvedMustFix, [])
for (const frame of scene.images) { assert.equal(hash(await readFile(frame.path)), frame.sha256); assert.ok(review.images.some(item => item.path === frame.path && item.sha256 === frame.sha256 && item.opened === true)) }
assert.ok(scene.images.length === 4)
for (const [file, sha] of Object.entries(scene.sourcePins)) assert.equal(hash(await readFile(join(root, file))), sha, 'Visual Source changed: ' + file)
await writeFile(join(output, 'qualification.json'), JSON.stringify({ ...sourceQualification, presentationSha256: hash(sceneBytes), independentReview: review }, null, 2) + '\n')
console.log(`Unobserved recovery actions qualified: ${current.tests} mounted GREEN, ${receipts.length} loaded counterexamples, independent review of ${scene.images.length} actual frames.`)
