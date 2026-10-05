import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/goal-confirmed-queue', String(globalThis.crypto.randomUUID()))
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const storeFile = 'apps/desktop/src/renderer/src/store.ts'
const testFile = 'apps/desktop/test/mote-daily-goal.test.tsx'
const scriptFile = relative(repository, import.meta.filename)
const condition = "if (dispatch?.stage === 'confirmed')"
const clear = `${condition} {
                set(state => ({ agentSteerQueues: Object.fromEntries(Object.entries(state.agentSteerQueues).map(([id, queue]) => [id,
                  queue.filter(entry => entry.goalDispatch?.goalId !== demandId || entry.goalDispatch.operationId !== businessOperationId)])) }))
              }`
const mutations = [
  { id: 'missing-confirmed-clear', file: storeFile, before: condition, after: 'if (false)' },
  { id: 'loop-confirmation-alone', file: storeFile, before: condition, after: 'if (true)' },
  { id: 'goal-without-operation', file: storeFile, before: clear, after: clear.replace(' || entry.goalDispatch.operationId !== businessOperationId', '') },
  { id: 'operation-without-goal', file: storeFile, before: clear, after: clear.replace('entry.goalDispatch?.goalId !== demandId || entry.goalDispatch.operationId', 'entry.goalDispatch?.operationId') }
]
const expected = [
  ...['confirmed', 'reconciled', 'missing', 'inspect-failed', 'reconcile-failed', 'still-unknown', 'different-operation'].map(state => `Goal replay queue: ${state} preserves the original input and releases only a confirmed Goal operation`),
  ...['finite', 'continue'].map(mode => `Demand Supervisor: canonical ${mode} start reaches original Main/Core through a unique presentation and retains the same unknown operation`)
].sort()
const configFile = join(evidence, 'vitest.config.mts')
// Exact current lockfile dependencies, already installed. Their workspace symlinks can
// lag a peer publication; read the existing pool without installing or writing to it.
const aliases = [
  ['/^highlight\\.js\\/(.+)$/', 'highlight.js@11.12.0/node_modules/highlight.js', '/$1'],
  ['/^remark-math$/', 'remark-math@6.0.0/node_modules/remark-math/index.js', ''],
  ['/^katex$/', 'katex@0.19.0/node_modules/katex/dist/katex.mjs', ''],
  ['/^katex\\/(.+)$/', 'katex@0.19.0/node_modules/katex', '/$1'],
  ['/^@noble\\/hashes\\/(.+)$/', '@noble+hashes@2.4.0/node_modules/@noble/hashes', '/$1']
].map(([find, path, suffix]) => `{find:${find},replacement:${JSON.stringify(join(repository, 'node_modules/.pnpm', path) + suffix)}}`).join(',\n')
await writeFile(configFile, `import original from ${JSON.stringify(join(repository, 'apps/desktop/scripts/fixtures/demand-supervisor/vitest.config.mts'))}
export default { ...original, cacheDir: ${JSON.stringify(join(evidence, 'cache'))},
  resolve: { ...original.resolve, alias: [${aliases}, ...(original.resolve?.alias ?? [])] },
  test: { ...original.test, include: ['test/mote-daily-goal.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } }
`)
const receipt = {
  schema: 'agentmux.goal-confirmed-queue.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
  source: {}, baseline: null, mutations: [], userRunTouched: false,
  scope: 'Actual public goal.start → Core RPC → Renderer → preload → registered Main IPC → original Loop/Core input/Demand owners. Only Electron transport/native I/O and observation replies are isolated; no installed App or fresh Native/visual qualification is claimed.'
}
async function run(name, mutation) {
  const loaded = join(evidence, `${name}.loaded.ndjson`), reportFile = join(evidence, `${name}.json`), logFile = join(evidence, `${name}.log`)
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', configFile,
    '-t', 'Goal replay queue:|Demand Supervisor: canonical (finite|continue) start', '--reporter=json', '--outputFile=' + reportFile], {
    cwd: repository, env: { ...process.env, AGENTMUX_DAILY_GOAL_PROOF: loaded,
      ...(mutation ? { AGENTMUX_DAILY_GOAL_MUTANT: JSON.stringify(mutation) } : {}) }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes)
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const [exitCode, signal] = await once(child, 'exit'); clearTimeout(timer)
  await writeFile(logFile, output)
  assert.equal(signal, null, 'Runner termination is not behavioral proof: ' + name)
  const bytes = await readFile(reportFile), report = JSON.parse(bytes)
  const rows = report.testResults.flatMap(file => file.assertionResults).filter(row => ['passed', 'failed'].includes(row.status))
  assert.deepEqual(rows.map(row => row.title).sort(), expected, 'The exact nonempty nine-case behavior set must execute')
  const failed = rows.filter(row => row.status === 'failed')
  const loadedBytes = await readFile(loaded)
  const graph = loadedBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(graph.length > 0, 'Empty loaded graph cannot qualify')
  for (const consumer of ['actual-source-cli', 'actual-vite-module']) assert.ok(graph.some(row => row.consumer === consumer), consumer + ' must execute')
  for (const file of [storeFile, 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/continuous-progress-loop-manager.ts',
    'apps/desktop/src/preload/index.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/client.ts', 'packages/demand/src/demand-store.ts']) {
    assert.ok(graph.some(row => row.file === file), 'Actual production owner must load: ' + file)
  }
  const changed = graph.filter(row => row.consumer.endsWith('mutant'))
  if (mutation) {
    assert.notEqual(exitCode, 0)
    assert.ok(failed.some(row => row.failureMessages.some(message => /AssertionError|__VITEST_(REJECTS|RESOLVES)__/.test(message))), 'Setup failures cannot qualify a mutant')
    assert.ok(changed.some(row => row.file === mutation.file && row.beforeSha256 !== row.afterSha256), 'The production owner must actually be mutated')
  } else { assert.equal(exitCode, 0, output); assert.equal(failed.length, 0) }
  for (const row of graph.filter(row => row.sha256)) {
    if (Object.hasOwn(receipt.source, row.file)) assert.equal(receipt.source[row.file], row.sha256, 'Source drift: ' + row.file)
    else receipt.source[row.file] = row.sha256
  }
  const result = { exitCode, assertions: rows.length, failed: failed.map(row => row.title), actualMutation: changed,
    report: relative(repository, reportFile), reportSHA256: hash(bytes), log: relative(repository, logFile), logSHA256: hash(output),
    loaded: relative(repository, loaded), loadedSHA256: hash(loadedBytes) }
  console.log(JSON.stringify({ name, assertions: rows.length, failed: failed.length }))
  return result
}
try {
  for (const file of [storeFile, testFile, scriptFile]) receipt.source[file] = hash(await readFile(join(repository, file)))
  for (const mutation of mutations) assert.equal((await readFile(join(repository, mutation.file), 'utf8')).split(mutation.before).length, 2, 'One exact production anchor: ' + mutation.id)
  receipt.baseline = await run('baseline')
  for (const mutation of mutations) receipt.mutations.push({ id: mutation.id, file: mutation.file, ...await run(mutation.id, mutation) })
  for (const [file, sha256] of Object.entries(receipt.source)) assert.equal(hash(await readFile(join(repository, file))), sha256, 'Source changed during gate: ' + file)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(repository, join(evidence, 'receipt.json')), mutations: receipt.mutations.length }))
assert.equal(receipt.passed, true, receipt.error?.message)
