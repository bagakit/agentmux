#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(process.env.AGENTMUX_STORAGE_RPC_EVIDENCE ?? join(dirname(common), '.local/reliability-fixes/core/storage-rpc'),
  new Date().toISOString().replaceAll(/[:.]/gu, '-') + '-' + process.pid)
await mkdir(evidence, { recursive: true, mode: 0o700 })
const digest = value => createHash('sha256').update(value).digest('hex')
const service = 'packages/core/src/public-rpc-service.ts', codec = 'packages/core/src/storage-recovery-rpc.ts'
const sourcePaths = [service, codec, 'packages/core/src/public-rpc.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/src/index.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/generated/agentmux-guides.ts', 'packages/core/src/generated/agentmux-guides-index.ts',
  'packages/core/guides/modules/storage.md', 'packages/core/src/storage-recovery.ts', 'packages/core/src/control-endpoint-listener-worker.ts',
  'packages/core/test/storage-recovery-rpc.test.ts', 'packages/core/test/helpers/storage-recovery-source-cli.ts',
  'packages/core/test/helpers/prompt-receipt-source-loader.mjs', 'packages/core/test/vitest.storage-recovery-rpc.config.mts',
  'packages/core/test/tsconfig.storage-recovery-rpc.json', 'packages/core/scripts/verify-storage-recovery-rpc.mjs']
const sources = new Map(await Promise.all(sourcePaths.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const receipt = { kind: 'agentmux.storage-recovery-rpc.v1', root, startedAt: new Date().toISOString(),
  scope: 'Public SDK/RPC/CLI source slice; real recovery owner and admitted synthetic files; no production namespace or Runtime connection. Whole Headless source composition is a separate owner gate.',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries([...sources].map(([path, source]) => [path, digest(source)])), tests: [], mutations: [] }
async function save(name, value) { const path = join(evidence, name); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); return path }
async function run(label, args, overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }) })
  })
  await save(label + '.log', result.output); return result
}
async function tests(label, pattern, mutant) {
  const results = join(evidence, label + '.private.json'), loads = await save(label + '-loads.private.ndjson', '')
  const result = await run(label, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/vitest.storage-recovery-rpc.config.mts',
    '--reporter=json', '--outputFile', results, ...(pattern ? ['-t', pattern] : [])],
  { AGENTMUX_RECEIPT_SOURCE_LOADS: loads, AGENTMUX_TEST_RECEIPT_SOURCE_LOADS: loads, ...(mutant ? { AGENTMUX_STORAGE_RPC_MUTANT: JSON.stringify(mutant) } : {}) })
  await chmod(results, 0o600)
  const parsed = JSON.parse(await readFile(results, 'utf8'))
  const failures = parsed.testResults.flatMap(suite => suite.assertionResults ?? []).filter(assertion => assertion.status === 'failed')
  const loaded = (await readFile(loads, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const item of loaded) {
    if (!item.path.startsWith(join(root, 'packages/core/src/')) || digest(await readFile(item.path)) !== item.sha256) throw Error('Loaded Core source changed or escaped the candidate: ' + item.path)
  }
  const required = pattern ? [codec, service] : [codec, service, 'packages/core/src/storage-recovery.ts', 'packages/core/src/public-rpc-client.ts',
    'packages/core/src/rpc-native-codec.ts', 'packages/core/src/agentmux.ts']
  for (const path of required) if (!loaded.some(item => item.path === join(root, path))) throw Error('Actual owner was not consumed: ' + path)
  return { code: result.code, total: parsed.numTotalTests, passed: parsed.numPassedTests, failed: parsed.numFailedTests,
    runtimeErrors: parsed.numRuntimeErrorTestSuites ?? 0, failures: failures.map(value => ({ name: value.fullName, messages: value.failureMessages })),
    results, loads }
}
function green(result) { if (result.code !== 0 || result.total !== 54 || result.passed !== 54 || result.failed !== 0 || result.runtimeErrors) throw Error('Public storage gate was not a nonempty 54/54 pass: ' + JSON.stringify(result)) }
function replace(source, from, to) { if (source.split(from).length !== 2) throw Error('Mutation anchor changed: ' + from); return source.replace(from, to) }
const mutations = [
  { id: 'accept-remote-transport', path: service, pattern: 'refuses http-user', edit: source => replace(source, "if (context.transport !== 'unix' || context.principal?.kind !== 'user'", "if (context.principal?.kind !== 'user'") },
  { id: 'accept-managed-caller', path: service, pattern: 'refuses agent-caller', edit: source => replace(source, ' || context.caller !== undefined || context.routeDelegation !== undefined)\n        throw new AgentMuxError(\'Storage recovery', ' || context.routeDelegation !== undefined)\n        throw new AgentMuxError(\'Storage recovery') },
  { id: 'accept-arbitrary-source-fields', path: codec, pattern: 'rejects additional authority', edit: source => replace(source,
    "rpcRecord(value, method === 'storage.backup.inspect' ? ['generationId'] : source ? ['captureId'] : [])", 'rpcRecord(value)') },
  { id: 'disconnect-original-owner', path: service, pattern: 'captures real admitted files', edit: source => replace(source,
    'const owner = this.ports.storageRecovery', 'const owner = undefined /* regression: composed source owner disconnected */') },
  { id: 'accept-another-generation', path: codec, pattern: 'rejects a traversal generation', edit: source => replace(source,
    "method === 'storage.backup.inspect' && result.generationId !== (params as StorageRecoveryParamsMap['storage.backup.inspect']).generationId", 'false') },
  { id: 'accept-another-source-capture', path: codec, pattern: 'rejects a traversal generation', edit: source => replace(source,
    "p.captureId !== (params as StorageRecoveryParamsMap['storage.source.capture']).captureId || ", '') }
]
const asset = join(root, 'packages/core/dist/control-endpoint-listener-worker.js')
let previousAsset
try { previousAsset = await readFile(asset) } catch (error) { if (error.code !== 'ENOENT') throw error }
try {
  await mkdir(dirname(asset), { recursive: true })
  await writeFile(asset, stripTypeScriptTypes(sources.get('packages/core/src/control-endpoint-listener-worker.ts'), { mode: 'transform' }), { mode: 0o600 })
  const types = await run('types', ['node_modules/typescript/bin/tsc', '--project', 'packages/core/test/tsconfig.storage-recovery-rpc.json', '--pretty', 'false'])
  if (types.code !== 0) throw Error('Narrow storage RPC type check failed.')
  const guides = await run('guides', ['packages/core/scripts/generate-guides.mjs', '--check'])
  if (guides.code !== 0) throw Error('Owned storage CLI guidance is not generated from its source.')
  const baseline = await tests('baseline'); green(baseline); receipt.tests.push(baseline); console.log('baseline: 54/54 source-bound public storage tests passed')
  for (const mutation of mutations) {
    const path = join(root, mutation.path), original = sources.get(mutation.path)
    if (await readFile(path, 'utf8') !== original) throw Error('Candidate changed before mutation: ' + path)
    const modified = mutation.edit(original), file = await save('mutation-' + mutation.id + '.source.private.ts', modified)
    const result = await tests('mutation-' + mutation.id, mutation.pattern, { path, file, diskSHA256: digest(original), id: mutation.id })
    if (result.code === 0 || result.failed < 1 || result.runtimeErrors || !result.failures.length ||
      result.failures.some(value => !value.messages.some(message => /AssertionError|expected |promise resolved/isu.test(message)))) throw Error('No business assertion rejected mutation: ' + mutation.id)
    const loaded = (await readFile(result.loads, 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    if (!loaded.some(value => value.mutation === mutation.id && value.compiledSourceSHA256 === digest(modified))) throw Error('Exact mutant was not consumed')
    receipt.mutations.push({ id: mutation.id, mutantSHA256: digest(modified), ...result }); console.log('mutation ' + mutation.id + ': business assertion rejected')
  }
  const restored = await tests('restored'); green(restored); receipt.tests.push(restored)
  for (const [path, source] of sources) if (await readFile(join(root, path), 'utf8') !== source) throw Error('Source was not restored: ' + path)
  receipt.verdict = 'pass'; console.log('restored: 54/54; 6/6 causal mutations rejected')
} catch (error) { receipt.verdict = 'fail'; receipt.failure = error.stack ?? String(error); process.exitCode = 1; console.error(receipt.failure) }
finally {
  if (previousAsset) await writeFile(asset, previousAsset); else await rm(asset, { force: true })
  receipt.endedAt = new Date().toISOString()
  console.log('evidence: ' + await save('verification.private.json', JSON.stringify(receipt, null, 2) + '\n'))
}
