import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { aliases } from './fixtures/settings-resource-library/environment.mjs'
import { runProbeProcess } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const args = process.argv.slice(2), capture = resolve(args[0] ?? '')
assert(capture.startsWith(join(root, '.tmp/remote-execution-experience/capture-')), 'Provide the exact completed App capture')
const mutant = args.includes('--mutant')
assert(!args.includes('--mutant') || args[args.indexOf('--mutant') + 1] === 'short-stack', 'Only the declared production CSS mutant is supported')
const directory = join(root, '.tmp/remote-execution-experience/css-' + (mutant ? 'mutant-' : '') + randomUUID())
await mkdir(directory, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), sources = {}, mutations = []
const launcher = join(root, 'apps/desktop/src/renderer/src/styles/launcher.css')
const { build } = await import(pathToFileURL(require.resolve('vite')))
await build({ configFile: false, root, base: './', logLevel: 'error', resolve: { alias: aliases },
  css: { postcss: { plugins: [{ postcssPlugin: 'execution-mode-css-candidate', Once(tree) {
    tree.walk(node => {
      const file = node.source?.input?.file
      if (file?.startsWith(root + '/') && !file.includes('/node_modules/')) sources[relative(root, file)] = sha(node.source.input.css)
    })
    if (!mutant) return
    tree.walkRules(rule => {
      if (rule.source?.input?.file !== launcher || !rule.selector.includes('[data-density=\'compact\']') || !rule.selector.endsWith('.launcher-execution__modes')) return
      rule.walkDecls('grid-template-columns', decl => {
        if (!decl.value.startsWith('repeat(3,')) return
        const before = rule.toString(), originalSha256 = sha(rule.source.input.css)
        decl.value = 'minmax(0, 1fr)'
        mutations.push({ owner: relative(root, launcher), originalSha256, originalRule: before, mutatedRule: rule.toString(), mutatedHash: sha(rule.toString()) })
      })
    })
  } }] } },
  build: { outDir: join(directory, 'compiled'), emptyOutDir: true, minify: false, rollupOptions: { input: join(root, 'apps/desktop/src/renderer/src/styles/index.css') } } })
assert(Object.keys(sources).length > 20, 'The entire production CSS cascade is compiled')
assert.equal(mutations.length, mutant ? 1 : 0, 'The declared rule must be unique in actual imported production CSS')
const cssFiles = []
async function collect(folder) { const { readdir } = await import('node:fs/promises'); for (const entry of await readdir(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) await collect(path); else if (entry.name.endsWith('.css')) cssFiles.push(path) } }
await collect(join(directory, 'compiled')); assert.equal(cssFiles.length, 1)
const css = cssFiles[0], drivers = ['apps/desktop/scripts/fixtures/execution-modes/main.cjs', 'apps/desktop/scripts/fixtures/execution-modes/preload.cjs', 'apps/desktop/scripts/review-execution-modes-css.mjs']
const driverHashes = Object.fromEntries(await Promise.all(drivers.map(async file => [file, sha(await readFile(join(root, file)))])))
const input = { sourceCapture: capture, source: join(capture, 'source.json'), stylesheet: css, stylesheetSha256: sha(await readFile(css)), sources, mutations, driverHashes }
await writeFile(join(directory, 'inputs.json'), JSON.stringify(input, null, 2))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
const execution = await runProbeProcess(require('electron'), [join(root, drivers[0]), join(capture, 'compiled/index.html'), join(capture, 'private-profile'), directory,
  mutant ? 'css-short-mutant' : 'css-review', join(root, 'packages/core/dist/spatial-state.js'), css],
  { cwd: root, env, temporaryRoot: join(capture, 'private-profile'), timeoutMs: 90000, onLine: line => { if (line.startsWith('{"frame":')) console.log(line) } })
const report = JSON.parse(await readFile(join(directory, (mutant ? 'css-short-mutant' : 'css-review') + '.json'), 'utf8'))
for (const [file, digest] of Object.entries(sources)) assert.equal(sha(await readFile(join(root, file))), digest, 'The qualified CSS owner remained unchanged: ' + file)
for (const [file, digest] of Object.entries(driverHashes)) assert.equal(sha(await readFile(join(root, file))), digest, 'The executed driver remained unchanged: ' + file)
assert.equal(execution.exitCode, mutant ? 1 : 0, report.failure?.message)
assert.equal(report.passed, !mutant)
if (mutant) assert(report.failure?.message?.includes('Short Launcher'), 'The mutation must fail actual short-layout behavior, not setup')
await writeFile(join(directory, 'receipt.json'), JSON.stringify({ passed: true, mutationKilled: mutant, input, execution, report, boundary: 'Same compiled production App JavaScript and durable Core profile; new production CSS full cascade, actual native Renderer geometry/hit tests. No Core/Provider journey repetition or product CSS injection.' }, null, 2))
console.log(JSON.stringify({ passed: true, mutationKilled: mutant, directory }))
