import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(!args.length || args.length === 2 && args[0] === '--receipt', 'Expected --receipt PATH')
await mkdir(join(root, '.tmp/browser-opinion-selection'), { recursive: true })
const directory = await mkdtemp(join(root, '.tmp/browser-opinion-selection/attempt-'))
const file = args.length ? resolve(root, args[1]) : join(directory, 'receipt.json')
const composer = 'apps/desktop/src/renderer/src/components/BrowserContextualComposer.tsx'
const selection = 'apps/desktop/src/renderer/src/components/BrowserOpinionSelection.tsx'
const editor = 'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx'
const tests = ['apps/desktop/test/browser-opinion-selection.test.tsx', 'apps/desktop/test/image-annotation-owner-document.test.tsx']
const hash = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'derived-scene', file: composer, before: '(original.selection?.scene ?? original.scene!).reference', after: 'original.scene!.reference', assertion: 'explicitly reads the original prepared image and freezes its derived scene through the real opinion queue' },
  { id: 'text-only-image', file: composer, before: 'const capture = intent.context ?', after: 'const capture = original.selection || intent.context ?', assertion: 'explicit text-only sending excludes a retained processed image and its context' },
  { id: 'late-selection', file: selection, before: 'function cancel() { ++ticket.current; setFrame(null); setBusy(false); prepared.current = null }', after: 'function cancel() { setFrame(null); setBusy(false); prepared.current = null }', assertion: 'does not attach a late original query after close' },
  { id: 'late-frame', file: selection, before: 'if (token === ticket.current && same(original)) setFrame(captured)', after: 'if (same(original)) setFrame(captured)', assertion: 'ignores a late frame after hiding and never treats opening a frame as image attachment' },
  { id: 'editor-document', file: editor, before: "ownerWindow.addEventListener('keydown', onKeyDown)", after: "window.addEventListener('keydown', onKeyDown)", assertion: 'uses the actual image document for keyboard ownership and exposes the host attachment action' }
]
const receipt = { schema: 'agentmux.browser-opinion-selection.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: {}, runs: [], sharedTreeMutations: 0,
  boundary: 'Actual mounted Composer, annotation editor, Store queue and original freeze arguments. Only Desktop image/capture/freeze ports are controlled. No native pixels, Main durability, Provider delivery or ordinary restart is claimed.' }
async function save() { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n') }
const consumed = new Map()
try {
  const inputs = [composer, selection, editor, ...tests, 'apps/desktop/scripts/verify-browser-opinion-selection.mjs',
    'apps/desktop/test/browser-opinion-selection.config.mts', 'packages/client-ui/package.json', 'packages/core/package.json']
  for (const input of inputs) receipt.sources[input] = hash(await readFile(join(root, input)))
  for (const mutation of mutations) assert.equal((await readFile(join(root, mutation.file), 'utf8')).split(mutation.before).length, 2, 'Unique production anchor: ' + mutation.id)
  const escape = value => value.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&')
  const aliases = Object.entries(JSON.parse(await readFile(join(root, 'packages/client-ui/package.json'), 'utf8')).exports)
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, spec]) => ({
      pattern: '^' + escape('@agentmux/client-ui' + (key === '.' ? '' : key.slice(1))).replace('\\*', '(.+)') + '$',
      replacement: resolve(root, 'packages/client-ui', typeof spec === 'string' ? spec : spec.browser).replace('*', '$1') }))
  await writeFile(join(directory, 'plan.json'), JSON.stringify({ root, mutations, aliases, sources: receipt.sources }))
  await writeFile(join(directory, 'vitest.config.mts'), `import base from ${JSON.stringify(join(root, 'apps/desktop/test/browser-opinion-selection.config.mts'))};
import {readFileSync,appendFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {relative,resolve} from 'node:path';import assert from 'node:assert/strict';
const plan=JSON.parse(readFileSync(${JSON.stringify(join(directory, 'plan.json'))},'utf8')),mutation=plan.mutations.find(item=>item.id===process.env.BROWSER_SELECTION_MUTATION),hash=value=>createHash('sha256').update(value).digest('hex');
export default {...base,resolve:{...base.resolve,alias:[...plan.aliases.map(item=>({find:new RegExp(item.pattern),replacement:item.replacement})),{find:/^@agentmux\\/identity$/,replacement:resolve(plan.root,'packages/identity/src/index.ts')},...base.resolve.alias]},test:{...base.test,include:${JSON.stringify(tests)},passWithNoTests:false},plugins:[{name:'private-selection-consumer-proof',enforce:'pre',load(id){const path=id.split('?')[0],file=relative(plan.root,path);if(!/^(apps|packages)\\//.test(file)||file.includes('/node_modules/')||!/\\.[cm]?[jt]sx?$/.test(file))return;let source;try{source=readFileSync(path,'utf8')}catch{return}const original=hash(source);if(plan.sources[file])assert.equal(original,plan.sources[file],'Changed proof input: '+file);if(mutation?.file===file){assert.equal(source.split(mutation.before).length,2);source=source.replace(mutation.before,mutation.after)}appendFileSync(process.env.BROWSER_SELECTION_LOADS,JSON.stringify({file,original,loaded:hash(source)})+'\\n');if(mutation?.file===file)return source}}]};\n`)
  for (const mutation of [undefined, ...mutations, undefined]) {
    const label = mutation?.id ?? (receipt.runs.length ? 'restored' : 'baseline')
    const reportFile = join(directory, label + '.json'), loadsFile = join(directory, label + '.loads.jsonl')
    let log = '', timedOut = false
    const outcome = await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(directory, 'vitest.config.mts'),
        '--reporter=json', '--outputFile=' + reportFile], { cwd: root, env: { ...process.env, NODE_ENV: 'test',
        BROWSER_SELECTION_MUTATION: mutation?.id ?? '', BROWSER_SELECTION_LOADS: loadsFile }, stdio: ['ignore', 'pipe', 'pipe'] })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
      child.once('error', error => { clearTimeout(timer); no(error) })
      child.once('close', (code, signal) => { clearTimeout(timer); yes({ code, signal }) })
    })
    await writeFile(join(directory, label + '.log'), log)
    const run = { label, ...outcome, timedOut, assertions: 0, failures: 0, report: relative(root, reportFile) }; receipt.runs.push(run)
    assert.equal(timedOut, false); assert.equal(outcome.signal, null)
    const report = JSON.parse(await readFile(reportFile, 'utf8'))
    assert.equal(report.testResults.length, 2); assert.equal(report.numTotalTests, 9); assert.equal(report.numPendingTests, 0)
    assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0); assert.ok(report.testResults.every(suite => suite.message === ''), 'Setup errors are not AssertionRED')
    assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
    const assertions = report.testResults.flatMap(suite => suite.assertionResults)
    assert.equal(assertions.length, 9)
    const loaded = new Map((await readFile(loadsFile, 'utf8')).trim().split('\n').map(line => { const item = JSON.parse(line); return [item.file, item] }))
    for (const input of [composer, selection, editor, ...tests]) assert.ok(loaded.has(input), 'Actual consumer loaded: ' + input)
    for (const [input, value] of loaded) {
      assert.equal(value.original, consumed.get(input) ?? value.original); consumed.set(input, value.original)
      if (input !== mutation?.file) assert.equal(value.loaded, value.original)
    }
    run.assertions = report.numTotalTests; run.failures = report.numFailedTests
    if (mutation) {
      assert.notEqual(outcome.code, 0)
      const owning = assertions.find(item => item.fullName === mutation.assertion)
      assert.equal(owning?.status, 'failed', 'Owning assertion: ' + mutation.id)
      assert.ok(owning.failureMessages.some(message => message.includes('AssertionError')), 'Only a semantic assertion qualifies RED')
      assert.equal(loaded.get(mutation.file).loaded, hash((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.before, mutation.after)))
      run.owningAssertion = mutation.assertion
    } else { assert.equal(outcome.code, 0); assert.equal(report.numFailedTests, 0); assert.ok(assertions.every(item => item.status === 'passed')) }
    await save(); console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
  }
  for (const [input, value] of consumed) { assert.equal(hash(await readFile(join(root, input))), value); receipt.sources[input] = value }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), receipt.candidate)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
await save(); console.log(JSON.stringify({ passed: receipt.passed, receipt: relative(root, file) }))
if (!receipt.passed) process.exitCode = 1
