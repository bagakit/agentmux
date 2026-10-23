import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), outputAt = args.indexOf('--output')
const output = resolve(root, outputAt < 0 ? '.tmp/capsule-chrome-proof' : args[outputAt + 1])
await mkdir(output, { recursive: true })
const chrome = 'apps/desktop/src/renderer/src/components/CapsuleInteractionChrome.tsx'
const reply = 'apps/desktop/src/renderer/src/components/CapsuleQuestionReply.tsx'
const sources = Object.fromEntries(await Promise.all([chrome, reply, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/styles/capsule-interaction.css', 'apps/desktop/test/capsule-chrome.test.tsx',
  'apps/desktop/test/capsule-chrome.config.mts'].map(async file => [file, await readFile(join(root, file), 'utf8')])))
const sha = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'questions-outside-original-toolbar', file: chrome, from: '</button>, toolbarHost)', to: '</button>, document.body)',
    test: 'retains current editor text across a late request refresh and keeps the native page in a separate bounded surface' },
  { id: 'trusted-app-confirm-lost', file: reply, from: 'await api.capsuleReplies.confirm(held.params)',
    to: "await api.capsules.call('capsule.interaction.reply', held.params)",
    test: 'reads original requests through public RPC, retains draft bytes, and confirms only through the trusted App boundary' },
  { id: 'unknown-confirmation-unlocked', file: reply,
    from: "held.pending = false; setAttempt({ ...held }); setAutoSave(false)\n      setNotice(`Confirmation",
    to: "original.current = null; setAttempt(null); setAutoSave(false)\n      setNotice(`Confirmation",
    test: 'keeps an unobserved confirmation frozen and inspect-only without guessing that a missing operation was not applied' },
  { id: 'prepared-original-operation-lost', file: reply, from: 'operationId: retained?.operationId ?? mintObjectId(),',
    to: 'operationId: mintObjectId(),',
    test: 'continues only a durably prepared confirmation with its saved operation, answer, revision and input identity' },
  { id: 'dispatch-started-continue-exposed', file: reply,
    from: "current.reply?.phase === 'prepared' && (delivery?.status === 'unknown' || delivery?.status === 'unavailable')",
    to: "current.reply && (delivery?.status === 'unknown' || delivery?.status === 'unavailable')",
    test: 'preserves uncertain confirmation identity across inspection and reopening without submitting again' },
  { id: 'validation-after-unknown-lock', file: reply,
    from: 'try { parseCapsuleRpcParams(held.method, held.params) }\n    catch (error) { setNotice(presentError(error)); setAutoSave(false); return }',
    to: '', test: 'rejects invalid draft and answer parameters before occupying an unknown operation' },
  { id: 'not-applied-receipt-ignored', file: reply, from: "return failure?.disposition === 'not_applied' && failure.confirmedInputBytes === 0",
    to: 'return false', test: 'accepts an explicit not-applied receipt as a fresh human action while keeping unknown failures inspect-only' },
  { id: 'inspect-replays-original-write', file: reply,
    from: "api.capsules.call('capsule.operation.inspect', { operationId: held.params.operationId })",
    to: 'api.capsules.call(held.method, held.params)',
    test: 'keeps unknown draft saves locked to their original operation while preserving later editable text' },
  { id: 'waiting-displayed-as-submitted', file: reply, from: "case 'waiting': return 'input waiting in Core'",
    to: "case 'waiting': return 'input submitted'", test: 'distinguishes Core input waiting without certifying Agent completion' },
  { id: 'saved-input-inspection-lost', file: reply, from: 'const inspectSavedReply = !attempt && current.reply',
    to: "const inspectSavedReply = !attempt && delivery?.status === 'unknown' && current.reply",
    test: 'reopens a waiting answer and reads its original terminal-confirmed receipt without another confirmation' },
  { id: 'waiting-hidden-in-history', file: reply,
    from: "['stopped', 'not-applied', 'terminal-confirmed', 'admitted'].includes(delivery.inputStatus ?? '')",
    to: "['waiting', 'stopped', 'not-applied', 'terminal-confirmed', 'admitted'].includes(delivery.inputStatus ?? '')",
    test: 'keeps waiting answers prominent and folds confirmed history without losing its original inspection path' },
  { id: 'history-always-expanded', file: reply, from: 'open={settled ? undefined : true}', to: 'open',
    test: 'reopens saved terminal answers as compact history with a reachable original operation' }
]
for (const mutation of mutations) assert.equal(sources[mutation.file].split(mutation.from).length - 1, 1,
  'Exactly one actual source mutation anchor: ' + mutation.id)
const callers = []
for (const [symbol, definition] of [['CapsuleInteractionChrome', chrome], ['CapsuleQuestionReply', reply]]) {
  const matches = execFileSync('rg', ['-n', '-w', symbol, 'apps/desktop/src', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(line => !line.startsWith(definition + ':'))
  assert.ok(matches.length > 0, 'Nonempty definition-excluded production consumer: ' + symbol)
  callers.push({ symbol, definition, consumers: matches })
}
const runs = []
async function run(mutation) {
  const id = mutation?.id ?? 'baseline', report = join(output, id + '.tests.json'), capture = join(output, id + '.loaded.json')
  const config = join(output, id + '.config.mts')
  const source = mutation ? sources[mutation.file].replace(mutation.from, mutation.to) : null
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-chrome.config.mts'))};
import {writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const target=${JSON.stringify(mutation ? join(root, mutation.file) : null)},replacement=${JSON.stringify(source)};
export default {...base,cacheDir:${JSON.stringify(join(output, id + '.cache'))},plugins:[...base.plugins,
{name:'capsule-chrome-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]!==target)return;
writeFileSync(${JSON.stringify(capture)},JSON.stringify({source:target,loadedSha256:createHash('sha256').update(replacement).digest('hex')}));return {code:replacement,map:null}}}],
test:{...base.test,passWithNoTests:false,maxWorkers:1}};\n`)
  const result = await new Promise((yes, no) => {
    const options = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) options.push('-t', mutation.test)
    const child = spawn(process.execPath, options, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    child.once('error', no); child.once('close', code => yes({ code, log }))
  })
  await writeFile(join(output, id + '.log'), result.log)
  const data = JSON.parse(await readFile(report, 'utf8')), assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'Empty collection cannot qualify')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.log.slice(-3000))
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  if (mutation) {
    assert.equal(result.code, 1, result.log.slice(-3000))
    const loaded = JSON.parse(await readFile(capture, 'utf8'))
    assert.equal(loaded.loadedSha256, sha(source)); assert.notEqual(loaded.loadedSha256, sha(sources[mutation.file]))
    assert.ok(assertions.some(item => item.fullName === mutation.test && item.status === 'failed' &&
      item.failureMessages.some(message => message.includes('AssertionError'))),
    'The declared consumer assertion must turn RED, not setup or collection: ' + mutation.id + '\n' + result.log.slice(-3000))
  } else {
    assert.equal(result.code, 0, result.log.slice(-4000)); assert.equal(data.numFailedTests, 0); assert.equal(data.numPassedTests, assertions.length)
  }
  const receipt = { id, exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    ...(mutation ? { source: mutation.file, loadedSha256: sha(source), assertion: mutation.test } : {}) }
  runs.push(receipt); process.stdout.write(JSON.stringify(receipt) + '\n')
}
await run()
const atMutation = args.indexOf('--mutation'), selected = mutations.filter(item => atMutation < 0 || item.id === args[atMutation + 1])
if (atMutation >= 0) assert.equal(selected.length, 1, 'Exactly one named mutation must exist')
if (args.includes('--mutations') || atMutation >= 0) for (const mutation of selected) await run(mutation)
const inputs = Object.fromEntries(Object.entries(sources).map(([file, value]) => [file, sha(value)]))
for (const [file, hash] of Object.entries(inputs)) assert.equal(sha(await readFile(join(root, file))), hash, 'Source changed during proof: ' + file)
await writeFile(join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.capsule-chrome-proof.v1', passed: true, inputs, callers, runs,
  boundary: 'Actual Capsule durable owner and Core public RPC feed the rendered App questions. Trusted confirmation native port is controlled here; no real OS input, native geometry, visual approval or restart is claimed.' }, null, 2) + '\n')
