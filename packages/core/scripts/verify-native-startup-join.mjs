import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild'), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = join(root, 'packages/core/.tmp/native-startup-join'); await mkdir(directory, { recursive: true })
const attempt = await mkdtemp(join(directory, 'attempt-')), worker = join(attempt, 'worker.mjs')
const sources = ['packages/core/src/providers/codex-managed-run.ts', 'packages/core/src/providers/codex-managed-frontend.ts',
  'packages/core/src/providers/codex-native-rpc.ts', 'packages/core/test/native-startup-join.test.ts',
  'packages/core/test/fixtures/native-startup-join.cjs', 'packages/core/test/native-startup-join.config.mts',
  'packages/core/scripts/verify-native-startup-join.mjs']
const inputs = Object.fromEntries(await Promise.all(sources.map(async path => [path, digest(await readFile(join(root, path)))])))
const variants = [{ name: 'candidate', count: 5 },
  { name: 'skip-native-join', file: 'codex-managed-frontend.ts',
    from: "const joined = await connection.request('thread/resume', { threadId: target.sessionId, excludeTurns: true })",
    to: 'const joined = loaded', test: 'keeps ready native input', count: 1 },
  { name: 'ignore-runtime-identity', file: 'codex-managed-frontend.ts',
    from: " ||\n      target.runtimeSessionId !== undefined && loaded.thread.sessionId !== target.runtimeSessionId",
    to: '', test: 'different loaded native runtime', count: 1 },
  { name: 'accept-changed-join', file: 'codex-managed-frontend.ts',
    from: ' || joined.thread.sessionId !== loaded.thread.sessionId', to: '',
    test: 'changed runtime in the actual native join receipt', count: 1 },
  { name: 'drop-native-progress', file: 'codex-managed-run.ts',
    from: "if (params.threadId === nativeSessionId && ['turn/started', 'turn/completed'].includes(method)) void continueInitialFrontend()",
    to: "if (false) void continueInitialFrontend()", test: 'keeps ready native input', count: 1 },
  { name: 'repeat-delayed-join', file: 'codex-managed-run.ts',
    from: 'if (initialFrontendPending) { initialFrontendWake = true; return initialFrontendPending }',
    to: 'if (false && initialFrontendPending) return initialFrontendPending',
    test: 'retains one delayed join', count: 1 }]
const receipt = { schema: 'agentmux.native-startup-join-proof.v1', passed: false, sourceStable: false, userRuntimeTouched: false, inputs, results: [] }
try {
  for (const variant of process.argv.includes('--candidate-only') ? variants.slice(0, 1) : variants) {
    let transformed = false
    await build({ entryPoints: [join(root, sources[0])], outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      plugins: [{ name: 'owning-source-mutation', setup(plugin) {
        plugin.onLoad({ filter: /codex-(?:managed-run|managed-frontend)\.ts$/ }, async ({ path }) => {
          let contents = await readFile(path, 'utf8')
          // Bound only the observer in private tests, never Native business progress.
          contents = contents.replace('const INITIALIZATION_OBSERVATION_MS = 8_000', 'const INITIALIZATION_OBSERVATION_MS = 150')
          if (variant.from && path.endsWith('/' + variant.file)) {
            assert.equal(contents.split(variant.from).length, 2, 'Unique source mutation anchor: ' + variant.name)
            contents = contents.replace(variant.from, variant.to); transformed = true
          }
          return { contents, loader: 'ts' }
        })
      } }] })
    if (variant.from) assert.ok(transformed, 'Owning source mutation was loaded')
    const report = join(attempt, variant.name + '.json')
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/native-startup-join.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.test) args.push('-t', variant.test)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_STARTUP_JOIN_WORKER: worker }, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, output }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.output)
    const tests = JSON.parse(await readFile(report, 'utf8'))
    const active = tests.testResults.flatMap(test => test.assertionResults).filter(test => !['skipped', 'pending', 'todo'].includes(test.status))
    const failed = active.filter(test => test.status === 'failed')
    assert.equal(active.length, variant.count, 'Exact nonempty test inventory: ' + variant.name)
    const semanticRed = result.code === 1 && result.signal === null && failed.length > 0 &&
      failed.every(test => /AssertionError|expected .+ to /su.test(test.failureMessages.join('\n')) ||
        /Caused by: AssertionError: expected .+ to /su.test(result.output))
    receipt.results.push({ name: variant.name, code: result.code, total: active.length, failed: failed.length, semanticRed,
      worker: digest(await readFile(worker)), failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    if (variant.from) assert.ok(semanticRed, 'Source mutation needs behavior-bearing assertion RED: ' + variant.name)
    else assert.equal(result.code, 0, 'Actual Provider launcher baseline failed: ' + report)
    process.stdout.write(variant.name + ': ' + (variant.from ? 'assertion RED' : 'GREEN') + '\n')
  }
  for (const [path, hash] of Object.entries(inputs)) assert.equal(digest(await readFile(join(root, path))), hash, 'Source changed during verification: ' + path)
  receipt.sourceStable = true; receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; throw error }
finally { await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); process.stdout.write(relative(root, join(attempt, 'receipt.json')) + '\n') }
