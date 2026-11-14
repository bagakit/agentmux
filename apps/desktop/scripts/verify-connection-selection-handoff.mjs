import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
const handoffIndex = args.indexOf('--handoff')
const handoffPath = handoffIndex >= 0 ? resolve(root, args[handoffIndex + 1]) : join(root, 'docs/reviews/connection-selection-handoff.json')
const expectedCommits = {
  'T-001': ['1ac2ed83784a143517a5d5852e5a511858e336cd', '921fd0847b96c7e1d42e94bb1790790c835ce443'],
  'T-002': ['d1ddb1a8034efdfbaa1c0d41f92c6d1d9e9bd927', 'cbc1cb1490040106c2ed3832e868e32d90b1b197', 'b7df6785d3e691b110c445a0e3a15323624fd1b9', 'cb31a9fe661cdbce7db754d801d72540de08ac10', '0095b6cf16ad089487e86c4c46fb8d5be080c72f'],
  'T-003': ['c3a0959d3684ac2cbe00fcc440478a378e18b105', 'db3bda141e9c8ccdadefb2fc4f5f858c4861ef16', 'a87cdf9638bb7b71801645d7fec74d6efff666c3'],
}
const landedHistoryCommits = [
  '7d726d26d5a62ef3a19038bec6cdd217a052e7d9',
  '446e8545cfa12ffdca142fd935342c68d0d5b17c',
  'b15c6f637ae568d96c3f7070bc6240f221e14606',
  '411fe46da2c643702df8f3ecb506bb679ac62e09',
  'f65d5aafa0748d8c751ed305c7f3f5bc9a754a0f',
  '56e3c0ad3d087c75004728a14487520cea7813b9',
  '9988a3c68e59bef4b0ecc129388c1f25fb9481dd',
  'c59c966ec64ed2d8244f920eaa3f29bc042b66d0',
  '85336743da09627fbbdf5d69911aa4db54b8764a',
  'd6648dfcdf53dfdd8ae2e236426d5695611a4cc4',
]
const requiredFiles = [
  'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/NetworkNodeSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/mesh-settings.css',
  'apps/desktop/scripts/fixtures/mesh-settings/capture.cjs',
  'apps/desktop/scripts/fixtures/mesh-settings/entry.tsx',
  'apps/desktop/scripts/fixtures/settings-connections/entry.tsx',
  'apps/desktop/test/settings-connections.test.tsx',
  'apps/desktop/test/network-node-settings.test.tsx',
  'apps/desktop/test/host-tailcat-settings.test.tsx',
  'apps/desktop/test/node-publication-navigation.test.tsx',
]
const expectedFrames = ['overview-narrow-dark.png', 'narrow-dark.png', 'narrow-middle-fields.png', 'narrow-lower-fields.png', 'failed-new-listener.png', 'local-only-connections.png']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const sealed = (path, expected) => assert.equal(sha(readFileSync(join(root, path))), expected, `Evidence seal must match: ${path}`)

function validate(path) {
  const handoff = read(path)
  assert.equal(handoff.schema, 'agentmux.connection-selection-handoff.v1', 'Connection handoff schema')
  assert.equal(handoff.sourceFeature, 'f-3sg8fq9vn')
  assert.equal(handoff.sourceStatus, 'archived', 'The source Feature must be closed before transfer')
  assert.equal(handoff.recipientFeature, 'f-3su8fk3ca')
  assert.equal(handoff.recipientTask, 'T-002')
  assert.deepEqual(handoff.commits, expectedCommits, 'Exact landed Connection commit sets')
  const missing = execFileSync('git', ['rev-list', ...landedHistoryCommits, '--not', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(missing, '', 'Reviewed Connection commits must be in the current history')
  sealed(handoff.gate.path, handoff.gate.sha256)
  const gate = readFileSync(join(root, handoff.gate.path), 'utf8')
  assert.ok(gate.includes('\nresult=pass\n'), 'Connection T-003 gate must pass')
  assert.ok(gate.includes(`\ncandidate_sha=${handoff.gate.candidate}\n`), 'Gate candidate must match the handoff')
  sealed(handoff.independentReview.path, handoff.independentReview.sha256)
  const review = read(join(root, handoff.independentReview.path))
  assert.equal(review.decision, 'approved', 'Independent visual approval is required')
  assert.equal(review.independentReviewer, true)
  assert.equal(review.actuallyViewedCompleteImages, true)
  assert.deepEqual(review.frames.map(frame => frame.path.split('/').at(-1)).sort(), [...expectedFrames].sort(), 'Exact reviewed frame set')
  sealed(handoff.capture.path, handoff.capture.sha256)
  const capture = read(join(root, handoff.capture.path))
  assert.equal(capture.passed, true, 'Connection capture must complete')
  for (const frame of review.frames) {
    assert.ok(capture.frames.includes(frame.path.split('/').at(-1)), `Reviewed frame must belong to capture: ${frame.path}`)
    assert.equal(sha(readFileSync(join(root, frame.path))), frame.sha256, `Reviewed PNG must remain unchanged: ${frame.path}`)
  }
  assert.equal(new Set(handoff.transferredFiles).size, handoff.transferredFiles.length, 'Transferred files must be unique')
  for (const file of requiredFiles) {
    assert.ok(handoff.transferredFiles.includes(file), `Required transferred file is missing: ${file}`)
    assert.ok(readFileSync(join(root, file)).length > 0, `Transferred file must exist: ${file}`)
  }
  return { commits: Object.values(handoff.commits).flat().length, frames: review.frames.length, files: handoff.transferredFiles.length }
}

if (args.includes('--self-test')) {
  const directory = mkdtempSync(join(root, '.tmp/connection-handoff-self-test-'))
  const broken = join(directory, 'handoff.json'), handoff = read(handoffPath)
  handoff.transferredFiles = handoff.transferredFiles.filter(file => file !== requiredFiles[0])
  writeFileSync(broken, JSON.stringify(handoff))
  const result = spawnSync(process.execPath, [resolve(import.meta.filename), '--handoff', broken], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 1, 'A missing required transfer must fail')
  assert.ok(result.stderr.includes('Required transferred file is missing'), 'The self-test must reach the required-file guard')
  console.log(JSON.stringify({ passed: true, selfTest: 'missing-transfer-rejected' }))
} else {
  try { console.log(JSON.stringify({ passed: true, ...validate(handoffPath) })) }
  catch (error) { console.error(JSON.stringify({ passed: false, failure: { message: error.message } })); process.exitCode = 1 }
}
