import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { privatePackageSmokeEnvironment } from '../../../apps/desktop/scripts/package-smoke-context.mjs'
import { runProbeProcess } from '../../../apps/desktop/scripts/probe-process.mjs'
import { pageDecoderMutation } from './page-decoder-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(require.resolve('vite'))
const fixture = join(root, 'packages/editor-extensions/test/fixtures/page-decoders')
const output = resolve(root, process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? '.tmp/page-decoders')
const temporary = await mkdtemp(join(tmpdir(), 'agentmux-page-decoders-'))
await mkdir(output, { recursive: true })
const hits = join(output, 'mutation-loaded.ndjson'); await writeFile(hits, '')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [
  'apps/desktop/src/main/workspace-cbr-archives.ts',
  'apps/desktop/test/workspace-cbr-archives.test.ts',
  'apps/desktop/test/vitest.page-decoders.config.mts',
  'packages/editor-extensions/src/books/security.ts',
  'packages/editor-extensions/test/page-book.test.ts',
  'packages/editor-extensions/scripts/verify-page-decoders.mjs',
  'packages/editor-extensions/scripts/page-decoder-mutations.mjs',
  ...['types.ts', 'page-book.ts', 'cbr.ts', 'djvu.ts', 'djvu.worker.ts', 'djvu-protocol.ts'].map(name => 'packages/editor-extensions/src/books/page-decoders/' + name),
  ...['browser.ts', 'electron.cjs', 'original-pages.cbr', 'chinese-cookbook.djvu'].map(name => 'packages/editor-extensions/test/fixtures/page-decoders/' + name),
]
const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, sha256(await readFile(join(root, file)))])))
const result = { passed: false, sources, mutations: [] }
const tests = async name => {
  const report = join(output, (name ?? 'green') + '-tests.json')
  const child = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', 'apps/desktop/test/vitest.page-decoders.config.mts', '--reporter=json', '--outputFile=' + report],
    { cwd: root, env: { ...process.env, PAGE_DECODER_MUTATION: name ?? '', PAGE_DECODER_HITS: hits }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const parsed = JSON.parse(await readFile(report, 'utf8'))
  assert.ok(parsed.numTotalTests >= 6, 'A nonempty page-decoder behavior surface actually ran')
  return { status: child.status, passed: parsed.numPassedTests, failed: parsed.numFailedTests, stderr: child.stderr }
}
const browser = async name => {
  const outDir = join(temporary, name ?? 'green'), plugins = pageDecoderMutation(name, hits)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins,
    worker: { format: 'es', plugins: () => plugins }, build: { outDir, emptyOutDir: true, assetsInlineLimit: 300000 } })
  const profile = join(temporary, (name ?? 'green') + '-profile'), report = join(output, (name ?? 'green') + '-browser.json')
  const env = privatePackageSmokeEnvironment(process.env, { userData: profile, runtimeRoot: join(temporary, 'runtime-' + (name ?? 'green')), readyFile: join(profile, 'ready') })
  for (const path of [env.HOME, env.TMPDIR, profile]) await mkdir(path, { recursive: true })
  const lines = []
  const outcome = await runProbeProcess(require('electron'), [join(fixture, 'electron.cjs'), join(outDir, 'index.html'), profile, report],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 45000, onLine: line => lines.push(line) })
  await writeFile(join(output, (name ?? 'green') + '-process.log'), lines.join('\n'))
  return { status: outcome.exitCode, ...(JSON.parse(await readFile(report, 'utf8'))) }
}
try {
  result.baseline = await tests(); assert.equal(result.baseline.status, 0, result.baseline.stderr)
  result.browser = await browser(); assert.equal(result.browser.status, 0, result.browser.failure); assert.equal(result.browser.passed, true)
  for (const name of ['original-offset', 'exact-entry', 'cbr-consumer', 'page-release', 'resident-race']) {
    const red = await tests(name); assert.notEqual(red.status, 0, name + ' must fail'); assert.ok(red.failed > 0)
    result.mutations.push({ name, failed: red.failed })
  }
  for (const name of ['djvu-page', 'djvu-terminate']) {
    const red = await browser(name); assert.notEqual(red.status, 0, name + ' must fail'); assert.equal(red.passed, false); assert.ok(red.failure)
    result.mutations.push({ name, failure: red.failure })
  }
  result.loaded = (await readFile(hits, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const mutation of result.mutations) assert.ok(result.loaded.some(hit => hit.name === mutation.name && hit.anchors === 1 && hit.sha256 === sources[hit.file]), mutation.name + ' consumed current checked-out source')
  result.restored = await tests(); assert.equal(result.restored.status, 0)
  result.passed = true
} catch (error) { result.failure = error.stack ?? String(error) }
finally {
  await rm(temporary, { recursive: true, force: true })
  await writeFile(join(output, 'receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, output, tests: result.baseline?.passed, memory: result.browser?.memory, mutations: result.mutations, failure: result.failure }))
  process.exitCode = result.passed ? 0 : 1
}
