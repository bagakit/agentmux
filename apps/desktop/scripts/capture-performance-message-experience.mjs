import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--evidence', 'Use an optional absolute --evidence directory')
const base = join(root, '.bagakit/design/performance-message-experience')
await mkdir(base, { recursive: true })
const directory = args[1] ? resolve(args[1]) : await mkdtemp(join(base, 'run-'))
await mkdir(directory, { recursive: true })
const fixture = join(desktop, 'scripts/fixtures/performance-message-experience')
const hash = value => createHash('sha256').update(value).digest('hex')
const owning = [
  'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceLiveOverview.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceMetric.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceTrend.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceResourceDetails.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceHostResources.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceCapture.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceProfileImport.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceScene.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceHeapSnapshot.tsx',
  'apps/desktop/src/renderer/src/components/performance/use-performance-app-trend.ts',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/ServiceNoticeRow.tsx',
  'apps/desktop/src/renderer/src/components/MailboxReading.tsx',
  'apps/desktop/src/renderer/src/components/MailboxA2A.tsx',
  'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx',
  'apps/desktop/src/renderer/src/components/MailboxNavigation.tsx',
  'apps/desktop/src/renderer/src/components/MailboxWorkspaceNavigation.tsx',
  'apps/desktop/src/renderer/src/components/LiquidSelectionSurface.tsx',
  'apps/desktop/src/renderer/src/components/use-mailbox-motion.ts',
  'apps/desktop/src/renderer/src/styles/performance-toolkit.css',
  'packages/client-ui/src/components/MailboxRecordRow.tsx',
  'packages/client-ui/src/styles/composer.css'
]
const sources = {}, aliases = [], escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
for (const packagePath of ['packages/client-ui', 'packages/core', 'apps/host', 'packages/conversation', 'packages/demand', 'packages/layout']) {
  const folder = join(root, packagePath), pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  for (const [key, target] of Object.entries(pkg.exports)) {
    const entry = typeof target === 'string' ? target : target.browser ?? target.import
    if (!entry) continue
    const source = entry.startsWith('./dist/src/') ? entry.replace('./dist/src/', './src/').replace(/\.js$/u, '.ts')
      : entry.startsWith('./dist/') ? entry.replace('./dist/', './src/').replace(/\.js$/u, '.ts') : entry
    const name = pkg.name + (key === '.' ? '' : key.slice(1))
    aliases.push({ find: new RegExp('^' + name.split('*').map(escape).join('(.+)') + '$'), replacement: resolve(folder, source).replace('*', '$1'), wildcard: key.includes('*'), length: key.length })
  }
}
aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.length - a.length)
const vite = await import(pathToFileURL(require.resolve('vite')))
await vite.build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  css: { postcss: { plugins: [{ postcssPlugin: 'experience-source-inputs', Once(css) {
    css.walk(node => {
      const file = node.source?.input.file
      if (!file?.startsWith(root + '/') || file.includes('/node_modules/') || !file.endsWith('.css') || file.includes('?')) return
      sources[relative(root, file)] = { file: hash(readFileSync(file)), consumed: hash(node.source.input.css) }
    })
  } }] } },
  plugins: [{ name: 'experience-controlled-store', enforce: 'pre', resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !/\/store$/u.test(source)) return
    const target = resolve(dirname(importer.split('?')[0]), source + '.ts')
    if (target === join(desktop, 'src/renderer/src/store.ts')) return join(fixture, 'store.ts')
  } }, { name: 'experience-production-sources', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0], name = relative(root, file)
    if (!file.startsWith(root + '/') || file.includes('/node_modules/') || !/\.(?:ts|tsx|css)$/u.test(file)) return
    sources[name] = { file: hash(readFileSync(file)), consumed: hash(code) }
  } }],
  build: { outDir: join(directory, 'compiled'), emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
for (const file of owning) {
  assert.equal(sources[file]?.file, hash(await readFile(join(root, file))), `Actual Renderer input: ${file}`)
  assert.equal(sources[file].consumed, sources[file].file, `Unmodified production source: ${file}`)
}
for (const file of ['apps/desktop/scripts/capture-performance-message-experience.mjs',
  'apps/desktop/scripts/fixtures/performance-message-experience/entry.tsx',
  'apps/desktop/scripts/fixtures/performance-message-experience/main.cjs',
  'apps/desktop/scripts/fixtures/performance-message-experience/index.html',
  'apps/desktop/scripts/fixtures/performance-message-experience/store.ts']) {
  const digest = hash(await readFile(join(root, file))); sources[file] = { file: digest, consumed: digest }
}
const outputs = {}
async function bindOutputs(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) await bindOutputs(file)
    else outputs[relative(directory, file)] = hash(await readFile(file))
  }
}
await bindOutputs(join(directory, 'compiled'))
assert.ok(Object.keys(outputs).some(file => file.endsWith('.js')) && Object.keys(outputs).some(file => file.endsWith('.css')))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
Object.assign(env, { AGENTMUX_EXPERIENCE_ROOT: directory, AGENTMUX_EXPERIENCE_HTML: join(directory, 'compiled/index.html') })
const logs = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs')], { cwd: directory, env, timeoutMs: 60000,
  onLine: line => { logs.push(line); process.stderr.write(line + '\n') } })
await writeFile(join(directory, 'native.log'), logs.join('\n'))
const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
for (const [file, digest] of Object.entries(outputs)) assert.equal(hash(await readFile(join(directory, file))), digest, `Compiled source remains exact: ${file}`)
const receipt = { schema: 'agentmux.performance-message-experience-proof.v1', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources, outputs,
  capture, outcome, passed: outcome.exitCode === 0 && !outcome.timedOut && capture.passed && capture.frames.length >= 12 && capture.cleanup?.windowDestroyed === true,
  boundary: 'Actual production Renderer components and styles in isolated Electron with controlled typed inputs. No live machine measurement, user Session, delivery, recovery, or installation claim.' }
await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
assert.equal(receipt.passed, true, capture.failure?.message ?? 'Integrated visual capture must pass')
console.log(JSON.stringify({ passed: true, directory, frames: capture.frames.length }))
