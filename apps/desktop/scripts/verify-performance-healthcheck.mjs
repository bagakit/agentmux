import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'

const repository = resolve(import.meta.dirname, '../../..'), desktop = join(repository, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const args = process.argv.slice(2)
assert.ok(args.every(arg => arg === '--with-restart'), 'Use verify-performance-healthcheck.mjs [--with-restart]')
const fixture = join(desktop, 'scripts/fixtures/performance-healthcheck')
const evidence = resolve(process.env.AGENTMUX_PERFORMANCE_HEALTHCHECK_EVIDENCE ??
  join(repository, '.local/state/performance-healthcheck-native', randomUUID()))
await mkdir(evidence, { recursive: true })
const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-performance-health-')))
const sha = value => createHash('sha256').update(value).digest('hex')
const dropdownRequire = createRequire(require.resolve('@radix-ui/react-dropdown-menu'))
const menuCjs = await realpath(dropdownRequire.resolve('@radix-ui/react-menu'))
const menuEsm = join(dirname(menuCjs), 'index.mjs')
const patchPath = 'patches/@radix-ui__react-menu@2.1.20.patch'
const patch = await readFile(join(repository, patchPath), 'utf8'), originalMenu = await readFile(menuEsm, 'utf8')

// Reverse the actual applied pnpm patch into an in-memory Rollup input. Never edit
// installed dependencies or write a broken candidate into the shared workspace.
function reverseMenuPatch(source, text) {
  const section = text.split(/^diff --git /m).find(part => part.startsWith('a/dist/index.mjs b/dist/index.mjs\n'))
  assert.ok(section, 'Actual ESM patch section is present')
  const hunks = section.split(/^@@[^\n]*\n/m).slice(1)
  assert.ok(hunks.length > 0)
  let result = source
  for (const hunk of hunks) {
    const rows = hunk.split('\n').filter(line => /^[ +\-]/.test(line))
    const before = rows.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n'
    const after = rows.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n'
    assert.equal(result.split(after).length - 1, 1, 'Actual patched dependency has one exact hunk')
    result = result.replace(after, before)
  }
  assert.notEqual(result, source)
  assert.ok(result.includes('const isUsingKeyboardRef = React.useRef(false)'))
  assert.ok(!result.includes('observeMenuKeyboardModality'))
  return result
}
const mutantMenu = reverseMenuPatch(originalMenu, patch)
const sourceAliases = [
  ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })),
  { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: join(repository, 'packages/client-ui/src/components/$1.tsx') },
  { find: '@agentmux/client-ui/platform', replacement: join(repository, 'packages/client-ui/src/platform.tsx') }
]
const expectedInputs = [
  'apps/desktop/scripts/fixtures/performance-healthcheck/entry.tsx',
  'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx',
  'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
  'apps/desktop/src/renderer/src/styles/agent.css',
  'packages/client-ui/src/components/InlineComposer.tsx',
  'packages/client-ui/src/platform.tsx'
]
const result = { schema: 'agentmux.performance-healthcheck-verification.v1', passed: false,
  evidence, privateRoot, sourceWritten: false, userAppOrRunTouched: false,
  qualifiedScope: 'native-shared-input-menu-and-xterm-boundary', restart: null, modes: [],
  limitations: ['The private shared-consumer fixture is not the complete Desktop App or a ctxmux Run.',
    'Chromium trusted input and composition are tested; physical OS IME is not.',
    'T-005 still needs its original Core-persisted App/workface restart proof and final independent review.',
    'The optional existing --pending-edit full-App restart is explicit because its own window presentation contract differs from this non-activating fixture.'] }
const inputRecords = []
async function runMode(mode) {
  const out = join(evidence, mode), renderer = join(out, 'renderer')
  const inputs = new Map(), dependencies = new Map()
  let menuCompiled = false
  await mkdir(out, { recursive: true })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    resolve: { alias: sourceAliases, dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-performance-healthcheck-source', enforce: 'pre', async load(id) {
      const file = id.split('?')[0]
      if (id.includes('?') || file.startsWith('\0')) return null
      if (file === menuEsm) {
        menuCompiled = true
        dependencies.set(relative(repository, file), sha(originalMenu))
        return mode === 'per-root-modality' ? mutantMenu : originalMenu
      }
      if (file.startsWith(repository + '/')) {
        const bytes = await readFile(file)
        const target = file.includes('/node_modules/') ? dependencies : inputs
        target.set(relative(repository, file), sha(bytes))
      }
      return null
    } }], build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false } })
  assert.equal(menuCompiled, true, 'The actual installed patched ESM Menu owner was compiled')
  for (const source of expectedInputs) assert.ok(inputs.has(source), 'Actual current-source UI consumer: ' + source)
  for (const [name, path] of Object.entries(radixOverlayAliases)) assert.ok(dependencies.has(relative(repository, path)),
    'Actual production overlay primitive owner was compiled: ' + name)
  for (const source of ['apps/desktop/scripts/verify-performance-healthcheck.mjs',
    'apps/desktop/scripts/fixtures/performance-healthcheck/main.cjs', 'apps/desktop/scripts/probe-process.mjs',
    'apps/desktop/scripts/radix-overlay-aliases.ts', 'apps/desktop/electron.vite.config.ts',
    'pnpm-workspace.yaml', 'pnpm-lock.yaml', patchPath]) inputs.set(source, sha(await readFile(join(repository, source))))
  dependencies.set(relative(repository, menuCjs), sha(await readFile(menuCjs)))
  const record = { mode, inputs: Object.fromEntries(inputs), dependencies: Object.fromEntries(dependencies),
    productionOverlayAliases: radixOverlayAliases,
    mutation: mode === 'per-root-modality' ? { owner: relative(repository, menuEsm), patch: patchPath,
      candidate: sha(originalMenu), mutated: sha(mutantMenu), method: 'Reverse actual pnpm patch hunks only in the isolated build input' } : null,
    electron: require('electron/package.json').version }
  inputRecords.push(record)
  await writeFile(join(out, 'inputs.json'), JSON.stringify(record, null, 2) + '\n')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let output = '', child
  try {
    child = await runProbeProcess(process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'),
      [join(fixture, 'main.cjs'), join(renderer, 'index.html'), join(privateRoot, mode), out, mode],
      { cwd: repository, env, timeoutMs: 60_000, onLine: line => { output += line + '\n' } })
    await stopProbeProcesses(child.originalPid, privateRoot)
    assert.deepEqual(await listProbeProcesses(child.originalPid, privateRoot), [])
    const native = JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8'))
    assert.equal(native.versions.electron, record.electron)
    result.modes.push({ mode, exitCode: child.exitCode, receipt: join(out, 'receipt.json'), cleanup: child, native })
    return { child, native }
  } catch (error) {
    child ??= error.probe
    throw error
  } finally {
    await writeFile(join(out, 'native.log'), output)
    if (child) await writeFile(join(out, 'cleanup.json'), JSON.stringify(child, null, 2) + '\n')
    if (child?.originalPid) await stopProbeProcesses(child.originalPid, privateRoot)
    await rm(renderer, { recursive: true, force: true })
  }
}
try {
  const candidate = await runMode('candidate')
  assert.equal(candidate.child.exitCode, 0, 'Candidate native proof passes: ' + candidate.native.error?.message)
  const mutant = await runMode('per-root-modality')
  assert.notEqual(mutant.child.exitCode, 0, 'Reversing the original shared modality patch must fail the same Native cost oracle')
  assert.equal(mutant.native.error?.code, 'ERR_ASSERTION')
  assert.equal(mutant.native.error?.message, 'Retained input cost grew with unrelated consumers')
  assert.equal(mutant.native.cases.length, 3, 'Mutant completes all fixed-load scales before semantic Assertion RED')
  for (const record of inputRecords) {
    for (const [file, digest] of Object.entries({ ...record.inputs, ...record.dependencies }))
      assert.equal(sha(await readFile(join(repository, file))), digest, 'Bound source/dependency unchanged: ' + file)
  }
  if (args.includes('--with-restart')) {
    const restartPath = join(evidence, 'workbench-restart.json')
    let output = ''
    const child = await runProbeProcess(process.execPath,
      [join(desktop, 'scripts/verify-workbench-persistence-restart.mjs'), '--pending-edit', '--inactive-window',
        '--probe-root=' + privateRoot, '--receipt-path=' + restartPath],
      { cwd: repository, env: process.env, timeoutMs: 360_000, onLine: line => { output += line + '\n' } })
    await writeFile(join(evidence, 'workbench-restart.log'), output)
    await stopProbeProcesses(child.originalPid, privateRoot)
    assert.equal(child.exitCode, 0, 'Actual original Core-persisted App restart passes')
    result.restart = { receipt: restartPath, cleanup: child }
  }
  result.passed = true
  console.log(JSON.stringify({ passed: true, evidence, qualifiedScope: result.qualifiedScope, restart: result.restart,
    candidate: candidate.native.cases.map(row => ({ scale: row.scale, taskDurationSeconds: row.taskDurationSeconds, costs: row.costs })),
    mutant: mutant.native.cases.map(row => ({ scale: row.scale, costs: row.costs })) }))
} catch (error) {
  result.error = { name: error.name, code: error.code, message: error.message, stack: error.stack }
  throw error
} finally {
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(result, null, 2) + '\n')
  if (result.passed && result.modes.every(mode => mode.cleanup.exitConfirmed)) await rm(privateRoot, { recursive: true, force: true })
}
