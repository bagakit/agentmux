import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { a2aFixedSource, freezeA2aPreparedSource, isA2aSourcePath } from '../scripts/lib/a2a-prepared-source.mjs'

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const commitAll = (git, message) => git(['-c', 'user.name=Proof fixture', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message])
async function write(root, files) {
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes)
  }
}
async function fixture(action) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-prepared-source-')))
  try {
    const git = async args => (await exec('git', args, { cwd: root })).stdout.trim()
    const files = {
      'tsconfig.base.json': '{"compilerOptions":{"target":"ES2022"}}\n',
      'pnpm-lock.yaml': 'lockfileVersion: fixture\n',
      'packages/core/package.json': '{"exports":{".":{"import":"./dist/owner.js"}},"dependencies":{"@agentmux/identity":"workspace:*"}}\n',
      'packages/core/tsconfig.json': '{"extends":"../../tsconfig.base.json"}\n',
      'packages/core/src/owner.ts': 'export const source = "original"\n',
      'packages/core/src/dependency.ts': 'export const dependency = "original"\n',
      'packages/core/test/excluded.test.ts': 'export const harness = true\n',
      'packages/identity/package.json': '{"exports":{".":{"import":"./dist/index.js"}}}\n',
      'packages/identity/tsconfig.json': '{"extends":"../../tsconfig.base.json"}\n',
      'packages/identity/scripts/runtime-bundle.mjs': 'export const recipe = "original"\n',
      'packages/identity/src/index.ts': 'export const identity = "original"\n',
      'packages/identity/src/runtime-entry.ts': 'export { identity } from "./index.js"\n',
      'packages/unrelated/package.json': '{}\n',
      'packages/unrelated/src/index.ts': 'export const unrelated = true\n'
    }
    await write(root, files)
    await mkdir(join(root, 'packages/core/node_modules'))
    await git(['init', '-q']); await git(['add', '-A']); await commitAll(git, 'Record source fixture')
    const commit = await git(['rev-parse', 'HEAD']), tree = await git(['rev-parse', 'HEAD^{tree}'])
    const declared = ['packages/core/src/owner.ts', 'packages/core/package.json']
    const preparation = { kind: 'prepared-artifact', identity: { sourceCommit: commit, sourceTree: tree },
      sourceSnapshot: { commit, tree, files: Object.fromEntries(declared.map(path => [path, hash(files[path])])) } }
    await action({ root, git, files, preparation, destination: join(root, 'snapshot') })
  } finally { await rm(root, { recursive: true, force: true }) }
}
async function listFiles(directory, prefix = '') {
  const names = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? prefix + '/' + entry.name : entry.name
    if (entry.isDirectory()) names.push(...await listFiles(directory, path))
    else if (!entry.isSymbolicLink()) names.push(path)
  }
  return names.sort()
}

test('freezes the whole workspace source closure from the commit despite later edits, deletions and a moved HEAD', async () => fixture(async options => {
  const { root, git, files, preparation, destination } = options
  await rm(join(root, 'packages/core/src/dependency.ts'))
  await write(root, { 'packages/core/src/owner.ts': 'concurrent owner edit\n', 'packages/identity/src/index.ts': 'concurrent identity edit\n',
    'packages/core/tsconfig.json': '{}\n', 'packages/core/src/added-later.ts': 'export const later = true\n' })
  await git(['add', '-A']); await commitAll(git, 'Record concurrent fixture change')
  await write(root, { 'pnpm-lock.yaml': files['pnpm-lock.yaml'] })
  const frozen = await freezeA2aPreparedSource(preparation, options)
  const closure = ['tsconfig.base.json', 'packages/core/package.json', 'packages/core/tsconfig.json', 'packages/core/src/dependency.ts', 'packages/core/src/owner.ts',
    'packages/identity/package.json', 'packages/identity/tsconfig.json', 'packages/identity/scripts/runtime-bundle.mjs',
    'packages/identity/src/index.ts', 'packages/identity/src/runtime-entry.ts'].sort()
  assert.deepEqual(frozen.closure, ['core', 'identity'])
  assert.deepEqual(await listFiles(destination), closure)
  for (const path of closure) {
    assert.equal(await readFile(join(destination, path), 'utf8'), files[path])
    assert.equal(frozen.digests[path], hash(files[path]))
  }
  assert.equal(await readlink(join(destination, 'packages/core/node_modules')), join(root, 'packages/core/node_modules'))
  assert.deepEqual({ ...frozen.origin, inventorySHA256: undefined, dependencyLock: undefined },
    { kind: 'fixed-git', commit: preparation.identity.sourceCommit, tree: preparation.identity.sourceTree, packages: ['core', 'identity'], inventorySHA256: undefined, dependencyLock: undefined })
  assert.match(frozen.origin.inventorySHA256, /^[a-f0-9]{64}$/u)
  assert.deepEqual(frozen.origin, (await a2aFixedSource(root, preparation.sourceSnapshot)).origin)
}))

test('names product source by the workspace closure, not by declaration', () => {
  const closure = ['core', 'identity']
  for (const path of ['tsconfig.base.json', 'packages/core/src/a.ts', 'packages/core/package.json', 'packages/core/tsconfig.json',
    'packages/identity/src/index.ts', 'packages/identity/scripts/runtime-bundle.mjs']) assert.equal(isA2aSourcePath(path, closure), true, path)
  for (const path of ['packages/core/test/a.test.ts', 'packages/core/scripts/verify.mjs', 'packages/unrelated/src/index.ts',
    'packages/core/src/../../unrelated/src/index.ts', 'pnpm-lock.yaml']) assert.equal(isA2aSourcePath(path, closure), false, path)
})

test('rejects mutable, changed, mismatched or empty source claims before creating the snapshot', async () => fixture(async options => {
  for (const change of [
    preparation => { preparation.identity.sourceCommit = preparation.sourceSnapshot.commit = 'HEAD' },
    preparation => { preparation.sourceSnapshot.files['packages/core/src/owner.ts'] = hash('foreign owner') },
    preparation => { preparation.sourceSnapshot.files = {} },
    preparation => { preparation.identity.sourceTree = preparation.sourceSnapshot.tree = '0'.repeat(40) },
    preparation => { preparation.identity.sourceCommit = '1'.repeat(40) }
  ]) {
    const preparation = structuredClone(options.preparation); change(preparation)
    await assert.rejects(freezeA2aPreparedSource(preparation, options))
    assert.equal((await readdir(options.root)).includes('snapshot'), false)
  }
}))

test('rejects a checkout whose installed dependency lock differs from the fixed commit', async () => fixture(async options => {
  await write(options.root, { 'pnpm-lock.yaml': 'lockfileVersion: concurrent\n' })
  await assert.rejects(freezeA2aPreparedSource(options.preparation, options), /lockfile/u)
  assert.equal((await readdir(options.root)).includes('snapshot'), false)
}))
