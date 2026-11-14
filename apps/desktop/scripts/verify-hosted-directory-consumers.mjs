import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, relative, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const common = realpathSync(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
const output = resolve(dirname(common), '.tmp/mobile-loading-review/desktop-directory-consumers')
const receiptPath = join(output, 'receipt.json')
const config = 'apps/desktop/test/hosted-directory-consumers.config.mts'
const test = 'apps/desktop/test/hosted-directory-consumers.test.ts'
const production = ['apps/desktop/src/main/desktop-host.ts', 'apps/desktop/src/main/runtime-controller.ts']
const sdk = ['packages/core/src/hosted-client.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/types.ts', 'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/client.ts',
  'packages/core/src/hosted-value.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts', 'packages/core/src/rpc-stream-transport.ts']
const related = ['apps/desktop/test/launch-smoke-connection.test.ts', 'apps/desktop/test/main-terminal-input-diagnostics.test.ts',
  'apps/desktop/test/toolset-terminal-input-native.test.ts',
  'apps/desktop/test/desktop-host-metadata.test.ts', 'apps/desktop/test/desktop-host-channel.test.ts']
const inputs = [...production, ...sdk, ...related, test, config,
  'apps/desktop/test/vitest.hosted-input-preparation.config.mts', 'packages/core/test/helpers/public-rpc-owner.ts',
  'packages/core/src/control-endpoint-listener-worker.ts', 'apps/host/test/host-lifecycle-recovery-node-loader.mjs',
  'tsconfig.base.json', 'apps/desktop/tsconfig.json',
  relative(root, fileURLToPath(import.meta.url))]
const hash = value => createHash('sha256').update(value).digest('hex')
const sources = Object.fromEntries(inputs.sort().map(file => [file, hash(readFileSync(resolve(root, file)))]))
const fingerprint = hash(JSON.stringify(sources))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const require = createRequire(resolve(root, 'package.json'))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const tsc = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const corePackage = realpathSync(resolve(root, 'apps/desktop/node_modules/@agentmux/core'))
const coreDeclarations = Object.fromEntries(['index.d.ts', 'hosted.d.ts', 'hosted-client-contract.d.ts', 'types.d.ts']
  .map(file => [file, hash(readFileSync(resolve(corePackage, 'dist', file)))]))
const variants = ['ignore-directory-ready', 'directory-as-control', 'hint-requires-directory',
  'draft-requires-directory', 'unverified-fence-blocks-exact', 'enumerate-caller-inventory', 'clone-cached-inventory']
const artifactsValid = receipt => receipt.artifacts.length > 0 && receipt.artifacts.every(item =>
  existsSync(item.path) && hash(readFileSync(item.path)) === item.sha256) && receipt.runs.every(run =>
  Object.entries(run.compiledInputs ?? {}).every(([file, sha]) => existsSync(resolve(root, file)) && hash(readFileSync(resolve(root, file))) === sha))
mkdirSync(output, { recursive: true })
if (existsSync(receiptPath)) {
  const receipt = read(receiptPath)
  if (receipt.passed && receipt.fingerprint === fingerprint && receipt.environment.node === process.version &&
    JSON.stringify(receipt.environment.coreDeclarations) === JSON.stringify(coreDeclarations) && artifactsValid(receipt)) {
    console.log(JSON.stringify({ passed: true, reused: true, receipt: receiptPath, fingerprint }))
    process.exit(0)
  }
}
const directory = join(output, 'run-' + randomUUID())
mkdirSync(directory)
const receipt = { schema: 'agentmux.desktop-directory-consumers.v1', passed: false, fingerprint, sources,
  environment: { node: process.version, vitest, corePackage, coreDeclarations,
    moduleResolution: 'Original dedicated config aliases canonical Core/Host source; private launch owner compiled modules and standard Desktop Core declarations are separately recorded.' },
  relatedBoundary: { excludedLegacyFile: 'apps/desktop/test/hosted-input-preparation.test.ts',
    excludedLegacyCase: 'prepares the real Desktop channel once for cold startup and all warm input and reader consumers',
    reason: 'These older input oracles inspect durable kernel.input/operationId/preparation round trips. Current live Main input uses openInput/rawInput and its native admission. Original failures are retained separately; no business assertion or input owner was weakened. Current real Native/Main input consumers replace that unrelated legacy protocol matrix.' },
  directory, runs: [], artifacts: [] }
const assert = (condition, message) => { if (!condition) throw new Error(message) }
function artifact(path) { receipt.artifacts.push({ path, sha256: hash(readFileSync(path)) }) }
function run(name, mutation, isRelated = false) {
  const trace = join(directory, name + '.loaded.jsonl'), report = join(directory, name + '.json'), log = join(directory, name + '.log')
  const native = join(directory, name + '.native.json'), launch = join(directory, name + '.launch.jsonl')
  const env = { ...process.env, DESKTOP_DIRECTORY_LOADED: trace }
  delete env.DESKTOP_DIRECTORY_MUTATION; delete env.DESKTOP_DIRECTORY_RELATED
  if (mutation) env.DESKTOP_DIRECTORY_MUTATION = mutation
  if (isRelated) { env.DESKTOP_DIRECTORY_RELATED = '1'; env.LAUNCH_SMOKE_LOADED = trace
    env.TOOLSET_INPUT_EVIDENCE = native; env.LAUNCH_SMOKE_FACTS = launch }
  const args = [vitest, 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
  const start = performance.now(), child = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(log, (child.stdout ?? '') + (child.stderr ?? ''))
  const row = { name, mutation: mutation ?? null, related: isRelated, command: [process.execPath, ...args],
    elapsedMs: performance.now() - start, exitCode: child.status, signal: child.signal, report, trace, log }
  receipt.runs.push(row); artifact(log)
  for (const path of [native, launch]) if (existsSync(path)) artifact(path)
  assert(existsSync(report) && existsSync(trace), name + ': real report and evaluated source trace required')
  artifact(report); artifact(trace)
  const result = read(report), tests = result.testResults.flatMap(suite => suite.assertionResults)
  const failures = tests.filter(item => item.status === 'failed')
  const loaded = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const evaluated = loaded.filter(item => item.phase === 'evaluated')
  if (isRelated) {
    const compiled = loaded.filter(item => item.surface === 'evaluated-compiled-owner')
    assert(compiled.some(item => item.path === 'packages/core/dist/index.js'), name + ': private original compiled Core owner must be evaluated')
    row.compiledInputs = Object.fromEntries(compiled.map(item => [item.path, item.originalSHA256]))
    assert(existsSync(native) && existsSync(launch), name + ': original private-process facts required')
    const nativeFacts = read(native)
    assert(nativeFacts.cleanup?.daemonAlive === false && nativeFacts.cleanup.runAlive === false &&
      nativeFacts.cleanup.proxyListening === false && nativeFacts.cleanup.errors.length === 0, name + ': private Native process cleanup must be confirmed')
    const launchFacts = readFileSync(launch, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert(launchFacts.some(item => item.phase === 'actual-hosted-reconnect') &&
      launchFacts.filter(item => item.cleanup).every(item => item.cleanup === 'confirmed'), name + ': original launch owner and cleanup required')
  }
  assert(tests.length > 0 && result.numTotalTests > 0 && evaluated.length > 0, name + ': nonempty real consumers required')
  for (const file of [...production, 'packages/core/src/hosted-client.ts', ...(isRelated ? related : [test])]) {
    assert(evaluated.some(item => item.file === file && item.originalSHA256 === sources[file]), name + ': original module not evaluated: ' + file)
  }
  row.total = result.numTotalTests; row.passed = result.numPassedTests; row.failed = result.numFailedTests
  row.executed = tests.filter(item => item.status !== 'pending').map(item => ({ title: item.fullName, status: item.status }))
  if (mutation) {
    assert(child.status === 1 && result.numFailedTests === 1 && failures.length === 1 && result.numPassedTests === 0,
      name + ': exactly one bearing failure required')
    assert(failures[0].failureMessages.some(message => message.includes('AssertionError')), name + ': import, timeout or protocol failure is not mutation evidence')
    assert(evaluated.some(item => item.mutation === mutation && item.originalSHA256 !== item.loadedSHA256 && production.includes(item.file)),
      name + ': actual mutated production owner must be evaluated')
    row.failureMessages = failures[0].failureMessages
  } else assert(child.status === 0 && result.numFailedTests === 0 && result.numPassedTests > 0 && failures.length === 0, name + ': all consumers must pass')
  console.log(JSON.stringify({ phase: name, exitCode: child.status, passed: row.passed, failed: row.failed }))
  return row
}
try {
  const baseline = run('baseline')
  for (const mutation of variants) run(mutation, mutation)
  const restored = run('restored')
  assert(baseline.total === restored.total && baseline.passed === restored.passed, 'restored discovery must match baseline')
  run('related', undefined, true)
  const args = [tsc, '--noEmit', '-p', 'apps/desktop/tsconfig.json']
  const start = performance.now(), checked = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const log = join(directory, 'production-typecheck.log')
  writeFileSync(log, (checked.stdout ?? '') + (checked.stderr ?? '')); artifact(log)
  receipt.productionTypecheck = { command: [process.execPath, ...args], elapsedMs: performance.now() - start,
    exitCode: checked.status, signal: checked.signal, log, scope: 'Original Desktop production program; legacy Activity test checker is outside this change.' }
  assert(checked.status === 0, 'original Desktop production typecheck must pass')
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
} finally {
  const current = Object.fromEntries(inputs.map(file => [file, hash(readFileSync(resolve(root, file)))]))
  if (hash(JSON.stringify(current)) !== fingerprint) { receipt.passed = false; receipt.sourceChanged = true }
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: receiptPath, directory, fingerprint, failure: receipt.failure }))
process.exitCode = receipt.passed ? 0 : 1
