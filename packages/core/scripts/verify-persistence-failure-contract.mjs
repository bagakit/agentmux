import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, copyFile, symlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), core = join(root, 'packages/core')
const require = createRequire(join(core, 'package.json')), { build } = require('esbuild')
const output = resolve(process.argv[2] ?? join(root, '.tmp/persistence-failure-contract'))
const cliRoot = join(output, 'cli'), cli = join(cliRoot, 'bin/amux')
const sdk = process.env.CTXMUX_TEST_SDK_SOURCE
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(join(cliRoot, 'bin'), { recursive: true }); await mkdir(join(cliRoot, 'dist'), { recursive: true })
const compiled = await build({ entryPoints: [join(core, 'src/agentmux.ts')], outfile: join(cliRoot, 'dist/agentmux.js'),
  bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', metafile: true,
  ...(sdk ? { alias: { '@ctxmux/sdk': resolve(sdk) } } : {}) })
await copyFile(join(core, 'bin/amux'), cli)
await writeFile(join(cliRoot, 'package.json'), JSON.stringify({ type: 'module' }))
await symlink(join(core, 'node_modules'), join(cliRoot, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
const receipt = { schema: 'agentmux.persistence-failure-contract-proof.v1', passed: false,
  boundary: 'Finite Native wire through the actual SDK, Core, Hosted RPC and compiled CLI; actual SQLite/PTY recovery and restart are separately qualified in ctxmux.',
  cliSha256: sha(await readFile(join(cliRoot, 'dist/agentmux.js'))), compiledInputs: {}, cases: [] }
for (const path of Object.keys(compiled.metafile.inputs)) {
  receipt.compiledInputs[path] = sha(await readFile(resolve(path)))
}
async function run(name, files, filter, mutation) {
  const report = join(output, name + '.json'), loaded = join(output, name + '-loaded.ndjson')
  await writeFile(loaded, '')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'packages/core/test/persistence-recovery.config.mts', ...files, '--reporter=json', '--outputFile=' + report]
  if (filter) args.push('-t', filter)
  const outcome = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
      AGENTMUX_TEST_OBJECT_CLI: cli, AGENTMUX_PERSISTENCE_LOADED: loaded,
      ...(mutation ? { AGENTMUX_PERSISTENCE_MUTATION: mutation } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
    child.once('error', reject); child.once('close', code => resolveRun({ code, log }))
  })
  await writeFile(join(output, name + '.log'), outcome.log)
  const results = JSON.parse(await readFile(report, 'utf8'))
  const assertions = results.testResults.flatMap(value => value.assertionResults)
  const executed = assertions.filter(value => !['pending', 'todo', 'skipped'].includes(value.status))
  assert(executed.length, name + ': nonempty behavioral assertions required')
  assert(results.testResults.every(value => value.assertionResults.length > 0), name + ': suite load must reach assertions')
  if (!mutation) { assert.equal(outcome.code, 0, outcome.log); assert(executed.every(value => value.status === 'passed'), name) }
  else {
    assert.equal(outcome.code, 1, name + ': mutation must fail')
    assert(executed.some(value => value.status === 'failed' && value.failureMessages.some(message => message.includes('AssertionError'))), name + ': must fail a behavioral assertion')
    const records = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(records.some(value => value.mutation === mutation && value.originalSHA256 !== value.loadedSHA256), name + ': actual owner mutation must be loaded')
  }
  receipt.cases.push({ name, mutation: mutation ?? null, executed: executed.length, exitCode: outcome.code,
    reportSha256: sha(await readFile(report)), loadedSha256: sha(await readFile(loaded)) })
}
try {
  await run('wire', ['packages/core/test/persistence-failure-contract.test.ts', 'packages/core/test/run-storage-observation.test.ts'])
  await run('input', ['packages/core/test/ctxmux-native-service.test.ts'], 'preserves the public input')
  await run('drop-creation-receipt', ['packages/core/test/persistence-failure-contract.test.ts'], 'preserves exact creation', 'drop-creation-receipt')
  await run('drop-storage-diagnostic', ['packages/core/test/persistence-failure-contract.test.ts'], 'preserves exact creation|carries the original structured', 'drop-storage-diagnostic')
  receipt.passed = true
} finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json') }))
