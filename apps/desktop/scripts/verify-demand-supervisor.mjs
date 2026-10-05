import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { probeGoalRuntime } from './fixtures/mote-daily-goal/runtime-probe.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = join(repository, '.tmp/demand-supervisor', String(globalThis.crypto.randomUUID()))
await mkdir(evidence, { recursive: true })
const owners = ['apps/desktop/src/main/continuous-progress-loop-manager.ts', 'apps/desktop/src/main/continuous-progress-task-source.ts',
  'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx', 'apps/desktop/src/renderer/src/styles/goal-continuation.css',
  'apps/desktop/src/renderer/src/lib/continuous-progress-input.ts', 'apps/desktop/src/renderer/src/lib/session-presentation.ts',
  'apps/desktop/src/renderer/src/lib/session-state.ts', 'apps/desktop/src/renderer/src/lib/steer-queue-delivery.ts',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx']
const tests = ['apps/desktop/test/mote-daily-goal.test.tsx', 'apps/desktop/test/mote-daily-goal-owner.test.ts', 'apps/desktop/test/continuous-progress-loop-manager.test.ts']
const storeFile = 'apps/desktop/src/renderer/src/store.ts'
const ts = createRequire(join(repository, 'package.json'))('typescript')
const startBegin = '    const startDemand = async ('
const startEnd = "    if (request.operation === 'demand.assign')"
function startSource(text) {
  const begin = text.indexOf(startBegin), end = text.indexOf(startEnd, begin)
  assert.ok(begin >= 0 && end > begin, 'The nonempty actual Start owner must be found')
  const source = text.slice(begin, end); assert.ok(source.includes('sendQueuedAgentSteer'))
  return source
}
const ownedPattern = 'Demand Supervisor|finite Goal|actual original Goal|lost original IPC|Goal revision|actual public typed|changing the original Goal|actual shared Goal|remounted Goal|real typed socket|ContinuousProgressLoopManager|original Goal'
function localInputSource(text) {
  const chunks = []
  for (const [start, end] of [['  async resyncTimeline(', '  applyEvent(event) {'], ['  applyEvent(event) {', '  decayStaleAgentStatuses(now) {']]) {
    const begin = text.indexOf(start), finish = text.indexOf(end, begin + start.length)
    assert.ok(begin > 0 && finish > begin, 'Nonempty original local input projection owner')
    chunks.push(text.slice(begin, finish))
  }
  chunks.push(...text.split('\n').filter(line => line.includes('confirmedSteerDelivery(')))
  return chunks.join('\n')
}
function ownedTestsSource(text) {
  const source = ts.createSourceFile(tests[0], text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fragments = [], pattern = new RegExp(ownedPattern)
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
    const first = statement.expression.arguments[0]
    if (first && ts.isStringLiteral(first) && pattern.test(first.text)) fragments.push(statement.getText(source))
  }
  const first = text.indexOf("it('Demand Supervisor:")
  assert.ok(first > 0 && fragments.length >= 20, 'Nonempty original fixtures and complete owned tests must be found')
  return text.slice(0, first) + '\n' + fragments.join('\n')
}
const mutations = [
  { id: 'new-supervisor-gate', file: owners[0], before: 'goal.supervisorSessionId !== input.agentSessionId', after: 'false' },
  { id: 'original-operation-read-dependency', file: owners[0], before: '        return existing', after: '        await this.goals?.read(input.goalId); return existing' },
  { id: 'one-loop-per-goal', file: owners[0], before: "if (this.list().some(loop => loop.taskSource?.kind === 'goal' && loop.taskSource.goalId === input.goalId && loop.status !== 'stopped'))", after: 'if (false)' },
  { id: 'goal-concurrent-start-serialization', file: owners[0], before: 'this.serialize(`goal-start-goal:${input.goalId}`', after: 'this.serialize(`goal-start-goal:${input.goalId}:${input.agentSessionId}`' },
  { id: 'finite-unique-assignee', file: storeFile, before: 'assigneeSessionIds.length === 1', after: 'assigneeSessionIds.length > 0' },
  { id: 'finite-explicit-responsibility', file: storeFile, before: '!savedContinuation && !assigneeSessionIds.includes(attachedSessionId)', after: 'false' },
  { id: 'supervisor-banner-consumer', file: owners[2], before: '!supervisorId ? <div className="goals-supervisor-guide">', after: 'false ? <div className="goals-supervisor-guide">' },
  { id: 'saved-supervisor-start-consumer', file: owners[2], before: 'sessionId: supervisorId, intervalMs:', after: 'sessionId: demand.sessionIds[0]!, intervalMs:' },
  { id: 'canonical-presentation-consumer', file: owners[2], before: 'agentSessionPresentationIndex(state.sessions).get(agentSessionId)', after: 'agentSessionPresentationIndex(state.sessions).get("missing-presentation-identity")' },
  { id: 'original-loop-host-presentation', file: owners[2], before: '(hostId === undefined || session.control.hostId === hostId)', after: '(true)' },
  { id: 'canonical-start-presentation', file: storeFile, before: 'candidate.control.agentSessionId === canonicalSessionId', after: 'candidate.id === canonicalSessionId' },
  { id: 'unique-start-presentation', file: storeFile, before: "if (matches.length !== 1) throw controlFailure", after: "if (matches.length === 0) throw controlFailure" },
  { id: 'canonical-input-observer', file: owners[4], before: 'agentSessionPresentationIndex(state.sessions).get(control.agentSessionId)', after: 'agentSessionPresentationIndex(state.sessions).get("missing-input-identity")' },
  { id: 'canonical-source-index', file: owners[5], before: 'new Set([session.id, session.control.agentSessionId])', after: 'new Set([session.id])' },
  { id: 'canonical-runtime-projection', file: owners[6], before: 'const existingEventSession = runtimeEventSession(state.sessions, event)', after: 'const existingEventSession = state.sessions.find(session => session.id === pendingAgentSessionId)' },
  { id: 'unique-runtime-presentation', file: owners[6], before: 'return matches.length === 1 ? matches[0] : undefined', after: 'return matches.length > 0 ? matches[0] : undefined' },
  { id: 'original-runtime-host', file: owners[6], before: 'session.hostId === event.hostId && session.control.hostId === event.hostId', after: 'true' },
  { id: 'original-runtime-run', file: owners[6], before: '(session.id === id || run !== undefined && sameRun(session.control.run, run))', after: 'true' },
  { id: 'canonical-queue-confirmation', file: owners[7], before: "const agentSessionId = source?.kind === 'agent' ? source.control.agentSessionId : undefined", after: 'const agentSessionId = source?.id' },
  { id: 'canonical-timeline-repair', file: storeFile, before: 'if (snapshot.agentSessionId !== session.control.agentSessionId)', after: 'if (snapshot.agentSessionId !== sessionId)' }

]
const receipt = { schema: 'agentmux.demand-supervisor.proof.v1', passed: false, candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, ownedTestsSourceSHA256: hash(ownedTestsSource(await readFile(join(repository, tests[0]), 'utf8'))), localInputSourceSHA256: hash(localInputSource(await readFile(join(repository, storeFile), 'utf8'))), startSourceSHA256: hash(startSource(await readFile(join(repository, storeFile), 'utf8'))), baseline: null, mutations: [], native: null,
  userRunTouched: false, limitations: ['Source tests operate actual public CLI/socket, Renderer, preload, registered IPC, original Loop owner and Core input with isolated Electron transport/native I/O seam.',
    'The separate Native probe uses real private ctxmux and two Host processes; it does not operate user Sessions or certify an installed App.',
    'Complete GoalDetail visual approval and durable Tab/Region/composer integration are consumed by T003/T006; this gate does not claim those visuals.'] }

async function run(name, mutation) {
  const loadedFile = join(evidence, name + '.loaded.ndjson'), reportFile = join(evidence, name + '.json'), logFile = join(evidence, name + '.log')
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/demand-supervisor/vitest.config.mts',
    '-t', mutation ? 'Demand Supervisor' : ownedPattern, '--reporter=json', '--outputFile=' + reportFile], {
    cwd: repository, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_DAILY_GOAL_PROOF: loadedFile,
      ...(mutation ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutation) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes)
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
  const [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer); await writeFile(logFile, output)
  assert.equal(signal, null, name + ': setup/runner termination cannot qualify')
  const reportBytes = await readFile(reportFile), report = JSON.parse(reportBytes)
  const rows = report.testResults.flatMap(result => result.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
  assert.equal(rows.length, mutation ? 11 : 31, 'The complete nonempty owned behavior set must execute')
  const failed = rows.filter(row => row.status === 'failed')
  const loadedBytes = await readFile(loadedFile), graph = loadedBytes.toString().trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
  assert.ok(graph.length > 0, 'No empty loaded graph may qualify')
  const changed = graph.filter(row => row.consumer.endsWith('mutant'))
  if (mutation) {
    assert.notEqual(exitCode, 0); assert.ok(failed.some(row => row.failureMessages.some(message => /AssertionError|__VITEST_(REJECTS|RESOLVES)__/.test(message))), 'Mutation needs a behavioral assertion RED')
    assert.ok(changed.some(row => row.file === mutation.file && row.beforeSha256 !== row.afterSha256), 'The actual production source must be mutated')
  } else {
    assert.equal(exitCode, 0, output); assert.equal(failed.length, 0)
    for (const consumer of ['actual-source-cli', 'actual-vite-module']) assert.ok(graph.some(row => row.consumer === consumer), consumer + ' must execute')
    for (const file of [storeFile, ...owners.filter(file => !file.endsWith('.css')), 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts', 'packages/core/src/public-rpc-service.ts', 'packages/demand/src/demand-store.ts'])
      assert.ok(graph.some(row => row.file === file), 'Actual original owner/consumer must load: ' + file)
  }
  const result = { exitCode, signal, assertions: rows.length, failed: failed.map(row => row.fullName), actualMutation: changed,
    report: relative(repository, reportFile), reportSHA256: hash(reportBytes), log: relative(repository, logFile), logSHA256: hash(output),
    loaded: relative(repository, loadedFile), loadedSHA256: hash(loadedBytes), graph }
  console.log(JSON.stringify({ name, assertions: rows.length, failed: failed.length }))
  return result
}
try {
  for (const file of [...owners, ...tests.slice(1), 'apps/desktop/scripts/fixtures/demand-supervisor/vitest.config.mts', 'apps/desktop/scripts/verify-demand-supervisor.mjs']) receipt.source[file] = hash(await readFile(join(repository, file)))
  for (const mutation of mutations) assert.equal((await readFile(join(repository, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One exact source anchor: ' + mutation.id)
  const baseline = await run('baseline'); receipt.baseline = { ...baseline }; delete receipt.baseline.graph
  for (const mutation of mutations) { const result = await run(mutation.id, mutation); delete result.graph; receipt.mutations.push({ id: mutation.id, file: mutation.file, ...result }) }
  if (!process.argv.includes('--source-only')) {
    const reusedNative = process.argv.find(argument => argument.startsWith('--native-receipt='))?.slice('--native-receipt='.length)
    const nativeEvidence = join(evidence, 'native')
    if (!reusedNative) await probeGoalRuntime({ repository, evidence: nativeEvidence })
    const file = reusedNative ? resolve(repository, reusedNative) : join(nativeEvidence, 'receipt.json'), bytes = await readFile(file), native = JSON.parse(bytes)
    assert.equal(native.passed, true); assert.equal(native.cleanup.exactPrivateRunStopped, true); assert.equal(native.cleanup.privateRootRemoved, true)
    if (reusedNative) {
      const inputs = { ...native.overlays, ...native.harnessSource }
      assert.ok(Object.keys(inputs).length > 20, 'Reused Native proof must name its nonempty exact candidate inputs')
      for (const [name, before] of Object.entries(inputs)) assert.equal(hash(await readFile(join(repository, name))), before, 'A changed Native input must be requalified: ' + name)
      assert.deepEqual(native.sourceChanges, [], 'Reused Native source inputs must have been stable')
    }
    assert.notEqual(native.seed.pid, native.restored.pid); assert.deepEqual(native.beforeRestart.loop, native.restored.loop)
    assert.equal(native.restored.goal.supervisorSessionId, 'retained-next-supervisor')
    assert.equal(native.restored.loop.agentSessionId, native.restored.session.id)
    receipt.native = { file: relative(repository, file), sha256: hash(bytes), reused: Boolean(reusedNative) }
  }
  for (const [file, before] of Object.entries(receipt.source)) assert.equal(hash(await readFile(join(repository, file))), before, 'Owned Source changed during gate: ' + file)
  assert.equal(hash(startSource(await readFile(join(repository, storeFile), 'utf8'))), receipt.startSourceSHA256, 'The exact Start function changed during gate')
  assert.equal(hash(localInputSource(await readFile(join(repository, storeFile), 'utf8'))), receipt.localInputSourceSHA256, 'The original local input projection source changed during gate')
  assert.equal(hash(ownedTestsSource(await readFile(join(repository, tests[0]), 'utf8'))), receipt.ownedTestsSourceSHA256, 'The original fixtures or owned test statements changed during gate')
  receipt.adjacentSourceChanges = []
  for (const row of baseline.graph.filter(row => row.sha256 && !Object.hasOwn(receipt.source, row.file) && row.file !== storeFile)) {
    const after = hash(await readFile(join(repository, row.file)))
    if (after !== row.sha256) receipt.adjacentSourceChanges.push({ file: row.file, beforeSHA256: row.sha256, afterSHA256: after })
  }
  receipt.sourceOnly = process.argv.includes('--source-only'); receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(repository, join(evidence, 'receipt.json')), mutations: receipt.mutations.length, native: receipt.native }))
assert.equal(receipt.passed, true, receipt.error?.message)
