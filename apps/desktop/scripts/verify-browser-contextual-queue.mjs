import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--receipt', 'Expected --receipt PATH or no arguments')
await mkdir(join(root, '.tmp/browser-contextual-queue'), { recursive: true })
const directory = await mkdtemp(join(root, '.tmp/browser-contextual-queue/attempt-'))
const receiptFile = args.length ? resolve(root, args[1]) : join(directory, 'receipt.json')
const store = 'apps/desktop/src/renderer/src/store.ts'
const tests = 'apps/desktop/test/browser-contextual-queue.test.ts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-contextual-queue-proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sources: {}, runs: [], sharedTreeMutations: 0,
  boundary: 'Actual Renderer Store admission, original API arguments and typed receipt projection. Only native Desktop API ports are mocked. Native Main/Host/Provider and ordinary-process recovery are verified by their owning consumers.' }
const mutations = [
  { id: 'original-recipient', file: store, edits: [
    ["if (entry.browserRecipient && !entry.directInputBinding && !entry.resumeInputIntent && session?.kind === 'agent' &&", "if (false && entry.browserRecipient && !entry.directInputBinding && !entry.resumeInputIntent && session?.kind === 'agent' &&"],
    ['if (changedRun && entry.browserRecipient) throw', 'if (false && changedRun && entry.browserRecipient) throw']
  ], assertions: [
    'does not rebind a queued captured opinion when its host changes before Send',
    'does not rebind a queued captured opinion when its run changes before Send'
  ] },
  { id: 'original-api-reference', file: store, edits: [
    ['retryMessage.goalPmo, retryMessage.goalDispatch, retryMessage.browserInput?.capture.reference)', 'retryMessage.goalPmo, retryMessage.goalDispatch, undefined)']
  ], assertions: ['carries the reference through the exact conditional queue path without attaching a producer proof'] },
  { id: 'damaged-capture-plain-fallback', file: store, edits: [
    ['if (entry.browserInput) frozenBrowserInput(entry.browserInput, attemptSessionId, entry.operationId, entry.text, entry.agentMuxNote)',
      'if (entry.browserInput) { try { frozenBrowserInput(entry.browserInput, attemptSessionId, entry.operationId, entry.text, entry.agentMuxNote) } catch { entry.browserInput = undefined } }']
  ], assertions: ['keeps a malformed persisted capture instead of submitting its body as plain input'] },
  { id: 'current-wire-receipt-guess', file: store, edits: [
    ['if (!receipt || operation?.agentSessionId !== original.control.agentSessionId || operation.operationId !== entry.operationId ||',
      'if (!receipt || receipt.prompt !== composeAgentPrompt(entry.text, entry.agentMuxNote).text || operation?.agentSessionId !== original.control.agentSessionId || operation.operationId !== entry.operationId ||']
  ], assertions: ['reconciles continuity from typed original capture fields rather than current wire formatting (wrongProof=false)'] }
]
const inputs = {}, consumed = new Map()
const proofPath = name => relative(root, join(directory, name))
async function save() {
  const json = JSON.stringify(receipt, null, 2) + '\n'
  await mkdir(dirname(receiptFile), { recursive: true })
  await writeFile(receiptFile, json)
  if (receiptFile !== join(directory, 'receipt.json')) await writeFile(join(directory, 'receipt.json'), json)
}
function substitute(source, mutation) {
  for (const [before, after] of mutation.edits) {
    assert.equal(source.split(before).length, 2, 'Unique production mutation anchor: ' + mutation.id)
    source = source.replace(before, after)
  }
  return source
}
async function run(label, mutation) {
  const reportFile = join(directory, label + '.tests.json'), loadsFile = join(directory, label + '.loads.jsonl')
  const command = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(directory, 'vitest.config.mts'),
    '--reporter=json', '--reporter=default', '--outputFile.json=' + reportFile]
  let log = '', timedOut = false
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, command, { cwd: root, env: { ...process.env,
      BROWSER_QUEUE_MUTATION: mutation?.id ?? '', BROWSER_QUEUE_LOADS: loadsFile }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
    child.once('error', error => { clearTimeout(deadline); no(error) })
    child.once('close', (exit, signal) => { clearTimeout(deadline); yes({ exit, signal }) })
  })
  await writeFile(join(directory, label + '.log'), log)
  const run = { label, mutation: mutation?.id ?? null, ...result, timedOut,
    command: ['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', proofPath('vitest.config.mts')],
    log: proofPath(label + '.log'), report: proofPath(label + '.tests.json'), loads: proofPath(label + '.loads.jsonl') }
  receipt.runs.push(run)
  assert.equal(timedOut, false, label + ': timeout is not a behavioral result')
  assert.equal(result.signal, null, label + ': process signal is not a behavioral result')
  const report = JSON.parse(await readFile(reportFile, 'utf8'))
  const loaded = Object.fromEntries((await readFile(loadsFile, 'utf8')).trim().split('\n').map(line => {
    const { file, ...digest } = JSON.parse(line); return [file, digest]
  }))
  assert.equal(report.testResults.length, mutation ? 1 : 4, label + ': exact owning suites')
  if (mutation) assert.equal(report.numTotalTests, 12, label + ': nonempty complete queue suite')
  else assert.ok(report.numTotalTests >= 30, label + ': all four nonempty mounted suites')
  assert.equal(report.numPendingTests, 0, label + ': no skipped behavior')
  assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0)
  assert.ok(report.testResults.every(suite => suite.message === ''), label + ': collection/setup failure is not AssertionRED')
  const assertions = report.testResults.flatMap(suite => suite.assertionResults)
  assert.equal(assertions.length, report.numTotalTests)
  const identities = report.testResults.flatMap(suite => suite.assertionResults.map(item => relative(root, suite.name) + ':' + item.fullName)).sort()
  if (label === 'baseline') receipt.assertions = identities
  if (label === 'restored') assert.deepEqual(identities, receipt.assertions, 'Restored suite retains every baseline assertion')
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const requiredSources = [store, tests, 'apps/desktop/src/renderer/src/lib/browser-contextual-input.ts',
    ...(!mutation ? ['packages/client-ui/src/components/CapturedConversationMessage.tsx',
      'packages/client-ui/src/components/ConversationMessage.tsx'] : [])]
  for (const required of requiredSources) {
    assert.ok(loaded[required], label + ': actual production/test consumer loaded: ' + required)
  }
  for (const [file, digest] of Object.entries(loaded)) {
    assert.equal(digest.original, consumed.get(file) ?? digest.original, 'Consumed source changed: ' + file)
    consumed.set(file, digest.original)
  }
  run.assertions = report.numTotalTests; run.failures = report.numFailedTests
  if (mutation) {
    assert.notEqual(result.exit, 0, label + ': mutation must turn RED')
    run.owningAssertions = mutation.assertions.map(name => {
      const assertion = assertions.find(item => item.fullName === name)
      assert.equal(assertion?.status, 'failed', label + ': owning assertion must fail: ' + name)
      assert.ok(assertion.failureMessages.some(message => message.includes('AssertionError') || /promise resolved .*instead of rejecting/s.test(message)),
        label + ': typed behavior assertion, not setup/runtime failure: ' + name)
      return { name, status: 'AssertionRED' }
    })
    assert.equal(loaded[mutation.file].loaded, hash(substitute(inputs[mutation.file], mutation)))
    assert.notEqual(loaded[mutation.file].loaded, loaded[mutation.file].original)
  } else {
    assert.equal(result.exit, 0, label + ': inspect its exact log')
    assert.equal(report.numFailedTests, 0)
    assert.ok(assertions.every(item => item.status === 'passed'))
  }
  for (const [file, digest] of Object.entries(loaded)) if (file !== mutation?.file) assert.equal(digest.loaded, digest.original)
  await save()
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}
try {
  const files = [store, tests, 'apps/desktop/src/renderer/src/lib/browser-contextual-input.ts',
    'apps/desktop/test/browser-contextual-queue.config.mts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/browser-contextual-composer.config.mts',
    'apps/desktop/test/browser-contextual-composer.test.tsx', 'apps/desktop/test/browser-contextual-activity.test.tsx',
    'apps/desktop/test/browser-trace-reading-host.test.tsx',
    'apps/desktop/scripts/verify-browser-contextual-queue.mjs', 'packages/core/package.json', 'packages/client-ui/package.json', 'vitest.config.ts', 'vitest.setup.ts']
  for (const file of files) { inputs[file] = await readFile(join(root, file), 'utf8'); receipt.sources[file] = hash(inputs[file]) }
  for (const mutation of mutations) substitute(inputs[mutation.file], mutation)
  const escape = value => value.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&')
  const uiAliases = Object.entries(JSON.parse(inputs['packages/client-ui/package.json']).exports)
    .sort(([left], [right]) => Number(left.includes('*')) - Number(right.includes('*')) || right.length - left.length)
    .map(([key, spec]) => {
      const target = typeof spec === 'string' ? spec : spec.browser
      assert.ok(target?.startsWith('./src/'), 'Current client-ui browser source export: ' + key)
      return { pattern: '^' + escape('@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))).replace('\\*', '(.+)') + '$',
        replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
    })
  await writeFile(join(directory, 'plan.json'), JSON.stringify({ root, inputs: receipt.sources, mutations, uiAliases }, null, 2))
  await writeFile(join(directory, 'vitest.config.mts'), `import queue from ${JSON.stringify(join(root, 'apps/desktop/test/browser-contextual-queue.config.mts'))};
import mounted from ${JSON.stringify(join(root, 'apps/desktop/test/browser-contextual-composer.config.mts'))};
import assert from 'node:assert/strict';import { readFileSync,appendFileSync } from 'node:fs';import { createHash } from 'node:crypto';import { relative } from 'node:path';
const plan=JSON.parse(readFileSync(${JSON.stringify(join(directory, 'plan.json'))},'utf8'));
const mutation=plan.mutations.find(item=>item.id===process.env.BROWSER_QUEUE_MUTATION),base=mutation?queue:mounted;
const h=value=>createHash('sha256').update(value).digest('hex');
export default {...base,resolve:{...base.resolve,alias:[...plan.uiAliases.map(({pattern,replacement})=>({find:new RegExp(pattern),replacement})),...(base.resolve?.alias??[])]},plugins:[...(base.plugins??[]),{name:'private-browser-queue-production-mutation',enforce:'pre',load(id){
const path=id.split('?')[0],file=relative(plan.root,path);if(!/^(apps|packages)\\//.test(file)||!/\\.[cm]?[jt]sx?$/.test(file)||file.includes('/node_modules/'))return;
let source;try{source=readFileSync(path,'utf8')}catch{return}const original=h(source);
if(plan.inputs[file])assert.equal(original,plan.inputs[file],'Proof input changed: '+file);
if(mutation?.file===file)for(const [before,after]of mutation.edits){assert.equal(source.split(before).length,2,'Unique loaded production anchor');source=source.replace(before,after)}
appendFileSync(process.env.BROWSER_QUEUE_LOADS,JSON.stringify({file,original,loaded:h(source)})+'\\n');if(mutation?.file===file)return source;
}}]};\n`)
  await save()
  await run('baseline')
  for (const mutation of mutations) await run(mutation.id + '-red', mutation)
  await run('restored')
  for (const [file, digest] of consumed) {
    assert.equal(hash(await readFile(join(root, file))), digest, 'Consumed source preserved: ' + file)
    receipt.sources[file] = digest
  }
  for (const [file, source] of Object.entries(inputs)) assert.equal(hash(await readFile(join(root, file))), hash(source), 'Proof source preserved: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
await save()
console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, receiptFile) }))
if (!receipt.passed) process.exitCode = 1
