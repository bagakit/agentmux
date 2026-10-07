import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile), repository = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args[0] === '--slice' && ['responsibility', 'patrol', 'cost', 'delegation'].includes(args[1]), 'Choose one bounded --slice responsibility|patrol|cost|delegation.')
assert.ok(args.length === 2 || args.length === 4 && ['--resume', '--check-qualified'].includes(args[2]), 'Optional continuation is --resume ORIGINAL_RECEIPT; read-only proof checking is --check-qualified POINTER.')
const slice = args[1], schemaName = slice === 'delegation' ? 'role-delegation' : slice
const schema = `agentmux.goal-${schemaName}-mutations.v1`, pointerSchema = `agentmux.goal-${schemaName}-qualified-receipt.v1`
const resumePath = args[2] === '--resume' ? resolve(repository, args[3]) : undefined
const previousBytes = resumePath ? await readFile(resumePath) : undefined
const previous = previousBytes ? JSON.parse(previousBytes) : undefined
if (previous) assert.ok(previous.schema === schema && previous.slice === slice && previous.passed === false,
  'Only an unfinished original receipt for this exact slice can be continued')
const shared = 'packages/core/src/goal-responsibility.ts'
const product = `apps/desktop/test/goal-${schemaName}-product.test.tsx`, unit = `apps/desktop/test/goal-${slice}.test.ts`
const costTest = 'packages/demand/test/demand-read-cost.test.ts'
const tests = slice === 'cost' ? [costTest] : slice === 'delegation' ? [product] : [`packages/demand/test/${slice === 'patrol' ? 'goal-patrol' : 'responsibility'}.test.ts`, unit, product,
  ...(slice === 'patrol' ? [costTest] : [])]
const oracleFiles = [...tests, ...(slice === 'cost' ? [] : ['apps/desktop/test/helpers/goal-responsibility-product.tsx'])]
const productSuite = 'responsibility production owners, compiled public CLI and mounted consumers '
const fullOracle = {
  'delays a short native idle but exposes persistent unreported responsibility': 'delays a short native idle but exposes persistent unreported responsibility from its original state start',
  'actual worker progress remains manager review until exact manager verification': productSuite + 'actual worker progress remains manager review until exact manager verification; related input and wrong Run reopen the original responsibility',
  'prioritizes a later stalled execution in actual list and Mote compact consumers': productSuite + 'prioritizes a later stalled execution in actual list and Mote compact consumers and exposes every hidden attention count',
  'an exact transient index update reads no unrelated Goal getters or record enumeration': productSuite + 'an exact transient index update reads no unrelated Goal getters or record enumeration and retains unrelated consumer references',
  'reads newly published execution after an early Domain event without detail': productSuite + 'reads newly published execution after an early Domain event without detail, then renders exact finite/delegated responsibility and preserves drafts',
  'retains same-Goal execution ambiguity': productSuite + 'retains same-Goal execution ambiguity in real Region and board consumers for starts, delegations and mixed sources'
}
const responsibilityCases = [
  { name: 'confirmed-input-erases-same-goal-execution-ambiguity', file: 'apps/desktop/src/renderer/src/lib/goal-current-work.ts',
    changes: [["attributionAmbiguous: original?.attributionAmbiguous === true || row?.binding === 'ambiguous'", 'attributionAmbiguous: false']], test: product,
    oracle: 'retains same-Goal execution ambiguity' },
  { name: 'idle-grace-never-becomes-unreported-stall', file: shared, build: true,
    changes: [['if (now < due) {', 'if (true) {']], test: unit,
    oracle: 'delays a short native idle but exposes persistent unreported responsibility' },
  { name: 'semantic-facts-cross-original-run-fence', file: shared, build: true,
    changes: [['const exact = facts.status?.session.agentSessionId === execution.agentSessionId && facts.status.session.run.runId === execution.runId && facts.status.run.runId === execution.runId',
      'const exact = Boolean(facts.status)']], test: product,
    oracle: 'actual worker progress remains manager review until exact manager verification' },
  { name: 'worker-wait-releases-unverified-management-responsibility', file: shared, build: true,
    changes: [["if (current && !current.managerVerified && current.phase !== 'executing')", "if (current && current.managerVerified && current.phase !== 'executing')"],
      ["if (current?.managerVerified && current.phase === 'waiting-external'", "if (current && current.phase === 'waiting-external'"]], test: product,
    oracle: 'actual worker progress remains manager review until exact manager verification' },
  { name: 'compact-truncates-later-alert', file: 'apps/desktop/src/renderer/src/components/GoalResponsibilitySummary.tsx',
    changes: [['const visible = compact ? [...attention, ...rows.filter(row => row.alert === null)].slice(0, 2) : rows', 'const visible = compact ? rows.slice(0, 2) : rows']], test: product,
    oracle: 'prioritizes a later stalled execution in actual list and Mote compact consumers' },
  { name: 'targeted-index-ignores-affected-goals', file: 'apps/desktop/src/renderer/src/lib/goal-current-work.ts',
    changes: [['for (const id of goalIds) replace(id, after[id])', 'for (const id of []) replace(id, after[id])']], test: product,
    oracle: 'an exact transient index update reads no unrelated Goal getters or record enumeration' },
  { name: 'targeted-index-enumerates-unrelated-work', file: 'apps/desktop/src/renderer/src/lib/goal-current-work.ts',
    changes: [['for (const id of goalIds) replace(id, after[id])', 'for (const id of Object.keys(after)) replace(id, after[id])']], test: product,
    oracle: 'an exact transient index update reads no unrelated Goal getters or record enumeration' },
  { name: 'early-event-business-publication-never-reads-new-execution', file: 'apps/desktop/src/renderer/src/store.ts',
    changes: [["set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(demand, state.demands[id]) } }))\n    refreshKnownGoalResponsibilities([id])\n  },\n  deleteDemand(id)",
      "set(state => ({ demands: { ...state.demands, [id]: demandRecordFromFilesystem(demand, state.demands[id]) } }))\n  },\n  deleteDemand(id)"]], test: product,
    oracle: 'reads newly published execution after an early Domain event without detail' }
]
const patrolSuite = 'actual original PMO patrol CLI, Core Input and mounted business consumer '
const patrolNames = {
  click: 'one actual click coalesces duplicate intent, commits the original Core input and keeps delivery distinct from PMO writeback',
  replay: 'an unknown attempted input survives a restarted Main owner without blind replay or replacement Session',
  stale: 'a stale frozen inspection retains original evidence without overriding new business scope, and unrelated authors cannot report it',
  review: 'review keeps management responsibility when an actual inspection has empty frozen criteria and empty checks',
  generation: 'an explicitly completed patrol can start a new generation at the same unaligned business scope while in-flight duplicate clicks still coalesce'
}
if (slice === 'patrol') for (const name of Object.values(patrolNames)) fullOracle[name] = patrolSuite + name
const patrolCases = [
  { name: 'gui-click-only-reads-instead-of-requesting-original-patrol', file: 'apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx',
    changes: [["api.demands.delegation('goal.patrol', { goalId, operationId })", "api.demands.delegation('goal.delegations', { goalId })"]], test: product, oracle: patrolNames.click },
  { name: 'unknown-original-attempt-replayed-after-owner-restart', file: 'apps/desktop/src/main/goal-patrol-owner.ts',
    changes: [['if (!attempt || attempt.attemptedAt || attempt.supersededAt || patrol.report || demandResponsibilityScope(goal) !== patrol.expectedScope) return',
      'if (!attempt || attempt.supersededAt || patrol.report || demandResponsibilityScope(goal) !== patrol.expectedScope) return'],
      ['if (admission.replayed) return // Another original owner already attempted; this read grants no submit.', 'void admission.replayed // Mutation: a persisted original attempt incorrectly grants submit again.']], test: product, oracle: patrolNames.replay },
  { name: 'stale-report-overwrites-new-original-business-scope', file: 'packages/demand/src/demand-store.ts', build: 'demand',
    changes: [['const applied = demandResponsibilityScope(goal) === patrol.expectedScope && goal.supervisorSessionId === author.agentSessionId && goal.grounding?.acceptedAt == null', 'const applied = true']], test: product, oracle: patrolNames.stale },
  { name: 'associated-review-hides-management-unknown-and-blocked-responsibility', file: shared, build: 'core',
    changes: [["if (current.reviewForHuman === true && goal.status !== 'blocked' && goal.alignment && goal.alignment.criteria.length > 0 &&\n      grounding.checks.length === goal.alignment.criteria.length && goal.alignment.criteria.every(c => grounding.checks.some(check => check.criterionId === c.id)) &&\n      grounding.checks.every(check => check.outcome !== 'unknown' && check.evidence.length > 0 && check.evidence.every(isDemandEvidenceReference) && (check.outcome !== 'gap' || Boolean(check.note.trim()))))",
      'if (current.reviewForHuman !== undefined)']], test: product, oracle: patrolNames.review },
  { name: 'reported-same-scope-reuses-old-patrol-input-generation', file: 'apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx',
    changes: [["operation('goal-patrol-request', [goalId, basis, patrol?.report?.operationId ?? null])", "operation('goal-patrol-request', [goalId, basis])"]], test: product, oracle: patrolNames.generation }
]
const costNames = { identity: 'invalidates for another original Store writer and for same revision, inode and size edits',
  bounded: 'keeps repeated exact Goal read work bounded with 1 or 1000 original Goals' }
if (slice === 'cost') for (const name of Object.values(costNames)) fullOracle[name] = name
const costCases = [
  { name: 'cached-file-version-ignores-same-inode-size-external-edit', file: 'packages/demand/src/demand-store.ts', build: 'demand',
    changes: [["[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')", "[stat.dev, stat.ino, stat.size].join(':')"]], test: costTest, oracle: costNames.identity },
  { name: 'point-goal-read-reprojects-all-unrelated-goals', file: 'packages/demand/src/demand-store.ts', build: 'demand',
    changes: [["const read = await this.readConfirmedSnapshot(), demand = read.demandsById.get(id)\n    if (!demand) return null\n    const { activities, ...content } = demand\n    return { ...clone(content), activities: projectActivities(activities, read.namesById) }",
      "const demand = (await this.snapshot()).demands.find(entry => entry.id === id)\n    return demand ? clone(demand) : null"]], test: costTest, oracle: costNames.bounded }
]
const delegationOracle = 'actual compiled delegation preserves the original authenticated Core source and canonical executor role through the mounted consumer'
if (slice === 'delegation') fullOracle[delegationOracle] = delegationOracle
const delegationCases = [{ name: 'original-delegation-producer-discards-canonical-executor-context', file: 'apps/desktop/src/main/goal-delegation-owner.ts',
  changes: [["roleGuidance: goalRoleGuidance({ role: 'executor', goalId: input.goalId, agentSessionId: intent.workerAgentSessionId, runId: intent.workerRunId, source: { kind: 'goal-delegation', operationId: intent.operationId, sourceMessageId: intent.sourceMessageId, threadId: intent.threadId } })", "roleGuidance: ''"]],
  test: product, oracle: delegationOracle }]
const cases = slice === 'delegation' ? delegationCases : slice === 'cost' ? costCases : slice === 'patrol' ? patrolCases : responsibilityCases
assert.ok(cases.length > 0, 'A nonempty production mutation set is required')
const id = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)
const proofDirectory = join(repository, '.tmp/goal-responsibility', slice === 'delegation' ? 't004/delegation' : slice === 'cost' ? 't003/cost' : slice === 'patrol' ? 't003' : 't001')
const evidence = join(proofDirectory, 'mutations-' + id)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const qualifiedPointer = join(proofDirectory, 'qualified-receipt.json')
const candidateFiles = [...new Set([...cases.map(item => item.file), ...oracleFiles,
  ...(slice === 'delegation' ? ['packages/core/src/goal-role-guidance.ts'] : [])])]
const originals = new Map(), receipt = { schema, slice,
  proofBoundary: slice === 'cost'
    ? 'Real original DemandStore semantic edits and owning file-protocol/cost counterexamples, with rebuilt Domain artifacts and precise restored source. The source-backed Domain oracle does not claim CLI, Native, Renderer, installed product or human acceptance.'
    : 'Real production semantic edits, original workspace build and owning tests including compiled public CLI/Main and mounted Renderer consumers. Build/load/infrastructure failures do not count as semantic RED. Not live Native, Chromium visual, installed product or human acceptance.',
  passed: false, startedAt: Date.now(), cases: [] }
if (previousBytes) receipt.continuation = { originalReceipt: resumePath, originalReceiptSha256: hash(previousBytes) }
const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false' }
let active
async function verifiedCompletedReceipt(pointerPath = qualifiedPointer) {
  let pointer
  try { pointer = JSON.parse(await readFile(pointerPath, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  assert.equal(pointer.schema, pointerSchema)
  assert.deepEqual(Object.keys(pointer).sort(), ['receipt', 'receiptSha256', 'schema'])
  const proofRoot = proofDirectory + '/'
  const readProof = async file => { const exact = resolve(repository, file); assert.ok(exact.startsWith(proofRoot), 'Qualified proof must stay within its original local evidence scope'); return await readFile(exact) }
  const file = resolve(repository, pointer.receipt), bytes = await readProof(file)
  assert.equal(hash(bytes), pointer.receiptSha256, 'Qualified receipt SHA changed')
  const value = JSON.parse(bytes)
  assert.ok(value.schema === schema && value.slice === slice && value.passed === true)
  const expectedFiles = [...candidateFiles].sort()
  assert.deepEqual(value.candidate.map(item => item.file).sort(), expectedFiles, 'Qualification must bind every critical semantic source and oracle test')
  for (const item of value.candidate) assert.equal(hash(await readFile(join(repository, item.file))), item.sha256, item.file + ': qualified candidate changed')
  const baselineBytes = await readProof(value.baseline.json)
  assert.equal(hash(baselineBytes), value.baseline.jsonSha256); assert.equal(value.baseline.code, 0)
  const baseline = JSON.parse(baselineBytes)
  assert.ok(baseline.numPassedTests > 0 && baseline.numFailedTests === 0 && baseline.numTotalTests === baseline.numPassedTests, 'Qualified baseline must execute nonempty GREEN tests')
  if (slice === 'patrol' || slice === 'cost') {
    assert.ok(value.baseline.costArtifact, 'Original nonempty cost artifact must be retained')
    const costBytes = await readProof(value.baseline.costArtifact.path)
    assert.equal(hash(costBytes), value.baseline.costArtifact.sha256)
    const costs = JSON.parse(costBytes)
    assert.deepEqual(costs.map(cost => cost.goals), [1, 1000], 'Both independent Goal populations must execute')
    for (const cost of costs) assert.deepEqual(cost, { goals: cost.goals, fileReads: 0, versionReads: 1, snapshotParses: 0, individualGoalClones: 1 })
  }
  assert.equal(value.cases.length, cases.length)
  assert.deepEqual(value.cases.map(item => item.name).sort(), cases.map(item => item.name).sort())
  for (const item of cases) {
    const proof = value.cases.find(entry => entry.name === item.name), original = await readFile(join(repository, item.file), 'utf8')
    let mutant = original
    for (const [from, to] of item.changes) { assert.equal(mutant.split(from).length, 2); mutant = mutant.replace(from, to) }
    assert.equal(proof.file, item.file); assert.equal(proof.test, item.test); assert.equal(proof.oracle, item.oracle)
    assert.equal(proof.originalSha256, hash(original)); assert.equal(proof.mutantSha256, hash(mutant))
    for (const [kind, code, state] of [['red', 1, 'failed'], ['restored', 0, 'passed']]) {
      const result = proof[kind], resultBytes = await readProof(result.json)
      assert.equal(result.code, code); assert.equal(hash(resultBytes), result.jsonSha256)
      const report = JSON.parse(resultBytes), executed = report.testResults.flatMap(suite => suite.assertionResults)
        .filter(test => !['pending', 'skipped', 'todo'].includes(test.status))
      assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0, item.name + ': runtime/load failures cannot qualify')
      assert.equal(executed.length, 1, item.name + ': one exact nonempty oracle must execute')
      assert.equal(executed[0].fullName, fullOracle[item.oracle]); assert.equal(executed[0].status, state)
      if (kind === 'red') assert.ok(executed[0].failureMessages.some(message => /AssertionError|expected .*to /u.test(message)), 'Infrastructure failure is not semantic RED')
    }
  }
  assert.equal(value.restoration.exactOriginalSource, true); assert.equal(value.restoration.allPlannedCases, cases.length)
  const seen = new Set([file]); let link = value.continuation
  while (link) {
    const exact = resolve(repository, link.originalReceipt); assert.ok(!seen.has(exact), 'Original evidence chain must not cycle'); seen.add(exact)
    const originalBytes = await readProof(exact); assert.equal(hash(originalBytes), link.originalReceiptSha256)
    const original = JSON.parse(originalBytes); assert.equal(original.schema, value.schema); assert.equal(original.slice, value.slice); link = original.continuation
  }
  return { passed: true, reused: true, receipt: file, receiptSha256: hash(bytes), verifiedCases: cases.length,
    baselineTests: baseline.numPassedTests, sourceShaVerified: true }
}
async function command(label, executable, parameters, runEnv = env) {
  process.stdout.write(JSON.stringify({ phase: label, executable, parameters }) + '\n')
  let code = 0, output = ''
  try { const value = await run(executable, parameters, { cwd: repository, env: runEnv, maxBuffer: 16 * 1024 * 1024 }); output = value.stdout + value.stderr }
  catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  const file = join(evidence, label + '.log'); await writeFile(file, output)
  return { code, log: file, logSha256: hash(output) }
}
async function build(label, kind = 'core') {
  const result = await command(label, 'pnpm', ['--filter', kind === 'demand' ? '@agentmux/demand' : '@agentmux/core...', 'build'])
  assert.equal(result.code, 0, label + ': build failure is not semantic RED; see ' + result.log)
  return result
}
async function check(label, { red = false, test, oracle } = {}) {
  const json = join(evidence, label + '.vitest.json')
  const parameters = [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', ...(test ? [test] : tests),
    ...(oracle ? ['--testNamePattern', oracle] : []), '--maxWorkers=1', '--reporter=default', '--reporter=json', '--outputFile=' + json]
  const productReceiptDirectory = join(evidence, 'product-' + label)
  const result = await command(label, process.execPath, parameters, { ...env,
    [['patrol', 'delegation'].includes(slice) ? 'AGENTMUX_GOAL_PATROL_RECEIPT_DIR' : 'AGENTMUX_GOAL_RESPONSIBILITY_RECEIPT_DIR']: productReceiptDirectory,
    ...(['patrol', 'cost'].includes(slice) && !oracle ? { AGENTMUX_DEMAND_READ_COST_EVIDENCE: join(evidence, label + '-demand-read-cost.json') } : {}) })
  let data
  try { data = JSON.parse(await readFile(json, 'utf8')) }
  catch (error) { throw new Error(label + ': no readable semantic test result was produced; this does not qualify as RED or GREEN. See ' + result.log, { cause: error }) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  const executed = assertions.filter(item => item.status !== 'pending' && item.status !== 'skipped' && item.status !== 'todo')
  assert.ok(executed.length > 0, label + ': no executed oracle; an empty test set cannot qualify')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, label + ': runtime/load failures do not qualify')
  if (oracle) {
    assert.equal(executed.length, 1, label + ': exactly one named nonempty oracle must execute')
    assert.equal(executed[0].fullName, fullOracle[oracle], label + ': exact owning assertion identity changed')
  }
  if (red) {
    assert.equal(typeof result.code, 'number', label + ': signal or spawn failure is not assertion RED')
    assert.notEqual(result.code, 0, label + ': production mutation survived')
    const failures = executed.filter(item => item.status === 'failed' && item.fullName.includes(oracle))
    assert.ok(failures.length > 0, label + ': the exact owning behavior must fail')
    assert.ok(failures.some(item => item.failureMessages.some(message => /AssertionError|expected .*to /u.test(message))), label + ': infrastructure/error loading is not semantic RED')
  } else {
    assert.equal(result.code, 0, label + ': candidate must be GREEN; see ' + result.log)
    assert.equal(executed.filter(item => item.status !== 'passed').length, 0, label + ': every executed oracle must pass')
  }
  const costArtifact = ['patrol', 'cost'].includes(slice) && !oracle ? join(evidence, label + '-demand-read-cost.json') : undefined
  return { ...result, json, jsonSha256: hash(await readFile(json)), productReceiptDirectory,
    ...(costArtifact ? { costArtifact: { path: costArtifact, sha256: hash(await readFile(costArtifact)) } } : {}), tests: executed.map(item => ({ name: item.fullName, status: item.status,
    ...(item.status === 'failed' ? { failures: item.failureMessages } : {}) })) }
}
async function restore() {
  if (!active) return
  const file = join(repository, active.file)
  assert.equal(hash(await readFile(file)), active.mutantSha256, 'Concurrent source change at ' + active.file + '; preserve it and do not overwrite')
  await writeFile(file, originals.get(active.file))
  assert.equal(hash(await readFile(file)), active.originalSha256, 'Original candidate was not precisely restored')
  active = undefined
}
try {
  if (args[2] === '--check-qualified') {
    try { const qualified = await verifiedCompletedReceipt(resolve(repository, args[3])); assert.ok(qualified, 'No completed qualified receipt'); console.log(JSON.stringify(qualified)); process.exit(0) }
    catch (error) { console.log(JSON.stringify({ passed: false, qualified: false, error: error.message })); process.exit(1) }
  }
  if (!previous) {
    try { const qualified = await verifiedCompletedReceipt(); if (qualified) { console.log(JSON.stringify(qualified)); process.exit(0) } }
    catch (error) { receipt.qualifiedReuseIssue = { name: error.name, message: error.message } }
  }
  await mkdir(evidence, { recursive: true })
  receipt.candidate = await Promise.all(candidateFiles.map(async file => {
    const bytes = await readFile(join(repository, file)); if (cases.some(item => item.file === file)) originals.set(file, bytes.toString('utf8'))
    return { file, sha256: hash(bytes) }
  }))
  if (previous) for (const prior of previous.candidate) assert.equal(hash(await readFile(join(repository, prior.file))), prior.sha256,
    prior.file + ': original qualified candidate changed; start a new bounded mutation run')
  if (previous) {
    assert.equal(previous.baseline.code, 0, 'The retained original baseline must be GREEN')
    assert.equal(hash(await readFile(previous.baseline.json)), previous.baseline.jsonSha256, 'Original baseline receipt changed')
    const baseline = JSON.parse(await readFile(previous.baseline.json, 'utf8'))
    assert.ok(baseline.numPassedTests > 0 && baseline.numFailedTests === 0 && baseline.numPassedTests === baseline.numTotalTests,
      'Only a nonempty completely GREEN original baseline can be reused')
    receipt.baseline = { ...previous.baseline, reusedFromOriginalReceipt: resumePath }
    process.stdout.write(JSON.stringify({ phase: 'reuse-confirmed-original-baseline', originalReceipt: resumePath, passedTests: baseline.numPassedTests }) + '\n')
  } else {
    // The coordinated patrol window starts from a freshly completed owner build;
    // Vitest's workspace guard rejects any stale artifact before tests execute.
    if (slice === 'responsibility') receipt.baselineBuild = await build('baseline-build')
    else receipt.baselineBuildPolicy = 'Uses the coordinated current build; standard workspace dist-freshness guard must pass before the nonempty baseline.'
    receipt.baseline = await check('baseline')
  }
  for (const item of cases) {
    const original = originals.get(item.file)
    assert.equal(hash(await readFile(join(repository, item.file))), hash(original), item.name + ': candidate drift; no mutation applied')
    let mutant = original
    for (const [from, to] of item.changes) {
      assert.equal(mutant.split(from).length, 2, item.name + ': one exact production anchor is required')
      mutant = mutant.replace(from, to)
    }
    assert.notEqual(hash(mutant), hash(original), item.name + ': a real semantic edit is required')
    const completed = previous?.cases.find(entry => entry.name === item.name)
    if (completed) {
      assert.equal(completed.file, item.file); assert.equal(completed.originalSha256, hash(original)); assert.equal(completed.mutantSha256, hash(mutant))
      assert.equal(completed.red.code, 1); assert.equal(completed.restored.code, 0)
      assert.equal(hash(await readFile(completed.red.json)), completed.red.jsonSha256)
      assert.equal(hash(await readFile(completed.restored.json)), completed.restored.jsonSha256)
      assert.ok(completed.red.tests.some(test => test.status === 'failed' && test.name.includes(item.oracle)))
      assert.ok(completed.restored.tests.length > 0 && completed.restored.tests.every(test => test.status === 'passed'))
      receipt.cases.push({ ...completed, reusedFromOriginalReceipt: resumePath })
      process.stdout.write(JSON.stringify({ phase: item.name + '-reuse-confirmed-original-red-green', originalReceipt: resumePath }) + '\n')
      continue
    }
    active = { file: item.file, originalSha256: hash(original), mutantSha256: hash(mutant) }
    await writeFile(join(repository, item.file), mutant)
    const entry = { name: item.name, ...active, test: item.test, oracle: item.oracle }
    if (item.build) entry.build = await build(item.name + '-build', item.build)
    entry.red = await check(item.name + '-red', { red: true, test: item.test, oracle: item.oracle })
    await restore()
    if (item.build) entry.restoredBuild = await build(item.name + '-restored-build', item.build)
    entry.restored = await check(item.name + '-restored', { test: item.test, oracle: item.oracle })
    receipt.cases.push(entry)
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  if (!previous) receipt.final = await check('final-restored')
  assert.equal(receipt.cases.length, cases.length, 'Every planned mutation must have assertion RED and restored GREEN')
  for (const [file, bytes] of originals) assert.equal(hash(await readFile(join(repository, file))), hash(bytes), file + ': original candidate must remain intact')
  for (const item of receipt.candidate) assert.equal(hash(await readFile(join(repository, item.file))), item.sha256, item.file + ': source/oracle candidate changed during qualification')
  receipt.restoration = { exactOriginalSource: true, allPlannedCases: cases.length,
    proof: 'Every planned production semantic mutation has owning assertion RED and an exact restored GREEN; the immutable original nonempty baseline is preserved.' }
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
} finally {
  try { if (active) { const kind = active.file.startsWith('packages/demand/') ? 'demand' : active.file.startsWith('packages/core/') ? 'core' : null; await restore(); if (kind) receipt.failureRecoveryBuild = await build('failure-recovery-build', kind) } }
  catch (error) { receipt.recoveryFailure = { name: error.name, message: error.message } }
  receipt.finishedAt = Date.now()
  await mkdir(dirname(join(evidence, 'receipt.json')), { recursive: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await writeFile(qualifiedPointer, JSON.stringify({ schema: pointerSchema,
    receipt: relative(repository, join(evidence, 'receipt.json')), receiptSha256: hash(await readFile(join(evidence, 'receipt.json'))) }, null, 2) + '\n')
  if (receipt.passed && slice === 'cost') {
    const pointer = join(repository, '.tmp/goal-responsibility/t005/cost-receipt.json'); await mkdir(dirname(pointer), { recursive: true })
    await writeFile(pointer, JSON.stringify({ path: relative(repository, join(evidence, 'receipt.json')), sha256: hash(await readFile(join(evidence, 'receipt.json'))) }, null, 2) + '\n')
  }
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), receiptSha256: hash(await readFile(join(evidence, 'receipt.json'))), failure: receipt.failure, recoveryFailure: receipt.recoveryFailure }))
assert.equal(receipt.passed, true, receipt.failure?.message ?? receipt.recoveryFailure?.message)
