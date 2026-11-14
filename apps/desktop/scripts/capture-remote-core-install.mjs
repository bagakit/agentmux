import { builtinModules } from 'node:module'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'
const exec = promisify(execFile), { build } = await import(desktopRequire.resolve('vite'))
const fixture = resolve(root, 'apps/desktop/scripts/fixtures/remote-core-install')
const evidence = resolve(root, process.argv[2] ?? ".local/state/remote-core-install-fixture/visual")
const focusMutant = process.argv.includes('--focus-mutation')
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-remote-install-visual-'))
const inputs = new Map()
let focusMutation
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'warn', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    resolve: { alias: [{ find: /^@agentmux\/client-ui\/note\/(.+)$/u, replacement: resolve(root, 'packages/client-ui/src/note') + '/$1.ts' }, { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(root, 'apps/host/src') + '/$1.ts' }, ...aliases] }, plugins: [{ name: 'owned-dependencies', enforce: 'pre', resolveId(source, importer) {
      if (builtinModules.includes(source) || source.startsWith('node:')) return
      return browserInstalledDependency.call(this, source, importer)
    },
      transform(code, id) {
        if (id.startsWith(root + '/') && !id.includes('/node_modules/')) inputs.set(id, createHash('sha256').update(code).digest('hex'))
        if (focusMutant && id === resolve(root, 'apps/desktop/src/renderer/src/components/settings/host-install.css')) {
          const rule = '.host-install__choice:focus-within { outline: 2px solid var(--green); outline-offset: 2px; }'
          assert.ok(!focusMutation && !code.includes(rule), 'Only the actual installation choice stylesheet is mutated')
          const mutated = code + '\n' + rule + '\n'
          focusMutation = { path: id, original: inputs.get(id), consumed: createHash('sha256').update(mutated).digest('hex'), rule }
          return { code: mutated, map: null }
        }
      } }], esbuild: { jsx: 'automatic' }, build: { outDir: join(privateRoot, 'dist'), emptyOutDir: true } })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const captureFailure = await exec(desktopRequire('electron'), [join(fixture, 'main.cjs'), join(privateRoot, 'dist/index.html'), privateRoot, evidence], { env, timeout: 240000, maxBuffer: 1024 * 1024 })
    .then(() => null, error => error)
  if (captureFailure && captureFailure.code !== 1) throw captureFailure
  const capture = JSON.parse(await readFile(join(evidence, 'capture.json'), 'utf8'))
  if (focusMutant) {
    assert.ok(focusMutation, 'The installation focus mutation was consumed')
    assert.equal(captureFailure?.code, 1)
    assert.match(capture.error, /^AssertionError.*The installation card does not add a second keyboard focus outline/u)
    capture.focusMutation = focusMutation
    capture.assertionRed = true
  } else if (captureFailure || !capture.passed) throw new Error(capture.error)
  for (const image of capture.images) image.sha256 = createHash('sha256').update(await readFile(join(evidence, image.path))).digest('hex')
  capture.inputs = [...inputs].map(([path, sha256]) => ({ path, sha256 }))
  capture.captureOnly = true; capture.aestheticReview = 'not-performed'
  await writeFile(join(evidence, 'capture.json'), JSON.stringify(capture, null, 2) + '\n')
  console.log(JSON.stringify({ evidence, images: capture.images.length, assertionRed: focusMutant, boundary: capture.boundary }))
} finally { await rm(privateRoot, { recursive: true, force: true }) }
