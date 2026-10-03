import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Join immutable, independently reviewed native proofs to their exact Source
// and images. Reusing a proof never upgrades it into an installation receipt.
const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert(args.every(arg => ['--native', '--source', '--mutations', '--artifacts'].includes(arg) || /^(--proof|--proof-sha|--publication|--publication-sha)=.+/u.test(arg)))
const option = name => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1)
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
function frozen(name) {
  const file = option(name), expected = option(`${name}-sha`)
  assert(file && /^[a-f0-9]{64}$/u.test(expected ?? ''), `Explicit immutable ${name} and SHA required`)
  assert.equal(sha(file), expected, `${name} Source identity`)
  return json(file)
}
const proof = frozen('--proof')
assert.equal(proof.status, 'approved')
assert.equal(proof.native_behavior_verified, true)
assert.equal(proof.mutants_verified, true)
assert.equal(proof.variantBindings.length, 3)
assert.equal(sha(proof.summary.path), proof.summary.sha256)
const summary = json(proof.summary.path)
assert.equal(summary.status, 'passed')
assert.equal(summary.base, proof.base)
assert.deepEqual(summary.selected, proof.selected)
for (const variant of proof.variantBindings) {
  assert(variant.evidence.length > 2)
  for (const file of variant.evidence) assert.equal(sha(file.path), file.sha256, `${variant.variant}: ${file.path}`)
  const receiptFile = variant.evidence.find(file => file.path.endsWith('/receipt.json'))
  assert(receiptFile)
  const receipt = json(receiptFile.path), directory = resolve(receiptFile.path, '..')
  assert.equal(receipt.base, proof.base)
  assert.deepEqual(receipt.selected, proof.selected)
  assert.equal(receipt.daemonSha256, variant.daemonSha256)
  assert.equal(receipt.implementationSha256, variant.implementationSha256)
  assert.equal(sha(join(directory, 'source.tar')), proof.fullMainArchiveSha256)
  assert.equal(sha(join(directory, 'source/crates/ctxmux-daemon/src/lib.rs')), variant.implementationSha256)
  assert.equal(sha(join(directory, 'executed-ctxmuxd')), variant.daemonSha256)
  const images = json(join(directory, 'executed-artifacts.json'))
  assert.equal(sha(join(directory, images.daemon.path)), images.daemon.sha256)
  for (const image of images.tests) assert.equal(sha(join(directory, image.path)), image.sha256)
  assert.equal(existsSync(join(directory, 'target')), false, 'Closed object cache was retired')
  assert(receipt.persistenceFailure?.includes('os error 27'), 'Real isolated filesystem append failure')
  assert(receipt.history.durable_output_bytes < receipt.history.latest_output_bytes)
  assert.equal(receipt.history.native_service.owner.type, 'serving')
  assert.equal(receipt.history.native_service.input.phase.type, 'open')
  assert.equal(summary.receipts.find(item => item.name === variant.variant)?.status, variant.finalStatus)
  if (variant.variant === 'candidate') {
    assert.equal(receipt.historyFailurePassed, true)
    for (const [file, digest] of Object.entries(proof.selected)) assert.equal(sha(join(directory, 'source', file)), digest)
    for (const file of ['known-model-source-gap.log', 'public-backend-source-gap.log', 'native-fixture-preflight.log']) {
      const raw = readFileSync(join(directory, file), 'utf8')
      assert.match(raw, /running 1 test/u); assert.match(raw, /1 passed; 0 failed/u)
    }
    const fixture = json(join(directory, 'fixture-preflight.json'))
    assert.equal(fixture.publicAdapterDeadlineChanged, false)
    assert.equal(sha(join(directory, 'executed-native-fixture')), fixture.sha256)
    const source = readFileSync(join(directory, 'source/crates/ctxmux-daemon/src/lib.rs'), 'utf8')
    assert.match(source, /output\.mark_history_gap\(\)/u)
    assert.match(source, /fn mark_source_gap\(&mut self\)/u)
  } else if (variant.variant === 'history-invalidates-terminal') {
    assert.match(receipt.failure, /history failure preserves intact current VT/u)
    assert.match(receipt.failure, /unknown/u); assert.match(receipt.failure, /basic_vt/u)
  } else {
    assert.equal(variant.variant, 'source-keeps-stale-terminal')
    assert.equal(json(join(directory, 'gap-boundaries.json')).counterfactualRed, true)
    const raw = readFileSync(join(directory, 'known-model-source-gap.log'), 'utf8')
    assert.match(raw, /running 1 test/u); assert.match(raw, /history_gap_distinction_keeps_true_source_gap_unknown .*FAILED/u)
    assert.match(raw, /BasicVt/u)
  }
}
if (args.includes('--artifacts')) {
  const publication = frozen('--publication')
  assert.equal(publication.status, 'approved')
  assert.equal(publication.published_artifacts_verified, true)
  assert.equal(publication.base, proof.base)
  const contract = json(join(root, 'packages/core/src/ctxmux-artifact-contract.json'))
  assert.deepEqual(Object.keys(contract.sources).sort(), ['darwin-arm64', 'linux-x64'])
  const archives = []
  for (const target of Object.keys(contract.sources)) {
    const directory = join(root, 'packages/core/vendor/ctxmux', target)
    const manifestPath = join(directory, 'manifest.json'), manifest = json(manifestPath)
    assert.equal(sha(manifestPath), contract.manifests[target])
    assert.equal(sha(manifestPath), publication.manifests[target])
    assert.equal(manifest.source.commit, proof.base)
    assert.deepEqual(contract.sources[target], { commit: manifest.source.commit, tree: manifest.source.tree })
    assert.equal(manifest.source.worktree_clean, true)
    assert.equal(manifest.product.version, contract.version); assert.equal(manifest.product.protocol, contract.protocol)
    assert.equal(`${manifest.support.platform}-${manifest.support.architecture}`, target)
    assert.equal(manifest.support.transport, 'unix')
    for (const descriptor of [...manifest.binaries, manifest.sdk.archive]) {
      const file = join(directory, descriptor.path), stat = lstatSync(file)
      assert(stat.isFile() && !stat.isSymbolicLink())
      assert.equal(stat.size, descriptor.bytes); assert.equal((stat.mode & 0o777).toString(8).padStart(4, '0'), descriptor.mode)
      assert.equal(sha(file), descriptor.sha256)
    }
    const bound = publication.receipts[target]
    assert.equal(sha(bound.path), bound.sha256)
    const receipt = json(bound.path)
    assert.equal(receipt.passed, true); assert.equal(receipt.manifestSha256, contract.manifests[target])
    assert.equal(receipt.source.commit, proof.base)
    archives.push(readFileSync(join(directory, manifest.sdk.archive.path)))
    if (target === `${process.platform}-${process.arch}`) for (const binary of manifest.binaries) {
      const version = execFileSync(join(directory, binary.path), ['--version'], { encoding: 'utf8' })
      assert(version.includes(`${binary.name} ${contract.version} (protocol ${contract.protocol}`))
    }
  }
  assert(archives[0].equals(archives[1]), 'Both targets publish the exact same SDK archive')
  const integrity = `sha512-${createHash('sha512').update(archives[0]).digest('base64')}`
  assert(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').includes(`integrity: ${integrity}`))
}
console.log(JSON.stringify({ passed: true, base: proof.base, nativeProofReused: true, mutants: 2, artifacts: args.includes('--artifacts'), installationVerified: false }))
