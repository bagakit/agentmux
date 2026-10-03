import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('../../../', import.meta.url)), out = join(root, '.tmp/project-group-public-commit')
mkdirSync(out, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const owner = 'packages/core/dist/public-rpc-service.js', source = 'packages/core/src/public-rpc-service.ts'
const inputs = ['packages/core/test/project-group-public-commit.test.ts', 'packages/core/src/agentmux-cli-commands.ts', source,
  'packages/core/src/spatial-state.ts', 'packages/core/src/spatial-graph.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/src/agentmux.ts', 'packages/core/src/rpc-native-codec.ts', 'packages/core/test/helpers/object-cli-rpc.ts',
  'packages/core/scripts/verify-project-group-public-commit.mjs']
const hashes = () => Object.fromEntries(inputs.map(p => [p, sha(readFileSync(join(root, p)))]))
const receipt = { passed: false, inputs: hashes(), boundary: 'Private populated durable Core owner, typed public client, actual compiled CLI; zero lifecycle clients and no user Runtime.' }
const copy = join(out, 'private-consumer')
assert.equal(existsSync(copy), false, 'A prior private consumer needs inspection before reusing this path')
let original
function run(name, red = false) {
  const report = join(out, name + '.json'), loaded = join(out, name + '-loaded.jsonl'), hook = join(out, name + '-hook.mjs'), config = join(out, name + '.config.mts')
  writeFileSync(loaded, '')
  writeFileSync(hook, `import {registerHooks} from 'node:module';import {appendFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';registerHooks({load(url,context,next){const r=next(url,context);if(url===${JSON.stringify(pathToFileURL(join(copy, owner)).href)})appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id:fileURLToPath(url),sha256:createHash('sha256').update(readFileSync(fileURLToPath(url))).digest('hex')})+'\\n');return r}})`)
  writeFileSync(config, `import {defineConfig} from 'vitest/config';import {appendFileSync,readFileSync} from 'node:fs';import {createHash} from 'node:crypto';export default defineConfig({root:${JSON.stringify(copy)},plugins:[{name:'actual-loaded-owner',transform(_code,id){if(id===${JSON.stringify(join(copy, owner))})appendFileSync(${JSON.stringify(loaded)},JSON.stringify({id,sha256:createHash('sha256').update(readFileSync(id)).digest('hex')})+'\\n')}}],test:{include:['packages/core/test/project-group-public-commit.test.ts'],passWithNoTests:false,maxWorkers:1}})`)
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report],
    { cwd: copy, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: ((process.env.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(hook).href).trim() } })
  writeFileSync(join(out, name + '.log'), result.stdout + result.stderr)
  assert.equal(result.status, red ? 1 : 0, result.stdout + result.stderr)
  const data = JSON.parse(readFileSync(report)), assertions = data.testResults.flatMap(r => r.assertionResults)
  assert.equal(assertions.length, 4); assert.equal(assertions.every(a => ['passed', 'failed'].includes(a.status)), true)
  assert.equal(data.numTotalTests, 4); assert.equal(data.numFailedTests > 0, red)
  if (red) for (const label of ['typed public client dissolves', 'actual compiled CLI discovers and consumes'])
    assert.ok(assertions.some(a => a.fullName.startsWith(label) && a.status === 'failed'), 'Both real consumers must detect lost forwarding')
  const loadedRecords = readFileSync(loaded, 'utf8').trim().split('\n').map(line => JSON.parse(line)), ownerHash = sha(readFileSync(join(copy, owner)))
  assert.ok(loadedRecords.length >= 2 && loadedRecords.every(r => r.id === join(copy, owner) && r.sha256 === ownerHash))
  return { exitCode: result.status, total: 4, failed: data.numFailedTests, ownerSha256: ownerHash, report: relative(root, report), reportSha256: sha(readFileSync(report)), loaded: relative(root, loaded), loadedSha256: sha(readFileSync(loaded)) }
}
try {
for (const p of ['packages/core/dist', 'packages/core/bin', 'packages/core/src', 'packages/core/test/helpers',
  'packages/core/test/project-group-public-commit.test.ts', 'packages/core/package.json', 'tsconfig.base.json']) {
  mkdirSync(dirname(join(copy, p)), { recursive: true }); cpSync(join(root, p), join(copy, p), { recursive: true })
}
for (const p of ['node_modules', 'packages/core/node_modules']) symlinkSync(join(root, p), join(copy, p))
original = readFileSync(join(copy, owner), 'utf8')
const anchor = '...(p.removedProjectGroupIds === undefined ? {} : { removedProjectGroupIds: p.removedProjectGroupIds })'
assert.equal(original.split(anchor).length - 1, 1, 'Qualified compiled forwarding must exist once')
receipt.baseline = run('baseline')
  const transformed = original.replace(anchor, '')
  writeFileSync(join(out, 'lost-exact-forwarding.compiled.js'), transformed)
  try {
    writeFileSync(join(copy, owner), transformed)
    receipt.red = run('lost-exact-forwarding', true)
  } finally { writeFileSync(join(copy, owner), original) }
  receipt.restored = run('restored')
assert.deepEqual(hashes(), receipt.inputs)
receipt.callers = [{ path: 'packages/core/src/agentmux.ts', symbol: 'client.call(method, invocation.params' },
  { path: source, symbol: 'this.spatial.commit' }]
for (const c of receipt.callers) assert.ok(readFileSync(join(root, c.path), 'utf8').includes(c.symbol))
receipt.compiledCliSha256 = sha(readFileSync(join(root, 'packages/core/dist/agentmux.js')))
receipt.passed = true

} finally {
  rmSync(copy, { recursive: true, force: true }); receipt.privateConsumerRemoved = !existsSync(copy)
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: true, tests: 4, loadedMutation: true, actualPublicConsumers: ['typed RPC', 'compiled CLI'] }))
