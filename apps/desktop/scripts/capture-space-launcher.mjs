import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { sourceAliases } from './fixtures/launcher-launchpad/vitest.owning.config.mts'
import { runProbeProcess } from './probe-process.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'

const repository = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/space-launcher')
const evidence = resolve(process.argv[2] ?? join(repository, '.tmp/space-launcher'))
const executionRelation = process.argv.includes('--execution-relation')
const regionWorkflow = process.argv.includes('--region-workflow')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const { build } = await import(require.resolve('vite'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'amux-space-launcher-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = {}, styles = {}
// Compile isolated counterexamples without ever editing the shared working tree.
const mutation = process.env.LAUNCHER_AFFORDANCE_MUTATION
const mutations = {
  overflow: ['components/AgentExecutorPicker.tsx', 'const after = catalog.scrollTop + catalog.clientHeight < catalog.scrollHeight - 1', 'const after = false'],
  position: null,
  'tooltip-width': ['components/agent-work-mode.css', 'min-width: 0; max-width: 100%; gap: 10px;', 'min-width: 720px; max-width: none; gap: 10px;'],
  'region-boundary': ['components/LauncherAgentDevice.tsx', "anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? ('clippingAncestors' as const)", "'clippingAncestors' as const"],
  'dialog-root-scroll': ['components/agent-work-mode.css', 'display: flex; flex-direction: column; width: min(400px', 'display: block; width: min(400px'],
  'dialog-body-height': ['components/agent-work-mode.css', 'min-height: 0; overflow-y: auto;', 'min-height: 240px; overflow-y: visible;'],
  'dialog-footer-order': ['components/AgentWorkModeSetup.tsx', "onChooseCustom={anchored ? () => setSourceSelection(false) : undefined} onOpenHost={props.onOpenHost ?? (settings ? id => settings.openHost(id) : undefined)} />\n    {!anchored ? <button className=\"agent-work-text-action\"", "onChooseCustom={undefined} onOpenHost={props.onOpenHost ?? (settings ? id => settings.openHost(id) : undefined)} />\n    {anchored ? <button className=\"small-button agent-work-setup__custom-startup\""],
  'dialog-path-disclosure': ['components/AgentWorkProjectAnchor.tsx', '<code className="agent-work-project-anchor__path">{project.path}</code>', '<code className="agent-work-project-anchor__path">{project.path.slice(0, 24)}</code>'],
  'dialog-menu-boundary': ['components/LauncherAgentDevice.tsx', "menuBoundary={anchor?.closest<HTMLElement>('[data-workbench-region-id]') ?? null}", 'menuBoundary={null}'],
  'dialog-device-tail': ['components/SourceAgentTargetSetup.tsx', "...(choices?.hosts.filter(host => host.kind !== 'local').map(host =>", "...(choices?.hosts.filter(host => host.kind !== 'local').slice(0, -1).map(host =>"],
  'dialog-device-scroll': ['packages/client-ui/src/components/SelectionField.tsx', 'className="selection-field__results" role={hasDialog', 'className="selection-field__results" style={{ overflow: \'hidden\' }} role={hasDialog'],
  'footer-nowrap': null,
  'pointer-focus-tooltip': ['components/WorkbenchNameTooltip.tsx', "const show = () => { if (parent.matches(':focus-visible')) current.current.showFor(parent) }", 'const show = () => { current.current.showFor(parent) }'],
  'tooltip-anchor-overlap': ['components/WorkbenchNameTooltip.tsx', 'shift({ padding: 8 }), size({ padding: 8,', 'shift({ padding: 8, crossAxis: true }), size({ padding: 8,']
}
assert(!mutation || Object.hasOwn(mutations, mutation), 'Unknown Launcher affordance mutation')
const mutationHits = []
const receipt = { passed: false, captureOnly: true, visualReview: 'pending-independent-review',
  mutation: mutation ?? null, mutationHits,
  boundary: 'Current production Workbench, Launcher, rich inputs, theme and CSS with controlled preview API facts. No installed App or real CLI/Runtime claim.' }
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: {
    alias: [...Object.entries(radixOverlayAliases).map(([find,replacement]) => ({find,replacement})), ...sourceAliases], dedupe: ['react','react-dom'] },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    css: { postcss: { plugins: ['position', 'footer-nowrap'].includes(mutation) ? [{ postcssPlugin: 'launcher-position-counterexample', Once(css) {
      css.walkRules(mutation === 'position' ? '.launcher-mote' : '.launch-surface__footer', rule => {
        const declaration = rule.nodes.find(node => node.prop === (mutation === 'position' ? 'margin-inline-end' : 'flex-wrap'))
        if (!declaration) return
        assert.equal(declaration.value, mutation === 'position' ? 'auto' : 'wrap', 'Mutate the actual action layout declaration')
        const original = hash(rule.source.input.css)
        declaration.value = mutation === 'position' ? '0' : 'nowrap'
        mutationHits.push({ file: 'apps/desktop/src/renderer/src/styles/launcher.css', original, compiledRule: hash(rule.toString()) })
      })
    } }] : [] } },
    plugins: [{ name: 'source-bound-space-launcher', enforce: 'pre', transform(source, id) {
      const file = id.split('?')[0]
      const workspaceSource = file.startsWith(join(repository, 'apps/desktop/src/renderer/src/'))
        || file.startsWith(join(repository, 'packages/')) || file.startsWith(join(repository, 'apps/host/'))
      if (!workspaceSource || file.includes('/node_modules/')) return
      const relative = file.slice(repository.length + 1)
      if (file.endsWith('.css')) styles[relative] = hash(source)
      else if (!id.includes('?')) sources[relative] = hash(source)
      const target = mutations[mutation]?.[0]
      const targetPath = target?.startsWith('packages/') ? target : target && 'apps/desktop/src/renderer/src/' + target
      if (targetPath && file === join(repository, targetPath)) {
        const [, from, to] = mutations[mutation]
        assert.equal(source.split(from).length, 2, 'Mutation must replace exactly one actual implementation')
        const code = source.replace(from, to)
        mutationHits.push({ file: relative, original: hash(source), compiled: hash(code) })
        return { code, map: null }
      }
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) {
        if (file.startsWith(join(repository, 'apps/desktop/src/renderer/src/')) && file.endsWith('.css'))
          styles[file.slice(repository.length + 1)] = hash(await readFile(file))
      }
    } }], build: { outDir: join(temporaryRoot, 'renderer'), emptyOutDir: true } })
  if (mutation) assert.equal(mutationHits.length, 1, 'The actual mutated product module must be compiled')
  for (const name of ['core', 'layout'])
    assert.ok(Object.keys(sources).some(file => file.startsWith(`packages/${name}/src/`)), `Actual aliased ${name} workspace sources are bound`)
  for (const name of ['WorkspaceWorkbench', 'NewTabSurface', 'SurfaceState', 'LauncherMoteAction', 'AgentExecutorPicker'])
    assert.ok(sources[`apps/desktop/src/renderer/src/components/${name}.tsx`], 'Actual compiled consumer: ' + name)
  for (const name of ['launcher', 'surface-state', 'workbench', 'tokens', 'base']) {
    const file = `apps/desktop/src/renderer/src/styles/${name}.css`
    assert.equal(styles[file], hash(await readFile(join(repository, file))), 'Actual imported stylesheet: ' + name)
  }
  const main = join(temporaryRoot, 'main.cjs')
  await writeFile(main, await readFile(join(fixture, 'main.cjs')))
  await writeFile(join(temporaryRoot, 'execution-relation.cjs'), await readFile(join(fixture, 'execution-relation.cjs')))
  await writeFile(join(temporaryRoot, 'region-workflow.cjs'), await readFile(join(fixture, 'region-workflow.cjs')))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  const result = await runProbeProcess(require('electron'), [main, join(temporaryRoot, 'renderer/index.html'), join(temporaryRoot, 'profile'), evidence, executionRelation ? 'execution-relation' : regionWorkflow ? 'region-workflow' : 'default'],
    { cwd: repository, temporaryRoot, env, timeoutMs: 60000, onLine: line => process.stderr.write(line.slice(0, 300) + '\n') })
  const ui = JSON.parse(await readFile(join(evidence, 'ui-receipt.json'), 'utf8'))
  Object.assign(receipt, { sources, styles, ui, exitCode: result.exitCode })
  assert.equal(result.exitCode, 0, JSON.stringify(ui.failure))
  assert.equal(ui.passed, true)
  receipt.frames = await Promise.all(ui.frames.map(async file => ({ file, sha256: hash(await readFile(join(evidence, file))) })))
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message }; process.exitCode = 1 }
finally {
  try { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
  finally { await rm(temporaryRoot, { recursive: true, force: true }) }
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure }))
}
