import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const mobile = resolve(import.meta.dirname, '..'), root = resolve(mobile, '../..')
const output = resolve(root, '.local/state/mobile-question-receipts')
await mkdir(output, { recursive: true })
const evidence = await mkdtemp(resolve(output, 'candidate-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const mutations = [
  { name: 'question-receipt-unchecked', test: 'MobileApp retains the original question', assertion: /to match object|expected.*unknown/su },
  { name: 'permission-completion-from-saved', test: 'the original Mote permission distinguishes', assertion: /答复已保存|还没确认答复是否送达/u },
  { name: 'permission-foreign-receipt', test: 'the original Mote permission distinguishes', assertion: /没有查到答复结果/u }
]
const tests = ['test/mobile-mote-input.test.tsx', 'test/question-replies.test.tsx']
const pattern = mutations.slice(0, 2).map(value => value.test).join('|')
const schema = 'agentmux.mobile-question-receipt-consumer.v1'
const results = []

async function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => chunks.push(bytes))
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => signal ? reject(new Error('Verification process ended with ' + signal)) : resolve(code))
  })
  return { code, output: Buffer.concat(chunks).toString() }
}

async function runTests(mutation) {
  const label = mutation?.name ?? 'original'
  const trace = resolve(evidence, label + '.jsonl'), report = resolve(evidence, label + '.json')
  const env = { ...process.env }
  delete env.AGENTMUX_TEST_MOBILE_MOTE_MUTATION
  delete env.AGENTMUX_TEST_MOBILE_MOTE_TRACE
  if (mutation) Object.assign(env, { AGENTMUX_TEST_MOBILE_MOTE_MUTATION: mutation.name, AGENTMUX_TEST_MOBILE_MOTE_TRACE: trace })
  const attempt = await run('pnpm', ['exec', 'vitest', 'run', '--config', 'test/mobile-mote-input.config.mts',
    ...tests, '-t', mutation?.test ?? pattern, '--reporter=json', '--outputFile', report], mobile, env)
  await writeFile(resolve(evidence, label + '.log'), attempt.output)
  const reportBytes = await readFile(report), facts = JSON.parse(reportBytes)
  if (!mutation) {
    assert.equal(attempt.code, 0, attempt.output)
    assert.equal(facts.numPassedTests, 3, 'The actual MobileApp exercises the native question and both original permission receipts')
    return { label, passed: facts.numPassedTests, reportSHA256: hash(reportBytes) }
  }
  assert.notEqual(attempt.code, 0, mutation.name + ' must fail in the actual MobileApp consumer')
  const failing = facts.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  assert.ok(failing.length > 0 && failing.every(test => test.fullName.includes(mutation.test) &&
    test.failureMessages.some(message => message.includes('AssertionError:') && mutation.assertion.test(message))), attempt.output)
  const changed = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(changed.length, 1, 'The mutation must load exactly one production source')
  const [source] = changed
  assert.equal(source.name, mutation.name)
  assert.equal(source.count, 1)
  assert.notEqual(source.before, source.after)
  assert.equal(hash(await readFile(source.file)), source.before, 'The working product remained at its original source')
  return { label, failed: failing.length, source: relative(root, source.file), original: source.before, changed: source.after, reportSHA256: hash(reportBytes) }
}

let capture
try {
  const head = await run('git', ['rev-parse', 'HEAD'], root, process.env)
  assert.equal(head.code, 0, head.output)
  results.push(await runTests())
  for (const mutation of mutations) results.push(await runTests(mutation))
  results.push({ ...await runTests(), label: 'original-restored' })
  capture = await run(process.execPath, [resolve(mobile, 'scripts/fixtures/mobile-product-redesign/capture-ui.mjs'), '--question-receipts'], root, process.env)
  await writeFile(resolve(evidence, 'capture.log'), capture.output)
  assert.equal(capture.code, 0, capture.output)
  const scene = capture.output.trim().split('\n').at(-1)
  assert.ok(scene.startsWith('.tmp/mobile-product-redesign/') && scene.endsWith('/receipt.json'), 'The capture returned its exact receipt')
  const sceneBytes = await readFile(resolve(root, scene)), visual = JSON.parse(sceneBytes)
  assert.equal(visual.passed, true)
  assert.equal(visual.captureSubset, 'question-receipts')
  assert.ok(visual.source['apps/mobile/src/MobileApp.tsx'])
  assert.ok(Object.keys(visual.images).length >= 7)
  const summary = { schema, passed: true, candidate: head.output.trim(), results, scene, sceneSHA256: hash(sceneBytes) }
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, evidence: relative(root, resolve(evidence, 'receipt.json')) }))
} catch (error) {
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema, passed: false, results, failure: error.message }, null, 2) + '\n')
  throw error
}
