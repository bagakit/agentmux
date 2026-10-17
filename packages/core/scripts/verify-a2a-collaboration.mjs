import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collaborationMutations, collaborationTests } from './lib/a2a-collaboration-cases.mjs'

const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp/a2a-collaboration')
const config = 'packages/core/test/vitest.a2a-collaboration.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFile(resolve(root, path))
const digest = async path => hash(await read(path))
const scopes = Object.keys(collaborationTests)
const args = process.argv.slice(2)
const sourceOnly = args.includes('--source-only'), joining = args.includes('--join')
const scope = args[args.indexOf('--scope') + 1]
assert.ok(args.every((arg, index) => ['--source-only', '--join', '--scope'].includes(arg) || args[index - 1] === '--scope'), 'Unknown proof argument')
assert.ok(joining ? !sourceOnly && !args.includes('--scope') : scopes.includes(scope), 'Use --scope discovery|broadcast|spawn [--source-only], or --join')
await mkdir(base, { recursive: true })
const json = async path => JSON.parse(await read(path))
async function unchanged(inputs) {
  assert.ok(Object.keys(inputs).length > 0, 'Proof inputs must be nonempty')
  for (const [path, sha] of Object.entries(inputs)) assert.equal(await digest(path), sha, 'Candidate changed: ' + path)
}
async function reviewFor(scope, inputs) {
  const path = `docs/reviews/a2a-collaboration-observability/implementation-${scope}.json`
  const artifact = await json(path)
  assert.equal(artifact.schema, 'agentmux.a2a-collaboration-review.v1'); assert.equal(artifact.scope, scope)
  assert.equal(artifact.approved, true); assert.deepEqual(artifact.unresolved, [])
  assert.ok(artifact.author && artifact.reviewer && artifact.author !== artifact.reviewer, 'Review must have a non-author reviewer')
  await unchanged(artifact.inputs)
  assert.ok(Object.keys(artifact.inputs).some(path => path.startsWith('packages/core/src/')), 'Review must inspect product code')
  assert.ok(Object.keys(artifact.inputs).some(path => path in inputs), 'Review must cover the executed candidate')
  return { path, sha256: await digest(path), reviewer: artifact.reviewer, inputs: artifact.inputs }
}
if (joining) {
  const receipts = await Promise.all(scopes.map(async scope => {
    const pointer = await json(join(base, scope + '.json')), receipt = await json(pointer.receipt)
    assert.equal(receipt.schema, 'agentmux.a2a-collaboration-proof.v1'); assert.equal(receipt.scope, scope)
    assert.equal(receipt.qualified, true); assert.equal(receipt.sourceOnly, false)
    assert.ok(receipt.compiled.tests > 0 && receipt.cases.length > 0)
    await unchanged(receipt.inputs); await unchanged(receipt.compiledInputs)
    assert.deepEqual(await reviewFor(scope, receipt.inputs), receipt.review)
    return { scope, receipt: pointer.receipt, sha256: await digest(pointer.receipt), inputs: receipt.inputs }
  }))
  const shared = new Map()
  for (const receipt of receipts) for (const [path, sha] of Object.entries(receipt.inputs)) {
    if (shared.has(path)) assert.equal(shared.get(path), sha, 'Scopes qualified different candidates: ' + path)
    shared.set(path, sha)
  }
  await writeFile(join(base, 'join.json'), JSON.stringify({ schema: 'agentmux.a2a-collaboration-join.v1', qualified: true, receipts }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ qualified: true, receipt: relative(root, join(base, 'join.json')) }) + '\n')
} else {
  const attempt = await mkdtemp(join(base, scope + '-')), receiptPath = join(attempt, 'receipt.json')
  const receipt = { schema: 'agentmux.a2a-collaboration-proof.v1', scope, sourceOnly, qualified: false, sourcePassed: false,
    sharedTreeMutations: 0, cases: [], inputs: {} }
  async function files(directory) {
    return (await readdir(directory, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  }
  const ownInputs = [config, 'packages/core/scripts/verify-a2a-collaboration.mjs', 'packages/core/scripts/lib/a2a-collaboration-cases.mjs', ...[collaborationTests[scope]].flat(),
    ...(scope === 'spawn' ? ['packages/core/test/fixtures/a2a-spawn/owner.mjs'] : [])]
  const known = new Map()
  async function run(label, tests, mutation, env = {}) {
    const output = join(attempt, label + '.json'), loaded = join(attempt, label + '.loaded.jsonl')
    await writeFile(loaded, '')
    const environment = { ...process.env, ...env, AGENTMUX_COLLABORATION_LOADED: loaded }
    delete environment.AGENTMUX_COLLABORATION_MUTATION
    delete environment.AGENTMUX_TEST_RPC_CORE_ENTRY
    if (mutation) environment.AGENTMUX_COLLABORATION_MUTATION = mutation.name
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
        ...[tests].flat(), '--reporter=json', '--outputFile=' + output], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''
      child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, log }))
    })
    await writeFile(join(attempt, label + '.log'), result.log)
    const report = await json(output), records = (await readFile(loaded, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.equal(result.signal, null, label + ': interrupted'); assert.ok(report.numTotalTests > 0, label + ': empty inventory')
    for (const test of [tests].flat()) assert.ok(report.testResults.some(suite => resolve(suite.name) === resolve(root, test) && suite.assertionResults.length > 0),
      label + ': required test inventory was not collected: ' + test)
    assert.ok(records.length > 0, label + ': no source inputs observed')
    for (const record of records) {
      const sha = await digest(record.file)
      assert.equal(record.sourceSHA256, sha, label + ': source changed during execution: ' + record.file)
      if (known.has(record.file)) assert.equal(known.get(record.file), sha, label + ': candidate changed between proof cases: ' + record.file)
      known.set(record.file, sha)
    }
    const failed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
    const assertions = failed.filter(test => test.failureMessages.some(message => message.includes('AssertionError') || /__VITEST_(?:RESOLVES|REJECTS)__/u.test(message))).length
    const transformed = records.filter(record => record.mutation)
    if (mutation) {
      assert.ok(result.code > 0 && report.numFailedTests > 0 && assertions > 0, label + ': mutation must fail a behavior assertion')
      assert.ok(transformed.length > 0 && transformed.every(record => record.mutation === mutation.name && record.file === mutation.file && record.sourceSHA256 !== record.compilerInputSHA256), label + ': actual target was not mutated')
    } else {
      assert.equal(result.code, 0, label + ': baseline failed; inspect its retained log')
      assert.equal(report.numFailedTests, 0); assert.equal(transformed.length, 0)
    }
    return { tests: report.numTotalTests, failed: report.numFailedTests, assertions,
      report: relative(root, output), loaded: relative(root, loaded), transformed }
  }
  try {
    if (!sourceOnly) {
      const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(join(root, 'vitest.dist-freshness.ts')).href)
      await assertWorkspaceDistBuiltFromCurrentSource(root)
      receipt.compiledInputs = Object.fromEntries(await Promise.all((await files(join(root, 'packages/core/dist'))).map(async path => [relative(root, path), await digest(path)])))
    }
    for (const path of ownInputs) known.set(path, await digest(path))
    receipt.baseline = await run('baseline', collaborationTests[scope])
    const mutations = collaborationMutations.filter(item => item.scope === scope)
    assert.ok(mutations.length > 0, 'No owning mutations for ' + scope)
    for (const mutation of mutations) {
      const red = await run(mutation.name + '-red', collaborationTests[scope], mutation)
      receipt.cases.push({ name: mutation.name, red })
    }
    receipt.restored = await run('restored', collaborationTests[scope])
    receipt.inputs = Object.fromEntries(known)
    await unchanged(receipt.inputs); receipt.sourcePassed = true
    if (!sourceOnly) {
      const compiledTest = scope === 'spawn' ? 'packages/core/test/a2a-collaboration-spawn-native.test.ts' : 'packages/core/test/a2a-collaboration-cli.test.ts'
      receipt.inputs[compiledTest] = await digest(compiledTest)
      receipt.compiled = await run('compiled-consumer', compiledTest, undefined, {
        AGENTMUX_TEST_COLLABORATION_SCOPE: scope,
        AGENTMUX_TEST_COLLABORATION_CORE: pathToFileURL(join(root, 'packages/core/dist/index.js')).href,
        AGENTMUX_TEST_COLLABORATION_CLI: join(root, 'packages/core/bin/amux') })
      receipt.inputs = { ...Object.fromEntries(known), [compiledTest]: receipt.inputs[compiledTest] }
      await unchanged(receipt.inputs); await unchanged(receipt.compiledInputs)
      receipt.review = await reviewFor(scope, receipt.inputs)
      receipt.qualified = true
    }
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    receipt.inputs = { ...Object.fromEntries(known), ...receipt.inputs }
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    await writeFile(join(base, scope + (sourceOnly ? '-source' : '') + '.json'), JSON.stringify({ receipt: relative(root, receiptPath) }) + '\n')
  }
  assert.ok(sourceOnly ? receipt.sourcePassed : receipt.qualified, receipt.failure?.message)
  process.stdout.write(JSON.stringify({ sourcePassed: receipt.sourcePassed, qualified: receipt.qualified, sourceOnly,
    receipt: relative(root, receiptPath) }) + '\n')
}
