import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const test = 'packages/core/test/capsule-public-rpc.test.ts'
const mutations = [
  { id: 'caller-projection-lost', file: 'packages/core/src/public-rpc-service.ts',
    from: 'caller: { hostId: caller.hostId, agentSessionId: caller.agentSessionId }',
    to: "caller: { hostId: caller.hostId, agentSessionId: 'unauthenticated-replacement' }",
    assertion: 'passes authenticated caller separately from producer-declared source' },
  { id: 'human-admission-lost', file: 'packages/core/src/public-rpc-service.ts',
    from: "if (method === 'capsule.interaction.reply' && (caller || !principal))",
    to: "if (false && method === 'capsule.interaction.reply' && (caller || !principal))",
    assertion: 'refuses managed Human attribution before touching the reply owner' },
  { id: 'result-target-validation-lost', file: 'packages/core/src/capsule.ts',
    from: 'return parseCapsuleResult(method, value, input)',
    to: 'return parseCapsuleResult(method, value)',
    assertion: 'rejects another owner target on both service and client result boundaries' },
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-core-proof-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.capsule-core-proof.v1', passed: false,
  boundary: 'Focused production source, real Unix RPC/client dispatch and compiled offline CLI guidance; full Node hosting/restart and Desktop presentation are separate product proofs.',
  inputs: {}, baseline: null, mutations: [] }

async function run(name, mutation) {
  const report = join(directory, `${name}.json`), config = join(directory, `${name}.config.mts`)
  let plugin = ''
  if (mutation) {
    const source = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.from).length - 1, 1, `${mutation.id}: source anchor must be unique`)
    const transformed = source.replace(mutation.from, mutation.to)
    assert.notEqual(sha(source), sha(transformed))
    receipt.inputs[mutation.file] = sha(source)
    // Vite mutates the actual owning implementation as loaded, never shared source or dist.
    plugin = `plugins:[{name:'capsule-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, mutation.file))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation source anchor unavailable');return {code:code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)}),map:null}}}}],`
    mutation.loadedSha256 = sha(transformed)
  }
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};export default {...base,root:${JSON.stringify(root)},${plugin}test:{...base.test,include:[${JSON.stringify(test)}],passWithNoTests:false,maxWorkers:1}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) args.push('-t', mutation.assertion)
    const child = spawn(process.execPath, args, { cwd: root,
      env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolveRun({ code, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(`${name}: no valid test report; infrastructure failure is not semantic RED. ${result.output.slice(-4000)}`) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'An empty suite is not proof')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  const failures = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(result.code, 1, `${name}: source mutation must fail. ${result.output.slice(-4000)}`)
    assert.ok(failures.some(item => item.fullName.includes(mutation.assertion) && item.failureMessages.some(message => message.includes('AssertionError'))),
      `${name}: designated business assertion must fail, not collection/preparation`)
  } else {
    assert.equal(result.code, 0, result.output.slice(-4000)); assert.equal(data.numFailedTests, 0)
    assert.ok(data.numPassedTests > 0, 'Baseline must execute real assertions')
  }
  return { exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    reportSha256: sha(await readFile(report)), ...(mutation ? { id: mutation.id, source: mutation.file,
      loadedSha256: mutation.loadedSha256, assertion: mutation.assertion } : {}) }
}

try {
  receipt.inputs[test] = sha(await readFile(join(root, test)))
  receipt.baseline = await run('baseline')
  if (process.argv.includes('--mutations')) for (const mutation of mutations) receipt.mutations.push(await run(mutation.id, mutation))
  receipt.passed = true
} finally {
  const targetIndex = process.argv.indexOf('--output')
  if (targetIndex >= 0) {
    const path = process.argv[targetIndex + 1]
    assert.ok(path, '--output requires an evidence file')
    await writeFile(resolve(path), JSON.stringify(receipt, null, 2) + '\n')
  }
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
