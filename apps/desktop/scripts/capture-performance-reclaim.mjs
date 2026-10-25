import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop'), require = createRequire(join(desktop, 'package.json'))
const args = process.argv.slice(2)
assert.ok(args.length === 1 && args[0] === '--prepare' || args.length === 2 && args[0] === '--run', 'Use --prepare, then --run DIRECTORY')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = args[0] === '--run' ? resolve(args[1]) : join(root, '.tmp/performance-reclaim/native-' + randomUUID())
assert.ok(directory.startsWith(join(root, '.tmp/performance-reclaim/') + 'native-'), 'Only this fixture namespace is eligible')
const sourceFile = join(directory, 'source.json'), fixture = join(desktop, 'scripts/fixtures/performance-reclaim')
const owning = ['apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceReclaim.tsx',
  'apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx',
  'apps/desktop/src/renderer/src/lib/use-browser-directory.ts', 'apps/desktop/src/renderer/src/lib/browser-resource-view.ts',
  'apps/desktop/src/renderer/src/styles/browser-resources.css', 'apps/desktop/src/renderer/src/styles/performance-toolkit.css',
  'packages/core/src/renderer-cache.ts']
if (args[0] === '--prepare') {
  await mkdir(directory, { recursive: true })
  const sources = {}, aliases = [], escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  for (const packagePath of ['packages/client-ui', 'packages/core', 'apps/host']) {
    const folder = join(root, packagePath), pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
    for (const [key, target] of Object.entries(pkg.exports)) {
      const entry = typeof target === 'string' ? target : target.browser ?? target.import
      if (!entry) continue
      const source = entry.startsWith('./dist/') ? entry.replace('./dist/', './src/').replace(/\.js$/u, '.ts') : entry
      const name = pkg.name + (key === '.' ? '' : key.slice(1))
      aliases.push({ find: new RegExp('^' + name.split('*').map(escape).join('(.+)') + '$'), replacement: resolve(folder, source).replace('*', '$1'), wildcard: key.includes('*'), length: key.length })
    }
  }
  aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.length - a.length)
  const vite = await import(pathToFileURL(require.resolve('vite')))
  await vite.build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
    css: { postcss: { plugins: [{ postcssPlugin: 'original-reclaim-css-inputs', Once(css) {
      css.walk(node => {
        const file = node.source?.input.file
        if (!file?.startsWith(root + '/') || file.includes('/node_modules/') || !file.endsWith('.css') || file.includes('?')) return
        sources[relative(root, file)] = { file: hash(readFileSync(file)), consumed: hash(node.source.input.css) }
      })
    } }] } },
    plugins: [{ name: 'original-reclaim-sources', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0], name = relative(root, file)
      if (!file.startsWith(root + '/') || file.includes('/node_modules/') || !/\.(?:ts|tsx|css)$/u.test(file)) return
      sources[name] = { file: hash(readFileSync(file)), consumed: hash(code) }
    } }],
    build: { outDir: join(directory, 'compiled'), emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
  for (const file of owning) {
    assert.equal(sources[file]?.file, hash(await readFile(join(root, file))), 'Actual candidate Renderer input: ' + file)
    assert.equal(sources[file].consumed, sources[file].file, 'Unmodified original product source')
  }
  for (const file of ['apps/desktop/scripts/capture-performance-reclaim.mjs', 'apps/desktop/scripts/fixtures/performance-reclaim/main.cjs', 'apps/desktop/scripts/fixtures/performance-reclaim/index.html']) {
    const digest = hash(await readFile(join(root, file))); sources[file] = { file: digest, consumed: digest }
  }
  await writeFile(sourceFile, JSON.stringify({ schema: 'agentmux.performance-reclaim-visual-inputs.v1',
    candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources,
    boundary: 'Production Performance and shared Browser UI/CSS with controlled typed resource and cache data. Renderer presentation only, no original Main or native reclamation qualification.' }, null, 2))
  console.log(JSON.stringify({ prepared: true, directory }))
} else {
  const source = JSON.parse(await readFile(sourceFile, 'utf8'))
  for (const file of [...owning, 'apps/desktop/scripts/fixtures/performance-reclaim/entry.tsx', 'apps/desktop/scripts/fixtures/performance-reclaim/main.cjs'])
    assert.equal(hash(await readFile(join(root, file))), source.sources[file].file, 'Prepared candidate input remains exact: ' + file)
  const outputs = {}
  async function bindOutputs(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await bindOutputs(file)
      else outputs[relative(directory, file)] = hash(await readFile(file))
    }
  }
  await bindOutputs(join(directory, 'compiled'))
  assert.ok(Object.keys(outputs).some(file => file.endsWith('.js')) && Object.keys(outputs).some(file => file.endsWith('.css')), 'Nonempty original compiled source')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RECLAIM_VISUAL_ROOT: directory, AGENTMUX_RECLAIM_VISUAL_HTML: join(directory, 'compiled/index.html') })
  const logs = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs')], { cwd: directory, env, timeoutMs: 45000,
    onLine: line => { logs.push(line); process.stderr.write(line + '\n') } })
  await writeFile(join(directory, 'native.log'), logs.join('\n'))
  const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
  for (const [file, digest] of Object.entries(outputs)) assert.equal(hash(await readFile(join(directory, file))), digest, 'Original compiled source remains exact')
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ ...source, outputs,
    runVerifierSha256: hash(await readFile(import.meta.filename)), capture, outcome,
    passed: outcome.exitCode === 0 && !outcome.timedOut && capture.passed && capture.cleanup?.windowDestroyed === true }, null, 2))
  assert.equal(outcome.exitCode, 0, capture.failure?.message); assert.equal(outcome.timedOut, false); assert.equal(capture.passed, true)
  console.log(JSON.stringify({ passed: true, directory, frames: capture.frames.length }))
}
