import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..'), run = promisify(execFile)
const argument = process.argv.indexOf('--evidence')
assert.ok(argument >= 0 && process.argv[argument + 1], 'Use --evidence <private evidence directory>')
const evidence = resolve(process.argv[argument + 1]), hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.focus-agent-menu-product.v1', passed: false, userRuntimeTouched: false,
  boundary: 'Actual private Renderer consumers and original action surfaces; private typed transport for captures. Runtime and durable spatial proof retain their original independent Task receipt and exact loaded identities. No user Session, installation or external binding is operated.', tasks: [], scenes: [] }
async function readArtifact(path) {
  const bytes = await readFile(path)
  return { path, sha256: hash(bytes), value: JSON.parse(bytes) }
}
try {
  for (const relative of ['reading/focus-agent-reading', 'transition/focus-agent-transition', 'connections', 'identity/agent-native-identity']) {
    const artifact = await readArtifact(join(evidence, '..', relative, 'receipt.json')), saved = artifact.value
    assert.equal(saved.passed, true); assert.equal(saved.sharedTreeMutations, 0)
    assert.ok(saved.cases.length > 0 && Object.keys(saved.sourceBefore).length > 0)
    for (const [name, digest] of Object.entries(saved.sourceBefore)) assert.equal(hash(await readFile(join(root, name))), digest, 'The qualified Task input stays exact: ' + name)
    for (const mutation of saved.cases) {
      assert.equal(mutation.exit, 1); assert.equal(mutation.restore.exit, 0)
      assert.notEqual(mutation.loaded.loadedSHA256 ?? mutation.loaded.sha256, saved.sourceBefore[mutation.file])
      for (const [log, digest] of [[mutation.log, mutation.logSHA256], [mutation.restore.log, mutation.restore.logSHA256]]) {
        const bytes = await readFile(join(dirname(artifact.path), log))
        assert.ok(bytes.length > 0); if (digest) assert.equal(hash(bytes), digest)
      }
    }
    receipt.tasks.push({ path: artifact.path, sha256: artifact.sha256, cases: saved.cases.length, currentInputs: saved.sourceBefore })
  }
  const durability = await readArtifact(join(evidence, '../transition/original-owner-durability/receipt.json'))
  assert.equal(durability.value.passed, true); assert.equal(durability.value.userRuntimeTouched, false)
  assert.equal(durability.value.privateRuntime, true); assert.equal(durability.value.newProcess, true)
  const subsequentOwnerChanges = []
  for (const [name, digest] of Object.entries(durability.value.source)) if (hash(await readFile(join(root, name))) !== digest) subsequentOwnerChanges.push(name)
  receipt.durability = { path: durability.path, sha256: durability.sha256, subsequentOwnerChanges,
    boundary: 'Original bounded actual Fork/public Core/new-process durable reload proof. Subsequent unrelated owner changes are disclosed, not silently requalified.' }
  for (const [name, args] of [
    ['region', ['apps/desktop/scripts/verify-agent-region-identity-menu.mjs', '--visual-only', '--agent-menu-owning']],
    ['focus', ['apps/desktop/scripts/capture-focus-context-recap-menu.mjs', '--evidence', join(evidence, 'focus')]]
  ]) {
    const outcome = await run(process.execPath, args, { cwd: root, env: process.env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(join(evidence, name + '.log'), outcome.stdout + outcome.stderr)
    const last = outcome.stdout.trim().split('\n').reverse().find(line => line.startsWith('{'))
    const report = JSON.parse(last)
    assert.equal(report.passed ?? report.capturedPass, true)
    const scene = await readArtifact(report.receipt ?? join(report.evidence, 'receipt.json'))
    assert.equal(scene.value.userRunTouched ?? scene.value.userAppRunRuntimeControlled, false)
    receipt.scenes.push({ name, path: scene.path, sha256: scene.sha256, frames: scene.value.frames ?? scene.value.render.rendered.frames })
  }
  const review = process.env.AGENTMUX_AGENT_MENU_VISUAL_REVIEW
  assert.ok(review, 'Consume the independent full-image review with AGENTMUX_AGENT_MENU_VISUAL_REVIEW')
  const reviewBytes = await readFile(resolve(review))
  assert.ok(reviewBytes.length > 0)
  receipt.independentVisualReview = { path: resolve(review), sha256: hash(reviewBytes), boundary: 'Human-readable independent judgment consumed by the delivery agent; no machine aesthetic score.' }
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure }))
