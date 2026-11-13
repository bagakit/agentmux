import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { a2aArtifactInventory, prepareA2aArtifact, verifyA2aPreparedArtifact } from '../scripts/lib/a2a-prepared-artifact.mjs'

const exec = promisify(execFile), sha = value => createHash('sha256').update(value).digest('hex')
const temporary = async fn => { const root = await realpath(await mkdtemp(join(tmpdir(), 'a2a-artifact-test-'))); try { await fn(root) } finally { await rm(root, { recursive: true, force: true }) } }
async function fixture(root) {
  const put = async (path, value, mode) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), value, mode ? { mode } : undefined) }
  const git = async args => (await exec('git', args, { cwd: root })).stdout.trim()
  await git(['init', '-q'])
  await put('owner.mjs', 'export const source = "fixed"\n')
  await git(['add', 'owner.mjs'])
  await git(['-c', 'user.name=Proof fixture', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Record proof fixture'])
  const identity = { schema: 'agentmux.package-identity.v1', appVersion: '0.1.0', platform: process.platform, arch: process.arch,
    sourceCommit: await git(['rev-parse', 'HEAD']), sourceTree: await git(['rev-parse', 'HEAD^{tree}']) }
  const bundle = join(root, 'origin/AgentMux.app'), app = 'origin/AgentMux.app/Contents/Resources/app'
  await put(app + '/package-identity.json', JSON.stringify(identity))
  const core = app + '/node_modules/@agentmux/core'
  await put(core + '/release.json', JSON.stringify({ sourceCommit: identity.sourceCommit, sourceTree: identity.sourceTree }))
  for (let index = 0; index < 101; index++) await put(core + '/dist/unit-' + index + '.js', 'export default ' + index + '\n')
  await put(core + '/bin/amux', '#!/bin/sh\nexit 0\n', 0o755)
  await put(app + '/out/main/index.js', 'export const main = true\n')
  await put('origin/AgentMux.app/Contents/MacOS/AgentMux', 'selected executable\n', 0o755)
  await symlink('unit-0.js', join(root, core, 'dist/internal-link.js'))
  const origin = { schema: 'agentmux.prepared-product-input.v1', applicationBundle: bundle, sourceIdentity: identity, qualifiedForLaunch: false }
  await put('origin.json', JSON.stringify(origin)); await put('build.log', 'Original completed compilation; install restoration unknown.\n'); await put('review.md', 'Fixed source and exact build record reviewed.\n')
  const ref = async path => ({ path, sha256: sha(await readFile(join(root, path))) })
  const descriptor = { schema: 'agentmux.a2a-prepared-input.v1', origin: await ref('origin.json'), buildRecord: await ref('build.log'), sourceReview: await ref('review.md'),
    buildDisposition: { compilation: 'completed', installation: 'unknown', sourceFinalization: 'not-reached', exitCode: 1 } }
  await put('input.json', JSON.stringify(descriptor)); await mkdir(join(root, 'private'))
  return { root, input: join(root, 'input.json'), privateRoot: join(root, 'private'), sourcePaths: ['owner.mjs'], identity, core: join(root, core) }
}

test('inventory retains executable modes and internal links but refuses borrowed or unresolved code', async () => temporary(async root => {
  await writeFile(join(root, 'program'), 'exact bytes', { mode: 0o755 }); await symlink('program', join(root, 'alias'))
  const before = await a2aArtifactInventory(root)
  assert.deepEqual(before.files.alias, { kind: 'link', mode: (await lstat(join(root, 'alias'))).mode & 0o777, target: 'program' })
  assert.equal(before.files.program.mode, 0o755)
  await chmod(join(root, 'program'), 0o644); assert.notEqual((await a2aArtifactInventory(root)).sha256, before.sha256)
  await symlink('../borrowed', join(root, 'outside'))
  await assert.rejects(a2aArtifactInventory(root), { name: 'AssertionError', message: /external link/u })
  await rm(join(root, 'outside')); await symlink('missing', join(root, 'dangling'))
  await assert.rejects(a2aArtifactInventory(root), { code: 'ENOENT' })
}))

test('prepared execution uses the exact Git snapshot and complete copied Core, preserving the unknown install outcome', async () => temporary(async root => {
  const options = await fixture(root)
  await writeFile(join(root, 'owner.mjs'), 'unrelated current checkout\n')
  const prepared = await prepareA2aArtifact(options)
  assert.equal(prepared.sourceSnapshot.files['owner.mjs'], sha('export const source = "fixed"\n'))
  assert.deepEqual(prepared.buildDisposition, { compilation: 'completed', installation: 'unknown', sourceFinalization: 'not-reached', exitCode: 1 })
  assert.equal(Object.keys(prepared.coreGraph).length, 101)
  assert.deepEqual(prepared.execution.cli.argv, [])
  assert.ok(prepared.execution.cli.executable.startsWith(options.privateRoot + '/application/'))
  assert.equal(prepared.artifact.inventory.files['Contents/MacOS/AgentMux'].mode, 0o755)
  assert.equal(prepared.artifact.inventory.files['Contents/Resources/app/node_modules/@agentmux/core/dist/internal-link.js'].target, 'unit-0.js')
  await verifyA2aPreparedArtifact(prepared, { root })
  await writeFile(join(prepared.execution.coreRoot, 'dist/unit-100.js'), 'changed compiled behavior\n')
  await assert.rejects(verifyA2aPreparedArtifact(prepared, { root }), { name: 'AssertionError', message: /execution graph stayed unchanged/u })
}))

test('wrong Core identity is refused before copying or launching any candidate', async () => temporary(async root => {
  const options = await fixture(root)
  await writeFile(join(options.core, 'release.json'), JSON.stringify({ sourceCommit: 'other', sourceTree: options.identity.sourceTree }))
  await assert.rejects(prepareA2aArtifact(options), { name: 'AssertionError' })
  assert.deepEqual(await readdir(options.privateRoot), [])
}))

test('verification rejects a truncated Core join, promoted build outcome and changed provenance', async () => temporary(async root => {
  const prepared = await prepareA2aArtifact(await fixture(root))
  const truncated = structuredClone(prepared); delete truncated.coreGraph['dist/unit-100.js']
  await assert.rejects(verifyA2aPreparedArtifact(truncated, { root }), { name: 'AssertionError', message: /same-Core graph/u })
  const promoted = structuredClone(prepared); promoted.buildDisposition.installation = 'passed'
  await assert.rejects(verifyA2aPreparedArtifact(promoted, { root }), { name: 'AssertionError' })
  await writeFile(join(root, 'build.log'), 'changed original build record\n')
  await assert.rejects(verifyA2aPreparedArtifact(prepared, { root }), { name: 'AssertionError', message: /provenance changed/u })
}))
