import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'
import { mutations } from './fixtures/message-tool-workspace/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/message-tool-workspace')
const evidence = join(root, '.tmp/message-tool-workspace', 'attempt-' + globalThis.crypto.randomUUID())
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-message-workspace-'))
const require = createRequire(import.meta.url), exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const selectedMutation = process.argv.includes('--mutation') ? process.argv[process.argv.indexOf('--mutation') + 1] : undefined
assert.ok(!selectedMutation || mutations.some(item => item.name === selectedMutation), 'The named mutation exists')
const result = { schema: 'agentmux.message-workspace-proof.v1', passed: false, userRunTouched: false, productionWritten: false,
  mode: process.argv.includes('--mutations') ? 'mutations' : 'renderer', aestheticReview: 'not-performed', cleanup: {} }
await mkdir(evidence, { recursive: true })

async function mounted(label, mutation) {
  const directory = join(evidence, label)
  const env = { ...process.env, AGENTMUX_MESSAGE_WORKSPACE_EVIDENCE: relative(root, directory) }
  if (mutation) env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION = mutation
  else delete env.AGENTMUX_MESSAGE_WORKSPACE_MUTATION
  let code = 0, output = ''
  try {
    const run = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
      'apps/desktop/scripts/fixtures/message-tool-workspace/vitest.config.mts', 'apps/desktop/test/message-tool-workspace.test.tsx'],
    { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    output = run.stdout + run.stderr
  } catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'test.log'), output)
  const discovery = JSON.parse(await readFile(join(directory, 'discovery.json'), 'utf8'))
  const tests = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'))
  assert.equal(discovery.requested.length, 1); assert.equal(discovery.discovered.length, 1)
  assert.ok(discovery.discovered[0].tests > 0, 'The real suite is nonempty')
  if (mutation) {
    assert.equal(discovery.applied.length, 1, 'The actual production consumer was mutated')
    assert.equal(typeof code, 'number'); assert.notEqual(code, 0)
    assert.ok(tests.numFailedTests > 0 && tests.testResults.every(suite => suite.assertionResults.length > 0), 'A behavioral assertion kills the mutation, not import failure or timeout')
    assert.match(output, /AssertionError:/)
  } else { assert.equal(code, 0, output); assert.ok(tests.numPassedTests > 0); assert.equal(tests.numFailedTests, 0) }
  return { label, code, tests: tests.numTotalTests, failed: tests.numFailedTests, applied: discovery.applied }
}

async function renderer() {
  const { build } = await import('vite'), outDir = join(privateRoot, 'renderer')
  const xterm = require.resolve('@xterm/xterm'), wrapper = join(privateRoot, 'record-xterm.mjs')
  await writeFile(wrapper, `import xterm from ${JSON.stringify(xterm)};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.identityTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  const loaded = {}, styles = {}
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    resolve: { dedupe: ['react', 'react-dom'], alias: [{ find: /^@xterm\/xterm$/, replacement: wrapper }] },
    plugins: [{ name: 'record-message-workspace-inputs', enforce: 'pre', transform(source, id) {
      if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(root, 'packages/client-ui/src') + '/') || id.startsWith(fixture + '/')) && !id.includes('?')) loaded[relative(root, id)] = hash(source)
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && file.endsWith('.css')) styles[relative(root, file)] = hash(await readFile(file))
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  for (const file of ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx',
    'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    'packages/client-ui/src/components/InputMailboxRecords.tsx', 'packages/client-ui/src/components/InputHistoryList.tsx']) assert.ok(loaded[file], 'The actual production source is compiled: ' + file)
  assert.ok(styles['packages/client-ui/src/styles/composer.css'], 'The actual owner stylesheet is compiled')
  const outputs = {}
  for (const file of await readdir(outDir, { recursive: true })) {
    try { outputs[file] = hash(await readFile(join(outDir, file))) } catch (error) { if (error.code !== 'EISDIR') throw error }
  }
  assert.ok(Object.keys(outputs).length > 0)
  result.compilation = { loaded, styles, outputs }
  await writeFile(join(evidence, 'compilation.json'), JSON.stringify(result.compilation, null, 2) + '\n')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = []
  result.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, evidence],
    { cwd: root, env, timeoutMs: 180000, onLine: line => log.push(line) })
  await writeFile(join(evidence, 'process.log'), log.join('\n'))
  result.render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  assert.equal(result.process.exitCode, 0, JSON.stringify(result.render.failure))
  assert.equal(result.process.timedOut, false)
  assert.equal(result.render.passed, true)
  assert.equal(result.render.scenes.length, 6)
  assert.ok(result.render.frames.length > 0)
  await writeFile(join(evidence, 'review.md'), ['# Message workspace visual review', '',
    'Actual isolated Electron Renderer: WorkspaceWorkbench → SessionPane → AgentSessionComposer → SessionMailbox.',
    'The original API ports receive bounded fixture records. This does not certify a live Host, CLI, installed app or Session recovery.',
    'User Sessions were not operated. Capture success does not certify aesthetic quality; open every complete image independently.', '',
    ...result.render.frames.map(frame => `- [${frame.theme} ${frame.width} ${frame.state}](${frame.file})`), ''].join('\n'))
}
try {
  if (result.mode === 'mutations') {
    result.baseline = await mounted('baseline')
    result.mutations = []
    for (const item of mutations.filter(item => !selectedMutation || item.name === selectedMutation)) result.mutations.push(await mounted(item.name, item.name))
    result.restored = await mounted('restored')
  } else await renderer()
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  const groupId = result.process?.originalPid
  try {
    const processes = await listProbeProcesses(groupId, privateRoot)
    if (processes.length) await stopProbeProcesses(groupId, privateRoot)
    result.cleanup.remaining = await listProbeProcesses(groupId, privateRoot)
    assert.equal(result.cleanup.remaining.length, 0)
    await rm(privateRoot, { recursive: true, force: true }); result.cleanup.privateRootRemoved = true
  } catch (error) { result.cleanup.failure = error.message; result.passed = false; process.exitCode = 1 }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: result.passed, mode: result.mode, evidence: relative(root, evidence), failure: result.failure }))
