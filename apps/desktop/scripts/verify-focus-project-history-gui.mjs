import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/focus-project-history')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-project-history-gui-${Date.now()}`))
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-fhist-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const inputs = [new URL(import.meta.url).pathname, path.join(desktop, 'scripts/probe-process.mjs'), ...await files(fixture),
  ...await files(path.join(desktop, 'src')), ...await files(path.join(root, 'packages/core/src')), ...await files(path.join(root, 'packages/core/dist')),
  ...await files(path.join(root, 'packages/demand/src')), ...await files(path.join(root, 'packages/demand/dist')),
  path.join(root, 'packages/core/package.json'), path.join(root, 'packages/core/scripts/build.mjs'), path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'pnpm-lock.yaml'), electron]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const mutation = process.env.AGENTMUX_FOCUS_HISTORY_GUI_MUTATION
if (mutation && mutation !== 'observation-readability') throw new Error('Select the one known loaded GUI mutation.')
const previousEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(name => [name, process.env[name]]))
const receipt = { schema: 'agentmux.focus-project-history-gui.v1', passed: false, sourceRoot: root, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), phases: [], inputs: null, inputsAfter: null, cleanup: null,
  boundary: 'Complete Main source input with production App, Store, Focus, split Workbench and real xterm. Two ordinary private Electron processes share exact public Core Agent/Terminal Runs. The Agent CLI is a repository fixture. Controlled Focus visit timestamps are not real execution duration. Terminal archive does not qualify native Agent messages. No user App/Run, installation, physical input device or independent aesthetic pass is claimed.',
  independentVisualReview: 'pending', visualPaths: [] }
let client, Core, guiStarted = false
await fs.mkdir(evidence, { recursive: true })
try {
  const dirty = spawnSync('git', ['status', '--porcelain', '--', 'apps/desktop/src', 'packages/core/src', 'packages/demand/src', 'apps/desktop/scripts/fixtures/focus-project-history', 'apps/desktop/scripts/verify-focus-project-history-gui.mjs'], { cwd: root, encoding: 'utf8' })
  assert.equal(dirty.status, 0)
  await fs.writeFile(path.join(evidence, 'candidate-status.log'), dirty.stdout + dirty.stderr)
  assert.equal(dirty.stdout.trim(), '', 'Use the complete accepted Main source cut; uncommitted fixture/product bytes are preparation only')
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr)
  assert.equal(freshness.status, 0, 'Consume a fresh normal Core/Demand build; never bypass the canonical guard')
  receipt.inputs = await hashes()
  Core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href)
  for (const name of ['alpha', 'beta']) {
    await fs.mkdir(path.join(privateRoot, name))
    await fs.writeFile(path.join(privateRoot, name, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" rx="6" fill="${name === 'alpha' ? '#5b8def' : '#af7bea'}"/><text x="12" y="17" text-anchor="middle" font-size="15" fill="white">${name === 'alpha' ? 'A' : 'B'}</text></svg>`)
  }
  await fs.mkdir(path.join(privateRoot, 'node_modules/@agentmux'), { recursive: true })
  await fs.symlink(path.join(root, 'packages/core'), path.join(privateRoot, 'node_modules/@agentmux/core'))
  await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(privateRoot, 'fake-codex-cli.mjs'))
  await fs.writeFile(path.join(privateRoot, 'producer.cjs'), `const fs=require('node:fs');for(let n=0;n<100;n++)process.stdout.write('Retained work '+n+'\\r\\n');setInterval(()=>process.stdout.write('Live private work\\r\\n'),1000);let pending='';process.stdin.on('data',data=>{pending+=data.toString();if(/[\\r\\n]/.test(pending)){fs.appendFileSync(${JSON.stringify(path.join(privateRoot, 'input.log'))},pending);process.stdout.write('ACK:'+pending+'\\r\\n');pending='';}});`)
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    plugins: mutation ? [{ name: 'focus-history-loaded-readability-counterexample', enforce: 'pre', transform(source, id) {
      if (!id.split('?')[0].endsWith('/styles/focus.css')) return
      const rule = source.match(/\.confirmation-dialog\.recent-focus__observation > p \{[^}]*\}/)?.[0]
      assert.ok(rule?.includes('white-space: normal;'), 'The actual production observation rule must be loaded')
      const changed = source.replace(rule, rule.replace('white-space: normal;', 'white-space: nowrap;'))
      receipt.loadedMutation = { variant: mutation, module: path.relative(root, id.split('?')[0]), originalSha256: hash(source), transformedSha256: hash(changed) }
      return changed
    } }] : [],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  if (mutation) assert.ok(receipt.loadedMutation, 'The actual production stylesheet mutation cannot be a no-op')
  await build({ configFile: false, root: fixture, logLevel: 'error', build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
    rollupOptions: { external: ['electron', '@agentmux/core', /^@agentmux\/core\//], output: { format: 'es', entryFileNames: 'main.mjs' } } } })
  receipt.compiled = Object.fromEntries(await Promise.all([...await files(path.join(privateRoot, 'renderer')), ...await files(path.join(privateRoot, 'main'))].map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const phaseRoot = path.join(privateRoot, `phase-${phase}`); await fs.mkdir(phaseRoot)
    const stderr = []
    guiStarted = true
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, phase, path.join(fixture, 'preload.cjs'), evidence, process.execPath],
      { temporaryRoot: phaseRoot, cwd: root, env, timeoutMs: 85000, onLine: line => stderr.push(line.slice(0, 1800)) })
    await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), stderr.join('\n'))
    const actual = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8'))
    receipt.phases.push({ phase, exit, actual })
    assert.equal(exit.timedOut, false, `${phase}: private watchdog fired`)
    assert.equal(exit.exitCode, 0, actual.failure?.message)
    assert.equal(actual.passed, true)
    process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
    process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
    process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
    client ??= await Core.connectLocalAgentMux({ store: new Core.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    const current = (await client.listRuns()).filter(run => run.state === 'running').map(run => ({ runId: run.runId, pid: run.pid })).sort((a, b) => a.runId.localeCompare(b.runId))
    assert.equal(current.length, 3, 'Only explicitly closed private Terminal stopped; original Agent and two other Terminal Runs survive')
    assert.deepEqual(current.map(run => run.runId).sort(), [actual.ids.keepRun, actual.ids.originalRun, actual.ids.companion].sort())
    if (phase === 'seed') receipt.originalRuns = current
    else { assert.deepEqual(current, receipt.originalRuns, 'Exact original Run IDs and PIDs survive ordinary GUI restart'); receipt.survivingRuns = current }
    for (const name of ['wide-archive', 'wide-fold', 'narrow']) receipt.visualPaths.push(path.relative(root, path.join(evidence, `${phase}-${name}.png`)))
  }
  assert.notEqual(receipt.phases[0].actual.pid, receipt.phases[1].actual.pid)
  receipt.inputsAfter = await hashes(); assert.deepEqual(receipt.inputsAfter, receipt.inputs, 'Exact complete candidate inputs remain unchanged throughout the two-process qualification')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const errors = []
  try {
    if (!client && Core && guiStarted) {
      process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(privateRoot, 'runtime')
      process.env.AGENTMUX_STATE_DIRECTORY = path.join(privateRoot, 'runtime', 'state')
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(privateRoot, 'messages.ndjson')
      client = await Core.connectLocalAgentMux({ store: new Core.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'agent-sessions.json')) })
    }
    if (client) {
      for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
      await client.dispose()
    }
  } catch (error) { errors.push(error.message) }
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), privateRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  for (const [name, value] of previousEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.deepEqual(receipt.cleanup.errors, [])
assert.deepEqual(receipt.cleanup.remaining, [])
assert.equal(receipt.cleanup.privateRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.relative(root, path.join(evidence, 'receipt.json')), independentVisualReview: receipt.independentVisualReview, survivingRuns: receipt.survivingRuns }))
