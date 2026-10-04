import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, relative, join } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.argv[2] ?? join(root, '.tmp', 'session-durability-' + Date.now()))
await mkdir(output, { recursive: true })
const owned = ['packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/durable-write.ts']
const verification = ['packages/core/scripts/verify-session-durability.mjs', 'packages/core/test/agent-session-durability.test.ts',
  'packages/core/test/durable-write.test.ts', 'packages/core/test/fixtures/session-durability/writer.mjs',
  'packages/core/test/fixtures/session-durability/vitest.mutation.config.mts']
const sha = value => createHash('sha256').update(value).digest('hex')
const pin = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const before = await pin(owned), verificationInputs = await pin(verification), candidates = new Map(), receipts = [], runs = []
const temporary = await mkdtemp(join(tmpdir(), 'amx-source-durability-'))
try {
  await symlink(join(root, 'packages/core/node_modules'), join(temporary, 'node_modules'))
  const module = join(temporary, 'store.mjs')
  const bundled = await build({ entryPoints: [join(root, 'packages/core/src/agent-session-store.ts')], outfile: module,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true })
  for (const input of Object.keys(bundled.metafile.inputs)) {
    const path = relative(root, resolve(root, input))
    assert.ok(path.startsWith('packages/core/src/'), 'Private Store bundle must use current workspace source: ' + path)
    candidates.set(path, sha(await readFile(join(root, path))))
  }
  assert.ok(candidates.has(owned[0]), 'Private writer did not load the owning Store source')
  await writeFile(join(output, 'writer-source-inputs.json'), JSON.stringify({ source: Object.fromEntries(candidates),
    artifactSHA256: sha(await readFile(module)) }, null, 2) + '\n')
  async function run(name, mutant) {
    const receipt = join(output, name + '.loaded.jsonl')
    await writeFile(receipt, '')
    let result
    try {
      const value = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
        'packages/core/test/fixtures/session-durability/vitest.mutation.config.mts'], { cwd: root, env: { ...process.env,
        AGENTMUX_SESSION_DURABILITY_MUTANT: mutant ?? '', AGENTMUX_SESSION_DURABILITY_RECEIPT: receipt,
        AGENTMUX_TEST_DURABILITY_STORE_MODULE: module }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
      result = { code: 0, ...value }
    } catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
    const log = result.stdout + result.stderr
    await writeFile(join(output, name + '.log'), log)
    const loaded = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    for (const path of owned) assert.ok(loaded.some(fact => fact.path === path), 'Missing owning source load: ' + path)
    for (const fact of loaded) {
      if (candidates.has(fact.path)) assert.equal(fact.sourceSha, candidates.get(fact.path), 'Candidate source drift: ' + fact.path)
      candidates.set(fact.path, fact.sourceSha)
    }
    const changed = loaded.filter(fact => fact.replacements)
    if (mutant) {
      assert.ok(Number.isInteger(result.code) && result.code > 0)
      assert.match(log, /AssertionError/)
      assert.match(log, /Tests\s+[1-9]\d* failed/)
      assert.doesNotMatch(log, /Failed to load|Error during transform|No test files found/)
      assert.equal(changed.length, 1); assert.equal(changed[0].name, mutant); assert.equal(changed[0].replacements, 1)
      assert.equal(changed[0].sourceSha, before[changed[0].path]); assert.notEqual(changed[0].sourceSha, changed[0].transformedSha)
      receipts.push({ name, assertionRed: true, loaded: changed[0] })
    } else { assert.equal(result.code, 0, log); assert.match(log, /Tests\s+18 passed \(18\)/) }
    assert.deepEqual(await pin(owned), before)
    runs.push({ name, code: result.code, loaded: loaded.length, changed })
    process.stdout.write(name + ': ' + (result.code === 0 ? 'green' : 'red') + '\n')
  }
  await run('owning-green')
  for (const mutant of ['directory-ack-omitted', 'writer-lock-bypassed', 'readable-binding-discarded', 'confirmation-snapshot-bypassed']) await run(mutant, mutant)
  await run('restored-green')
  const callers = []
  for (const [path, pattern] of [
    ['packages/core/src/agent-session-registry.ts', /this\.store\.(?:compareAndSwap|commitLifecycle|confirmDurability)\(/g],
    ['packages/core/src/client.ts', /this\.registry\.(?:commitLifecycle|update|confirmDurability)\(/g],
    ['apps/desktop/src/main/desktop-host.ts', /AgentMuxFileAgentSessionStore/g]
  ]) {
    const source = await readFile(join(root, path), 'utf8'), matches = [...source.matchAll(pattern)]
    assert.ok(matches.length > 0, 'Production callers must be nonempty: ' + path)
    const sourceSha = sha(source); callers.push({ path, count: matches.length, sourceSha }); candidates.set(path, sourceSha)
  }
  for (const [path, hash] of candidates) assert.equal(sha(await readFile(join(root, path))), hash, 'Final source drift: ' + path)
  assert.deepEqual(await pin(verification), verificationInputs)
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ status: 'passed', source: before, candidateSources: Object.fromEntries(candidates),
    verificationInputs, runs, receipts, callers, userRuntimeTouched: false,
    processProof: 'Actual private SIGKILL, stable inode and independent source-bundled writers; not a physical power-cut experiment.' }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'passed', receipt: relative(root, join(output, 'receipt.json')), mutants: receipts.length, callers }))
} finally { await rm(temporary, { recursive: true, force: true }) }
