import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
export async function hashes(root, files) {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(join(root, file)))])))
}
async function git(root, ...args) { return (await execute('git', args, { cwd: root, encoding: 'utf8' })).stdout.trim() }

/** The proof consumes a complete main candidate. It does not build Desktop or Mobile. */
export async function bindCandidate(repository, output) {
  const root = resolve(repository), directory = resolve(output)
  const commit = await git(root, 'rev-parse', 'HEAD'), tree = await git(root, 'rev-parse', 'HEAD^{tree}')
  await git(root, 'merge-base', '--is-ancestor', commit, 'main')
  const mainCommit = await git(root, 'rev-parse', 'main'), mainTree = await git(root, 'rev-parse', mainCommit + '^{tree}')
  assert.equal(await git(root, 'status', '--porcelain', '--untracked-files=normal'), '', 'The complete main candidate must be clean; use a separate clean checkout when the shared checkout has active edits')
  const freshness = await import(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)
  await freshness.assertWorkspaceDistBuiltFromCurrentSource(root)
  for (const [name, entry] of [['client-ui', 'dist/index.js'], ['relay', 'dist/index.js'], ['connectors', 'dist/index.js'], ['capsule', 'dist/index.js']]) {
    const complaint = await freshness.staleDistComplaint(join(root, 'packages', name), entry)
    assert.equal(complaint, null, complaint ?? undefined)
  }
  const mobileRoot = join(root, 'apps/mobile/dist')
  assert.equal(await freshness.staleDistComplaint(join(root, 'apps/mobile'), 'dist/mobile-release.json'), null,
    'The current formal Mobile source must precede every consumed build artifact')
  const mobile = JSON.parse(await readFile(join(mobileRoot, 'mobile-release.json'), 'utf8'))
  assert.equal(mobile.schema, 'agentmux.mobile-web-release.v1')
  const { digest: mobileDigest, ...body } = mobile
  assert.equal(digest(JSON.stringify(body)), mobileDigest)
  assert.ok(mobile.files.length > 2 && mobile.files.some(file => file.path.startsWith('assets/') && file.path.endsWith('.js')),
    'The original Mobile application must be built; a placeholder HTML fixture cannot qualify')
  for (const file of mobile.files) {
    assert.ok(!isAbsolute(file.path) && !file.path.split('/').includes('..'))
    const bytes = await readFile(join(mobileRoot, file.path))
    assert.equal(bytes.length, file.bytes); assert.equal(digest(bytes), file.digest)
  }
  const newestRendererSource = await freshness.extremeModification(join(root, 'apps/desktop/src/renderer'), (a, b) => a > b)
  const oldestRendererArtifact = await freshness.extremeModification(join(root, 'apps/desktop/out/renderer'), (a, b) => a < b)
  assert.ok(newestRendererSource && oldestRendererArtifact, 'The original Desktop Renderer source and artifacts must both be nonempty')
  assert.equal(freshness.distIsStale(newestRendererSource, oldestRendererArtifact), false,
    'The current Desktop Renderer source must precede the consumed release')
  const renderer = JSON.parse(await readFile(join(root, 'apps/desktop/out/renderer/release.json'), 'utf8'))
  const { sourceUpdateIdentity } = await import(pathToFileURL(join(root, 'apps/desktop/scripts/update-identity.mjs')).href)
  assert.deepEqual(renderer.identity, await sourceUpdateIdentity(root), 'Desktop shell/Core source differs from the built candidate')
  assert.ok(Object.keys(renderer.files).length > 2)
  const artifacts = ['apps/desktop/out/main/index.js', 'apps/desktop/out/main/agentmux-host.js', 'apps/desktop/out/preload/index.cjs',
    'apps/desktop/out/renderer/release.json', 'apps/mobile/dist/mobile-release.json', 'apps/host/resources/bin/agentmux-workspace-move',
    ...['index', 'hosted', 'headless-runtime', 'public-rpc-client', 'control-endpoint-listener-worker', 'note-merge-worker'].map(name => 'packages/core/dist/' + name + '.js'),
    'packages/core/vendor/ctxmux/' + process.platform + '-' + process.arch + '/bin/ctxmuxd']
  const artifactHashes = await hashes(root, artifacts)
  await mkdir(directory, { recursive: true })
  const require = createRequire(join(root, 'apps/host/package.json'))
  const { build } = require('esbuild')
  const hostLibrary = join(directory, 'compiled-host.mjs')
  // This is the original library, with only its public options supplied by the private fixture.
  const built = await build({ absWorkingDir: root, entryPoints: ['apps/host/src/host.ts'], outfile: hostLibrary,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', metafile: true })
  const compiledInputs = Object.keys(built.metafile.inputs)
  assert.ok(compiledInputs.includes('apps/host/src/host.ts') && compiledInputs.includes('apps/host/src/content-owner.ts'))
  for (const path of compiledInputs) {
    assert.ok(!isAbsolute(path) && !path.split('/').includes('..'), 'Compilation input must be part of the bound candidate')
  }
  const sourceHashes = await hashes(root, [...new Set([...compiledInputs, 'apps/host/src/macos-service.ts', 'apps/host/src/index.ts',
    'apps/host/src/host.ts', 'packages/core/src/headless-runtime.ts', 'apps/desktop/src/main/desktop-host.ts',
    'apps/desktop/scripts/package-semantic-host.mjs', 'packages/core/test/fixtures/fake-codex-cli.mjs'])])
  try { await symlink(join(root, 'apps/host/node_modules'), join(directory, 'node_modules'), 'dir') }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    assert.equal(await realpath(join(directory, 'node_modules')), await realpath(join(root, 'apps/host/node_modules')),
      'The existing private output must load dependencies from this exact candidate')
  }
  const input = { schema: 'agentmux.mobile-desktop-candidate.v1', commit, tree, mainCommit, mainTree, sourceHashes, artifactHashes,
    hostLibrary: { digest: digest(await readFile(hostLibrary)), inputs: Object.fromEntries(compiledInputs.map(path => [path, sourceHashes[path]])) },
    mobile: { buildId: mobile.buildId, digest: mobile.digest, files: mobile.files }, renderer: { id: renderer.id, identity: renderer.identity } }
  await writeFile(join(directory, 'candidate-inputs.json'), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 })
  await writeFile(join(directory, 'host-metafile.json'), JSON.stringify({ inputs: built.metafile.inputs,
    outputs: Object.fromEntries(Object.entries(built.metafile.outputs).map(([path, info]) => [relative(directory, resolve(root, path)), info])) }, null, 2) + '\n')
  const assertUnchanged = async () => {
    assert.equal(await git(root, 'rev-parse', 'HEAD'), commit)
    assert.equal(await git(root, 'rev-parse', 'HEAD^{tree}'), tree)
    await git(root, 'merge-base', '--is-ancestor', commit, 'main')
    assert.equal(await git(root, 'status', '--porcelain', '--untracked-files=normal'), '', 'Candidate changed during the proof')
    assert.deepEqual(await hashes(root, artifacts), artifactHashes, 'Compiled candidate changed during the proof')
    assert.equal(digest(await readFile(hostLibrary)), input.hostLibrary.digest)
  }
  return { root, directory, hostLibrary, mobileRoot, input, assertUnchanged }
}
