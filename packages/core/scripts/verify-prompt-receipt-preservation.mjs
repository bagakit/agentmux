#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(process.env.AGENTMUX_RECEIPT_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/core'))
await mkdir(evidence, { recursive: true, mode: 0o700 })
const config = 'packages/core/test/vitest.prompt-receipt-preservation.config.mts'
const storePath = 'packages/core/src/agent-session-store.ts', recordPath = 'packages/core/src/prompt-submission-record.ts'
const asset = join(root, 'packages/core/dist/control-endpoint-listener-worker.js')
const sha = value => createHash('sha256').update(value).digest('hex')
const sources = [storePath, recordPath, 'packages/core/src/prompt-submission.ts', 'packages/core/src/types.ts',
  'packages/core/test/prompt-receipt-preservation.test.ts', 'packages/core/test/current-terminal-prompt.test.ts',
  'packages/core/test/immediate-prompt.test.ts', config, 'packages/core/test/tsconfig.prompt-receipt-preservation.json',
  'packages/core/test/helpers/prompt-receipt-process.ts', 'packages/core/test/helpers/prompt-receipt-source-loader.mjs',
  'packages/core/test/helpers/prompt-receipt-reader.mjs', 'packages/core/src/control-endpoint-listener-worker.ts',
  'packages/core/scripts/verify-prompt-receipt-preservation.mjs']
const originals = new Map(await Promise.all(sources.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const sourceManifest = [...originals].map(([path, source]) => ({ path, sha256: sha(source) }))
const report = { kind: 'agentmux.prompt-receipt-preservation.v1', root, startedAt: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: sourceManifest,
  scope: 'Isolated synthetic Store/Client, controlled Runtime byte port, real public Unix RPC and source CLI, cold process; no production namespace or provider process.',
  tests: [], mutations: [] }
async function save(name, value) { const path = join(evidence, name); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); return path }
async function run(label, args, env = {}) {
  const result = await new Promise((resolve, reject) => {
    const isolated = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
    const child = spawn(process.execPath, args, { cwd: root, env: { ...isolated, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
  await save(label + '.log', result.output)
  return result
}
function summary(value) {
  const assertions = value.testResults.flatMap(suite => suite.assertionResults ?? [])
  return { total: value.numTotalTests, passed: value.numPassedTests, failed: value.numFailedTests,
    suites: value.testResults.filter(suite => suite.assertionResults?.length).length,
    errors: value.numRuntimeErrorTestSuites ?? 0, failures: assertions.filter(test => test.status === 'failed').map(test => ({
      name: test.fullName, messages: test.failureMessages })) }
}
async function vitest(label, pattern, mutant) {
  const results = join(evidence, label + '.private.json'), loads = await save(label + '-source-loads.private.ndjson', '')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', results,
    ...(pattern ? ['-t', pattern] : [])], { AGENTMUX_RECEIPT_SOURCE_LOADS: loads, AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: loads, ...(mutant ? { AGENTMUX_RECEIPT_MUTANT: JSON.stringify(mutant) } : {}) })
  await chmod(results, 0o600)
  const parsed = JSON.parse(await readFile(results, 'utf8')), counts = summary(parsed)
  const loaded = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const item of loaded) {
    if (!item.path.startsWith(join(root, 'packages/core/src/'))) throw Error('A Core source was loaded outside the candidate worktree: ' + item.path)
    if (sha(await readFile(item.path)) !== item.sha256) throw Error('Loaded Core source changed during verification: ' + item.path)
  }
  const required = pattern ? [storePath, recordPath] : [storePath, recordPath, 'packages/core/src/prompt-submission.ts',
    'packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-server.ts',
    'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux.ts']
  for (const path of required) if (!loaded.some(item => item.path === join(root, path))) throw Error('Owner source was not actually loaded: ' + path)
  return { ...result, ...counts, resultPath: results, sourceLoadsPath: loads, loadedCount: loaded.length }
}
function assertGreen(result) {
  if (result.code !== 0 || result.total !== 109 || result.passed !== 109 || result.failed !== 0 || result.suites !== 6 || result.errors)
    throw Error('Receipt regression gate was not a non-empty 109/109 pass: ' + JSON.stringify({ ...result, output: undefined }))
}
function replace(source, from, to, count = 1) {
  if (source.split(from).length - 1 !== count) throw Error('Mutation anchor changed: ' + from)
  return source.split(from).join(to)
}
const mutations = [
  { id: 'ordinary-pty-overwrite', path: storePath, pattern: 'retains exact phase ACKs',
    edit: source => replace(source, 'Object.assign(next, mergePtyPromptRecord(original, next, receipt))', '/* regression: ordinary projections overwrite the retained PTY record */') },
  { id: 'frozen-claim-rebind', path: recordPath, pattern: 'rejects conflicting gate',
    edit: source => replace(source, 'oldClaim && newClaim && !dequal(ptyClaim(oldClaim), ptyClaim(newClaim))', 'false') },
  { id: 'drop-acknowledged-prefix', path: recordPath, pattern: 'preserves partial chunks',
    edit: source => replace(source, 'acknowledged: oldAck || newAck', 'acknowledged: newAck') },
  { id: 'settlement-rewrites-current', path: storePath, pattern: 'never rewrites the matching current projection',
    edit: source => replace(source, "if (next.admission && ['native', 'launch'].includes(next.admission.transport ?? 'pty') && latest && projected", 'if (next.admission && latest && projected', 2) },
  { id: 'decoder-drops-refresh-history', path: recordPath, pattern: 'restores exact redraw history',
    edit: source => replace(source, '    validatePtyPlan(parsed)\n  }\n  return parsed', '    validatePtyPlan(parsed)\n    delete parsed.ptyRefreshHistory\n  }\n  return parsed') },
  { id: 'accept-uncorrelated-terminal', path: recordPath, pattern: 'rejects newly supplied terminal evidence',
    edit: source => replace(source, 'validatePtyPlan(result)', 'void 0 /* regression: uncorrelated terminal evidence accepted */') }
]
let previousAsset
try { previousAsset = await readFile(asset) } catch (error) { if (error.code !== 'ENOENT') throw error }
try {
  // The production public server forks this one asset. No package build or alternate RPC server.
  await mkdir(dirname(asset), { recursive: true })
  const assetBytes = stripTypeScriptTypes(originals.get('packages/core/src/control-endpoint-listener-worker.ts'), { mode: 'transform' })
  await writeFile(asset, assetBytes, { mode: 0o600 })
  report.listenerAsset = { path: asset, sha256: sha(assetBytes) }
  const types = await run('types', ['node_modules/typescript/bin/tsc', '--project', 'packages/core/test/tsconfig.prompt-receipt-preservation.json', '--pretty', 'false'])
  if (types.code !== 0) throw Error('Narrow Core receipt type check failed.')
  const baseline = await vitest('baseline'); assertGreen(baseline)
  report.tests.push({ ...baseline, output: undefined }); process.stdout.write('baseline: 109/109, source-bound product chain and cold process passed\n')
  for (const mutation of mutations) {
    const path = join(root, mutation.path), original = originals.get(mutation.path)
    if (await readFile(path, 'utf8') !== original) throw Error('Candidate changed before mutation: ' + path)
    const modified = mutation.edit(original), file = await save('mutation-' + mutation.id + '.source.private.ts', modified)
    const result = await vitest('mutation-' + mutation.id, mutation.pattern, { path, file, diskSHA256: sha(original), id: mutation.id })
    if (result.code === 0 || result.failed < 1 || result.errors || !result.failures.length ||
      result.failures.some(failure => !failure.messages.some(message => /AssertionError|expected .*|promise resolved/isu.test(message))))
      throw Error('Mutation did not fail through a business assertion: ' + mutation.id)
    const loaded = (await readFile(result.sourceLoadsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    if (!loaded.some(value => value.mutation === mutation.id && value.compiledSourceSHA256 === sha(modified))) throw Error('The exact input mutant was not consumed')
    report.mutations.push({ id: mutation.id, sourcePath: mutation.path, mutantSHA256: sha(modified), ...result, output: undefined })
    process.stdout.write('mutation ' + mutation.id + ': business assertion failed as required\n')
  }
  const restored = await vitest('restored'); assertGreen(restored); report.tests.push({ ...restored, output: undefined })
  for (const [path, original] of originals) if (await readFile(join(root, path), 'utf8') !== original) throw Error('Source was not restored: ' + path)
  report.verdict = 'pass'; process.stdout.write('restored: 109/109; all 6 causal mutations rejected\n')
} catch (error) { report.verdict = 'fail'; report.failure = error.stack ?? String(error); process.exitCode = 1; console.error(report.failure) }
finally {

  if (previousAsset) await writeFile(asset, previousAsset); else await rm(asset, { force: true })
  report.endedAt = new Date().toISOString()
  await save('verification.private.json', JSON.stringify(report, null, 2) + '\n')
}
