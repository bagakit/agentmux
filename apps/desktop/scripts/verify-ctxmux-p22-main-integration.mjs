// Task-local qualification. Never an installer or packaging prerequisite.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/ctxmux-p22-main-integration')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = async path => hash(await readFile(path))
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert(['source', 'scene'].includes(slice), 'Use --slice source|scene')
await mkdir(evidence, { recursive: true })
const contract = await json(join(root, 'packages/core/src/ctxmux-artifact-contract.json'))
assert.equal(contract.protocol, 22)
const manifests = {}
for (const platform of ['darwin-arm64', 'linux-x64']) {
  const directory = join(root, 'packages/core/vendor/ctxmux', platform)
  const path = join(directory, 'manifest.json'), manifest = await json(path)
  assert.equal(await digest(path), contract.manifests[platform])
  assert.equal(manifest.source.commit, contract.sources[platform].commit)
  assert.equal(manifest.source.tree, contract.sources[platform].tree)
  assert.equal(manifest.source.worktree_clean, true)
  assert.equal(manifest.product.protocol, contract.protocol)
  assert.equal(manifest.sdk.protocol, contract.protocol)
  for (const item of [...manifest.binaries, manifest.sdk.archive]) {
    const path = join(directory, item.path), bytes = await readFile(path)
    assert.equal(hash(bytes), item.sha256); assert.equal(bytes.length, item.bytes)
    assert.equal(((await stat(path)).mode & 0o777).toString(8).padStart(4, '0'), item.mode)
  }
  manifests[platform] = manifest
}
assert.equal(manifests['darwin-arm64'].sdk.archive.sha256, manifests['linux-x64'].sdk.archive.sha256)
const archive = join(root, 'packages/core/vendor/ctxmux/darwin-arm64', manifests['darwin-arm64'].sdk.archive.path)
const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(path => path.startsWith('package/dist/') && !path.endsWith('/'))
assert(entries.length > 0)
for (const entry of entries) assert.equal(await digest(join(root, 'packages/core/node_modules/@ctxmux/sdk', entry.slice('package/'.length))),
  hash(execFileSync('tar', ['-xOzf', archive, entry])))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const checkpoint = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) }
assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '', 'Commit the owning candidate before qualification')
async function run(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', ...env }, stdio: 'inherit' })
  const code = await new Promise((done, fail) => {
    child.once('error', fail); child.once('exit', (code, signal) => signal ? fail(new Error(`${command} ended by ${signal}`)) : done(code))
  })
  assert.equal(code, 0, `${command} ${args.join(' ')} failed`)
}
async function fingerprints(paths) {
  const values = {}
  for (const path of paths) values[path] = await digest(join(root, path))
  assert(Object.keys(values).length > 0)
  return values
}
async function files(directory) {
  return (await readdir(join(root, directory), { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)))
}
if (slice === 'source') {
  const tests = [
    'packages/core/test/p22-output-gap-wire.test.ts', 'packages/core/test/output-gap-evidence.test.ts',
    'packages/core/test/hosted-output-observer.test.ts', 'packages/core/test/ctxmux-version-binding.test.ts',
    'packages/core/test/p22-artifact-contract.test.ts', 'packages/core/test/ctxmux-native-service.test.ts',
    'packages/core/test/ctxmux-run-current-size.test.ts', 'apps/desktop/test/output-gap-disclosure-survives.test.ts',
    'apps/desktop/test/agent-flow-diagnostic-projection.test.tsx'
  ]
  const callerSpecs = [
    ['packages/core/src/client.ts', /observation: event\.observation/u],
    ['packages/core/src/public-rpc-client.ts', /parseOutputGapEvidence\(/u],
    ['packages/core/src/public-rpc-service.ts', /message: event\.message, evidence: event\.evidence/u],
    ['packages/core/src/hosted-client.ts', /const output = createHostedOutputObservation\(/u],
    ['apps/desktop/src/main/runtime-controller.ts', /this\.publish\(prepared\.id, event\)/u],
    ['apps/desktop/src/renderer/src/store.ts', /runtimeDiagnosticNotice\((?:get\(\)|useAppStore\.getState\(\))/u]
  ]
  const paths = [...new Set([...await files('packages/core/src'), ...tests, ...callerSpecs.map(([path]) => path),
    'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/core-gap.mjs',
    'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/main-integration-mutations.mjs',
    'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/vitest.main-integration.config.mts',
    'apps/desktop/scripts/verify-ctxmux-p22-main-integration.mjs', 'pnpm-lock.yaml'])]
  const compiled = await files('packages/core/dist'), before = await fingerprints([...paths, ...compiled])
  await run('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/vitest.main-integration.config.mts',
    '--maxWorkers=1', '--reporter=json', `--outputFile=${join(evidence, 'affected-tests.json')}`])
  const report = await json(join(evidence, 'affected-tests.json'))
  assert.equal(report.success, true); assert.equal(report.numFailedTests, 0)
  assert.equal(report.testResults.length, tests.length)
  for (const path of tests) {
    const suite = report.testResults.find(suite => suite.name === join(root, path))
    assert(suite && suite.assertionResults.length > 0, `Missing actual owning assertions: ${path}`)
    assert(suite.assertionResults.every(result => result.status === 'passed'), `Skipped/failed owning assertions: ${path}`)
  }
  const mutations = await json(join(evidence, 'mutations.json'))
  assert.equal(mutations.passed, true); assert.equal(mutations.mutations.length, 5)
  for (const item of mutations.mutations) {
    assert(item.red && item.green); assert.equal(item.sourceSha256, item.restoredSha256)
    assert.equal(await digest(join(root, item.source)), item.restoredSha256)
    assert.equal(await digest(join(root, item.test)), item.testSha256)
    for (const proof of [item.redReport, item.greenReport]) assert.equal(await digest(join(root, proof.path)), proof.sha256)
    for (const proof of [item.redLog, item.greenLog]) assert.equal(await digest(join(root, proof.log)), proof.logSha256)
  }
  const callers = []
  for (const [path, expression] of callerSpecs) {
    const found = (await readFile(join(root, path), 'utf8')).split('\n').flatMap((line, index) =>
      !/^\s*(?:import|export|\/\/)/u.test(line) && expression.test(line) ? [{ path, line: index + 1, text: line.trim() }] : [])
    assert(found.length > 0, `Missing non-definition product consumer: ${path}`); callers.push(...found)
  }
  await run(process.execPath, ['apps/desktop/scripts/fixtures/ctxmux-p22-qualification/core-gap.mjs'])
  const nativePath = join(root, '.tmp/ctxmux-p22-qualification/core-gap-runtime.json'), native = await json(nativePath)
  assert(native.passed && native.userRuntimeTouched === false); assert.equal(native.sourceCommit, contract.sources['darwin-arm64'].commit)
  assert.equal(native.runs.length, 2); assert(native.gapCount > 0); assert(native.inputReceipts.length > 0)
  assert.equal(native.cleanup.rootRemoved, true); assert.deepEqual(native.cleanup.remaining, [])
  await writeFile(join(evidence, 'core-gap-runtime.json'), await readFile(nativePath))
  const after = await fingerprints([...paths, ...compiled]); assert.deepEqual(after, before, 'Candidate changed during source proof')
  await writeFile(join(evidence, 'source.json'), JSON.stringify({ passed: true, userRuntimeTouched: false, checkpoint,
    sourceCommit: contract.sources['darwin-arm64'].commit, protocol: contract.protocol, manifests: contract.manifests, loadedSdkFiles: entries.length,
    tests: { passed: report.numPassedTests, path: 'affected-tests.json', sha256: await digest(join(evidence, 'affected-tests.json')) },
    mutations, callers, inputs: after, actualCoreGap: { path: 'core-gap-runtime.json', sha256: hash(await readFile(nativePath)) },
    cleanup: native.cleanup, limitations: ['No user Runtime transition or installed App qualification.',
      'The current affected slice is newly executed. Historical T006 receipts remain historical, not current-source qualification.'] }, null, 2) + '\n')
} else {
  const path = join(evidence, 'scene-runtime.json')
  await run(process.execPath, ['apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs'], {
    AGENTMUX_VERIFY_RECEIPT: path, AGENTMUX_VERIFY_P22_SCENE: '1', AGENTMUX_VERIFY_P22_MAIN_SCENE: '1'
  })
  const scene = await json(path)
  assert(scene.passed && scene.userRuntimeTouched === false)
  assert.equal(scene.runtime.protocolGeneration, 22); assert.equal(scene.guis.length, 2)
  assert.notEqual(scene.guis[0].pid, scene.guis[1].pid)
  for (const gui of scene.guis) { assert.equal(gui.exitCode, 0); assert.equal(gui.signalCode, null) }
  assert(scene.firstSpatialHydration.reads.length > 0)
  const firstRead = scene.firstSpatialHydration.reads[0]
  assert.equal(firstRead.sequence, 1)
  assert.equal(hash(firstRead.raw), scene.spatialBefore.rawSha256)
  assert.deepEqual(JSON.parse(firstRead.raw).graph, scene.spatialBefore.state.graph)
  assert(scene.spatialBefore.state.graph.tabs.length > 0 && scene.spatialBefore.state.graph.regions.length > 0)
  assert(Object.keys(scene.spatialBefore.state.graph.layouts).length > 0)
  assert.equal(scene.draftBefore, scene.draftAfter)
  assert.equal(scene.resumed.sessionId, scene.seed.normal.agentSessionId)
  assert.notEqual(scene.resumed.runId, scene.seed.normal.runId)
  assert.equal(scene.inputAfter.pid, scene.inputBefore.pid); assert(scene.inputAfter.inputAfter > scene.inputAfter.inputBefore)
  assert.equal(scene.cleanup.rootRemoved, true); assert.deepEqual(scene.cleanup.remaining, []); assert.deepEqual(scene.cleanup.errors, [])
  assert(Object.keys(scene.inputsAfter).length > 0 && Object.keys(scene.loadedAfter).length > 0)
  for (const [path, expected] of Object.entries(scene.inputsAfter)) assert.equal(await digest(path), expected)
  const frames = [scene.screenshotNormal, scene.screenshotRestart, scene.screenshotGap]
  for (const frame of frames) assert.equal(await digest(frame.path), frame.sha256)
  await writeFile(join(evidence, 'scene.json'), JSON.stringify({ passed: true, userRuntimeTouched: false, checkpoint,
    sourceCommit: contract.sources['darwin-arm64'].commit, protocol: contract.protocol, runtimeReceipt: { path, sha256: await digest(path) }, frames,
    limitations: scene.limitations }, null, 2) + '\n')
}
console.log(`Current Main protocol-22 ${slice} integration proof passed; user Runtime untouched.`)
