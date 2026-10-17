import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { runProbeProcess } from './probe-process.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/space-launcher')
const evidence = resolve(process.argv[2] ?? join(repository, '.tmp/space-launcher'))
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const { build } = await import(require.resolve('vite'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'amux-space-launcher-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, styles = {}
const receipt = { passed: false, captureOnly: true, visualReview: 'pending-independent-review',
  boundary: 'Current production Workbench, Launcher, rich inputs, theme and CSS with controlled preview API facts. No installed App or real CLI/Runtime claim.' }
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: sourceAliases },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    plugins: [{ name: 'source-bound-space-launcher', enforce: 'pre', transform(source, id) {
      const file = id.split('?')[0]
      if (!file.startsWith(join(repository, 'apps/desktop/src/renderer/src/'))) return
      const relative = file.slice(repository.length + 1)
      if (file.endsWith('.css')) styles[relative] = hash(source)
      else if (!id.includes('?')) sources[relative] = hash(source)
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) {
        if (file.startsWith(join(repository, 'apps/desktop/src/renderer/src/')) && file.endsWith('.css'))
          styles[file.slice(repository.length + 1)] = hash(await readFile(file))
      }
    } }], build: { outDir: join(temporaryRoot, 'renderer'), emptyOutDir: true } })
  for (const name of ['WorkspaceWorkbench', 'NewTabSurface', 'SurfaceState', 'LauncherMoteAction'])
    assert.ok(sources[`apps/desktop/src/renderer/src/components/${name}.tsx`], 'Actual compiled consumer: ' + name)
  for (const name of ['launcher', 'surface-state', 'workbench', 'tokens', 'base']) {
    const file = `apps/desktop/src/renderer/src/styles/${name}.css`
    assert.equal(styles[file], hash(await readFile(join(repository, file))), 'Actual imported stylesheet: ' + name)
  }
  const main = join(temporaryRoot, 'main.cjs')
  await writeFile(main, await readFile(join(fixture, 'main.cjs')))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  const result = await runProbeProcess(require('electron'), [main, join(temporaryRoot, 'renderer/index.html'), join(temporaryRoot, 'profile'), evidence],
    { cwd: repository, temporaryRoot, env, timeoutMs: 60000, onLine: line => process.stderr.write(line.slice(0, 300) + '\n') })
  const ui = JSON.parse(await readFile(join(evidence, 'ui-receipt.json'), 'utf8'))
  Object.assign(receipt, { sources, styles, ui, exitCode: result.exitCode })
  assert.equal(result.exitCode, 0, JSON.stringify(ui.failure))
  assert.equal(ui.passed, true)
  receipt.frames = await Promise.all(ui.frames.map(async file => ({ file, sha256: hash(await readFile(join(evidence, file))) })))
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(temporaryRoot, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure }))
}
