import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '../../..')
const evidence = join(repo, '.tmp/agentmux-private-mobile-client/private-access-status/certificate-preparation')
await mkdir(evidence, { recursive: true })
const paths = ['apps/host/src/certificate-preparation.ts', 'apps/host/test/certificate-preparation.test.ts',
  'apps/host/scripts/verify-certificate-preparation.mjs']
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path,
  createHash('sha256').update(await readFile(join(repo, path))).digest('hex')])))
const source = await hashes()
const run = mutation => spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run',
  'apps/host/test/certificate-preparation.test.ts'], { cwd: repo, encoding: 'utf8',
  env: { ...process.env, ...(mutation ? { AGENTMUX_CERTIFICATE_PREPARATION_MUTATION: mutation } : {}) } })
const green = run(); await writeFile(join(evidence, 'green.log'), `${green.stdout}${green.stderr}`)
assert.equal(green.status, 0, `${green.stdout}${green.stderr}`); assert.match(green.stdout, /2 passed/u)
const proofs = []
for (const id of ['artifact-gate-removed', 'caller-cwd-selects-helper', 'node-env-claims-electron']) {
  const result = run(id), output = `${result.stdout}${result.stderr}`
  await writeFile(join(evidence, `${id}.log`), output)
  assert.equal(result.status, 1, output); assert.ok(output.includes(`AMX_CERTIFICATE_HELPER_MUTANT:${id}`))
  assert.match(output, /AssertionError/u); proofs.push({ id, sourceBlockApplied: true, assertionRed: true })
}
const restored = run(); await writeFile(join(evidence, 'restored-green.log'), `${restored.stdout}${restored.stderr}`)
assert.equal(restored.status, 0); assert.match(restored.stdout, /2 passed/u)
assert.deepEqual(await hashes(), source)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), source,
  behaviorCases: 2, sourceMutations: proofs, restoredGreen: { exitCode: restored.status, cases: 2 },
  productCallerJoined: false, limitations: ['Exact same-directory Node artifact/FS behavior only; original Host device.ls caller awaits the common reviewed public state type.',
    'Plain Node is verified with ELECTRON_RUN_AS_NODE=1 remaining false; no installed Electron artifact or physical phone claim.'] }, null, 2) + '\n')
console.log('Fixed certificate preparation locator: 2 actual Node/FS cases, 3 Source block AssertionRED, restored GREEN; Host caller pending the common public type.')
