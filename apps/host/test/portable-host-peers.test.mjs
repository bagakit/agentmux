import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const mutations = {
  'skip-peers': ["...Object.keys(peers)", ''],
  'flatten-peer-scope': ['await resolvePackageRoot(sourceDirectory, name)', 'await resolvePackageRoot(name in peers ? packageRoot : sourceDirectory, name)'],
  'optional-required-peer': ['const canBeAbsent = !requiredPeer && (', 'const canBeAbsent = name in peers || !requiredPeer && (']
}
const mutant = process.env.AGENTMUX_PACKAGE_PEER_MUTATION
if (mutant) {
  assert.ok(Object.hasOwn(mutations, mutant), 'Choose one exact publication peer mutation')
  registerHooks({ load(url, context, next) {
    const result = next(url, context)
    if (!url.endsWith('/scripts/package-dependencies.mjs')) return result
    const source = String(result.source), [before, after] = mutations[mutant]
    assert.equal(source.split(before).length, 2, 'The peer mutation must match one exact owning source anchor')
    const changed = source.replace(before, after), hash = value => createHash('sha256').update(value).digest('hex')
    const proof = process.env.AGENTMUX_PACKAGE_PEER_PROOF
    const header = proof ? "import { appendFileSync as __peerProof } from 'node:fs'; __peerProof(" + JSON.stringify(proof) + ', ' + JSON.stringify(JSON.stringify({ mutant, originalSHA256: hash(source), loadedSHA256: hash(changed) }) + '\n') + ');\n' : ''
    return { ...result, source: header + changed }
  } })
}
const { assemblePortableHost } = await import('../scripts/portable-host.mjs')
const exec = promisify(execFile)
const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
const pkg = async (root, name, version, fields = {}, body = '') => {
  await put(join(root, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'dist/index.js', files: ['dist'], ...fields }))
  await put(join(root, fields.main ?? 'dist/index.js'), body)
}
async function fixture(root) {
  const installed = join(root, 'installed'), host = join(installed, 'host'), core = join(host, 'node_modules/@agentmux/core')
  await pkg(host, '@agentmux/host', '1.0.0', { files: ['dist', 'resources'], dependencies: { '@agentmux/core': '1.0.0', 'peer-consumer': '1.0.0', 'nested-owner': '1.0.0' } },
    'const one=(await import("peer-consumer")).default;const two=(await import("nested-owner")).default;console.log(JSON.stringify({one,two,args:process.argv.slice(2)}))')
  await pkg(core, '@agentmux/core', '1.0.0', { files: ['dist', 'bin'] })
  await put(join(core, 'dist/agentmux.js'), 'console.log("original-cli")')
  // This fixture isolates packaging and Node module resolution; it does not claim a real Native install.
  await put(join(core, 'bin/install-ctxmux.mjs'), '')
  await put(join(host, 'resources/bin/agentmux-workspace-move'), 'fixture-native-resource')
  const cjs = join(host, 'node_modules/peer-consumer')
  await pkg(cjs, 'peer-consumer', '1.0.0', { type: 'commonjs', main: 'dist/index.cjs', peerDependencies: { 'runtime-peer': '^1.0.0', '@peer-fixture/absent': '*' }, peerDependenciesMeta: { '@peer-fixture/absent': { optional: true } } },
    'module.exports=require("runtime-peer")')
  await pkg(join(host, 'node_modules/runtime-peer'), 'runtime-peer', '1.0.0', { type: 'commonjs', main: 'dist/index.cjs' }, 'module.exports="runtime-one"')
  const nested = join(host, 'node_modules/nested-owner')
  await pkg(nested, 'nested-owner', '1.0.0', { dependencies: { '@peer-fixture/plugin': '1.0.0' } }, 'export {default} from "@peer-fixture/plugin"')
  const context = join(installed, 'node_modules/.store/plugin_runtime-two'), plugin = join(context, 'node_modules/@peer-fixture/plugin')
  await pkg(plugin, '@peer-fixture/plugin', '1.0.0', { peerDependencies: { 'runtime-peer': '^2.0.0', '@peer-fixture/helper': '^2.0.0', 'present-optional-peer': '*', 'absent-optional-peer': '*' },
    peerDependenciesMeta: { 'present-optional-peer': { optional: true }, 'absent-optional-peer': { optional: true } } },
    'import runtime from "runtime-peer";import helper from "@peer-fixture/helper";import optional from "present-optional-peer";export default {runtime,helper,optional}')
  const peerTwo = join(installed, 'node_modules/.store/runtime-two/node_modules/runtime-peer')
  await pkg(peerTwo, 'runtime-peer', '2.0.0', {}, 'export default "runtime-two"')
  await mkdir(join(context, 'node_modules'), { recursive: true })
  await symlink(peerTwo, join(context, 'node_modules/runtime-peer'))
  await pkg(join(context, 'node_modules/@peer-fixture/helper'), '@peer-fixture/helper', '2.0.0', {}, 'export default "scoped-two"')
  await pkg(join(context, 'node_modules/present-optional-peer'), 'present-optional-peer', '3.0.0', {}, 'export default "optional-present"')
  // A flattened ancestor context would resolve different versions despite identical peer names.
  await pkg(join(host, 'node_modules/@peer-fixture/helper'), '@peer-fixture/helper', '1.0.0', {}, 'export default "wrong-scoped-one"')
  await pkg(join(host, 'node_modules/present-optional-peer'), 'present-optional-peer', '1.0.0', {}, 'export default "wrong-optional-one"')
  const reference = join(nested, 'node_modules/@peer-fixture/plugin'); await mkdir(dirname(reference), { recursive: true }); await symlink(plugin, reference)
  return { installed, host, cjs, plugin }
}

test('portable publication runs hoisted CommonJS peers and scoped ESM peers from their original physical contexts after relocation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'portable-host-peers-')))
  try {
    const f = await fixture(root), candidate = join(root, 'candidate')
    const publication = await assemblePortableHost(candidate, process.execPath, f.host)
    const relocated = join(root, 'relocated'); await rename(candidate, relocated)
    // Neither cwd nor the original installation may supply an undeclared missing artifact edge.
    await rename(f.installed, join(root, 'retained-original'))
    const run = await exec(join(relocated, 'bin/agentmux-host'), ['literal argument with spaces'], { cwd: root, env: { ...process.env, NODE_PATH: '' } })
      .then(value => ({ code: 0, ...value }), error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), { one: 'runtime-one', two: { runtime: 'runtime-two', helper: 'scoped-two', optional: 'optional-present' }, args: ['literal argument with spaces'] })
    const versions = publication.packages.filter(item => item.name === 'runtime-peer').map(item => item.version).sort()
    assert.deepEqual(versions, ['1.0.0', '2.0.0'])
    const plugin = publication.packages.find(item => item.name === '@peer-fixture/plugin')
    assert.equal(plugin.dependencies.find(item => item.name === 'absent-optional-peer').packageId, null)
    assert.equal(plugin.dependencies.find(item => item.name === 'present-optional-peer').optional, true)
    assert.equal(plugin.dependencies.find(item => item.name === 'runtime-peer').optional, false)
    assert.equal((await exec(join(relocated, 'bin/amux'), [], { env: { ...process.env, NODE_PATH: '' } })).stdout.trim(), 'original-cli')
    assert.equal(publication.files.every(file => file.target === undefined || !file.target.startsWith('/')), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a missing required installed peer prevents an incomplete portable artifact while absent optional peers remain supported', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'portable-host-required-peer-')))
  try {
    const f = await fixture(root), manifest = JSON.parse(await readFile(join(f.cjs, 'package.json'), 'utf8'))
    manifest.peerDependencies['@peer-fixture/required-absent'] = '*'
    await put(join(f.cjs, 'package.json'), JSON.stringify(manifest))
    await assert.rejects(assemblePortableHost(join(root, 'candidate'), process.execPath, f.host), error => error.code === 'PACKAGE_DEPENDENCY_UNAVAILABLE' && error.message.includes('@peer-fixture/required-absent'))
    assert.equal(JSON.parse(await readFile(join(f.cjs, 'package.json'), 'utf8')).peerDependencies['@peer-fixture/required-absent'], '*')
  } finally { await rm(root, { recursive: true, force: true }) }
})
