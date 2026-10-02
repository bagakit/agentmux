import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { capturePostcssInputs } from './remote-runtime-proof-candidate.mjs'

const desktop = path.resolve(import.meta.dirname, '..'), root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/cross-device-project-groups')
const require = createRequire(path.join(desktop, 'package.json')), exec = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => fs.readFile(file, 'utf8').then(JSON.parse)
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true }))
  .map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const sourceIdentity = async () => {
  const git = async args => (await exec('git', args, { cwd: root })).stdout.trim()
  return { head: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
    trackedStatus: await git(['status', '--porcelain=v1', '--untracked-files=no']) }
}

// One spatial-only producer. Main imports the same freshly built public Core SDK for real
// durable read/commit/watch. Optional filesystem/Git metadata are controlled preview facts;
// there is no SSH connection, semantic Runtime, fabricated Agent or user application here.
export async function verifyCrossDeviceProjectGroupsNative() {
  const runId = `project-groups-${Date.now()}-${randomUUID().slice(0, 6)}`
  const evidence = path.join(root, '.tmp/cross-device-project-groups-native', runId)
  await fs.mkdir(evidence, { recursive: true, mode: 0o700 })
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-project-groups-'))
  await fs.chmod(privateRoot, 0o700)
  const proof = { schema: 'agentmux.cross-device-project-groups.native.v1', passed: false, runId, evidence,
    phases: [], consumedModules: [], screenshots: [], aestheticReview: 'not-performed', userAppTouched: false,
    originalRemoteOwnerTouched: false, boundary: {
      actual: ['App.initialize', 'WorkspaceSidebar', 'ProjectGroupsTree', 'ProjectGroupDialog', 'WorkspaceWorkbench',
        'Store save/dissolve and original storage flush fence', 'desktopSpatialGraph adapter',
        'public Core SpatialStateStore durable read/commit/subscribe and native filesystem watcher',
        'two ordinary Electron processes sharing one private profile', 'native pointer/text/keyboard input', 'actual Vite/PostCSS compilation'],
      controlled: ['three registered Projects and Host configuration', 'initial file Regions built by the product spatial adapter',
        'file contents and file directory metadata', 'explicit Git identity suggestions; real Git discovery is qualified separately',
        'empty Runtime/Provider/Topic/Demand catalogs'],
      notClaimed: ['SSH availability', 'Agent/Run lifecycle', 'remote file or Git discovery', 'installed application qualification']
    } }
  const cleanupErrors = []
  try {
    proof.sourceBefore = await sourceIdentity()
    assert.equal(proof.sourceBefore.trackedStatus, '', 'Native proof requires a closed tracked Source candidate')
    const expectedHead = process.argv.includes('--expected-head') ? process.argv[process.argv.indexOf('--expected-head') + 1] : null
    if (expectedHead) assert.equal(proof.sourceBefore.head, expectedHead)
    const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)
    await assertWorkspaceDistBuiltFromCurrentSource(root)
    const coreSpatialPath = path.join(root, 'packages/core/dist/spatial-state.js')
    const sdkFiles = (await Promise.all(['core', 'demand'].map(name => files(path.join(root, `packages/${name}/dist`))))).flat()
    const sdkIdentity = async () => Object.fromEntries(await Promise.all(sdkFiles.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
    proof.sdkBefore = await sdkIdentity()
    proof.publicCore = { absolutePath: coreSpatialPath, sha256: hash(await fs.readFile(coreSpatialPath)) }
    const input = { createdName: 'AgentMux workspace · Mac and remote studio', renamedName: 'AgentMux workspace · shared delivery',
      retainedGroupId: 'project-group:retained-release', unknownProjectId: JSON.stringify(['retained-device-unregistered', _hygiene_fixturePath("srv/original/release-project-not-currently-registered")]),
      config: { version: 9, hosts: [
        { id: 'local', kind: 'local', label: 'This Mac' },
        { id: 'groups-remote-preview', kind: 'ssh', label: 'Remote development studio · registered execution device', hostname: 'controlled-preview.invalid' },
        { id: 'groups-archive-preview', kind: 'ssh', label: 'Release archive server', hostname: 'archive-preview.invalid' }
      ], workspaces: [
        { id: 'groups-local', hostId: 'local', name: 'AgentMux desktop workspace', path: path.join(privateRoot, 'local-project'), kind: 'folder' },
        { id: 'groups-remote', hostId: 'groups-remote-preview', name: 'AgentMux desktop workspace · remote integration and long project identity',
          path: _hygiene_fixturePath("srv/development/team-workspaces/agentmux-desktop/remote-integration-with-a-deliberately-long-original-directory"), kind: 'folder' },
        { id: 'groups-archive', hostId: 'groups-archive-preview', name: 'Delivery archive and retained release project',
          path: _hygiene_fixturePath("opt/archive/team-deliveries/agentmux-desktop-release-project"), kind: 'folder' }
      ], executors: {}, appearance: { terminalTheme: 'graphite' },
        browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } }
    await fs.mkdir(input.config.workspaces[0].path, { mode: 0o700 })
    const inputPath = path.join(privateRoot, 'input.json'), preload = path.join(privateRoot, 'preload.cjs'), main = path.join(privateRoot, 'main.cjs')
    await write(inputPath, input)
    await fs.copyFile(path.join(fixture, 'preload.cjs'), preload); await fs.copyFile(path.join(fixture, 'main.cjs'), main)
    const modules = new Map()
    const record = async (id, code, consumedBy = 'vite-transform') => {
      const file = id.split('?')[0]
      if (!path.isAbsolute(file) || !file.startsWith(root + path.sep) || file.includes('/node_modules/')) return
      const relative = path.relative(root, file)
      if (!/\.(?:[cm]?[jt]sx?|css)$/.test(file)) return
      const sourceSHA256 = hash(await fs.readFile(file)), consumedCodeSHA256 = hash(code)
      const key = `${relative}:${consumedBy}`
      const previous = modules.get(key)
      assert.ok(!previous || previous.sourceSHA256 === sourceSHA256, `Source changed while compiling ${relative}`)
      modules.set(key, { path: relative, sourceSHA256, consumedCodeSHA256, consumedBy })
    }
    const { build } = await import(pathToFileURL(require.resolve('vite')).href)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"', __TERMINAL_WHEEL_UMD_URL__: '"unused"' },
      plugins: [{ name: 'actual-project-groups-compiler-inputs', enforce: 'pre', async transform(code, id) { await record(id, code) } }],
      css: { postcss: { plugins: [capturePostcssInputs(record)] } },
      build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
    for (const name of ['ProjectGroupDialog.tsx', 'ProjectGroupsTree.tsx', 'WorkspaceSidebar.tsx', 'WorkspaceWorkbench.tsx'])
      assert.ok([...modules.values()].some(one => one.path.endsWith(`/components/${name}`)), `Actual compiler consumed ${name}`)
    assert.ok([...modules.values()].some(one => one.path.endsWith('/styles/project-groups.css') && one.consumedBy === 'postcss-input'),
      'The actual PostCSS compiler consumed the imported Project group stylesheet')
    proof.consumedModules = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path) || a.consumedBy.localeCompare(b.consumedBy))
    const seal = async () => { for (const one of proof.consumedModules) assert.equal(hash(await fs.readFile(path.join(root, one.path))), one.sourceSHA256, `Actual consumed Source unchanged: ${one.path}`) }
    await seal()
    const compiledFiles = [...await files(path.join(privateRoot, 'renderer')), main, preload, inputPath]
    const compiledIdentity = async () => Object.fromEntries(await Promise.all(compiledFiles.map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
    proof.compiledBefore = await compiledIdentity()
    await fs.cp(path.join(privateRoot, 'renderer'), path.join(evidence, 'compiled/renderer'), { recursive: true })
    for (const file of [main, preload, inputPath]) await fs.copyFile(file, path.join(evidence, 'compiled', path.basename(file)))
    proof.compiledArtifacts = { preserved: true, recordOnly: false, directory: path.join(evidence, 'compiled') }
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    for (const name of Object.keys(env)) if (/^AGENTMUX_/.test(name)) delete env[name]
    for (const phase of ['seed', 'restore']) {
      process.stdout.write(`project-groups ${phase} ordinary Electron: ${evidence}\n`)
      const lines = []
      const exit = await runProbeProcess(process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron'),
        [main, path.join(privateRoot, 'renderer/index.html'), privateRoot, phase, preload, evidence, inputPath, coreSpatialPath],
        { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000,
          onLine: line => { lines.push(line); if (line.startsWith('project-groups:')) process.stdout.write(line + '\n') } })
      await fs.writeFile(path.join(evidence, `${phase}-stderr.log`), lines.join('\n'), { mode: 0o600 })
      const receipt = { phase, exit }; proof.phases.push(receipt)
      try { receipt.native = await json(path.join(evidence, `${phase}.json`)) } catch (error) { receipt.receiptError = error.message }
      assert.equal(exit.timedOut, false, 'Ordinary Electron must finish within the original bounded watchdog')
      assert.equal(exit.exitCode, 0, receipt.native?.failure?.message)
      assert.equal(receipt.native?.passed, true, receipt.native?.failure?.message)
    }
    assert.equal(new Set(proof.phases.map(one => one.native.electronPid)).size, 2)
    assert.deepEqual(proof.phases[0].native.finalDurable, proof.phases[1].native.originalDurable)
    assert.ok(proof.phases.every(one => one.native.runtimeCalls.length === 0))
    proof.compiledAfter = await compiledIdentity(); assert.deepEqual(proof.compiledAfter, proof.compiledBefore)
    proof.sdkAfter = await sdkIdentity(); assert.deepEqual(proof.sdkAfter, proof.sdkBefore)
    await seal(); proof.sourceAfter = await sourceIdentity(); assert.deepEqual(proof.sourceAfter, proof.sourceBefore)
    proof.passed = true
  } catch (error) { proof.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    const remaining = await listProbeProcesses(-1, privateRoot).catch(error => { cleanupErrors.push(error.message); return ['unknown'] })
    for (const file of ['core-spatial-state.json', 'seed-expectation.json']) {
      try { await fs.copyFile(path.join(privateRoot, file), path.join(evidence, file)) }
      catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(error.message) }
    }
    proof.cleanup = { errors: cleanupErrors, remaining, userAppTouched: false, remoteOwnerLifecycleAction: false, privateRootRemoved: false }
    if (!cleanupErrors.length && !remaining.length) {
      try { await fs.rm(privateRoot, { recursive: true }); proof.cleanup.privateRootRemoved = true }
      catch (error) { cleanupErrors.push(error.message); proof.passed = false }
    }
    else proof.passed = false
    proof.screenshots = proof.phases.flatMap(one => one.native?.images ?? [])
    for (const shot of proof.screenshots) assert.equal(hash(await fs.readFile(shot.absolutePath)), shot.sha256, 'Preserved PNG exact bytes')
    const receiptPath = path.join(evidence, 'receipt.json'); await write(receiptPath, proof)
    const canonical = path.join(root, '.tmp/cross-device-project-groups-native/proof.json')
    await fs.copyFile(receiptPath, canonical); await fs.chmod(canonical, 0o600)
    process.stdout.write(JSON.stringify({ passed: proof.passed, evidence, receiptPath, proofSHA256: hash(await fs.readFile(receiptPath)),
      screenshots: proof.screenshots.length, aestheticReview: proof.aestheticReview, failure: proof.failure?.message, cleanup: proof.cleanup }) + '\n')
  }
  assert.equal(proof.passed, true, proof.failure?.message ?? cleanupErrors.join('; '))
  return proof
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await verifyCrossDeviceProjectGroupsNative()
