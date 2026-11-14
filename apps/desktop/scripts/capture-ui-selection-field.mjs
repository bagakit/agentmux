import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { aliases, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/settings-connections')
const operation = process.argv[2] ?? '--node'
assert.ok(['--node', '--desktop'].includes(operation), 'Known selection capture operation')
const section = operation.slice(2)
const evidence = resolve(root, `.tmp/ui-selection-field/${section}`)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'amx-selection-node-'))
const output = join(temporaryRoot, 'compiled')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { completed: false, boundary: 'Actual SettingsPanel/NetworkNodeSettingsPane and SelectionField with controlled Settings DTOs. No real SSH, installation, Runtime recovery or physical device claim.', images: [], sources: {} }
const sources = {}
for (const file of [
  'apps/desktop/scripts/capture-ui-selection-field.mjs',
  `apps/desktop/scripts/fixtures/ui-selection-field/${section}-main.cjs`,
  'apps/desktop/scripts/fixtures/settings-connections/native-input.cjs',
  'apps/desktop/scripts/fixtures/settings-connections/environment.mjs',
  'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs',
  'apps/desktop/scripts/candidate-package-resolve.mjs',
  'apps/desktop/scripts/probe-process.mjs',
  'packages/client-ui/scripts/radix-overlay-aliases.ts',
]) sources[file] = sha(readFileSync(resolve(root, file)))
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: [...aliases, { find: 'node:crypto', replacement: resolve(root, 'apps/desktop/scripts/lib/browser-crypto.mjs') }, { find: 'node:util', replacement: resolve(root, 'apps/desktop/scripts/lib/browser-util.mjs') }, { find: '@agentmux/core/browser-viewport', replacement: resolve(root, 'packages/core/src/browser-viewport.ts') }], }, esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, worker: { format: 'es' },
    plugins: [{ name: 'selection-source-binding', enforce: 'pre', transform(_code, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
      sources[relative(root, file)] = sha(readFileSync(file))
    }, generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && !file.includes('/node_modules/')) sources[relative(root, file)] = sha(readFileSync(file))
    } }], build: { outDir: output, emptyOutDir: true } })
  for (const [file, digest] of Object.entries(sources)) assert.equal(sha(readFileSync(resolve(root, file))), digest, `Source changed during capture build: ${file}`)
  receipt.sources = sources
  receipt.sourceIdentity = sha(JSON.stringify(Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = []
  receipt.execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, `../ui-selection-field/${section}-main.cjs`), resolve(output, 'index.html'), temporaryRoot, evidence, section], {
    temporaryRoot, cwd: root, env, timeoutMs: 120_000, onLine: line => log.push(line),
  })
  Object.assign(receipt, JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8')))
  await writeFile(join(evidence, 'process.log'), log.join('\n') + '\n')
  assert.equal(receipt.execution.exitCode, 0, receipt.failure?.message)
  assert.equal(receipt.completed, true, receipt.failure?.message)
  for (const image of receipt.images) image.sha256 = sha(await readFile(join(evidence, image.path)))
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: `.tmp/ui-selection-field/${section}/receipt.json`, images: receipt.images.length }))
} catch (error) {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ ...receipt, failure: { message: error.message } }, null, 2) + '\n')
  console.error(JSON.stringify({ passed: false, failure: { message: error.message } }))
  process.exitCode = 1
} finally {
  receipt.remaining = await listProbeProcesses(-1, temporaryRoot)
  assert.deepEqual(receipt.remaining, [], 'Only owned preview processes must be reaped')
  await rm(temporaryRoot, { recursive: true, force: true })
}
