import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..'), evidence = join(repository, '.tmp/demand-current-work', 'source-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const store = 'apps/desktop/src/renderer/src/store.ts', domain = 'packages/demand/src/demand-store.ts', input = 'apps/desktop/src/main/goal-dispatch-input.ts'
const projection = 'apps/desktop/src/renderer/src/lib/goal-current-work.ts', widget = 'apps/desktop/src/renderer/src/components/RegionCurrentDemand.tsx'
const files = [domain, input, store, projection, widget, 'packages/demand/src/dispatch.ts', 'packages/demand/src/demand-types.ts', 'packages/demand/src/index.ts',
  'packages/core/src/control.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/agentmux-cli-commands.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/ipc-sender-trust.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/goal-dispatch.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/lib/global-demand-board.ts', 'apps/desktop/src/renderer/src/lib/steer-queue-delivery.ts',
  'apps/desktop/src/renderer/src/components/AgentRegionHeader.tsx', 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx',
  'apps/desktop/src/renderer/src/styles/region-current-demand.css', 'apps/desktop/test/demand-current-work.test.tsx', 'apps/desktop/test/demand-current-work-product.test.tsx',
  'apps/desktop/test/helpers/current-demand-product.tsx', 'apps/desktop/scripts/fixtures/demand-current-work/vitest.config.mts', 'apps/desktop/scripts/verify-demand-current-work.mjs']
const mutations = [
  { id: 'original-receipt-reference', file: files[5], before: 'native.itemId !== `prompt:${intent.operationId}`', after: 'false' },
  { id: 'public-update-cannot-author-dispatch', file: domain, before: "if (Object.hasOwn(patch, 'dispatches'))", after: 'if (false)' },
  { id: 'business-operation-single-goal', file: domain, before: 'owner!.id !== id || !sameDemandDispatchIntent(original, intent)', after: '!sameDemandDispatchIntent(original, intent)' },
  { id: 'confirmed-input-never-regresses', file: domain, before: "if (original.stage === 'confirmed') return { unchanged: demand }", after: 'if (false) return { unchanged: demand }' },
  { id: 'core-receipt-frozen-prompt', file: input, before: 'item.content === dispatch.prompt', after: 'true' },
  { id: 'submit-frozen-prompt', file: input, before: 'original.prompt !== prompt', after: 'false' },
  { id: 'finite-core-business-ref', file: store, before: "{ goalDispatch: dispatchReference, execution: 'default' }", after: "{ execution: 'default' }" },
  { id: 'public-inspect-dispatch', file: 'packages/core/src/control-codec.ts', before: "...(source.dispatches === undefined ? {} : { dispatches: parseDemandDispatches(source.dispatches) }),", after: '...{},' },
  { id: 'actual-renderer-dispatch', file: store, before: 'dispatches: [...(demand.dispatches ?? [])],', after: 'dispatches: [],' },
  { id: 'unknown-not-current', file: projection, before: "const phase = confirmed ? null : dispatch.stage === 'prepared' ? 'prepared' : dispatch.stage === 'submitted' ? 'submitted' : 'unknown'", after: 'const phase = null' },
  { id: 'related-region-cache', file: projection, before: 'retained && JSON.stringify(retained) === JSON.stringify(fact) ? retained : fact', after: 'fact' },
  { id: 'current-work-exact-host', file: projection, before: 'JSON.stringify([hostId, agentSessionId])', after: 'JSON.stringify([agentSessionId])' },
  { id: 'region-exact-goal-focus', file: widget, before: "target: { kind: 'goal', goalId }", after: "target: { kind: 'goal', goalId: work.goals[0]!.goalId }" },
  { id: 'historical-related-not-current', file: 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', before: 'const context = !fact ? null', after: "const context = !fact ? demand.sessionIds.includes(source?.control.agentSessionId ?? '') ? 'Current execution' : null" }
]
const receipt = { schema: 'agentmux.demand-current-work.proof.v1', passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, baseline: null, mutations: [], userRunTouched: false, boundaries: [
    'Actual Source CLI and Unix JSON-RPC, Store, preload, registered Main IPC, Core prompt admission/durable timeline and Domain fsync; controlled Native I/O and Electron transport only.',
    'Private exact Source Core listener worker asset localization is explicitly logged; the original publication and semantic owner are loaded. Asset localization is not a behavioral mutant.',
    'Region and original Agent chrome/GoalDetail/GoalRow consumers are mounted; this Source gate does not certify installed App, native restart or visual quality.',
    'T006 owns real complete App restart. Unknown business receipt uses original goal.start/inspect; the generic message.pending selector gap is outside these actions.' ] }

async function run(name, mutation) {
  const reportFile = join(evidence, name + '.json'), loadedFile = join(evidence, name + '.loaded.ndjson'), logFile = join(evidence, name + '.log')
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-current-work/vitest.config.mts', '-t', 'Current Demand:', '--reporter=json', '--outputFile=' + reportFile], {
    cwd: repository, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_DAILY_GOAL_PROOF: loadedFile,
      ...(mutation ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutation) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data)
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000), [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer)
  await writeFile(logFile, output); assert.equal(signal, null, 'Runner/setup termination cannot qualify')
  const bytes = await readFile(reportFile), report = JSON.parse(bytes), rows = report.testResults.flatMap(result => result.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
  assert.equal(rows.length, 10, 'All nonempty owned behavior cases must execute')
  const failed = rows.filter(row => row.status === 'failed'), loadedBytes = await readFile(loadedFile)
  const graph = loadedBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), changed = graph.filter(row => row.consumer.endsWith('mutant'))
  assert.ok(graph.length > 0, 'An empty loaded graph cannot qualify')
  if (mutation) {
    assert.notEqual(exitCode, 0); assert.ok(failed.some(row => row.failureMessages.some(message => /AssertionError|__VITEST_(REJECTS|RESOLVES)__/.test(message))), 'A loaded mutation requires behavioral assertion RED')
    assert.ok(changed.some(row => row.file === mutation.file && row.beforeSha256 !== row.afterSha256), 'Actual owner Source must change while loaded')
  } else {
    assert.equal(exitCode, 0, output); assert.equal(failed.length, 0)
    for (const consumer of ['actual-source-cli', 'actual-vite-module', 'actual-source-listener-worker', 'actual-fixture-listener-asset']) assert.ok(graph.some(row => row.consumer === consumer), consumer + ' must execute')
    for (const file of files.filter(file => /\/src\/.*\.(ts|tsx)$/.test(file) && !file.endsWith('/demand-types.ts') && !file.endsWith('/control.ts') && !file.endsWith('/contracts.ts')))
      assert.ok(graph.some(row => row.file === file), 'Actual owner/consumer must load: ' + file)
    for (const file of ['packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/control-endpoint-publication.ts', 'packages/core/src/prompt-submission.ts'])
      assert.ok(graph.some(row => row.file === file), 'Actual public/native receipt boundary must load: ' + file)
  }
  const result = { exitCode, assertions: rows.length, failed: failed.map(row => row.fullName), actualMutation: changed, report: relative(repository, reportFile), reportSHA256: hash(bytes),
    log: relative(repository, logFile), logSHA256: hash(output), loaded: relative(repository, loadedFile), loadedSHA256: hash(loadedBytes) }
  console.log(JSON.stringify({ name, assertions: rows.length, failed: failed.length })); return result
}
try {
  for (const file of files) receipt.source[file] = hash(await readFile(join(repository, file)))
  for (const mutation of mutations) assert.equal((await readFile(join(repository, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One exact Source anchor: ' + mutation.id)
  receipt.baseline = await run('baseline')
  for (const mutation of mutations) receipt.mutations.push({ id: mutation.id, file: mutation.file, ...await run(mutation.id, mutation) })
  for (const [file, before] of Object.entries(receipt.source)) assert.equal(hash(await readFile(join(repository, file))), before, 'Owned Source changed during the gate: ' + file)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(repository, join(evidence, 'receipt.json')), mutations: receipt.mutations.length, error: receipt.error?.message }))
assert.equal(receipt.passed, true, receipt.error?.message)
