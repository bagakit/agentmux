import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const tests = { core: 'packages/core/test/capsule-links.test.ts', ui: 'packages/client-ui/test/capsule-links.test.tsx' }
const mutations = [
  { id: 'canonical-link-check-lost', suite: 'core', file: 'packages/core/src/sharing.ts',
    from: 'if (formatAmuxObjectLink(target) !== raw)', to: 'if (false)',
    assertion: 'round trips the exact original Capsule identity without executable additions or normalization' },
  { id: 'typed-capsule-match-lost', suite: 'core', file: 'packages/core/src/search-metadata.ts',
    from: " || original.kind === 'capsule'", to: '',
    assertion: 'matches Capsule links by their typed identity without confusing an Agent or spatial scalar' },
  { id: 'original-capsule-source-lost', suite: 'core', file: 'packages/core/src/public-rpc-service.ts',
    from: "this.ports.capsules || this.ports.forwardControl ? { capsules: { hostId: 'local',",
    to: "false ? { capsules: { hostId: 'local',",
    assertion: 'finds the original Capsule through actual public search and the compiled CLI using the same owner' },
  { id: 'shared-capsule-reader-lost', suite: 'ui', file: 'packages/client-ui/src/lib/object-link-reference.ts',
    from: 'return { uri, target, ...(label ? { label } : {}) }',
    to: "return target.kind === 'capsule' ? null : { uri, target, ...(label ? { label } : {}) }",
    assertion: 'delivers the same exact Capsule reference through both shared Markdown and plain conversation readers' }
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-links-proof-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.capsule-links-proof.v1', passed: false,
  boundary: 'Strict canonical Core object links, actual public metadata RPC/compiled CLI with original Node Capsule owner, and production shared Markdown/conversation readers. Desktop navigation and Browser visibility are separate owning proofs.',
  inputs: {}, baseline: {}, mutations: [] }
async function run(name, suite, mutation) {
  const report = join(directory, `${name}.json`), config = join(directory, `${name}.config.mts`)
  let plugin = ''
  if (mutation) {
    const source = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.from).length - 1, 1, `${name}: unique actual source anchor required`)
    const changed = source.replace(mutation.from, mutation.to)
    receipt.inputs[mutation.file] = sha(source); mutation.loadedSha256 = sha(changed)
    plugin = `,{name:'capsule-links-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, mutation.file))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation source unavailable');return {code:code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)}),map:null}}}}`
  }
  const base = suite === 'ui' ? 'packages/client-ui/test/capsule-links.config.mts' : 'vitest.config.ts'
  await writeFile(config, `import base from ${JSON.stringify(join(root, base))};export default {...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[])${plugin}],test:{...base.test,include:[${JSON.stringify(tests[suite])}],maxWorkers:1,passWithNoTests:false}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) args.push('-t', mutation.assertion)
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolveRun({ code, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(`${name}: infrastructure failure is not semantic RED. ${result.output.slice(-4000)}`) }
  const assertions = data.testResults.flatMap(value => value.assertionResults)
  assert.ok(assertions.length > 0); assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  if (mutation) {
    assert.equal(result.code, 1, result.output.slice(-4000))
    assert.ok(assertions.some(value => value.status === 'failed' && value.fullName.includes(mutation.assertion) && value.failureMessages.some(message => message.includes('AssertionError'))),
      `${name}: designated production behavior assertion must fail`)
  } else { assert.equal(result.code, 0, result.output.slice(-4000)); assert.equal(data.numFailedTests, 0); assert.ok(data.numPassedTests > 0) }
  return { exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests, reportSha256: sha(await readFile(report)),
    ...(mutation ? { id: mutation.id, source: mutation.file, loadedSha256: mutation.loadedSha256, assertion: mutation.assertion } : {}) }
}
try {
  for (const file of [...Object.values(tests), 'packages/core/src/sharing.ts', 'packages/core/src/search-contract.ts', 'packages/core/src/search-metadata.ts',
    'packages/core/src/search-observation.ts', 'packages/core/src/search-codec.ts', 'packages/core/src/public-rpc-service.ts', 'packages/client-ui/src/lib/object-link-reference.ts']) receipt.inputs[file] = sha(await readFile(join(root, file)))
  receipt.baseline.core = await run('core', 'core'); receipt.baseline.ui = await run('shared-reader', 'ui')
  if (process.argv.includes('--mutations')) for (const mutation of mutations) receipt.mutations.push(await run(mutation.id, mutation.suite, mutation))
  receipt.passed = true
} finally {
  const at = process.argv.indexOf('--output')
  if (at >= 0) { assert.ok(process.argv[at + 1]); await writeFile(resolve(process.argv[at + 1]), JSON.stringify(receipt, null, 2) + '\n') }
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
