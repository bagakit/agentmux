import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const git = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()
const evidence = resolve(dirname(git), '.local/browser-workface-context-menu/qualification.json')
const argument = process.argv.slice(2)
assert.ok(argument.length === 0 || argument.length === 2 && argument[0] === '--proof', 'Use --proof FILE to verify a specific qualification')
const proofFile = argument.length ? resolve(argument[1]) : evidence
const json = bytes => JSON.parse(bytes.toString('utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const proof = json(readFileSync(proofFile))
assert.equal(proof.schema, 'agentmux.browser-workface-context-menu-qualification.v1')
const read = (file, digest) => {
  const bytes = readFileSync(file)
  assert.equal(sha256(bytes), digest, 'Original evidence ' + file)
  return bytes
}
const reference = entry => resolve(dirname(proofFile), entry.path)
const load = entry => json(read(reference(entry), entry.sha256))
const native = load(proof.native)
const mutant = load(proof.mutant)
const phases = native.phases.map(phase => json(read(resolve(dirname(reference(proof.native)), phase.receipt), phase.sha256)))
assert.equal(native.selectedCase, 'context-menu')
assert.equal(native.passed, true)
assert.equal(native.mutation, null)
assert.equal(phases.length, 2)
assert.ok(phases.every(phase => phase.passed && phase.businessPassed))
const [first, restart] = phases
assert.notEqual(first.pid, restart.pid)
assert.deepEqual(restart.recoveredIdentity, first.savedIdentity)
assert.ok(restart.cases.some(entry => entry.passed && entry.kind === 'context-menu-original-workface-recovered'))
assert.deepEqual(first.cases.filter(entry => entry.passed && entry.kind === 'context-menu-directional-split').map(entry => entry.direction).sort(), ['down', 'left', 'right', 'up'])
for (const kind of ['context-menu-profile-admission', 'context-menu-original-frame-reload']) {
  assert.ok(first.cases.some(entry => entry.passed && entry.kind === kind), 'Product outcome ' + kind)
}
for (const run of [native, mutant]) {
  assert.deepEqual(run.privateProcessesRemaining, [])
  assert.deepEqual(run.sourceDrift, [])
  assert.deepEqual(run.artifactDrift, [])
}
assert.equal(mutant.selectedCase, 'context-menu')
assert.equal(mutant.passed, false)
assert.equal(mutant.mutation.name, 'ignore-workbench-menu-direction')
assert.match(mutant.failure.message, /The selected Split Left opens into the original Browser's specified side/)
const [changed] = mutant.mutation.applied
assert.equal(mutant.mutation.applied.length, 1)
assert.equal(changed.file, 'apps/desktop/src/renderer/src/lib/browser-child-projection.ts')
assert.equal(changed.originalSha256, native.sources[changed.file])
assert.notEqual(changed.effectiveSha256, changed.originalSha256)
for (const file of [
  'apps/desktop/src/main/browser-page-menu-presentation.ts',
  'apps/desktop/src/main/browser-page-context-menu.ts',
  'apps/desktop/src/main/text-edit-context-menu.ts',
  'apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/shared/browser-page-menu.ts',
  'apps/desktop/src/renderer/src/components/BrowserPageContextMenuHost.tsx',
  'apps/desktop/src/renderer/src/components/WorkbenchLayoutMenuRows.tsx',
  'apps/desktop/scripts/fixtures/browser-profile-survey-workface/context-menu-case.ts',
  'apps/desktop/scripts/verify-browser-profile-survey-workface.mjs',
  changed.file
]) {
  assert.equal(mutant.sources[file], native.sources[file], 'Exact original input in both Electron processes ' + file)
  read(resolve(root, file), native.sources[file])
}
const hit = load(proof.hit)
assert.equal(hit.passed, true)
assert.equal(hit.scratchRemoved, true)
assert.deepEqual(hit.drift, [])
const stale = hit.runs.find(run => run.id === 'workbench-hit-stale')
assert.ok(stale && stale.redExit !== 0 && stale.restoredExit === 0)
assert.equal(stale.originalSha256, native.sources[stale.source])
assert.notEqual(stale.changedSha256, stale.originalSha256)

const review = load(proof.visualReview)
assert.equal(review.passed, true)
assert.ok(review.reviewer)
for (const name of ['dark', 'light', 'profiles']) {
  const file = `first-context-menu-${name}.png`
  assert.ok(first.frames.some(frame => frame.file === file), 'Actual menu frame ' + file)
  const image = review.images.find(image => image.file === file)
  assert.ok(image, 'Independently viewed ' + file)
  read(resolve(dirname(reference(proof.native)), file), image.sha256)
}
console.log('Browser page menu qualified: four directions, Profile, original frame, two PIDs, two rejected mutations and three independently reviewed frames.')
