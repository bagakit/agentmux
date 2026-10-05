import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import('vite')
const fixture = path.join(desktop, 'scripts/fixtures/markdown-parse-reuse'), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'am-md-reuse-'))
const baselineOnly = process.argv.includes('--baseline-only'), owner = 'packages/client-ui/src/components/AgentMarkdown.tsx'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { passed: false, baselineOnly, userRunTouched: false, naturalFreezeAttribution: false, consumers: {}, variants: [], cleanup: null }
const critical = [owner, 'packages/client-ui/src/lib/agent-markdown.ts', 'pnpm-lock.yaml', 'apps/desktop/package.json',
  ...['entry.tsx', 'main.cjs', 'index.html', 'vitest.config.mts'].map(file => 'apps/desktop/scripts/fixtures/markdown-parse-reuse/' + file),
  'apps/desktop/scripts/verify-markdown-parse-reuse.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'packages/client-ui/test/markdown-parse-reuse.test.tsx', 'packages/client-ui/test/input-markdown.config.mts',
  ...['input-markdown', 'markdown-semantics', 'markdown-outline'].map(file => 'packages/client-ui/test/' + file + '.test.tsx')]
const hashes = async () => Object.fromEntries(await Promise.all(critical.map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
try {
  report.sourceAndPackageBefore = await hashes()
  if (!baselineOnly) {
    const output = path.join(temporary, 'unit.json')
    report.unitOutcome = await runProbeProcess('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/markdown-parse-reuse/vitest.config.mts', '--reporter=json', '--outputFile=' + output], { temporaryRoot: temporary, cwd: root, env: process.env, timeoutMs: 45_000 })
    assert.equal(report.unitOutcome.exitCode, 0); assert.equal(report.unitOutcome.timedOut, false); assert.equal(report.unitOutcome.interruption, null)
    report.unit = JSON.parse(await fs.readFile(output, 'utf8'))
    assert.equal(report.unit.success, true)
    assert.equal(report.unit.testResults.length, 4, 'All four actual mounted owning suites must execute')
    assert.ok(report.unit.numPassedTests > 0); assert.equal(report.unit.numFailedTests, 0)
  }
  for (const [file, call] of [['apps/desktop/src/renderer/src/components/ActivityView.tsx', '<ConversationView'], ['packages/client-ui/src/components/ConversationView.tsx', '<ConversationMessage'], ['packages/client-ui/src/components/ConversationMessage.tsx', '<MemoizedAgentMarkdown']]) {
    const source = await fs.readFile(path.join(root, file), 'utf8'); assert.ok(source.includes(call), 'Nonempty actual external consumer ' + file)
    report.consumers[file] = { sha256: sha(source), call }
  }
  for (const variant of baselineOnly ? ['baseline'] : ['candidate', 'source-no-reuse', 'source-stale-content']) {
    const sources = {}, loaded = {}, out = path.join(temporary, variant)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, esbuild: { jsx: 'automatic' }, resolve: { conditions: ['browser'], dedupe: ['react', 'react-dom'] },
      plugins: [{ name: 'actual-markdown-owner-proof', enforce: 'pre', transform(source, id) {
        const file = id.split('?')[0], relative = path.relative(root, file)
        if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return null
        sources[relative] = sha(source)
        let code = source
        if (relative === owner && variant.startsWith('source-')) {
          const dependency = '}, [content, parseMode])'; assert.equal(code.split(dependency).length, 2, 'Actual unique current-result owner')
          if (variant === 'source-no-reuse') {
            assert.equal(code.split('useMemo(() => {').length, 2)
            code = code.replace('useMemo(() => {', '(() => {').replace(dependency, '})()')
          } else code = code.replace(dependency, '}, [parseMode])')
        }
        if (relative === 'packages/client-ui/src/lib/agent-markdown.ts') {
          const site = 'const tree = processor.parse(source) as Root'; assert.equal(code.split(site).length, 2)
          code = code.replace(site, 'const before = performance.now(); ' + site + '; (globalThis as any).__markdownParseProbe.push({bytes: source.length, collectHeadings, duration: performance.now() - before})')
        }
        loaded[relative] = sha(code)
        return code === source ? null : { code, map: null }
      } }], build: { outDir: out, emptyOutDir: true } })
    assert.ok(sources[owner]); assert.ok(sources['packages/client-ui/src/components/ConversationView.tsx']); assert.ok(sources['packages/client-ui/src/lib/agent-markdown.ts'])
    if (variant.startsWith('source-')) assert.notEqual(loaded[owner], sources[owner]); else assert.equal(loaded[owner], sources[owner])
    const output = path.join(temporary, variant + '.json'), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const outcome = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(out, 'index.html'), path.join(temporary, 'profile-' + variant), output, variant], { temporaryRoot: temporary, cwd: root, env, timeoutMs: 30_000 })
    const native = JSON.parse(await fs.readFile(output, 'utf8'))
    report.variants.push({ variant, sources, loaded, outcome, native })
    assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
    if (variant.startsWith('source-')) {
      assert.equal(outcome.exitCode, 1); assert.equal(native.failure?.name, 'AssertionError', 'Compile/startup failure is not mutation RED')
      assert.match(native.failure.message, variant === 'source-no-reuse' ? /Unchanged production Conversation body/ : /Changed content must reach the actual current DOM/)
    }
    else { assert.equal(outcome.exitCode, 0, native.failure?.message); assert.equal(native.passed, true) }
    for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await fs.readFile(path.join(root, file))), digest, 'Stable current production input ' + file)
  }
  report.sourceAndPackageAfter = await hashes()
  assert.deepEqual(report.sourceAndPackageAfter, report.sourceAndPackageBefore)
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  await fs.rm(temporary, { recursive: true }); report.cleanup.rootRemoved = true
  await fs.mkdir(path.join(root, '.tmp'), { recursive: true })
  const evidence = path.join(root, '.tmp', `markdown-parse-reuse-${baselineOnly ? 'baseline' : 'last'}.json`)
  await fs.writeFile(evidence, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null, cleanup: report.cleanup }))
  process.exitCode = report.passed ? 0 : 1
}
