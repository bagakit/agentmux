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
const evidence = join(repository, '.tmp/demand-mote-origin', String(globalThis.crypto.randomUUID()))
await mkdir(evidence, { recursive: true })
const testFile = 'apps/desktop/test/mote-daily-goal.test.tsx'
const pattern = 'Mote new-chat origin:'
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
const main = 'apps/desktop/src/main/ipc.ts', store = 'apps/desktop/src/renderer/src/store.ts'
const projection = 'apps/desktop/src/renderer/src/lib/primary-mote-executor.ts'
const mutations = [
  { id: 'saved-mote-config-consumption', file: projection, before: 'if (moteExecutorId) {', after: 'if (false && moteExecutorId) {' },
  { id: 'unconfirmed-is-not-missing', file: projection, before: "if (topic?.quickMode?.status === 'unconfirmed') return { issue: topic.quickMode.message }", after: '' },
  { id: 'exact-host-discovery', file: projection, before: 'const executor = choices.find(item => item.id === moteExecutorId)', after: 'const executor = state.config?.executors[moteExecutorId] ? { id: moteExecutorId } : undefined' },
  { id: 'mapped-original-receiver', file: store, before: "if (mappedRegion?.kind === 'agent' && prompt?.trim()) {", after: 'if (false) {' }
]
const frozenFiles = [projection, 'apps/desktop/scripts/verify-demand-mote-origin.mjs', 'apps/desktop/scripts/fixtures/demand-activity/vitest.config.mts', 'apps/desktop/test/helpers/injected-context-core.ts']
function ownedFixture(text) {
  const start = text.indexOf('// T009: original MOTE.md file owner'), end = text.indexOf('// T003: actual Goal detail/picker')
  assert.ok(start >= 0 && end > start, 'Owned fixture must precede the peer frozen slice')
  return text.slice(start, end)
}
const receipt = { schema: 'agentmux.demand-mote-origin.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), source: {},
  ownedTestsSHA256: hash(ownedTests(await readFile(join(repository, testFile), 'utf8'))), ownedFixtureSHA256: hash(ownedFixture(await readFile(join(repository, testFile), 'utf8'))), baseline: null, mutations: [],
  userSessionTouched: false, limitations: ['Original renderer Files read/revision write traverses preload/Main real WorkspaceFiles, Main ScratchTopics MOTE parser, PMO new-chat and real Core/FileStore. Only Native I/O, probes and Electron transport are controlled. Original Source CLI is also built from Source; no new RPC/CLI command is added.',
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
    for (const file of [main, store, projection, 'apps/desktop/src/preload/index.ts', 'packages/core/src/client.ts',
      'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/scratch-topics.ts', 'apps/desktop/src/shared/mote-quick-mode.ts',
      'apps/desktop/src/renderer/src/lib/executors.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/shared/goal-pmo-origin.ts'])
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
  assert.equal(hash(ownedFixture(await readFile(join(repository, testFile), 'utf8'))), receipt.ownedFixtureSHA256, 'Owned fixture changed during gate')
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
