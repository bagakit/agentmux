import { aliases } from './fixtures/settings-resource-library/environment.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { runProbeProcess } from './probe-process.mjs'
import { executionUiAliases } from '../test/vitest.tool-execution-ui.config.mts'
const root = resolve(import.meta.dirname, '../../..'), fixture = join(import.meta.dirname, 'fixtures/execution-modes')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const args = process.argv.slice(2)
assert(args[0] === '--prepare' && args.length === 1 || args[0] === '--run' && args[1] && args.length <= 3 && (!args[2] || ['--first', '--restore', '--configuration-review'].includes(args[2])), 'Use --prepare, then --run EXACT_DIRECTORY [--first]')
const directory = args[0] === '--prepare' ? join(root, '.tmp/remote-execution-experience/capture-' + randomUUID()) : resolve(args[1])
assert(directory.startsWith(join(root, '.tmp/remote-execution-experience/capture-')))
assert(!process.env.EXECUTION_MODES_MUTANT && !process.env.TOOL_EXECUTION_UI_MUTANT, 'A capture uses unchanged production source')
const hash = v => createHash('sha256').update(v).digest('hex')
const sourceFile = join(directory, 'source.json')
const owners = ['apps/desktop/src/renderer/src/components/settings/RemoteExecutionSettingsPane.tsx', 'apps/desktop/src/renderer/src/components/settings/modules/remote-execution.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/App.tsx', ...['NewTabSurface', 'LauncherExecutionModes', 'LauncherExecutionPicker', 'LauncherEnvironment', 'WorkspaceWorkbench', 'AgentSessionComposer', 'SurfaceToolDock', 'WorkspaceFilesTool', 'WorkspaceGitTool'].map(x => `apps/desktop/src/renderer/src/components/${x}.tsx`),
  ...['use-composer-candidates.tsx', 'use-composer-attachments.ts', 'launcher-state.ts', 'workbench-persistence.ts', 'desktop-spatial-state.ts'].map(x => `apps/desktop/src/renderer/src/lib/${x}`),
  'packages/client-ui/src/lib/composer-semantic-reference.ts',
  'apps/desktop/src/renderer/src/styles/launcher.css', 'apps/desktop/scripts/fixtures/execution-modes/entry.tsx']
const boundary = 'Production WorkspaceWorkbench → NewTabSurface → Store/Composer/components/CSS and real Core durable spatial storage through private Electron IPC. Machine/configuration/Session/API facts are controlled external inputs. No SSH, native-Agent execution, physical OS interaction or user App claim.'
if (args[0] === '--prepare') {
  await mkdir(directory, { recursive: true })
  const sources = {}, css = new Set()
  const bind = async (file, compiledInput) => {
    if (!file.startsWith(root + '/') || file.includes('/node_modules/') || file.includes('/.tmp/') || file.includes('?')) return
    const key = relative(root, file), digest = hash(await readFile(file))
    if (owners.includes(key)) {
      if (compiledInput !== undefined) assert.equal(hash(compiledInput), digest, 'The actual owning input is compiled unchanged: ' + key)
      if (sources[key] !== undefined) assert.equal(sources[key], digest, 'The owner changed while preparing: ' + key)
    }
    sources[key] = digest
  }
  const { build } = await import(pathToFileURL(require.resolve('vite')))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: [...aliases, ...executionUiAliases] },
    worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'execution-modes-source-capture', enforce: 'pre', async transform(code, id) { if (/\.[cm]?[jt]sx?$/u.test(id)) await bind(id, code) }, async generateBundle() { for (const file of this.getWatchFiles()) await bind(file) } }],
    css: { postcss: { plugins: [{ postcssPlugin: 'execution-modes-css-inputs', Once(tree) { tree.walk(node => { const file = node.source?.input?.file; if (file?.startsWith(root + '/') && !file.includes('/node_modules/')) { css.add(file); const key = relative(root, file), digest = hash(node.source.input.css); if (owners.includes(key) && sources[key] !== undefined) assert.equal(sources[key], digest, 'The actual CSS owner changed during compilation: ' + key); sources[key] = digest } }) } }] } },
    build: { target: 'esnext', minify: false, outDir: join(directory, 'compiled'), emptyOutDir: true, chunkSizeWarningLimit: 20000 } })
  for (const file of css) await bind(file)
  for (const file of [import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'preload.cjs'), join(fixture, 'index.html')]) await bind(file)
  for (const file of owners) assert(sources[file], 'The product owner must be compiled: ' + file)
  assert(css.size > 20, 'Complete production CSS cascade is consumed')
  await writeFile(sourceFile, JSON.stringify({ candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources, owners, boundary, css: [...css].map(x => relative(root, x)) }, null, 2))
  console.log(JSON.stringify({ prepared: true, directory, sourceFile }))
} else {
  const original = JSON.parse(await readFile(sourceFile, 'utf8'))
  const styleInputFile = process.env.EXECUTION_MODES_STYLE_INPUTS
  const styleInput = styleInputFile ? JSON.parse(await readFile(styleInputFile, 'utf8')) : null
  if (styleInput) assert.equal(hash(await readFile(styleInput.stylesheet)), styleInput.stylesheetSha256, 'The exact production CSS artifact is retained')
  const qualifiedSources = { ...original.sources, ...(styleInput?.sources ?? {}) }
  for (const file of owners) assert.equal(hash(await readFile(join(root, file))), qualifiedSources[file], 'Owning source changed; prepare the precise new candidate: ' + file)
  const first = args[2] === '--first', restoreOnly = args[2] === '--restore', configurationOnly = args[2] === '--configuration-review', processes = []
  const restoreSource = process.env.EXECUTION_MODES_RESTORE_SOURCE ? resolve(process.env.EXECUTION_MODES_RESTORE_SOURCE) : directory
  assert(restoreSource === directory || restoreOnly, 'A retained profile is used only for the bounded restore phase')
  assert(restoreSource.startsWith(join(root, '.tmp/remote-execution-experience/capture-')), 'Restore must use an exact retained private capture')
  const profile = join(restoreOnly ? restoreSource : directory, 'private-profile'), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  await mkdir(profile, { recursive: true })
  const priorJourney = restoreOnly ? JSON.parse(await readFile(join(restoreSource, 'journey.json'), 'utf8')) : null
  if (restoreOnly) assert(priorJourney.passed && priorJourney.frames.length === 14, 'Restore consumes an already completed native journey and its original profile')
  const restartExpected = join(restoreSource, 'restart-expected.json')
  const reusedJourney = restoreOnly ? { receipt: join(restoreSource, 'journey.json'), sha256: hash(await readFile(join(restoreSource, 'journey.json'))), driver: join(restoreSource, 'driver-journey.cjs'), driverSha256: hash(await readFile(join(restoreSource, 'driver-journey.cjs'))), expected: restartExpected, expectedSha256: hash(await readFile(restartExpected)), profile, source: join(restoreSource, 'source.json'), sourceSha256: hash(await readFile(join(restoreSource, 'source.json'))) } : null
  for (const phase of first ? ['first'] : configurationOnly ? ['configuration-review'] : restoreOnly ? ['restore'] : ['journey', 'restore']) {
    const process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(directory, 'compiled/index.html'), profile, directory, phase, join(root, 'packages/core/dist/spatial-state.js'), styleInput?.stylesheet ?? '', restartExpected],
      { cwd: root, env, temporaryRoot: profile, timeoutMs: 120000, onLine: line => { if (line.startsWith('{"frame":')) console.log(line) } })
    processes.push(process)
    const capture = JSON.parse(await readFile(join(directory, phase + '.json'), 'utf8'))
    assert.equal(process.exitCode, 0, capture.failure?.message ?? process.stderr)
    assert.equal(capture.passed, true, capture.failure?.message)
  }
  for (const file of owners) assert.equal(hash(await readFile(join(root, file))), qualifiedSources[file], 'Captured owner changed: ' + file)
  await writeFile(join(directory, first ? 'first-receipt.json' : configurationOnly ? 'configuration-receipt.json' : restoreSource !== directory ? 'restore-receipt.json' : 'receipt.json'), JSON.stringify({ passed: true, first, configurationOnly, restoreOnly, reusedJourney, captureOnly: true, drivers: Object.fromEntries(await Promise.all([import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'preload.cjs')].map(async file => [relative(root, file), hash(await readFile(file))]))), independentVisualReview: 'not-performed', qualifiedOwners: owners, qualifiedSources, styleInput: styleInputFile ? { path: styleInputFile, sha256: hash(await readFile(styleInputFile)), boundary: 'Original App JavaScript snapshot with the exact newly compiled entire production CSS cascade' } : null, original, processes, boundary }, null, 2))
  console.log(JSON.stringify({ passed: true, directory, independentVisualReview: 'not-performed', boundary }))
}
