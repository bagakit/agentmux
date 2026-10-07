import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, desktopRequire, root } from './fixtures/settings-resource-library/environment.mjs'

const mode = process.argv[2]
assert.ok(['--check', '--capture', '--review'].includes(mode))
const base = resolve(root, '.bagakit/executor-command-clarity')
const fixture = resolve(root, 'apps/desktop/scripts/fixtures/executor-launch')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}
async function bind(file) {
  file = resolve(file.split('?')[0])
  const path = relative(root, file)
  if (path.startsWith('..') || isAbsolute(path) || path.includes('node_modules/')) return
  const digest = hash(await readFile(file))
  if (sources[path]) assert.equal(sources[path], digest, 'Consumed source changed: ' + path)
  sources[path] = digest
}
const identity = values => hash(JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))))
async function verifySources(values) {
  assert.ok(Object.keys(values).length > 20, 'Nonempty actual consumed source graph')
  for (const [file, digest] of Object.entries(values)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Proof source changed: ' + file)
}
await mkdir(base, { recursive: true })
if (mode === '--review') {
  const capture = JSON.parse(await readFile(resolve(base, 'capture.json'), 'utf8'))
  const peer = JSON.parse(await readFile(resolve(base, 'visual-review.json'), 'utf8'))
  assert.equal(capture.format, 2, 'Capture must bind actual source graph and frame observations')
  assert.equal(capture.passed, true)
  assert.equal(peer.passed, true, 'Independent full-image review must accept the candidate')
  assert.equal(peer.sourceIdentity, capture.sourceIdentity)
  assert.equal(identity(capture.sources), capture.sourceIdentity)
  await verifySources(capture.sources)
  assert.equal(capture.render.frames.length, 6)
  for (const frame of capture.render.frames) {
    assert.equal(frame.observed.appearance, frame.requestedTheme)
    const digest = hash(await readFile(resolve(root, capture.evidence, frame.file)))
    assert.equal(digest, frame.sha256)
    assert.ok(peer.images.includes(digest), 'Every original PNG was reviewed')
  }
  console.log(JSON.stringify({ passed: true, reviewer: peer.reviewer, capture: capture.evidence }))
  process.exit(0)
}
const evidence = resolve(base, mode.slice(2) + '-' + crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const receipt = { format: 2, passed: false, mode, evidence: relative(root, evidence), sources, runs: [] }
async function run(label, command, args, extra = {}) {
  const log = [], env = { ...process.env, ...extra }
  if (label === 'electron') delete env.ELECTRON_RUN_AS_NODE
  const result = await runProbeProcess(command, args, { cwd: root, temporaryRoot: evidence, env, timeoutMs: 90000, onLine: line => log.push(line) })
  await writeFile(resolve(evidence, label + '.log'), log.join('\n'))
  return result
}
try {
  for (const file of ['apps/desktop/scripts/verify-executor-launch.mjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs', 'vitest.setup.ts', 'pnpm-lock.yaml',
    'apps/desktop/package.json', 'packages/core/package.json', 'packages/client-ui/package.json']) await bind(resolve(root, file))
  if (mode === '--check') {
    const config = resolve(fixture, 'vitest.config.mts')
    await bind(config)
    const build = await run('core-build', 'pnpm', ['--filter', '@agentmux/core', 'build'])
    assert.equal(build.exitCode, 0, 'Build the exact public CLI and Core')
    const sourceLog = resolve(evidence, 'loaded-source.jsonl')
    // No partial cache: each explicit check executes its actual consumers and mutations.
    for (const mutant of ['baseline', 'preview', 'adjacent', 'literal', 'diagnostic', 'label', 'guidance']) {
      const output = resolve(evidence, mutant + '.json'), mutationLog = resolve(evidence, mutant + '-loaded.jsonl')
      const result = await run(mutant, process.execPath, [desktopRequire.resolve('vitest/vitest.mjs'), 'run', '--config', config,
        '--reporter=json', '--outputFile', output], { AMUX_LAUNCH_SOURCE_LOG: sourceLog,
        ...(mutant === 'baseline' ? {} : { AMUX_LAUNCH_MUTANT: mutant, AMUX_LAUNCH_MUTATION_LOG: mutationLog }) })
      const tests = JSON.parse(await readFile(output, 'utf8'))
      assert.equal(result.timedOut, false)
      assert.ok(tests.numTotalTests > 0, 'Actual nonempty test set')
      if (mutant === 'baseline') { assert.equal(result.exitCode, 0); assert.equal(tests.numFailedTests, 0) }
      else {
        const loaded = (await readFile(mutationLog, 'utf8')).trim().split('\n').map(JSON.parse)
        assert.ok(loaded.length > 0 && loaded.every(item => item.mutant === mutant), 'Production mutation loaded')
        assert.equal(result.exitCode, 1)
        const failures = tests.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
        assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Assertion RED, not setup failure')
      }
      receipt.runs.push({ mutant, ...result, passedTests: tests.numPassedTests, failedTests: tests.numFailedTests })
    }
    // Loaded mutations never write product files; verify their actual original inputs instead of repeating baseline.
    for (const input of (await readFile(sourceLog, 'utf8')).trim().split('\n').map(JSON.parse)) {
      if (sources[input.path]) assert.equal(sources[input.path], input.sha256)
      sources[input.path] = input.sha256
    }
  } else {
    for (const file of ['main.cjs', 'scenario.md']) await bind(resolve(fixture, file))
    const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
    const output = resolve(evidence, 'compiled')
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, worker: { format: 'es' },
      plugins: [{ name: 'consumed-launch-source', enforce: 'pre', async transform(_code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file)
      } }],
      css: { postcss: { plugins: [{ postcssPlugin: 'consumed-launch-css', async OnceExit(tree) {
        const files = new Set()
        tree.walk(node => { if (node.source?.input?.file) files.add(node.source.input.file) })
        for (const file of files) await bind(file)
      } }] } },
      esbuild: { jsx: 'automatic' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      build: { target: 'esnext', outDir: output, emptyOutDir: true } })
    const owned = await mkdtemp(resolve(tmpdir(), 'amux-executor-launch-'))
    try {
      const result = await run('electron', desktopRequire('electron'), [resolve(fixture, 'main.cjs'), resolve(output, 'index.html'), owned, evidence])
      receipt.render = JSON.parse(await readFile(resolve(evidence, 'render.json'), 'utf8'))
      assert.equal(result.exitCode, 0, receipt.render.failure?.message)
      assert.equal(receipt.render.passed, true)
      for (const frame of receipt.render.frames) frame.sha256 = hash(await readFile(resolve(evidence, frame.file)))
      receipt.captureOnly = true
    } finally {
      assert.deepEqual(await listProbeProcesses(-1, owned), [])
      await rm(owned, { recursive: true, force: true })
      await rm(output, { recursive: true, force: true })
    }
  }
  await verifySources(sources)
  receipt.sourceIdentity = identity(sources)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; throw error }
finally {
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (receipt.passed) await writeFile(resolve(base, mode === '--capture' ? 'capture.json' : 'check.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, mode, evidence, failure: receipt.failure?.message }))
}
