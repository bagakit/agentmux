import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '../../..')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
// Preserve proof bytes outside an owned worktree so its cleanup cannot erase them.
const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()
const output = join(dirname(commonGit), '.local/browser-daily-p0p1/t003-native')
const indexPath = join(output, 'index.json')
assert.ok(process.argv.slice(2).every(arg => arg === '--fresh'), 'Only explicit --fresh launches this private App proof.')
const fresh = process.argv.includes('--fresh')
const check = receipt => {
  assert.equal(receipt.case, 'task-data-outcomes')
  assert.equal(receipt.passed, true, JSON.stringify(receipt.failure)); assert.equal(receipt.completeGate, true)
  assert.equal(receipt.taskData?.complete, true)
  assert.equal(receipt.taskData.outcomes.completion.status, 'passed')
  assert.ok(receipt.taskData.cases.length >= 7, 'Actual nonempty task data business cases are required')
  assert.equal(receipt.taskData.producers.length, 2)
  assert.notEqual(receipt.taskData.producers[0], receipt.taskData.producers[1])
  assert.ok(receipt.taskData.guiResultRead.utf8Bytes > 0 && receipt.taskData.guiResultRead.utf8Bytes <= 65536)
  assert.equal(receipt.taskData.guiResultRead.originalArtifactSha256, receipt.taskData.artifacts[0].sha256)
  assert.notEqual(receipt.first.pid, receipt.second.pid, 'The actual product must have two distinct App PIDs')
  assert.equal(receipt.taskData.original.runId, receipt.taskData.recovered.run.runId)
  assert.equal(receipt.taskData.original.pid, receipt.taskData.recovered.run.pid)
  assert.equal(receipt.taskData.original.actionCount, receipt.taskData.recovered.actionCount)
  assert.equal(receipt.taskData.privateCounterexamples.retention.release.status, 'retained')
  assert.ok(receipt.taskData.privateCounterexamples.retention.release.reasons.includes('document-used'))
  assert.deepEqual(receipt.taskData.coldRead.nativeBefore, [])
  assert.deepEqual(receipt.taskData.coldRead.nativeAfter, [])
  assert.equal(receipt.taskData.coldRead.artifactSha256, receipt.taskData.privateCounterexamples.safeArtifact.sha256)
  assert.equal(receipt.taskData.coldRead.actionCount, receipt.taskData.original.actionCount)
  assert.deepEqual(receipt.identityBefore, receipt.identityAfter)
  assert.equal(receipt.cleanup.privateProcessesReaped, true)
  assert.equal(receipt.cleanup.temporaryRootRemoved, true)
  assert.ok(receipt.visual.frames.length >= 5)
}

await mkdir(output, { recursive: true })
if (!fresh) {
  let index
  try { index = JSON.parse(await readFile(indexPath, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') throw new Error('No original task-data proof exists. Run this command with explicit --fresh to launch its private App; default never launches or silently refreshes.'); throw error }
  const bytes = await readFile(index.receipt.path); assert.equal(sha(bytes), index.receipt.sha256)
  const receipt = JSON.parse(bytes); check(receipt)
  for (const item of index.inputs) {
    const current = await readFile(isAbsolute(item.path) ? item.path : join(repo, item.path))
    assert.equal(sha(current), item.sha256, `Task-data proof input changed: ${item.path}. No App was launched; inspect drift and use explicit --fresh only when intended.`)
    assert.equal(sha(await readFile(item.archived)), item.sha256, `Original proof bytes changed: ${item.archived}`)
  }
  for (const item of [...index.frames, ...(index.evidence ?? [])]) assert.equal(sha(await readFile(item.path)), item.sha256)
  const visual = index.aestheticReview
  assert.ok(visual && typeof visual === 'object' && visual.path && visual.sha256, 'The exact original frames still need independent visual review.')
  const reviewBytes = await readFile(visual.path); assert.equal(sha(reviewBytes), visual.sha256)
  const review = JSON.parse(reviewBytes)
  assert.equal(review.approved, true); assert.ok(review.reviewer && review.reviewer !== review.author)
  assert.ok(review.images?.length >= 5, 'Independently review the actual normal, narrow, short, result-reader and restored views.')
  for (const label of ['normal-task-data-outcomes', 'narrow-task-data-outcomes', 'short-task-data-outcomes', 'normal-task-data-original-fields', 'normal-task-data-restored']) {
    const candidates = index.frames.filter(frame => frame.label === label && ['os', 'renderer'].includes(frame.kind))
    assert.ok(candidates.some(frame => review.images.some(image => image.path === frame.path && image.sha256 === frame.sha256)), 'A required current full-window view was not reviewed: ' + label)
  }
  for (const reviewed of review.images) assert.ok(index.frames.some(frame => frame.path === reviewed.path && frame.sha256 === reviewed.sha256), 'Visual review must name this exact attempt’s original images')
  console.log(JSON.stringify({ passed: true, appLaunched: false, receipt: index.receipt.path, aestheticReview: visual, scope: 'Original task-data native proof, unchanged source/artifact inputs and exact independently reviewed frames; no new App operation.' }))
} else {
  const attempt = await mkdtemp(join(output, 'attempt-'))
  const invocationId = randomUUID()
  const result = await new Promise((done, fail) => {
    const env = { ...process.env, AGENTMUX_TASK_DATA_PROBE_ID: invocationId }; delete env.AGENTMUX_BROWSER_NATIVE_PROOF_INDEX
    const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-browser-recovery-restart.mjs'), '--case-task-data-outcomes'], { cwd: repo, env, stdio: 'inherit' })
    child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal }))
  })
  const receiptBytes = await readFile(join(repo, '.tmp/browser-task-data-outcomes-last.json'))
  const receipt = JSON.parse(receiptBytes), receiptPath = join(attempt, 'receipt.json')
  assert.equal(receipt.taskDataProbeId, invocationId, 'A stale last receipt cannot stand in for this invocation or authorize cleanup')
  await writeFile(receiptPath, receiptBytes)
  const inputs = [], frames = [], evidence = [], blobs = join(output, 'blobs')
  await mkdir(blobs, { recursive: true })
  for (const [path, expected] of Object.entries(receipt.identityBefore ?? {})) {
    const bytes = await readFile(isAbsolute(path) ? path : join(repo, path))
    assert.equal(sha(bytes), expected, 'Input drift before independent byte preservation: ' + path)
    const archived = join(blobs, expected)
    try { await writeFile(archived, bytes, { flag: 'wx' }) }
    catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(sha(await readFile(archived)), expected, 'An immutable proof blob changed') }
    inputs.push({ path, kind: /(?:\/out\/|\/dist\/|\/resources\/bin\/)/.test(path) || isAbsolute(path) ? 'artifact' : 'source', sha256: expected, archived })
  }
  for (const frame of receipt.visual?.frames ?? []) {
    for (const [kind, original] of [['renderer', frame.file], ['native', frame.nativePage?.file]]) {
      if (!original) continue
      const path = join(attempt, frame.label + '-' + kind + '.png'); await copyFile(original, path)
      frames.push({ label: frame.label, kind, path, sha256: sha(await readFile(path)) })
    }
  }
  for (const frame of receipt.visual?.osFrames ?? []) {
    for (const [kind, original] of [['os', frame.file], ['os-state', frame.stateFile]]) {
      const path = join(attempt, frame.label + '-' + kind + (kind === 'os' ? '.png' : '.json')); await copyFile(original, path)
      frames.push({ label: frame.label, kind, path, sha256: sha(await readFile(path)) })
    }
  }
  for (const original of [...(receipt.taskData?.artifactFiles ?? []), ...(receipt.taskData?.durableFiles ?? [])]) {
    const path = join(attempt, original.file.split('/').at(-1)); await copyFile(original.file, path)
    assert.equal(sha(await readFile(path)), original.sha256)
    evidence.push({ ...original, path })
  }
  for (const host of receipt.privateElectronHosts ?? []) {
    const bytes = Buffer.from(host.source)
    assert.equal(sha(bytes), host.sha256)
    const path = join(attempt, 'bootstrap-' + host.label + '.cjs'); await writeFile(path, bytes, { flag: 'wx' })
    evidence.push({ kind: 'private-electron-bootstrap', path, sha256: host.sha256 })
  }
  const index = { schema: 'agentmux.browser-task-data-proof.v1', receipt: { path: receiptPath, sha256: sha(receiptBytes) }, inputs, frames, evidence, aestheticReview: 'not-performed', command: [process.execPath, import.meta.filename, '--fresh'], boundary: 'Generated and compiled input bytes and original data artifacts are archived independently per attempt; no subsequent build may overwrite this proof. Actual native actions and original durable owners, normal quit only.' }
  await writeFile(join(attempt, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  const captured = resolve(receipt.visual.captureDirectory)
  assert.ok(captured.startsWith(join(repo, '.tmp/browser-operation-visual-')), 'Only this invocation’s original private capture directory may be removed')
  if (receipt.cleanup.privateProcessesReaped) {
    await rm(captured, { recursive: true })
    for (const host of receipt.privateElectronHosts ?? []) {
      assert.equal(resolve(host.entry), join(repo, 'apps/desktop/out/main', `private-task-data-outcomes-${host.label}.cjs`))
      assert.equal(sha(await readFile(host.entry)), host.sha256, 'An altered bootstrap stays available for its actual owner')
      await rm(host.entry)
    }
  }
  assert.equal(result.signal, null); assert.equal(result.code, 0, JSON.stringify(receipt.failure))
  check(receipt)
  await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, appLaunched: true, receipt: receiptPath, index: indexPath, aestheticReview: 'not-performed', privateResources: receipt.cleanup }))
}
