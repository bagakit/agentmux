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
assert.ok(args.length === 1 && args[0] === '--prepare' || args.length === 2 && args[0] === '--run', 'Use --prepare, then --run DIRECTORY for the original pure-Renderer Settings captures')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = args[0] === '--run' ? resolve(args[1]) : join(root, '.tmp/browser-resource-presentation/native-' + randomUUID())
assert.ok(directory.startsWith(join(root, '.tmp/browser-resource-presentation/') + 'native-'), 'Only this fixture output is eligible')
const sourceFile = join(directory, 'source.json'), fixture = join(desktop, 'scripts/fixtures/browser-resource-presentation')
if (args[0] === '--prepare') {
  await mkdir(directory, { recursive: true })
  const sources = {}, aliases = [], pkgDir = join(root, 'packages/client-ui')
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  for (const [key, target] of Object.entries(pkg.exports)) {
    const browser = typeof target === 'string' ? target : target.browser
    if (!browser) continue
    const name = pkg.name + (key === '.' ? '' : key.slice(1))
    aliases.push({ find: new RegExp('^' + name.split('*').map(escape).join('(.+)') + '$'), replacement: resolve(pkgDir, browser).replace('*', '$1'), wildcard: key.includes('*'), length: key.length })
  }
  aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.length - a.length)
  const vite = await import(pathToFileURL(require.resolve('vite')))
  await vite.build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
    css: { postcss: { plugins: [{ postcssPlugin: 'actual-resource-settings-css-inputs', Once(css) {
      css.walk(node => {
        const file = node.source?.input.file
        if (!file?.startsWith(root + '/') || file.includes('/node_modules/') || !file.endsWith('.css') || file.includes('?')) return
        sources[relative(root, file)] = { file: hash(readFileSync(file)), consumed: hash(node.source.input.css) }
      })
    } }] } },
    plugins: [{ name: 'actual-resource-settings-sources', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0], name = relative(root, file)
      if (!file.startsWith(root + '/') || file.includes('/node_modules/') || !/\.(?:ts|tsx|css)$/u.test(file)) return
      sources[name] = { file: hash(readFileSync(file)), consumed: hash(code) }
    } }],
    build: { outDir: join(directory, 'compiled'), emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
  for (const file of ['apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
    'apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx',
    'apps/desktop/src/renderer/src/lib/browser-resource-view.ts',
    'apps/desktop/src/renderer/src/styles/browser-resources.css',
    'apps/desktop/src/renderer/src/styles/settings-materials.css']) {
    assert.equal(sources[file]?.file, hash(await readFile(join(root, file))), 'Actual candidate Renderer input: ' + file)
    assert.equal(sources[file].consumed, sources[file].file, 'Unmodified actual presentation source')
  }
  for (const file of ['apps/desktop/scripts/capture-browser-resource-settings.mjs', 'apps/desktop/scripts/fixtures/browser-resource-presentation/main.cjs']) {
    const digest = hash(await readFile(join(root, file))); sources[file] = { file: digest, consumed: digest }
  }
  await writeFile(sourceFile, JSON.stringify({ schema: 'agentmux.browser-resource-settings-visual-inputs.v1',
    candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources,
    boundary: 'Production Settings components and CSS with controlled typed directory/process data; original Main lifecycle and machine metrics are not under test.' }, null, 2))
  console.log(JSON.stringify({ prepared: true, directory, next: 'Run this exact directory to capture the complete actual Settings viewports' }))
} else {
  const source = JSON.parse(await readFile(sourceFile, 'utf8'))
  const owning = ['apps/desktop/src/renderer/src/components/browser/BrowserResources.tsx',
    'apps/desktop/src/renderer/src/lib/browser-resource-view.ts', 'apps/desktop/src/renderer/src/styles/browser-resources.css',
    'apps/desktop/src/renderer/src/styles/settings-materials.css', 'apps/desktop/src/renderer/src/components/settings/BrowserSettingsPane.tsx',
    'apps/desktop/src/renderer/src/components/SettingsPanel.tsx', 'apps/desktop/scripts/fixtures/browser-resource-presentation/main.cjs']
  for (const file of owning) assert.equal(hash(await readFile(join(root, file))), source.sources[file].file, 'Prepared owning product input remains exact: ' + file)
  const outputs = {}
  async function bindOutputs(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await bindOutputs(file)
      else outputs[relative(directory, file)] = hash(await readFile(file))
    }
  }
  await bindOutputs(join(directory, 'compiled'))
  assert.ok(Object.keys(outputs).some(file => file.endsWith('.js')) && Object.keys(outputs).some(file => file.endsWith('.css')), 'The actual private Renderer has nonempty compiled assets')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_RESOURCE_VISUAL_ROOT: directory, AGENTMUX_RESOURCE_VISUAL_HTML: join(directory, 'compiled/index.html') })
  const executable = require('electron'), logs = []
  const outcome = await runProbeProcess(executable, [join(fixture, 'main.cjs')], { cwd: directory, env, timeoutMs: 45000,
    onLine: line => { logs.push(line); process.stderr.write(line + '\n') } })
  await writeFile(join(directory, 'native.log'), logs.join('\n'))
  const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
  for (const [file, digest] of Object.entries(outputs)) assert.equal(hash(await readFile(join(directory, file))), digest, 'The captured Renderer consumes the original compiled bytes')
  await writeFile(join(directory, 'receipt.json'), JSON.stringify({ ...source, outputs,
    runVerifierSha256: hash(await readFile(import.meta.filename)), capture, outcome,
    passed: outcome.exitCode === 0 && !outcome.timedOut && capture.passed && capture.cleanup?.windowDestroyed === true }, null, 2))
  assert.equal(outcome.exitCode, 0, capture.failure?.message); assert.equal(outcome.timedOut, false); assert.equal(capture.passed, true)
  console.log(JSON.stringify({ passed: true, directory, pid: capture.pid, frames: capture.frames.length }))
}
