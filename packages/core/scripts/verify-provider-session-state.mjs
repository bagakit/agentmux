import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), mode = process.argv[2]
assert.ok(['activity', 'initialization', 'integration'].includes(mode), 'Choose activity, initialization or integration.')
const evidence = join(root, '.bagakit/provider-session-activity/verification', mode)
const candidate = join(root, '.local/provider-session-state', mode + '-candidate')
const config = 'packages/core/test/provider-session-state-gate.config.mts'
const hash = value => createHash('sha256').update(value).digest('hex')
const read = path => readFile(join(root, path), 'utf8')
await mkdir(evidence, { recursive: true })

async function sourceFingerprints(directory = 'packages/core/src') {
  const result = {}
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) Object.assign(result, await sourceFingerprints(path))
    else if (/\.(?:ts|json)$/u.test(entry.name)) result[path] = hash(await read(path))
  }
  assert.ok(Object.keys(result).length > 0, 'The actual candidate source collection cannot be empty.')
  return result
}
function runProgram(command, args, env = {}, timeout = 120000) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); done({ code, signal, stdout, stderr }) })
  })
}
const run = (args, env, timeout) => runProgram(process.execPath, args, env, timeout)
const before = await sourceFingerprints()
const previousMode = process.env.AMX_SESSION_STATE_MODE
process.env.AMX_SESSION_STATE_MODE = mode
const { default: owningConfig } = await import('../test/provider-session-state-gate.config.mts')
if (previousMode === undefined) delete process.env.AMX_SESSION_STATE_MODE
else process.env.AMX_SESSION_STATE_MODE = previousMode
const tests = owningConfig.test.include
assert.ok(tests.length > 0 && tests.every(file => typeof file === 'string' && !file.includes('*')), 'The owning configuration must name actual tests.')
for (const file of [config, 'packages/core/test/provider-initialization-state.config.mts', 'packages/core/scripts/verify-provider-session-state.mjs',
  'packages/core/package.json', 'packages/core/tsconfig.json', 'packages/core/tsconfig.build.json', 'packages/core/bin/amux',
  'apps/host/package.json', 'packages/core/native/native-socket-peer.c', 'packages/core/test/native-process-environment.test.ts',
  'apps/desktop/src/renderer/src/lib/agent-observation.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'packages/client-ui/src/lib/agent-presentation.ts',
  ...tests, 'packages/core/test/provider-session-state.test.ts', 'packages/core/test/codex-managed-initialization.test.ts',
  'packages/core/test/native-completion-authority.test.ts',
  'packages/core/test/fixtures/activity-certainty-client.ts', 'packages/core/test/fixtures/provider-session-state-owner.mjs',
  'packages/core/test/provider-initialization-process.test.ts', 'packages/core/test/fixtures/provider-initialization-process-owner.mjs',
  'packages/core/test/fixtures/platform-initialization-loader.mjs', 'packages/core/test/fixtures/platform-initialization-owner.mjs']) before[file] = hash(await read(file))

// One private compiled candidate belongs only to this gate mode; no shared dist is replaced.
await rm(candidate, { recursive: true, force: true })
await mkdir(join(candidate, 'bin'), { recursive: true })
await copyFile(join(root, 'packages/core/package.json'), join(candidate, 'package.json'))
await copyFile(join(root, 'packages/core/bin/amux'), join(candidate, 'bin/amux'))
await symlink(join(root, 'packages/core/node_modules'), join(candidate, 'node_modules'), 'dir')
await symlink(join(root, 'packages/core/vendor'), join(candidate, 'vendor'), 'dir')
const compiled = await run(['node_modules/typescript/bin/tsc', '--project', 'packages/core/tsconfig.build.json',
  '--incremental', 'false', '--composite', 'false', '--outDir', join(candidate, 'dist')])
await writeFile(join(evidence, 'compile.log'), compiled.stdout + compiled.stderr)
assert.equal(compiled.code, 0, 'The exact candidate Core must compile; see compile.log.')
assert.ok((await readFile(join(candidate, 'dist/agentmux.js'))).byteLength > 0)
let nativeHelper
if (process.platform === 'darwin') {
  const helper = join(candidate, 'dist/native-socket-peer-darwin')
  const result = await runProgram('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    join(root, 'packages/core/native/native-socket-peer.c'), '-o', helper], {}, 10000)
  await writeFile(join(evidence, 'native-helper-compile.log'), result.stdout + result.stderr)
  assert.equal(result.code, 0, 'The private candidate native helper must compile with the production flags.')
  nativeHelper = { sourceSHA256: before['packages/core/native/native-socket-peer.c'], executableSHA256: hash(await readFile(helper)) }
}
const compiledInputs = Object.fromEntries(await Promise.all(['client.js', 'ctxmux-run-adapter.js', 'agent-native-process.js',
  'providers/grok-input-initialization.js', 'agent-initialization.js', 'agent-input-receipt-codec.js'].map(async path =>
  [path, hash(await readFile(join(candidate, 'dist', path)))])))

async function execute(label, testMode = mode, mutation) {
  const loadedPath = join(evidence, label + '.loaded.jsonl'), reportPath = join(evidence, label + '.json')
  const nativeLoadedPath = join(evidence, label + '.native-loaded.jsonl'), native = testMode === 'codex-authentication'
  const compiledLoadedPath = join(evidence, label + '.compiled-loaded.jsonl'), compiledMutation = mutation === 'additive-environment'
  await writeFile(loadedPath, '')
  await writeFile(nativeLoadedPath, '')
  await writeFile(compiledLoadedPath, '')
  const result = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', '--outputFile', reportPath], {
    AMX_SESSION_STATE_MODE: testMode, AMX_SESSION_STATE_MUTATION: native || compiledMutation ? '' : mutation ?? '', AMX_SESSION_STATE_LOADED: loadedPath,
    AGENTMUX_CODEX_INITIALIZATION_MUTATION: native ? mutation ?? '' : '', AGENTMUX_CODEX_INITIALIZATION_LOADED: nativeLoadedPath,
    AMX_NATIVE_ENV_MUTATION: '', AGENTMUX_TEST_RPC_CORE_ENTRY: '',
    AMX_SESSION_STATE_COMPILED_MUTATION: compiledMutation ? mutation : '', AMX_SESSION_STATE_COMPILED_LOADED: compiledLoadedPath,
    AMX_SESSION_STATE_COMPILED: join(candidate, 'dist'), AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'bin/amux')
  })
  await writeFile(join(evidence, label + '.log'), result.stdout + result.stderr)
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  assert.ok(report.numTotalTests >= (native || ['desktop-mutation', 'process-environment'].includes(testMode) ? 1 : testMode === 'mutation' ? 5 : 2) && report.testResults.length > 0, 'Real nonempty behavior tests must collect.')
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const line of (await readFile(nativeLoadedPath, 'utf8')).trim().split('\n').filter(Boolean)) {
    const input = JSON.parse(line)
    loaded.push({ path: relative(root, input.path), originalSHA256: input.originalSHA256, sha256: input.loadedSHA256,
      ...(input.mutation ? { mutation: input.mutation } : {}) })
  }
  assert.ok(loaded.length > 0, 'The original candidate implementation must actually load.')
  for (const input of loaded) assert.equal(input.originalSHA256, before[input.path], 'Candidate input drifted: ' + input.path)
  const compiledLoaded = (await readFile(compiledLoadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const input of compiledLoaded) assert.equal(input.originalSHA256, compiledInputs[input.path], 'Wrong compiled candidate loaded: ' + input.path)
  if (testMode === 'process-environment' || testMode === 'initialization') for (const path of ['client.js', 'ctxmux-run-adapter.js',
    'agent-native-process.js', 'providers/grok-input-initialization.js']) assert.ok(compiledLoaded.some(input => input.path === path),
    'The compiled original environment must traverse the actual owning implementation: ' + path)
  if (testMode === 'activity' || testMode === 'integration') for (const path of [
    'apps/desktop/src/renderer/src/lib/agent-observation.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts'
  ]) assert.ok(loaded.some(input => input.path === path), 'The production Desktop observation consumer must actually load: ' + path)
  if (mutation) {
    const mutated = [...loaded, ...compiledLoaded].filter(input => input.mutation === mutation && input.sha256 !== input.originalSHA256)
    assert.ok(mutated.length > 0, 'The actual mutated implementation must load: ' + mutation)
    const failed = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    assert.ok(result.code !== 0 && failed.some(test => test.failureMessages.some(message => /AssertionError|expected /u.test(message))),
      'The mutation must fail a behavior assertion, not loading or timing: ' + mutation)
    return { result: 'assertion-red', mutation, failed: failed.map(test => test.fullName), implementations: mutated }
  }
  assert.equal(result.code, 0, 'Candidate behavior failed; see ' + label + '.log.')
  assert.equal(report.numFailedTests, 0)
  assert.ok(report.numPassedTests > 0, 'A skipped-only native qualification cannot pass.')
  return { result: 'green', tests: report.numPassedTests, files: report.testResults.map(file => file.name.slice(root.length + 1)) }
}

const baseline = await execute('baseline')
process.stdout.write(JSON.stringify({ mode, baseline }) + '\n')
const mutations = mode === 'activity' ? ['child-not-active', 'child-not-saved', 'old-child-end', 'source-gap-ignored', 'desktop-child-detached']
  : mode === 'initialization' ? ['startup-bypass', 'ignore-process-generation', 'additive-environment'] : []
const reds = []
for (const mutation of mutations) {
  reds.push(await execute('mutation-' + mutation, mutation === 'desktop-child-detached' ? 'desktop-mutation'
    : mutation === 'ignore-process-generation' ? 'native-environment' : mutation === 'additive-environment' ? 'process-environment'
      : mutation === 'startup-bypass' ? 'startup-mutation' : mode === 'activity' ? 'mutation' : mode, mutation))
  process.stdout.write(JSON.stringify({ mutation, result: 'assertion-red' }) + '\n')
}
const restored = mutations.length ? await execute('restored', mode === 'activity' ? 'mutation' : 'startup-mutation') : baseline
const environmentRestored = mode === 'initialization' ? await execute('environment-restored', 'process-environment') : undefined
const desktopRestored = mode === 'activity' ? await execute('desktop-restored', 'desktop-mutation') : undefined
const completion = mode === 'activity' ? await execute('completion', 'completion') : undefined
const nativeAuthentication = mode === 'initialization' ? {
  baseline: await execute('native-authentication-baseline', 'codex-authentication'),
  mutation: await execute('native-authentication-mutated', 'codex-authentication', 'drop-authentication-blocker'),
  restored: await execute('native-authentication-restored', 'codex-authentication')
} : undefined
for (const [file, fingerprint] of Object.entries(before)) assert.equal(hash(await read(file)), fingerprint, 'Candidate changed during qualification: ' + file)
const compileHashes = { cliSHA256: hash(await readFile(join(candidate, 'dist/agentmux.js'))), clientSHA256: hash(await readFile(join(candidate, 'dist/client.js'))) }
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ schema: 'agentmux.provider-session-state.v1', mode,
  passed: true, inputs: before, compiled: { ...compileHashes, inputs: compiledInputs, ...(nativeHelper ? { nativeHelper } : {}) }, baseline, mutations: reds, restored,
  ...(desktopRestored ? { desktopRestored } : {}), ...(completion ? { completion } : {}), ...(nativeAuthentication ? { nativeAuthentication } : {}),
  ...(environmentRestored ? { environmentRestored } : {}),
  boundary: 'Exact candidate Core, durable FileStore, public Control/RPC and compiled CLI with an isolated deterministic Runtime transport. Owner restart uses different real Node processes and the same original persisted data. No installed Provider, user Run, Desktop installation or live permission confirmation is certified.' }, null, 2) + '\n')
await rm(candidate, { recursive: true, force: true })
process.stdout.write(JSON.stringify({ mode, passed: true, qualification: '.bagakit/provider-session-activity/verification/' + mode + '/qualification.json' }) + '\n')
