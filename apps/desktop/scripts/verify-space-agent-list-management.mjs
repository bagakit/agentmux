import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const captureOnly = process.argv.length === 3 && process.argv[2] === '--capture-only'
assert.ok(process.argv.length === 2 || captureOnly, 'Use no arguments or --capture-only')
const evidence = join(root, '.tmp/space-agent-list-management', 'attempt-' + crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const component = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const row = 'apps/desktop/src/renderer/src/components/WorkspaceAgentRow.tsx'
const close = 'apps/desktop/src/renderer/src/components/WorkspaceAgentSelection.tsx'
const test = 'apps/desktop/test/space-agent-list-management.test.tsx'
const sources = [component, row, close, 'apps/desktop/src/renderer/src/lib/workspace-agent-order.ts',
  'apps/desktop/src/renderer/src/lib/focus-context.ts',
  'apps/desktop/src/renderer/src/components/FocusContextRow.tsx',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs']
const receipt = { schema: 'agentmux.space-agent-list-management.v1', passed: false, capturedPass: false,
  independentAestheticReview: 'pending full-image review', actualUserRunControlled: false,
  captureOnly, phases: [], frames: [], transformations: [],
  boundary: 'Compiled production SurfaceToolDock → WorkspaceAgentsTool → WorkspaceAgentRow → FocusContextRow, original Store preference and existing persistence, real Electron/CDP pointer and keyboard input, shared Focus menus and board. Typed presentation Session/control I/O only; Native PTY and Monaco paint isolated. Two actual private Electron PIDs share one profile and restore the original manual order and split workface. Public order tests separately invoke the actual compiled CLI, RPC and Store owner. No user Run, actual Core Stop, Agent message delivery, installation or whole-product claim.' }
let privateRoot
const inputs = new Map(), logs = []
try {
  if (!captureOnly) {
    const tests = ['apps/desktop/test/workspace-agent-order-control.test.tsx', 'packages/core/test/workspace-agent-order-cli.test.ts']
    const report = join(evidence, 'public-order-tests.json')
    const args = ['exec', 'vitest', 'run', ...tests, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
    const execution = await new Promise((yes, no) => {
      const child = spawn('pnpm', args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.on('error', no); child.on('close', (exitCode, signal) => yes({ exitCode, signal, output }))
    })
    await writeFile(join(evidence, 'public-order-tests.log'), execution.output)
    receipt.publicOrder = { tests, command: ['pnpm', ...args], exitCode: execution.exitCode, signal: execution.signal,
      report: 'public-order-tests.json', log: 'public-order-tests.log' }
    assert.equal(execution.exitCode, 0, execution.output); assert.equal(execution.signal, null)
    const results = JSON.parse(await readFile(report, 'utf8'))
    assert.equal(results.success, true); assert.equal(results.numFailedTests, 0)
    assert.ok(results.numTotalTests >= 8, 'Nonempty original public order regression set')
    assert.equal(results.numPassedTests, results.numTotalTests); assert.equal(results.numPendingTests, 0)
    assert.equal(results.testResults.length, tests.length, 'Both actual public consumers executed')
    assert.ok(results.testResults.every(file => file.assertionResults.length > 0 && file.assertionResults.every(test => test.status === 'passed')))
    receipt.publicOrder.passedTests = results.numPassedTests
    const mutations = [
      { label: 'activity-must-not-reorder-list', file: component,
        before: 'orderedWorkspaceAgents(scoped, manualOrder)',
        after: '[...scoped].sort((a, b) => b.updatedAt - a.updatedAt)' },
      { label: 'space-must-consume-real-focus-card', file: row,
        before: '<FocusContextRow context={context} identity={identity} goalLinks={goalLinks} selected={selected} onSelect={onOpen} />',
        after: '<div data-session-id={context.id}>{context.name}</div>' },
      { label: 'select-visible-must-not-select-hidden', file: component,
        before: '...visible.map(workspaceAgentOrderKey)]', after: '...contexts.map(workspaceAgentOrderKey)]' },
      { label: 'bulk-copy-must-use-original-agent-link', file: component,
        before: 'formatSessionAddress(context.control!.agentSessionId)', after: 'context.runId' },
      { label: 'changed-run-must-not-receive-stale-stop', file: close,
        before: 'current.control.run.runId !== control.run.runId', after: 'false' },
      { label: 'bulk-stop-must-send-exact-reviewed-control', file: close,
        before: 'await api.sessions.stop(control)', after: 'await api.sessions.stop({ ...control, run: { runId: "different-unreviewed-run" } })' }
    ]
    await verifyRendererSourceMutations({ name: 'renderer-mutations', tests: [test], sources, mutations, evidenceRoot: evidence })
    receipt.mutations = process.env.AGENTMUX_MUTATION_RECEIPTS
      ? { passed: true, exactReuseValidated: true, evidence: JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) }
      : JSON.parse(await readFile(join(evidence, 'renderer-mutations/receipt.json'), 'utf8'))
  }
  privateRoot = await mkdtemp(join(tmpdir(), 'amux-space-agent-list-'))
  const fixture = join(desktop, 'scripts/fixtures/space-agent-list-management')
  const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const observe = { name: 'actual-space-agent-list-inputs', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source))
      const component = path.slice(path.lastIndexOf('/') + 1)
      if (['TerminalView.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx', 'FileSurfaceView.tsx', 'FileSourceEditor.tsx', 'PdfContent.tsx', 'ExcalidrawFilePreview.tsx', 'GitDiffCanvas.tsx', 'ToolkitScriptEditor.tsx'].includes(component)) {
        const code = `export function ${component.slice(0, -4)}(){return null}`
        receipt.transformations.push({ path: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code),
          isolated: 'Unrelated Native PTY, editor and file-preview paint only; original Agent list, Store, preference, shared Focus card/menu/board and confirmation untouched' })
        return { contents: code, loader: 'js' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); return { contents: source, loader: 'css' } })
    builder.onLoad({ filter: /\.(png|svg|woff2?|ttf)$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path); inputs.set(path, hash(source)); return { contents: source, loader: 'file' } })
  } }
  for (const path of [join(fixture, 'main.cjs'), new URL(import.meta.url).pathname]) inputs.set(path, hash(await readFile(path)))
  const out = join(privateRoot, 'out'); await mkdir(out)
  const built = await build({ entryPoints: [join(fixture, 'entry.tsx')], outfile: join(out, 'app.js'), bundle: true,
    platform: 'browser', conditions: ['browser', 'production'], format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = built.metafile
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  for (const suffix of ['SurfaceToolDock.tsx', 'WorkspaceAgentRow.tsx', 'WorkspaceAgentSelection.tsx', 'FocusContextRow.tsx', 'FocusContextMenu.tsx', 'workspace-agent-order.ts', 'store.ts', 'ConfirmationDialog.tsx', 'GlobalFocusSurface.tsx']) {
    assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Actual nonempty production module: ' + suffix)
  }
  const html = join(out, 'index.html')
  await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="root"></div><div data-overlay-host></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'profile'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }
  delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const processReceipt = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence, phase], {
      cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(phase + ': ' + line) })
    const actual = await readFile(join(evidence, phase + '.json'), 'utf8').then(JSON.parse)
    receipt.phases.push({ process: processReceipt, actual })
    assert.equal(processReceipt.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  }
  assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid, 'Two real private process identities')
  assert.equal(receipt.phases[0].actual.seedCount, 1); assert.equal(receipt.phases[1].actual.seedCount, 0)
  receipt.frames = await Promise.all(receipt.phases.flatMap(item => item.actual.frames).map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.image))) })))
  assert.deepEqual(receipt.frames.map(frame => frame.image).sort(), ['default-384.png', 'shared-menu-384.png', 'filtered-multiselect-384.png', 'bulk-close-confirmation.png', 'partial-close-result-384.png', 'narrow-288.png', 'shared-focus-1200.png', 'shared-focus-360.png', 'restored-order-384.png'].sort())
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Source remained equal to actual compiled inputs during capture')
  receipt.capturedPass = true
  receipt.passed = captureOnly ? false : receipt.mutations.passed
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  if (privateRoot) {
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { remaining, removed: false, evidencePreserved: true }
    if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(evidence, 'review.md'), '# Space Agent 列表完整截图\n\n独立审美评审待完成；采图与测试不代签。\n\n' + receipt.frames.map(frame => `- [${frame.image}](${frame.image}) — ${frame.purpose}`).join('\n') + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, independentAestheticReview: 'pending' }))
}
