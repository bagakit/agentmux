import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), directory = join(root, '.local/t023-tcp'); await mkdir(directory, { recursive: true })
const results = []
function run(args) {
 const result = spawnSync(process.execPath, [join(root, 'apps/desktop/scripts/verify-browser-proxy-transport-tcp.mjs'), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
 const metadata = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(value => value?.receipt).at(-1)
 assert.ok(metadata, 'Native qualification must emit an original receipt even when the loaded business mutation is RED')
 return { result, metadata }
}
for (const name of ['connect', 'unknown', 'scope', 'header']) {
 const red = run(['--mutation='+name]); await writeFile(join(directory, name+'-red.log'), red.result.stdout+red.result.stderr)
 const original = JSON.parse(await readFile(red.metadata.receipt, 'utf8'))
 assert.notEqual(red.result.status, 0); assert.equal(original.tcpPassed, false); assert.equal(original.taskComplete, false)
 assert.equal(original.mutationHits.length, 1); assert.equal(original.mutationHits[0].name, name); assert.deepEqual(original.sourceDrift, [])
 assert.ok(original.processes.length > 0, 'The mutation must reach a real native process, not fail compilation')
 const first = JSON.parse(await readFile(join(original.out, 'first.json'), 'utf8'))
 if (name === 'connect') { assert.equal(first.stage, 'original-HTTPS-CONNECT-pages'); assert.match(first.failure?.message ?? '', /ERR_TUNNEL_CONNECTION_FAILED/u) }
 else if (name === 'unknown') { assert.equal(first.stage, 'unknown-observations-keep-healthy-route'); assert.match(first.failure?.stack ?? '', /AssertionError/u) }
 else if (name === 'scope') { assert.equal(first.stage, 'public-network-owner'); assert.match(first.failure?.stack ?? '', /AssertionError/u) }
 else { assert.equal(first.passed, true); assert.match(original.failure?.message ?? '', /Private proxy authorization must never reach the original endpoint/u) }
 const green = run([]); await writeFile(join(directory, name+'-restored.log'), green.result.stdout+green.result.stderr)
 const restored = JSON.parse(await readFile(green.metadata.receipt, 'utf8'))
 assert.equal(green.result.status, 0); assert.equal(restored.tcpPassed, true); assert.equal(restored.taskComplete, false); assert.deepEqual(restored.sourceDrift, [])
 assert.equal(restored.processes.length, 2); assert.notEqual(restored.processes[0].originalPid, restored.processes[1].originalPid)
 for (const process of restored.processes) { assert.equal(process.exitCode, 0); assert.deepEqual(process.remaining, []) }
 results.push({ name, productionLoaded: original.mutationHits[0], red: red.metadata.receipt, restored: green.metadata.receipt, redExit: red.result.status, restoredExit: green.result.status })
 await writeFile(join(directory, 'mutations.json'), JSON.stringify(results, null, 2)); console.log(name+' native business RED→restored GREEN')
}
