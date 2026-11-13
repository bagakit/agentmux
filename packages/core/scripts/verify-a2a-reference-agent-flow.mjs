import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { launchPrivateA2aProof } from './lib/a2a-private-model-proof.mjs'
import { referenceProofSha as sha } from './lib/a2a-reference-proof.mjs'

// One finite real-model sample of reference delivery and active reading. The model runs the Core of one
// installed App bundle; the App's own focused gates are consumed by commit, never re-sealed here.
const harnessInputs = ['packages/core/scripts/verify-a2a-reference-agent-flow.mjs', 'packages/core/scripts/lib/a2a-private-model-proof.mjs',
  'packages/core/scripts/lib/a2a-reference-proof.mjs', 'packages/core/test/fixtures/a2a-idle-input-proof.mjs',
  'packages/core/scripts/fixtures/a2a-reference-agent/coordinator.mjs',
  ...['peer', 'process', 'native-evidence'].map(name => `packages/core/scripts/fixtures/a2a-agent-behavior/${name}.mjs`)]

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const exec = promisify(execFile)
const prepareOnly = args.length === 1 && args[0] === '--prepare-only'
assert.ok(prepareOnly || args.length === 2 && args[0] === '--installed' && !args[1].startsWith('--'),
  'Run with --installed <AgentMux.app>, or --prepare-only for a read-only preflight')

let installed
if (!prepareOnly) {
  // The packaging owner records which commit and tree a bundle was built from.
  const bundle = resolve(args[1]), app = join(bundle, 'Contents/Resources/app')
  const identity = JSON.parse(await readFile(join(app, 'package-identity.json'), 'utf8'))
  assert.match(identity.sourceCommit, /^[a-f0-9]{40}$/u, 'The installed bundle names its source commit')
  assert.equal((await exec('git', ['show', '-s', '--format=%T', identity.sourceCommit], { cwd: root })).stdout.trim(), identity.sourceTree,
    'The installed bundle names a commit of this repository with its exact tree')
  installed = { bundle, sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree, coreRoot: join(app, 'node_modules/@agentmux/core') }
}
const modelResult = await launchPrivateA2aProof({
  repository: root, sourceInputs: harnessInputs,
  coordinatorEntry: join(import.meta.dirname, 'fixtures/a2a-reference-agent/coordinator.mjs'),
  name: 'a2a-reference-agent-flow', schema: 'agentmux.a2a-reference-agent-launcher.v1',
  scenario: 'idle-reference-native-discovery', model: process.env.AGENTMUX_A2A_REFERENCE_MODEL || 'gpt-6.1-sol',
  prepareOnly, privatePrefix: 'amr-', requiredFlags: ['--no-daemon'], ...(installed ? { installedCoreRoot: installed.coreRoot } : {})
})

if (!prepareOnly) {
  assert.equal(modelResult.passed, true)
  const model = JSON.parse(await readFile(modelResult.launcher, 'utf8')), actual = JSON.parse(await readFile(modelResult.receipt, 'utf8'))
  assert.equal(actual.passed, true); assert.equal(actual.finiteSample, true); assert.equal(actual.completeFeatureCoverage, false)
  assert.equal(model.cleanup.privateRootRemoved, true); assert.deepEqual(model.cleanup.errors, [])
  assert.equal(model.redaction.credentialValueFound, false)
  assert.equal(model.installedCoreRoot, installed.coreRoot, 'The model ran the installed bundle Core')
  const joined = join(dirname(modelResult.receipt), 'joined.json')
  await writeFile(joined, JSON.stringify({ schema: 'agentmux.a2a-reference-joined-proof.v2', passed: true, finiteSample: true, completeFeatureCoverage: false,
    installed: { bundle: installed.bundle, sourceCommit: installed.sourceCommit, sourceTree: installed.sourceTree },
    model: { receipt: modelResult.receipt, receiptSHA256: sha(await readFile(modelResult.receipt)), launcher: modelResult.launcher, launcherSHA256: sha(await readFile(modelResult.launcher)) },
    boundary: 'One finite real-model sample against one installed bundle. The focused delivery and reading gates are consumed by commit; no bytes are re-sealed and no general adoption is claimed.' }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ passed: true, completeFeatureCoverage: false, joined }) + '\n')
}
