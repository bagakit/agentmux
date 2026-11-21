import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['contract', 'codex', 'claude', 'surface', 'integration'].includes(mode), 'Choose contract, codex, claude, surface or integration.')
const evidence = join(root, '.bagakit/agent-information-model/verification', mode)
// All modes reuse one private candidate. Source changes invalidate its compile receipt.
const candidate = join(root, '.local/agent-information/candidate')
const config = 'packages/core/test/agent-information-gate.config.mts'
const hash = value => createHash('sha256').update(value).digest('hex')
const read = path => readFile(join(root, path))
await mkdir(evidence, { recursive: true })

async function fingerprints(directory, nested = false) {
  const result = {}
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) Object.assign(result, await fingerprints(path, true))
    else if (/\.(?:ts|tsx|json|css|svg)$/u.test(entry.name)) result[path] = hash(await read(path))
  }
  if (!nested) assert.ok(Object.keys(result).length, 'A candidate source collection must be nonempty: ' + directory)
  return result
}
function runProgram(program, args, env = {}, timeoutMs = 120000) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }) })
  })
}
const run = (args, env, timeout) => runProgram(process.execPath, args, env, timeout)
const before = { ...await fingerprints('packages/core/src'), ...await fingerprints('packages/providers/src') }
const productionSources = { ...before }
for (const path of ['tsconfig.base.json', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json',
  'packages/providers/tsconfig.json', 'packages/core/package.json', 'packages/providers/package.json',
  'packages/core/bin/amux', 'packages/core/native/native-socket-peer.c']) before[path] = hash(await read(path))
const compileDigest = hash(JSON.stringify(before))
const providersDigest = hash(JSON.stringify(Object.fromEntries(Object.entries(before).filter(([path]) =>
  path.startsWith('packages/providers/') || path === 'tsconfig.base.json'))))
const oldMode = process.env.AMX_INFORMATION_MODE
process.env.AMX_INFORMATION_MODE = mode
const { informationTests, informationMutations } = await import('../test/agent-information-gate.config.mts')
if (oldMode === undefined) delete process.env.AMX_INFORMATION_MODE
else process.env.AMX_INFORMATION_MODE = oldMode
const tests = informationTests[mode]
assert.ok(tests.length && tests.every(path => typeof path === 'string' && !path.includes('*')), 'The gate must name exact nonempty test files.')
for (const path of tests) await read(path)
for (const path of [config, 'packages/core/scripts/verify-agent-information.mjs',
  'packages/core/test/fixtures/agent-information-loader.mjs', 'packages/core/test/fixtures/agent-information-native.mjs',
  'packages/core/test/fixtures/agent-information-owner.mjs', ...tests]) before[path] = hash(await read(path))
if (mode === 'codex' || mode === 'integration') before['packages/core/test/fixtures/codex-information-native-owner.mjs'] =
  hash(await read('packages/core/test/fixtures/codex-information-native-owner.mjs'))
if (mode === 'surface' || mode === 'integration') {
  Object.assign(before, await fingerprints('packages/client-ui/src'), await fingerprints('apps/desktop/src'))
  for (const path of ['apps/desktop/test/agent-information-surface.config.mts', 'apps/desktop/test/vitest.ui-controls-owning.config.mts',
    'apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts']) before[path] = hash(await read(path))
}

let compiledReceipt
try { compiledReceipt = JSON.parse(await readFile(join(candidate, 'compiled.json'), 'utf8')) } catch { /* No reusable candidate. */ }
const reused = compiledReceipt?.digest === compileDigest
if (!reused) {
  for (const name of ['core', 'providers']) {
    await mkdir(join(candidate, name, 'dist'), { recursive: true })
    await copyFile(join(root, 'packages', name, 'package.json'), join(candidate, name, 'package.json'))
    try { await symlink(join(root, 'packages', name, 'node_modules'), join(candidate, name, 'node_modules'), 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  await mkdir(join(candidate, 'core/bin'), { recursive: true })
  await copyFile(join(root, 'packages/core/bin/amux'), join(candidate, 'core/bin/amux'))
  try { await symlink(join(root, 'packages/core/vendor'), join(candidate, 'core/vendor'), 'dir') }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  let previousProviders
  try { previousProviders = JSON.parse(await readFile(join(candidate, 'providers-compiled.json'), 'utf8')) } catch { /* No previous Provider compile. */ }
  if (previousProviders?.digest !== providersDigest) {
    await rm(join(candidate, 'providers/dist'), { recursive: true, force: true })
    const providers = await run(['node_modules/typescript/bin/tsc', '-p', 'packages/providers/tsconfig.json',
      '--incremental', 'false', '--composite', 'false', '--outDir', join(candidate, 'providers/dist')])
    await writeFile(join(evidence, 'providers-compile.log'), providers.stdout + providers.stderr)
    assert.equal(providers.code, 0, 'The exact candidate Providers must compile; see providers-compile.log.')
    await writeFile(join(candidate, 'providers-compiled.json'), JSON.stringify({ digest: providersDigest }) + '\n')
  }
  // Core consumes declarations compiled from this same Provider source, even when node_modules is shared.
  const manifest = JSON.parse(await read('packages/providers/package.json'))
  const paths = Object.fromEntries(Object.entries(manifest.exports).flatMap(([key, entry]) => entry.types ? [[
    '@agentmux/providers' + (key === '.' ? '' : key.slice(1)), [resolve(candidate, 'providers', entry.types)]
  ]] : []))
  const project = join(candidate, 'core.build.json')
  await writeFile(project, JSON.stringify({ extends: join(root, 'packages/core/tsconfig.build.json'),
    compilerOptions: { paths, incremental: false, composite: false, outDir: join(candidate, 'core/dist') } }))
  await rm(join(candidate, 'core/dist'), { recursive: true, force: true })
  const core = await run(['node_modules/typescript/bin/tsc', '-p', project])
  await writeFile(join(evidence, 'core-compile.log'), core.stdout + core.stderr)
  assert.equal(core.code, 0, 'The exact candidate Core must compile; see core-compile.log.')
  let helper
  if (process.platform === 'darwin') {
    const executable = join(candidate, 'core/dist/native-socket-peer-darwin')
    const result = await runProgram('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
      join(root, 'packages/core/native/native-socket-peer.c'), '-o', executable], {}, 10000)
    await writeFile(join(evidence, 'native-helper-compile.log'), result.stdout + result.stderr)
    assert.equal(result.code, 0, 'The private native helper must compile with the production flags.')
    helper = { sourceSHA256: before['packages/core/native/native-socket-peer.c'], executableSHA256: hash(await readFile(executable)) }
  }
  compiledReceipt = { digest: compileDigest, ...(helper ? { helper } : {}) }
  await writeFile(join(candidate, 'compiled.json'), JSON.stringify(compiledReceipt, null, 2) + '\n')
}
const compiledInputs = {}
for (const name of ['core', 'providers']) {
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.js')) compiledInputs[relative(candidate, path)] = hash(await readFile(path))
    }
  }
  await walk(join(candidate, name, 'dist'))
}
assert.ok(Object.keys(compiledInputs).length && compiledInputs['core/dist/agentmux.js'], 'The compiled product CLI must exist.')
assert.ok(compiledInputs['core/dist/public-rpc-server.js'] && compiledInputs['core/dist/control-endpoint-listener-worker.js'],
  'The real public Server and its package-owned listener worker must belong to this candidate.')
process.stdout.write(JSON.stringify({ mode, compiled: 'ready', reused }) + '\n')

async function execute(label, mutation) {
  const loadedPath = join(evidence, label + '.loaded.jsonl'), compiledPath = join(evidence, label + '.compiled-loaded.jsonl')
  const reportPath = join(evidence, label + '.json')
  await writeFile(loadedPath, ''); await writeFile(compiledPath, '')
  const edit = mutation ? informationMutations[mutation] : undefined
  assert.ok(!mutation || edit, 'A real implementation edit must define the mutation: ' + mutation)
  const compiledEdit = edit && mutation === 'public-information-detached' ? { ...edit, mutation,
    path: edit.path.replace(/^packages\/(core|providers)\/src\//u, '$1/dist/').replace(/\.ts$/u, '.js') } : undefined
  const ownerSubset = mode === 'integration' && (mutation || label === 'restored')
  const selected = ownerSubset ? ['packages/core/test/agent-information-contract.test.ts']
    : (mutation || label === 'restored') && mode === 'codex' ? ['packages/core/test/codex-information.test.ts']
    : (mutation || label === 'restored') && mode === 'claude' ? ['packages/core/test/claude-information.test.ts'] : tests
  // Node owners and mounted Renderer consumers require their original package conditions.
  const rendered = new Set(informationTests.surface.filter(path => path.endsWith('.tsx')))
  const batches = ['integration', 'surface'].includes(mode) && !ownerSubset
    ? [{ name: 'node', files: selected.filter(path => !rendered.has(path)), surface: false },
      { name: 'surface', files: selected.filter(path => rendered.has(path)), surface: true }]
    : [{ name: mode, files: selected, surface: mode === 'surface' }]
  const reports = [], results = []
  for (const batch of batches) {
    assert.ok(batch.files.length, 'Each execution environment must have an exact nonempty test set.')
    const output = batches.length === 1 ? reportPath : join(evidence, label + '-' + batch.name + '.json')
    results.push(await run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', output,
      ...batch.files], {
      AMX_INFORMATION_MODE: mode, AMX_INFORMATION_SURFACE: batch.surface ? '1' : '',
      AMX_INFORMATION_MUTATION: mutation ?? '', AMX_INFORMATION_LOADED: loadedPath,
      AMX_INFORMATION_CANDIDATE: candidate, AMX_INFORMATION_COMPILED_LOADED: compiledPath,
      AMX_INFORMATION_COMPILED_EDIT: compiledEdit ? JSON.stringify(compiledEdit) : '',
      AGENTMUX_TEST_RPC_CORE_ENTRY: '', AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux')
    }))
    reports.push(JSON.parse(await readFile(output, 'utf8')))
  }
  const result = { code: results.every(value => value.code === 0) ? 0 : 1 }
  await writeFile(join(evidence, label + '.log'), results.map(value => value.stdout + value.stderr).join('\n'))
  const report = reports.length === 1 ? reports[0] : {
    success: reports.every(value => value.success), testResults: reports.flatMap(value => value.testResults),
    ...Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests',
      'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'].map(key =>
      [key, reports.reduce((sum, value) => sum + (value[key] ?? 0), 0)])) }
  if (reports.length > 1) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  assert.ok(report.numTotalTests > 0 && report.testResults.length > 0, 'The behavior set must be nonempty.')
  const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const loaded = await lines(loadedPath), compiled = await lines(compiledPath)
  assert.ok(loaded.length, 'The tests must load the actual candidate source.')
  for (const input of loaded) assert.equal(input.originalSHA256, before[input.path], 'The source candidate changed or escaped its worktree: ' + input.path)
  for (const input of compiled) assert.equal(input.originalSHA256, compiledInputs[input.path], 'The wrong compiled candidate loaded: ' + input.path)
  if (['contract', 'integration'].includes(mode) && !ownerSubset) for (const path of ['core/dist/client.js', 'core/dist/public-rpc-service.js', 'core/dist/agentmux.js']) {
    assert.ok(compiled.some(input => input.path === path), 'The public product consumer must actually load: ' + path)
  }
  if (mode === 'surface') assert.ok(compiled.some(input => input.path === 'core/dist/public-rpc-server.js'),
    'The production Main route must consume the actual compiled Server and its private listener asset.')
  if (mutation) {
    const implementations = [...loaded, ...compiled].filter(input => input.mutation === mutation && input.sha256 !== input.originalSHA256)
    const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert.ok(implementations.length, 'The actual mutant implementation must load: ' + mutation)
    assert.ok(result.code !== 0 && failed.some(test => test.failureMessages.some(message => /AssertionError|expected |promise resolved .* instead of rejecting/u.test(message))),
      'The mutation must fail a behavior assertion, rather than collection or a timeout: ' + mutation)
    return { mutation, result: 'assertion-red', failed: failed.map(test => test.fullName), implementations }
  }
  assert.equal(result.code, 0, 'Candidate behavior failed; see ' + label + '.log.')
  assert.equal(report.numFailedTests, 0); assert.ok(report.numPassedTests > 0, 'Skipped-only tests cannot qualify.')
  return { result: 'green', tests: report.numPassedTests, files: report.testResults.map(file => relative(root, file.name)) }
}

const baseline = await execute('baseline')
process.stdout.write(JSON.stringify({ mode, baseline }) + '\n')
const mutations = mode === 'contract' ? ['wrong-native-information', 'fake-model-ack', 'public-information-detached']
  : mode === 'codex' ? ['codex-native-identity', 'codex-fake-ack', 'codex-original-request-id', 'codex-reset-unit', 'codex-duplicate-dispatch']
  : mode === 'claude' ? ['claude-information-detached', 'claude-information-repeated', 'claude-reset-unit', 'claude-information-not-saved', 'claude-old-sequence', 'claude-gap-ignored']
  : mode === 'surface' ? ['surface-old-run-adopted', 'surface-unknown-ack-applied', 'surface-remote-host-detached']
  : ['owner-sdk-reference', 'owner-null-retained', 'owner-newer-ack-erased']
const reds = []
for (const mutation of mutations) {
  reds.push(await execute('mutation-' + mutation, mutation))
  process.stdout.write(JSON.stringify({ mode, mutation, result: 'assertion-red' }) + '\n')
}
const restored = mutations.length ? await execute('restored') : baseline
for (const [path, sha] of Object.entries(before)) assert.equal(hash(await read(path)), sha, 'The candidate changed during qualification: ' + path)
assert.deepEqual({ ...await fingerprints('packages/core/src'), ...await fingerprints('packages/providers/src') }, productionSources,
  'New or removed production sources invalidate this exact candidate qualification.')
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.agent-information.v1', mode,
  passed: true, inputs: before, compiled: { ...compiledReceipt, inputs: compiledInputs }, baseline, mutations: reds, restored,
  boundary: 'Exact candidate Core and Providers, real Control/RPC and compiled CLI, with isolated Provider/Runtime fixture inputs. Native vendor validation and rendered visual review remain separately attributed evidence; no user Run or installed Desktop is operated.' }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ mode, passed: true, qualification: relative(root, join(evidence, 'qualification.json')) }) + '\n')
if (mode === 'integration') await rm(candidate, { recursive: true, force: true })
