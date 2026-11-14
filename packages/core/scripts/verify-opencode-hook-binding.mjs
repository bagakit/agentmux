import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const evidence = join(root, '.local/hook-durability/opencode-proof')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const mutations = process.argv.includes('--mutations')
const version = '1.18.25'
const config = 'packages/core/test/vitest.opencode-hook-binding.config.mts'
const owner = join(root, 'packages/core/src/providers/opencode.ts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const original = hash(await readFile(owner))

async function nativeBinary() {
  const supplied = process.env.AGENTMUX_OPENCODE_NATIVE_BINARY
  if (supplied) {
    assert((await stat(supplied)).isFile())
    const { stdout } = await exec(supplied, ['--version'])
    assert.equal(stdout.trim(), version)
    await writeFile(join(evidence, 'selected-artifact.json'), JSON.stringify({ path: supplied, version,
      binarySHA256: hash(await readFile(supplied)), bytes: (await stat(supplied)).size }, null, 2) + '\n', { mode: 0o600 })
    return supplied
  }
  // A private proof input, never an installation into user PATH or Provider settings.
  const name = `opencode-${process.platform}-${process.arch}`
  const directory = join(evidence, name)
  const binary = join(directory, 'package/bin/opencode')
  try {
    assert((await stat(binary)).isFile())
    const { stdout } = await exec(binary, ['--version'])
    assert.equal(stdout.trim(), version)
    const artifact = JSON.parse(await readFile(join(directory, 'artifact.json'), 'utf8'))
    assert.equal(hash(await readFile(binary)), artifact.binarySHA256, 'Cached native proof artifact changed')
    return binary
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const response = await fetch(`https://registry.npmjs.org/${name}/${version}`)
  assert(response.ok, `Native artifact metadata unavailable: ${response.status}`)
  const metadata = await response.json()
  assert.equal(metadata.name, name); assert.equal(metadata.version, version)
  const download = await fetch(metadata.dist.tarball)
  assert(download.ok, `Native artifact unavailable: ${download.status}`)
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, metadata.dist.integrity)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const archive = join(directory, 'native.tgz')
  await writeFile(archive, bytes, { mode: 0o600 })
  await exec('tar', ['-xzf', archive, '-C', directory, 'package/bin/opencode'])
  await chmod(binary, 0o700)
  const { stdout } = await exec(binary, ['--version'])
  assert.equal(stdout.trim(), version)
  await writeFile(join(directory, 'artifact.json'), JSON.stringify({ name, version, integrity: metadata.dist.integrity,
    binarySHA256: hash(await readFile(binary)), bytes: (await stat(binary)).size }, null, 2) + '\n', { mode: 0o600 })
  await rm(archive)
  return binary
}

async function run(mutant) {
  const label = mutant ?? 'positive', loaded = join(evidence, `${label}.loaded.ndjson`)
  await writeFile(loaded, '')
  const env = { ...process.env, AGENTMUX_OPENCODE_LOADED: loaded }
  delete env.AGENTMUX_OPENCODE_MUTANT; delete env.AGENTMUX_OPENCODE_NATIVE_BINARY
  if (mutant) env.AGENTMUX_OPENCODE_MUTANT = mutant
  else {
    env.AGENTMUX_OPENCODE_NATIVE_BINARY = await nativeBinary()
    env.AGENTMUX_OPENCODE_NATIVE_RECEIPT = join(evidence, 'native-receipt.json')
  }
  let result
  try {
    result = { ...(await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      '--reporter=default', '--reporter=json', '--outputFile=' + join(evidence, label + '.vitest.json')], { cwd: root, env, maxBuffer: 8 * 1024 * 1024 })), code: 0 }
  } catch (error) { result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code } }
  const output = result.stdout + result.stderr
  await writeFile(join(evidence, `${label}.log`), output)
  const actual = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert(actual.length > 0 && actual.every(entry => entry.originalSHA256 === original), 'Proof did not consume the current production owner')
  if (mutant) {
    assert(actual.some(entry => entry.mutant === mutant && entry.applied), 'Selected owner mutation was not loaded')
    assert.notEqual(result.code, 0, `Production mutant survived: ${mutant}`)
    assert(/Tests\s+.*[1-9]\d* failed/.test(output) && /AssertionError|expected/.test(output), 'Mutation failed before nonempty semantic assertions ran')
  } else {
    assert.equal(result.code, 0, output)
    assert(/Tests\s+.*[1-9]\d* passed/.test(output), 'No semantic test was executed')
    const native = JSON.parse(await readFile(env.AGENTMUX_OPENCODE_NATIVE_RECEIPT, 'utf8'))
    assert.equal(native.nativeHostCount, 3); assert.equal(native.nativeSessionCount, 4); assert.equal(native.outsideIngress, false)
    assert.equal(native.sharedServerForeignSubjectFenced, true)
    assert.equal(native.childrenReaped, true); assert.equal(native.sharedPluginUnchanged, true)
    assert.equal(native.originalRunIds.length, 2)
  }
  return { label, code: result.code, loadedOwner: actual.length, assertionsExecuted: true }
}

const results = []
for (const mutant of mutations ? ['last-binding-wins', 'foreign-host-admitted', 'external-host-claimed', 'persist-run-environment'] : [undefined]) {
  results.push(await run(mutant))
  process.stdout.write(`${mutant ?? 'positive'}: passed\n`)
}
assert.equal(hash(await readFile(owner)), original, 'Production owner changed during qualification')
await writeFile(join(evidence, mutations ? 'mutations.json' : 'positive.json'), JSON.stringify({ ownerSHA256: original, results,
  scope: mutations ? 'Loaded production Provider owner; original-binding, external-host, passive-host and shared-source semantic assertions.' :
    'Source Provider, actual Hook ingress, scoped Core inspection and verified native TUI Workers with multiple native Sessions.',
  passed: true }, null, 2) + '\n', { mode: 0o600 })
