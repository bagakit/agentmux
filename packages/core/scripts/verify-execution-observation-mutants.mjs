import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
assert(process.argv.length <= 3, 'Pass at most one fresh evidence directory')
const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'amux-observation-mutants-'))
if (process.argv[2]) await mkdir(root, { recursive: false, mode: 0o700 })
const mutations = [
  ['ignore-run-state', 'agent-execution-bridge', 'agent-execution-coordinator', "if (event.type === 'process-state' || event.type === 'run-removed') {", "if (event.type === 'process-state' || event.type === 'run-removed') { return;"],
  ['wrong-run-fact', 'agent-execution-bridge', 'agent-execution-coordinator', "event.run?.runId !== position.runId", 'false'],
  ['reader-revives-ended-run', 'agent-execution-bridge', 'agent-execution-coordinator', "attachmentObserved = true; connection.reader", "attachmentObserved = true; connection.process = 'running'; connection.reader"],
  ['ignore-native-service', 'agent-execution-coordinator', 'agent-execution-coordinator', "if (service && (service.owner.type", "if (false && service && (service.owner.type"],
  ['local-issue-disconnects', 'agent-execution-coordinator', 'agent-execution-coordinator', 'const diagnostic = this.connectionDiagnostic(input.bindingId)', 'const diagnostic = this.connectionDiagnostic(input.bindingId) ?? (retained ? this.localDiagnostics(retained)[0] : undefined)'],
  ['settle-unrelated-operation', 'agent-execution-coordinator', 'agent-execution-coordinator', 'isDeepStrictEqual(diagnostic.operation, value.operation)', 'true'],
  ['frontend-settles-operation', 'agent-execution-coordinator', 'agent-execution-coordinator', "side === 'executor' && value.type === 'operation-completed'", "value.type === 'operation-completed'"],
  ['discard-unscoped-record', 'agent-execution-coordinator', 'agent-execution-coordinator', "...(record.diagnostic ? [{ ...record.diagnostic, scope: 'unclassified' as const }] : [])", '...[]'],
  ['ordinary-completion-republishes', 'agent-execution-coordinator', 'agent-execution-coordinator', 'if (unresolved.length === retained.length) return', 'void 0'],
  ['counter-revision-rereads-intent', 'agent-execution-coordinator', 'agent-execution-coordinator', 'if (!isDeepStrictEqual(before, this.connectionDiagnostic(id))) this.observe(record.input)', 'this.observe(record.input)'],
  ['complete-before-journal', 'agent-execution-executor', 'agent-execution-executor', 'await options.journal.complete(pending.key, pending.digest, pending.response)', 'await completed(pending.key); await options.journal.complete(pending.key, pending.digest, pending.response)'],
]
const candidatePaths = ['agent-execution-bridge', 'agent-execution-coordinator', 'agent-execution-executor'].flatMap(name => [`packages/core/src/${name}.ts`, `packages/core/test/${name}.test.ts`])
const fingerprint = async () => Object.fromEntries(await Promise.all(candidatePaths.map(async path => [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])))
const candidate = await fingerprint()
const receipts = []
for (const [name, product, test, from, to] of mutations) {
  const report = join(root, name + '.json'), config = join(root, name + '.config.mjs'), log = join(root, name + '.log')
  await writeFile(config, `let applied=0;export default {root:${JSON.stringify(repository)},plugins:[{name:'exact-execution-observation-mutation',enforce:'pre',transform(source,id){if(!id.endsWith(${JSON.stringify('/' + product + '.ts')}))return;const from=${JSON.stringify(from)};if(source.split(from).length!==2)throw new Error('Mutation source must match exactly once');applied++;return source.replace(from,${JSON.stringify(to)})},buildEnd(){if(applied!==1)throw new Error('Mutation did not reach the exact product module')}}],test:{include:[${JSON.stringify('packages/core/test/' + test + '.test.ts')}],testTimeout:30000,hookTimeout:30000,passWithNoTests:false,pool:'forks',maxWorkers:1,reporters:['json'],outputFile:${JSON.stringify(report)}}}`, { mode: 0o600 })
  const child = spawn(resolve(repository, 'packages/core/node_modules/.bin/vitest'), ['run', '--config', config], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
  const { exitCode, signal } = await new Promise((resolveClose, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal })) })
  await writeFile(log, Buffer.concat(chunks), { mode: 0o600 })
  const result = JSON.parse(await readFile(report, 'utf8'))
  const failed = result.testResults?.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed') ?? []
  const assertionFailure = failed.some(test => test.failureMessages?.some(message => /AssertionError/u.test(message) || /(?:__VITEST_REJECTS__|__VITEST_RESOLVES__)/u.test(message) && /promise (?:resolved|rejected).*instead of (?:rejecting|resolving)/su.test(message)))
  const killed = Number.isInteger(exitCode) && exitCode !== 0 && signal === null && result.numTotalTests >= 10 && result.numFailedTests > 0 && assertionFailure
  assert.deepEqual(await fingerprint(), candidate, 'The tested source candidate changed during mutation execution')
  receipts.push({ mutation: name, exitCode, signal, closed: true, killed, totalTests: result.numTotalTests, failedTests: result.numFailedTests, report, log })
  await writeFile(join(root, 'summary.json'), JSON.stringify({ candidate, errors: [], passed: receipts.every(receipt => receipt.killed), complete: receipts.length === mutations.length, mutations: receipts }, null, 2) + '\n', { mode: 0o600 })
  assert(killed, `Mutation ${name} did not fail an executed protocol assertion; retain ${log}`)
}
console.log(JSON.stringify({ passed: true, root, summary: join(root, 'summary.json'), errors: [], mutations: receipts.map(receipt => receipt.mutation) }))
