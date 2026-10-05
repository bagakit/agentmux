import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const ts = createRequire(join(repository, 'package.json'))('typescript')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = join(repository, '.tmp/demand-origin-supervisor', String(globalThis.crypto.randomUUID()))
await mkdir(evidence, { recursive: true })
const testFile = 'apps/desktop/test/mote-daily-goal.test.tsx'
const pattern = 'origin Supervisor first-default'
function ownedTests(text) {
  const source = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fragments = []
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
    const first = statement.expression.arguments[0]
    if (first && ts.isStringLiteral(first) && first.text.startsWith(pattern)) fragments.push(statement.getText(source))
  }
  assert.equal(fragments.length, 3, 'All three owned original consumer cases must be nonempty')
  return fragments.join('\n')
}
const main = 'apps/desktop/src/main/ipc.ts', domain = 'packages/demand/src/demand-store.ts', store = 'apps/desktop/src/renderer/src/store.ts'
const mutations = [
  { id: 'canonical-requester-view', file: store, before: 'originalPmoSessionId = pendingOriginalSource ? originalSource.agentSessionId : presentations[0]!.id', after: 'originalPmoSessionId = originalSource.agentSessionId' },
  { id: 'canonical-public-receipt', file: store, before: 'receiptSessionId = canonicalRecipientId ?? null', after: "receiptSessionId = mappedRegion?.kind === 'agent' ? mappedRegion.sessionId : null" },
  { id: 'main-sole-preference', file: main, before: 'creationOrigin: { requesterAsSupervisor },', after: 'creationOrigin: { requesterAsSupervisor: !requesterAsSupervisor },' },
  { id: 'manual-default-pending', file: domain, before: 'origin.supervisorDefaultPending && origin.requesterAsSupervisor', after: 'origin.requesterAsSupervisor' },
  { id: 'atomic-assignee-union', file: domain, before: 'demand.assigneeSessionIds = [...new Set([...demand.assigneeSessionIds, source.agentSessionId])]', after: 'demand.assigneeSessionIds = []' },
  { id: 'original-loop-preservation', file: main, before: "allowSupervisorDefault: !loops.some(loop => loop.status !== 'stopped')", after: 'allowSupervisorDefault: true' },
  { id: 'confirmed-input-source', file: main, before: 'await confirmedPmoSource(goalPmo, original, operationId)', after: 'void original' },
  { id: 'queue-source-context', file: store, before: 'retryMessage.goalPmo)', after: 'undefined)' },
  { id: 'original-core-session-binding', file: store, before: 'await api.sessions.resolveCreationSessionId(workspace.hostId, createOperationId)', after: 'mintAgentSessionId()' },
  { id: 'durable-creation-reference', file: 'apps/desktop/src/renderer/src/lib/goals-direct-pmo.ts', before: 'creationOperationId: request?.creationOperationId ?? current.creationOperationId', after: 'creationOperationId: undefined' },
  { id: 'confirmed-input-source-reference', file: 'apps/desktop/src/renderer/src/lib/steer-queue-delivery.ts', before: 'entry.goalPmo?.creationOperationId !== undefined ||', after: '' },
  { id: 'confirmed-source-readonly-retry', file: store, before: 'entry.goalPmo?.creationOperationId !== undefined && confirmedSteerDelivery(state.timelines[sessionId], session.control, entry.operationId)', after: 'false' }
]
const frozenFiles = ['apps/desktop/src/shared/goal-pmo-origin.ts', 'apps/desktop/src/renderer/src/lib/goals-direct-pmo.ts',
  'apps/desktop/scripts/verify-demand-origin-supervisor.mjs', 'apps/desktop/scripts/fixtures/demand-activity/vitest.config.mts', 'apps/desktop/test/helpers/injected-context-core.ts', 'apps/desktop/src/renderer/src/lib/steer-queue-delivery.ts']
const receipt = { schema: 'agentmux.demand-origin-supervisor.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), source: {},
  ownedTestsSHA256: hash(ownedTests(await readFile(join(repository, testFile), 'utf8'))), baseline: null, mutations: [],
  userSessionTouched: false, limitations: ['Actual Source CLI/socket, Main ConfigStore and DemandStore, Renderer NewGoal/PMO queue, preload and real Core/FileStore are exercised. Only private Native I/O and Electron transport are controlled.',
    'The original directory identity helper is compiled from current Source if absent; no user Agent or installed App is driven.',
    'Installed Native App, visuals, restart of the complete Desktop workface and Region dispatch are separate T003/T005/T006 acceptance; this receipt does not certify them.'] }

async function run(name, mutation) {
  const proof = join(evidence, name + '.loaded.ndjson'), reportFile = join(evidence, name + '.json'), log = join(evidence, name + '.log')
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-activity/vitest.config.mts',
    '-t', pattern, '--reporter=json', '--outputFile=' + reportFile], { cwd: repository,
    env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_DAILY_GOAL_PROOF: proof,
      ...(mutation ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutation) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes)
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer); await writeFile(log, output)
  assert.equal(signal, null, name + ': runner/setup termination cannot qualify')
  const reportBytes = await readFile(reportFile), report = JSON.parse(reportBytes)
  const rows = report.testResults.flatMap(result => result.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
  assert.equal(rows.length, 3, 'No empty or partial set of owned product assertions may qualify')
  const failed = rows.filter(row => row.status === 'failed')
  const bytes = await readFile(proof), graph = bytes.toString().trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
  assert.ok(graph.length > 0, 'No empty original loaded Source graph may qualify')
  const changed = graph.filter(row => row.consumer.endsWith('mutant'))
  if (mutation) {
    assert.notEqual(exitCode, 0)
    assert.ok(failed.some(row => row.failureMessages.some(message => /AssertionError|__VITEST_(REJECTS|RESOLVES)__/.test(message))), 'Mutation must fail a behavioral assertion')
    assert.ok(changed.some(row => row.file === mutation.file && row.beforeSha256 !== row.afterSha256), 'Actual production consumer must load mutated Source')
  } else {
    assert.equal(exitCode, 0, output); assert.equal(failed.length, 0)
    for (const consumer of ['actual-source-cli', 'actual-vite-module']) assert.ok(graph.some(row => row.consumer === consumer), consumer + ' must execute')
    for (const file of [main, domain, store, 'apps/desktop/src/preload/index.ts', 'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts',
      'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/shared/goal-pmo-origin.ts',
      'apps/desktop/src/renderer/src/lib/goals-direct-pmo.ts', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'])
      assert.ok(graph.some(row => row.file === file), 'Actual original owner/consumer must load: ' + file)
  }
  console.log(JSON.stringify({ name, assertions: rows.length, failed: failed.length }))
  return { exitCode, signal, assertions: rows.length, failed: failed.map(row => row.fullName), actualMutation: changed,
    report: relative(repository, reportFile), reportSHA256: hash(reportBytes), log: relative(repository, log), logSHA256: hash(output),
    loaded: relative(repository, proof), loadedSHA256: hash(bytes), graph }
}
try {
  const helper = join(repository, 'apps/desktop/resources/bin/agentmux-workspace-move')
  try { await access(helper) } catch { execFileSync(process.execPath, ['apps/desktop/scripts/build-workspace-move-helper.mjs'], { cwd: repository, stdio: 'pipe' }) }
  receipt.directoryIdentityHelper = { binarySHA256: hash(await readFile(helper)) }
  for (const file of frozenFiles) receipt.source[file] = hash(await readFile(join(repository, file)))
  for (const mutation of mutations) assert.equal((await readFile(join(repository, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One exact current Source anchor: ' + mutation.id)
  const baseline = await run('baseline'); receipt.baseline = { ...baseline }; delete receipt.baseline.graph
  for (const mutation of mutations) { const result = await run(mutation.id, mutation); delete result.graph; receipt.mutations.push({ id: mutation.id, file: mutation.file, ...result }) }
  const final = await run('final-current-baseline'); receipt.final = { ...final }; delete receipt.final.graph
  for (const [file, before] of Object.entries(receipt.source)) assert.equal(hash(await readFile(join(repository, file))), before, 'Owned Source changed: ' + file)
  assert.equal(hash(ownedTests(await readFile(join(repository, testFile), 'utf8'))), receipt.ownedTestsSHA256, 'Owned test statements changed during gate')
  receipt.adjacentSourceChanges = []
  for (const row of baseline.graph.filter(row => row.sha256 && !Object.hasOwn(receipt.source, row.file))) {
    const after = hash(await readFile(join(repository, row.file)))
    if (after !== row.sha256) receipt.adjacentSourceChanges.push({ file: row.file, beforeSHA256: row.sha256, afterSHA256: after })
  }
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(repository, join(evidence, 'receipt.json')), mutations: receipt.mutations.length }))
assert.equal(receipt.passed, true, receipt.error?.message)
