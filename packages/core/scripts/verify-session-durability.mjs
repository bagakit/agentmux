import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, relative, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const output = join(root, '.tmp', 'session-durability-' + Date.now())
await mkdir(output, { recursive: true })
const owned = ['packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/durable-write.ts']
const sha = v => createHash('sha256').update(v).digest('hex')
const pin = async () => Object.fromEntries(await Promise.all(owned.map(async p => [p, sha(await readFile(join(root, p)))])))
const before = await pin()
const receipts = []
async function run(name, mutant) {
 const receipt = join(output, name + '.loaded.jsonl')
 const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/fixtures/session-durability/vitest.mutation.config.mts', '--root', '.', '--maxWorkers=1']
 const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
   ...(mutant ? { AGENTMUX_SESSION_DURABILITY_MUTANT: mutant, AGENTMUX_SESSION_DURABILITY_RECEIPT: receipt } : {}) }, stdio: ['ignore','pipe','pipe'] })
 let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
 const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok) })
 await writeFile(join(output, name + '.log'), text)
 if (mutant) {
  assert.notEqual(code, 0); assert.match(text, /AssertionError:/)
  assert.doesNotMatch(text, /Failed to load|Error during transform|No test files found/)
  const loaded = (await readFile(receipt,'utf8')).trim().split('\n').map(v => JSON.parse(v))
  assert.equal(loaded.length, 1); assert.equal(loaded[0].replacements, 1)
  assert.equal(loaded[0].sourceSha, before[loaded[0].path]); assert.notEqual(loaded[0].sourceSha, loaded[0].transformedSha)
  receipts.push({ name, assertionRed: true, loaded: loaded[0] })
 } else { assert.equal(code, 0, text); assert.match(text, /Tests\s+18 passed \(18\)/) }
 assert.deepEqual(await pin(), before)
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
 const source = await readFile(join(root, path), 'utf8'); const matches = [...source.matchAll(pattern)]
 assert(matches.length > 0, 'Production callers must be nonempty: ' + path)
 callers.push({ path, count: matches.length, sourceSha: sha(source) })
}
await writeFile(join(output,'receipt.json'),JSON.stringify({ status: 'passed', source: before, receipts, callers,
 processProof: 'Real SIGKILL, stable inode and independent writers; not a physical power-cut experiment.' }, null, 2)+'\n')
console.log(JSON.stringify({ status:'passed', receipt:relative(root,join(output,'receipt.json')), mutants:receipts.length, callers }))
