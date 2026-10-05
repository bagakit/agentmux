import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyMacosSigning } from './macos-signing.mjs'

const exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--proof', 'Use --proof <this-run-continuity.json>')
const proof = JSON.parse(await readFile(resolve(args[1]), 'utf8'))
assert.equal(proof.schema, 'agentmux.macos-authorization-continuity.v1')
assert.equal(proof.status, 'passed')
assert.equal(proof.builds?.length, 2, 'Two actual installed builds are required')
const readOriginal = async original => {
  assert.ok(original?.path && /^[a-f0-9]{64}$/.test(original.sha256), 'Each original needs a bound path and hash')
  const bytes = await readFile(original.path)
  assert.ok(bytes.length > 0)
  assert.equal(sha(bytes), original.sha256, `Changed original: ${original.path}`)
  return bytes
}
const review = JSON.parse(await readOriginal(proof.review))
assert.equal(review.schema, 'agentmux.macos-authorization-continuity-review.v1')
assert.equal(review.status, 'approved')
assert.equal(review.evidenceBasis, 'actual-installed-message-tools-across-update')
assert.ok(review.reviewer && review.reviewedAt)
assert.deepEqual(review.builds, proof.builds, 'Independent review must consume these exact A/B originals')
const verified = []
for (const build of proof.builds) {
  assert.equal(build.canonicalAppPath, proof.canonicalAppPath)
  assert.ok(Number.isInteger(build.mainPid) && build.mainPid > 0)
  const signature = await verifyMacosSigning(build.archivedAppPath, build.signingPlan)
  assert.equal(signature.kind, 'certificate')
  assert.equal(signature.designatedRequirement, build.designatedRequirement)
  const executable = join(build.archivedAppPath, 'Contents/MacOS/AgentMux')
  assert.equal(sha(await readFile(executable)), build.executableSha256)
  const details = await exec('/usr/bin/codesign', ['--display', '--verbose=4', build.archivedAppPath])
  const cdhash = `${details.stdout}\n${details.stderr}`.match(/^CDHash=([a-f0-9]+)$/m)?.[1]
  assert.equal(cdhash, build.cdhash)
  const observation = JSON.parse(await readOriginal(build.observation))
  const image = await readOriginal(build.image)
  const tcc = await readOriginal(build.tcc)
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(observation.method, 'actual-message-tools-ui')
  assert.equal(observation.mainPid, build.mainPid)
  assert.equal(observation.executablePath, join(proof.canonicalAppPath, 'Contents/MacOS/AgentMux'))
  assert.equal(observation.designatedRequirement, build.designatedRequirement)
  assert.equal(observation.captureResult.type, 'saved')
  assert.equal(observation.captureResult.sha256, sha(image))
  assert.ok(observation.target && observation.before.target === observation.target && observation.after.target === observation.target)
  assert.ok(!observation.before.draft.includes(observation.captureResult.path))
  assert.ok(observation.after.draft.includes(observation.captureResult.path), 'The original draft must consume the actual saved image')
  assert.ok(tcc.toString().includes(`pid=${build.mainPid}`) && tcc.toString().includes('kTCCServiceScreenCapture'), 'No bound responsible App TCC original')
  verified.push(signature)
}
const [a, b] = proof.builds
assert.notEqual(a.cdhash, b.cdhash, 'Signing the same sealed code twice cannot prove update continuity')
assert.notEqual(a.executableSha256, b.executableSha256, 'Two genuinely different code builds are required')
assert.deepEqual(a.signingPlan, b.signingPlan, 'Both builds must retain the same exact certificate identity')
assert.notEqual(a.mainPid, b.mainPid, 'The second build must actually restart the canonical App')
const second = JSON.parse(await readOriginal(b.observation))
assert.equal(second.systemConsentPrompts, 0, 'The updated build must work without another authorization')
assert.equal(proof.permissionResets, 0)
assert.equal(proof.automaticConsentActions, 0)
for (const [build, other] of [[a, b], [b, a]]) {
  await exec('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=${other.designatedRequirement.replace(/^designated =>\s*/, '')}`, build.archivedAppPath])
}
assert.deepEqual(review.workbenchContinuity, proof.workbenchContinuity)
assert.equal(proof.workbenchContinuity?.status, 'preserved')
assert.ok(proof.workbenchContinuity.originalSessionIds?.length > 0 && proof.workbenchContinuity.originalRunIds?.length > 0)
await readOriginal(proof.workbenchContinuity.observation)
console.log(JSON.stringify({ passed: true, scope: 'actual-installed-A-to-B-screen-capture', cdhashes: [a.cdhash, b.cdhash] }))
