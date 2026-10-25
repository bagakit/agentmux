import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
assert(process.argv.length <= 3, 'Pass at most one fresh evidence directory')
const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'amux-input-mutants-'))
if (process.argv[2]) await mkdir(root, { recursive: false, mode: 0o700 })
const mutations = [
  ['wire-numeric-budget', 'inputEnvelopeBytes(runId, operation, Number.MAX_SAFE_INTEGER)) / 4)', 'inputEnvelopeBytes(runId, operation, Number.MAX_SAFE_INTEGER)) / 1)'],
  ['source-cursor-midframe', 'pending: { ...current, operation, chunk: { offset: through, bytes: limit } }', '[current.source]: { ...this.state[current.source], outputByte: current.sourceStartByte + through }, pending: { ...current, operation, chunk: { offset: through, bytes: limit } }'],
  ['unknown-chunk-new-id', '{ ...current.operation, data: part }', "{ ...current.operation, operationId: current.operation.operationId + '-retry-' + Math.random(), data: part }"],
  ['ignore-confirmed-offset', 'const offset = current.chunk?.offset ?? 0', 'const offset = 0'],
  ['repartition-old-claim', 'const limit = current.chunk?.bytes ?? data.byteLength', 'const limit = current.chunk?.bytes ?? inputChunkBytes(position.runId, current.operation)'],
  ['skip-durable-claim', 'await this.options.persist(structuredClone(next))', 'await Promise.resolve()'],
]
const candidatePaths = ['packages/core/src/agent-execution-bridge.ts', 'packages/core/src/recoverable-input-frame.ts', 'packages/core/test/agent-execution-bridge.test.ts']
const fingerprint = async () => Object.fromEntries(await Promise.all(candidatePaths.map(async path => [path, createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])))
const candidate = await fingerprint()
const receipts = []
for (const [name, from, to] of mutations) {
  const report = join(root, name + '.json'), config = join(root, name + '.config.mjs'), log = join(root, name + '.log')
  const module = name === 'wire-numeric-budget' ? '/recoverable-input-frame.ts' : '/agent-execution-bridge.ts'
  await writeFile(config, `let applied=0;export default {root:${JSON.stringify(repository)},plugins:[{name:'exact-input-mutation',enforce:'pre',transform(source,id){if(!id.endsWith(${JSON.stringify(module)}))return;const from=${JSON.stringify(from)};if(source.split(from).length!==2)throw new Error('Mutation source must match exactly once');applied++;return source.replace(from,${JSON.stringify(to)})},buildEnd(){if(applied!==1)throw new Error('Mutation did not reach the exact product module')}}],test:{include:['packages/core/test/agent-execution-bridge.test.ts'],passWithNoTests:false,pool:'forks',maxWorkers:1,reporters:['json'],outputFile:${JSON.stringify(report)}}}`, { mode: 0o600 })
  const child = spawn(resolve(repository, 'packages/core/node_modules/.bin/vitest'), ['run', '--config', config], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
  const { exitCode, signal } = await new Promise((resolveClose, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolveClose({ exitCode, signal })) })
  await writeFile(log, Buffer.concat(chunks), { mode: 0o600 })
  const result = JSON.parse(await readFile(report, 'utf8'))
  const failed = result.testResults?.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed') ?? []
  const assertionFailure = failed.some(test => test.failureMessages?.some(message => /AssertionError/u.test(message) || /(?:__VITEST_REJECTS__|__VITEST_RESOLVES__)/u.test(message) && /promise (?:resolved|rejected).*instead of (?:rejecting|resolving)/su.test(message)))
  const killed = Number.isInteger(exitCode) && exitCode !== 0 && result.numTotalTests >= 15 && result.numFailedTests > 0 && assertionFailure
  assert.deepEqual(await fingerprint(), candidate, 'The tested source candidate changed during mutation execution')
  receipts.push({ mutation: name, exitCode, signal, closed: true, killed, totalTests: result.numTotalTests, failedTests: result.numFailedTests, report, log })
  await writeFile(join(root, 'summary.json'), JSON.stringify({ candidate, errors: [], passed: receipts.every(receipt => receipt.killed), complete: receipts.length === mutations.length, mutations: receipts }, null, 2) + '\n', { mode: 0o600 })
  assert(killed, `Mutation ${name} did not fail an executed protocol assertion; retain ${log}`)
}
console.log(JSON.stringify({ passed: true, root, summary: join(root, 'summary.json'), errors: [], mutations: receipts.map(receipt => receipt.mutation) }))
