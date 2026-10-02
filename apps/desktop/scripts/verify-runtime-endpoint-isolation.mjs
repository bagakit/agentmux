import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { prepareRemoteProofCandidate } from './remote-runtime-proof-candidate.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/remote-runtime-renderer')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/runtime-endpoint-isolation', ("run-" + (globalThis.crypto.randomUUID()) + "")))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-endpoint-isolation-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
  ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const receipt = { schema: 'agentmux.runtime-endpoint-isolation-native.v1', passed: false, phases: [], inputBefore: null, inputAfter: null,
  aestheticReview: 'not-performed', userAppRunTouched: false, limitations: [
    'Actual App/Store/SessionPane/TerminalView and Hosts settings are compiled into a private Electron profile.',
    'The local Provider is a repository CLI fixture; its actual Session, PTY, Run, replay, input and process survival use public Core through RuntimeController.',
    'Only one remote endpoint observation is controlled offline. No remote connection, real remote Provider, SSH or Farm qualification is claimed.',
    'A private two-workspace workbench is seeded once. The second ordinary Electron process restores its original durable state without reseeding.',
    'The original rich editor DOM and caret are checked through membership resync; restart checks workspace/group/Region/layout/drafts and original Run, not a durable character-offset feature.',
    'Screenshots are capture evidence and require independent subjective review before aesthetics can be accepted.'
  ] }
let client, candidate, identities
await fs.mkdir(evidence, { recursive: true })
try {
  await fs.mkdir(path.join(privateRoot, 'workspace'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'codex'), { recursive: true })
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  candidate = await prepareRemoteProofCandidate({ root, privateRoot, proof: receipt })
  await fs.symlink(candidate.core, path.join(privateRoot, 'node_modules/@agentmux/core'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  const preload = path.join(privateRoot, 'preload.cjs')
  await fs.copyFile(path.join(fixture, 'preload.cjs'), preload)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    plugins: [candidate.capture],
    esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
    resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(desktop, 'scripts/fixtures/terminal-wheel/xterm-instrumented.ts') }] },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error',
    plugins: [candidate.capture],
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  await candidate.buildHost(build)
  await candidate.seal()
  identities = async () => ({ ...await candidate.identity(), ...Object.fromEntries(await Promise.all([
    ...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main')),
    preload, path.join(privateRoot, 'fake-codex-cli.mjs')
  ].map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))]))) })
  receipt.compiledInputs = await identities()
  receipt.inputBefore = receipt.compiledInputs
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`); await fs.mkdir(phaseRoot)
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, preload, evidence, process.execPath],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 60000, onLine: line => stderr.push(line) })
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8'))
    receipt.phases.push({ phase, exit, native })
    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0); assert.equal(native.passed, true, native.failure?.message)
    client ??= await candidate.connectLocalHost()
    const runs = (await client.listRuns()).filter(run => run.state === 'running')
    assert.equal(runs.length, 1, 'Exactly the owned healthy local Run remains')
    const current = runs.map(run => ({ runId: run.runId, pid: run.pid }))
    const owner = client.runtimeOwnerIdentity()
    assert.ok(owner && Number.isSafeInteger(owner.processId) && owner.processId > 0)
    assert.notEqual(owner.processId, native.pid, 'The ordinary Electron generation is a client of the original Host')
    if (phase === 'seed') { receipt.originalRuns = current; receipt.originalHost = owner }
    else {
      assert.deepEqual(current, receipt.originalRuns); receipt.survivingRuns = current
      assert.deepEqual([owner.runtimeId, owner.ownerInstanceId, owner.processId],
        [receipt.originalHost.runtimeId, receipt.originalHost.ownerInstanceId, receipt.originalHost.processId],
        'The original semantic Host survives the ordinary Electron restart')
      receipt.survivingHost = owner
    }
  }
  assert.equal(new Set(receipt.phases.map(item => item.native.pid)).size, 2, 'Two real ordinary Electron process generations')
  receipt.inputAfter = await identities()
  assert.deepEqual(receipt.inputAfter, receipt.inputBefore, 'The consumed immutable Core/Host/Main/Renderer candidate changed')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (!client && candidate && receipt.phases.length > 0) client = await candidate.connectLocalHost()
    if (client) {
      for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
    }
  } catch (error) { errors.push(error.message) }
  try { await client?.dispose() } catch (error) { errors.push(error.message) }
  try { if (candidate) await candidate.stopHost() } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.temporaryRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  const screenshots = receipt.phases.flatMap(({ phase }) => [`${phase}-workbench.png`, `${phase}-endpoint-notice.png`, `${phase}-hosts.png`])
  await fs.writeFile(path.join(evidence, 'review.md'), `# Runtime endpoint isolation: private native candidate\n\nNative proof passed: ${receipt.passed}. Aesthetic review: not performed.\n\n` +
    receipt.limitations.map(item => `- ${item}`).join('\n') + '\n\n' + screenshots.map(file => `- [${file}](./${file})`).join('\n') + '\n')
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, receipt: path.join(evidence, 'receipt.json'), review: path.join(evidence, 'review.md'), survivingRuns: receipt.survivingRuns }))
