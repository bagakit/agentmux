import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { executionUiAliases } from '../test/vitest.tool-execution-ui.config.mts'
import { productFiles } from './verify-remote-execution-settings.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const fixture = join(import.meta.dirname, 'fixtures/remote-execution-settings')
const args = process.argv.slice(2)
assert(args.length === 1 && args[0] === '--prepare' || (args.length === 2 || args.length === 3 && ['--first', '--guidance'].includes(args[2])) && args[0] === '--run', 'Use --prepare, then --run the exact prepared directory')
assert(!process.env.TOOL_EXECUTION_UI_MUTANT, 'A visual candidate cannot inherit a test mutation')
const outputRoot = join(repository, '.tmp/remote-execution-settings')
const directory = args[0] === '--run' ? resolve(args[1]) : join(outputRoot, 'capture-' + randomUUID())
assert(directory.startsWith(outputRoot + '/capture-'), 'Only this task’s explicit capture directory is eligible')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
// This finite entry-owner set qualifies the rendered scenario against current source.
// Every other loaded input remains identified as the actual compiled snapshot.
const rendererRoot = 'apps/desktop/src/renderer/src/'
const presentationOwners = new Set([
  ...productFiles,
  'apps/desktop/scripts/fixtures/remote-execution-settings/entry.tsx',
  'apps/desktop/scripts/fixtures/remote-execution-settings/index.html',
  'apps/desktop/src/shared/contracts.ts', 'packages/layout/src/index.ts',
  ...[
    'components/SettingsNavigation.tsx', 'components/DesktopClientUiProvider.tsx',
    'components/WorkspaceWorkbench.tsx', 'components/NewTabSurface.tsx',
    'components/SessionPane.tsx', 'components/AgentAvatar.tsx', 'components/AgentExecutorPicker.tsx',
    'components/ServiceWindowNotice.tsx', 'components/ServiceNoticeDisclosure.tsx', 'components/WindowOverlayHost.tsx',
    'components/WorkbenchSplitHandle.tsx', 'components/WorkbenchTabStrip.tsx', 'components/WorkbenchEmptyState.tsx',
    'components/settings/MoteDirectorySettingsPane.tsx', 'components/settings/MoteOriginStory.tsx',
    'components/settings/modules/mote.tsx',
    'lib/api.ts', 'lib/space-agent-control.ts', 'lib/workbench-tabs.ts', 'lib/workbench-projection.ts',
    'lib/workbench-persistence.ts', 'lib/workbench-session-subscriptions.ts', 'lib/workbench-tab-actions.ts',
    ...['index', 'tokens', 'base', 'settings-materials', 'settings-workflows', 'settings-theme',
      'settings-overview', 'settings-search', 'settings-resource-library', 'settings-mote', 'mote-origin-story',
      'mote-directory', 'workbench', 'workbench-topology', 'workbench-windows', 'launcher', 'surface-state',
      'surfaces', 'service-notice'].map(name => 'styles/' + name + '.css'),
  ].map(file => rendererRoot + file),
  ...['index', 'icons', 'runtime', 'schema', 'catalog', 'terminal-palette', 'terminal-palettes',
    'icon-catalog-metadata', 'icon-presentation', 'icon-sprite', 'icon-authored', 'icon-assets',
    'icon-catalog', 'builtin-retro', 'builtin-fallout', 'css-variables', 'icon-glyphs']
    .map(name => 'packages/client-ui/src/theme/' + name + (name === 'icons' ? '.tsx' : '.ts')),
  ...['palette', 'theme-defaults', 'overlays', 'theme-transition', 'semantic-icons', 'native-controls',
    'mote-identity', 'interaction', 'inline-rename-field', 'composer', 'composer-choice-reading', 'input-history',
    'workflow-status', 'conversation-avatar', 'agent-avatar-face'].map(name => 'packages/client-ui/src/styles/' + name + '.css'),
])
const ownsPresentation = file => presentationOwners.has(file)
const driverFiles = [import.meta.filename, join(fixture, 'main.cjs'), join(import.meta.dirname, 'probe-process.mjs')]
async function captureDriverHashes() {
  return Object.fromEntries(await Promise.all(driverFiles.map(async file => [relative(repository, file), hash(await readFile(file))])))
}
const first = args[2] === '--first'
const mode = first ? 'first' : args[2] === '--guidance' ? 'guidance' : 'complete'
const sourcePath = join(directory, 'source.json')
const boundary = 'Production SettingsPanel, Remote execution and Mote Settings, WorkspaceWorkbench, Launcher, Store and CSS in private Electron. External Session/binding/API facts are controlled typed preview inputs. No Main, SSH, model, native execution, user App or physical input claim.'

if (args[0] === '--prepare') {
  await mkdir(directory, { recursive: true })
  const sources = {}, consumed = {}, currentInputDrift = {}, cssSources = new Set()
  const bind = async file => {
    if (!file.startsWith(repository + '/') || file.includes('/node_modules/') || file.includes('/.tmp/') || file.includes('?')) return
    const key = relative(repository, file), digest = hash(await readFile(file))
    if (sources[key] !== undefined && sources[key] !== digest) {
      assert(!ownsPresentation(key), 'Owning presentation changed while building: ' + key)
      currentInputDrift[key] = { compiledInputSha256: sources[key], currentSha256: digest, qualification: 'not-current-source-qualified' }
    } else sources[key] = digest
  }
  const { build } = await import(pathToFileURL(require.resolve('vite')))
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    resolve: { alias: executionUiAliases }, worker: { format: 'es' }, esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bound-remote-settings-capture', enforce: 'pre', async transform(code, id) {
      if (id.includes('?') || !id.startsWith(repository + '/') || id.includes('/node_modules/')) return
      if (id.endsWith('/assets/settings/remote-execution.png')) {
        await bind(id)
        // Vite loads an image as an asset module; its JavaScript is not PNG bytes.
        consumed[relative(repository, id)] = hash(code)
        return
      }
      if (!/\.[cm]?[jt]sx?$/u.test(id)) return
      await bind(id); consumed[relative(repository, id)] = hash(code)
      const key = relative(repository, id)
      if (ownsPresentation(key)) assert.equal(consumed[key], sources[key], 'Actual unmodified presentation source is compiled')
      else if (consumed[key] !== sources[key]) {
        currentInputDrift[key] = { compiledInputSha256: consumed[key], currentSha256: sources[key], qualification: 'not-current-source-qualified' }
        sources[key] = consumed[key]
      }
    }, async generateBundle() { for (const file of this.getWatchFiles()) await bind(file) } }],
    css: { postcss: { plugins: [{ postcssPlugin: 'bound-remote-settings-css', Once(tree) {
      tree.walk(node => { const file = node.source?.input?.file; if (file?.startsWith(repository + '/') && !file.includes('/node_modules/')) cssSources.add(file) })
    } }] } },
    build: { target: 'esnext', minify: false, outDir: join(directory, 'compiled'), emptyOutDir: true, chunkSizeWarningLimit: 20000 } })
  for (const file of cssSources) await bind(file)
  for (const file of [import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'entry.tsx'), join(fixture, 'index.html'), join(import.meta.dirname, 'probe-process.mjs')]) await bind(file)
  for (const file of ['components/SettingsPanel.tsx', 'components/settings/RemoteExecutionSettingsPane.tsx',
    'components/settings/MoteDirectorySettingsPane.tsx', 'components/WorkspaceWorkbench.tsx', 'components/NewTabSurface.tsx', 'store.ts', 'assets/settings/remote-execution.png']) {
    assert(sources['apps/desktop/src/renderer/src/' + file], 'Real product consumer was compiled: ' + file)
  }
  assert(cssSources.size > 20, 'Full production CSS cascade must be consumed')
  for (const file of Object.keys(sources)) await bind(join(repository, file))
  await writeFile(sourcePath, JSON.stringify({ schema: 'agentmux.remote-execution-settings.capture-inputs.v1',
    candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    sources, consumed, currentInputDrift, cssSources: [...cssSources].map(file => relative(repository, file)), boundary }, null, 2))
  console.log(JSON.stringify({ prepared: true, directory, source: sourcePath, next: ['node', import.meta.filename, '--run', directory] }))
} else {
  const original = JSON.parse(await readFile(sourcePath, 'utf8'))
  const currentInputDrift = { ...original.currentInputDrift }
  async function checkInputs() {
    for (const [file, digest] of Object.entries(original.sources)) {
      const current = hash(await readFile(join(repository, file)))
      if (current === digest) continue
      assert(!ownsPresentation(file), 'Prepared owning source changed; capture the new candidate: ' + file)
      currentInputDrift[file] = { compiledInputSha256: digest, currentSha256: current, qualification: 'not-current-source-qualified' }
    }
  }
  for (const file of productFiles) assert(original.sources[file], 'All owning product inputs must be compiled: ' + file)
  await checkInputs()
  const captureDrivers = await captureDriverHashes()
  const compiled = {}
  async function bindOutputs(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name)
      if (entry.isDirectory()) await bindOutputs(file)
      else compiled[relative(directory, file)] = hash(await readFile(file))
    }
  }
  await bindOutputs(join(directory, 'compiled'))
  assert(Object.keys(compiled).some(file => file.endsWith('.js')) && Object.keys(compiled).some(file => file.endsWith('.css')))
  const privateRoot = join(directory, 'private-profile')
  await mkdir(privateRoot, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  const logs = [], receipt = { ...original, schema: 'agentmux.remote-execution-settings.capture.v1', passed: false, captureOnly: true,
    independentVisualReview: 'not-performed', boundary, source: { path: sourcePath, sha256: hash(await readFile(sourcePath)) }, compiled, currentInputDrift,
    qualificationScope: 'compiled-snapshot-with-current-owning-inputs', currentWorkingTreeQualified: false,
    owningInputs: [...presentationOwners].filter(file => original.sources[file]), captureDrivers }
  try {
    receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(directory, 'compiled/index.html'), privateRoot, directory, mode],
      { cwd: repository, env, temporaryRoot: privateRoot, timeoutMs: 120000, onLine: line => { logs.push(line); if (line.startsWith('{\"frame\":')) console.log(line) } })
    receipt.capture = JSON.parse(await readFile(join(directory, first ? 'first-capture.json' : 'capture.json'), 'utf8'))
    assert.equal(receipt.process.exitCode, 0, receipt.capture.failure?.message)
    assert.equal(receipt.process.timedOut, false)
    assert.equal(receipt.capture.passed, true)
    assert.equal(receipt.capture.frames.length, first ? 1 : mode === 'guidance' ? 9 : 17, 'The selected scenario must produce its complete frame set')
    for (const [file, digest] of Object.entries(compiled)) assert.equal(hash(await readFile(join(directory, file))), digest, 'Captured assets changed')
    await checkInputs()
    assert.deepEqual(await captureDriverHashes(), captureDrivers, 'Actual capture drivers stay fixed through execution')
    for (const frame of receipt.capture.frames) assert.equal(hash(await readFile(join(directory, frame.file))), frame.sha256)
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot) }
    if (receipt.cleanup.remaining.length) { receipt.passed = false; process.exitCode = 1 }
    else { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateProfileRemoved = true }
    await writeFile(join(directory, first ? 'first-native.log' : 'native.log'), logs.join('\n'))
    await writeFile(join(directory, first ? 'first-receipt.json' : 'receipt.json'), JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ passed: receipt.passed, captureOnly: true, independentVisualReview: 'not-performed', directory, receipt: join(directory, first ? 'first-receipt.json' : 'receipt.json') }))
  }
}
