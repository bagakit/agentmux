import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/ctxmux-p22-qualification')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), exec = promisify(execFile)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['source', 'scene'].includes(slice), 'Use --slice source|scene')
await mkdir(evidence, { recursive: true })
const input = await json(join(evidence, 'input.json'))
assert.equal(input.candidate, root, 'The owning frozen input must select this exact worktree')
assert.equal(input.protocol, 22); assert.equal(input.producerPassed, true)
const manifestPath = join(root, 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json')
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes)
assert.equal(hash(manifestBytes), input.manifestSha256)
assert.equal(manifest.source.commit, input.sourceCommit); assert.equal(manifest.product.protocol, 22)
assert.equal(manifest.source.worktree_clean, true)
for (const artifact of [...manifest.binaries, manifest.sdk.archive]) {
  const bytes = await readFile(join(resolve(manifestPath, '..'), artifact.path))
  assert.equal(hash(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes)
  const metadata = await stat(join(resolve(manifestPath, '..'), artifact.path))
  assert.equal((metadata.mode & 0o777).toString(8).padStart(4, '0'), artifact.mode)
}
async function run(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...extra }, stdio: 'inherit' })
  const code = await new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', (code, signal) => signal ? fail(new Error(`${command} ended by ${signal}`)) : done(code))
  })
  assert.equal(code, 0, `${command} ${args.join(' ')} failed`)
}
const git = async args => (await exec('git', args, { cwd: root, maxBuffer: 2 * 1024 * 1024 })).stdout.trim()
const checkpoint = { commit: await git(['rev-parse', 'HEAD']), tree: await git(['rev-parse', 'HEAD^{tree}']),
  branch: await git(['branch', '--show-current']), trackedStatus: await git(['status', '--porcelain', '--untracked-files=no']) }
assert.equal(checkpoint.branch, input.branch)
assert.equal(checkpoint.trackedStatus, '', 'The qualification must bind a committed, clean candidate ref')
if (slice === 'source') {
  const sourcePath = join(evidence, 'source.json')
  let previous
  try { previous = await json(sourcePath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const maps = previous ? [previous.sourceInputs, previous.compiledInputs] : []
  let reuse = previous?.passed === true && previous.sourceCommit === input.sourceCommit && previous.protocol === 22 &&
    previous.inputSha256 === hash(await readFile(join(evidence, 'input.json'))) && previous.manifestSha256 === hash(manifestBytes) &&
    maps.length === 2 && maps.every(map => map && Object.keys(map).length > 0)
  if (reuse) for (const map of maps) for (const [path, expected] of Object.entries(map)) {
    if (hash(await readFile(join(root, path))) !== expected) reuse = false
  }
  if (!reuse) await run(process.execPath, ['apps/desktop/scripts/verify-ctxmux-p22-source.mjs'])
  const source = await json(join(evidence, 'source.json'))
  assert.equal(source.passed, true); assert.equal(source.userRuntimeTouched, false)
  assert.equal(source.sourceCommit, input.sourceCommit); assert.equal(source.protocol, 22)
  const archive = join(resolve(manifestPath, '..'), manifest.sdk.archive.path)
  const sdkEntries = (await exec('tar', ['-tzf', archive])).stdout.split('\n').filter(path => path.startsWith('package/dist/') && !path.endsWith('/'))
  assert.ok(sdkEntries.length > 0); assert.equal(sdkEntries.length, source.loadedSdkFiles)
  for (const entry of sdkEntries) {
    const bytes = (await exec('tar', ['-xOzf', archive, entry], { encoding: 'buffer' })).stdout
    assert.equal(hash(await readFile(join(root, 'packages/core/node_modules/@ctxmux/sdk', entry.slice('package/'.length)))), hash(bytes))
  }
  assert.ok(source.tests.passed > 0)
  assert.equal(hash(await readFile(join(evidence, 'tests.json'))), source.tests.sha256)
  assert.ok(source.callers.length > 0); assert.ok(source.mutations.length > 0)
  for (const mutation of source.mutations) {
    assert.equal(mutation.red, true); assert.equal(mutation.green, true)
    assert.equal(mutation.sourceSha256, mutation.restoredSha256)
    assert.equal(hash(await readFile(join(root, mutation.source))), mutation.restoredSha256)
    assert.equal(hash(await readFile(join(root, mutation.test))), mutation.testSha256)
    for (const [path, expected] of [[mutation.redLog, mutation.redLogSha256], [mutation.greenLog, mutation.greenLogSha256],
      [mutation.redReport, mutation.redReportSha256], [mutation.greenReport, mutation.greenReportSha256]]) {
      assert.equal(hash(await readFile(join(root, path))), expected)
    }
  }
  assert.equal(hash(await readFile(join(evidence, 'core-gap-runtime.json'))), source.actualCoreGap.sha256)
  assert.equal(source.cleanup.rootRemoved, true); assert.deepEqual(source.cleanup.remaining, [])
  await writeFile(join(evidence, 'source-gate.json'), JSON.stringify({
    schema: 'agentmux.ctxmux-p22-source-gate.v1', passed: true, userRuntimeTouched: false,
    sourceCommit: input.sourceCommit, protocol: 22, checkpoint,
    sourceReceipt: { path: sourcePath, sha256: hash(await readFile(sourcePath)), reused: reuse,
      reason: reuse ? 'All qualified production, proof, compiled inputs and mutation evidence retain exact bytes.' : 'Canonical source qualification ran.' },
    verifierSha256: hash(await readFile(new URL(import.meta.url)))
  }, null, 2) + '\n')
  process.stdout.write('Frozen protocol-22 source qualification passed.\n')
} else {
  const runtimePath = join(evidence, 'scene-runtime.json')
  await run(process.execPath, ['apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs'], {
    AGENTMUX_VERIFY_RECEIPT: runtimePath, AGENTMUX_VERIFY_P22_SCENE: '1'
  })
  const runtime = await json(runtimePath)
  assert.equal(runtime.passed, true); assert.equal(runtime.userRuntimeTouched, false)
  assert.equal(runtime.runtime.protocolGeneration, 22)
  assert.equal(runtime.guis.length, 2); assert.notEqual(runtime.guis[0].pid, runtime.guis[1].pid)
  for (const gui of runtime.guis) { assert.equal(gui.exitCode, 0); assert.equal(gui.signalCode, null) }
  assert.ok(runtime.firstHydration.reads.length > 0); assert.ok(runtime.persistedBefore.rawSha256)
  assert.equal(runtime.draftAfter, runtime.draftBefore)
  assert.equal(runtime.resumed.sessionId, runtime.seed.normal.agentSessionId)
  assert.notEqual(runtime.resumed.runId, runtime.seed.normal.runId)
  assert.equal(runtime.inputAfter.pid, runtime.inputBefore.pid)
  assert.ok(runtime.inputAfter.inputAfter > runtime.inputAfter.inputBefore)
  assert.equal(runtime.cleanup.rootRemoved, true); assert.deepEqual(runtime.cleanup.remaining, []); assert.deepEqual(runtime.cleanup.errors, [])
  assert.ok(Object.keys(runtime.inputsAfter).length > 0); assert.ok(Object.keys(runtime.loadedAfter).length > 0)
  for (const [path, expected] of Object.entries(runtime.inputsAfter)) assert.equal(hash(await readFile(path)), expected, `Candidate changed after scene: ${path}`)
  const frames = [runtime.screenshotNormal, runtime.screenshotRestart, runtime.screenshotGap]
  for (const frame of frames) assert.equal(hash(await readFile(frame.path)), frame.sha256)
  assert.equal(hash(await readFile(runtime.gapProjection.record.path)), runtime.gapProjection.record.sha256)
  await writeFile(join(evidence, 'scene.json'), JSON.stringify({
    schema: 'agentmux.ctxmux-p22-scene.v1', passed: true, userRuntimeTouched: false,
    sourceCommit: input.sourceCommit, protocol: 22, manifestSha256: hash(manifestBytes), checkpoint,
    runtimeReceipt: { path: runtimePath, sha256: hash(await readFile(runtimePath)) }, frames,
    limitations: ['Private ordinary GUI recovery; no installed package or user Runtime transition qualification.',
      'Gap details replay a captured private Native event through this GUI IPC; no live Gap or ownership of that source Run is claimed.'],
    verifierSha256: hash(await readFile(new URL(import.meta.url)))
  }, null, 2) + '\n')
  process.stdout.write('Frozen protocol-22 private GUI restart and original workbench qualification passed.\n')
}
