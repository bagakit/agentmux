import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), output = join(root, '.tmp/browser-context-reading', randomUUID())
await mkdir(output, { recursive: true })
const digest = value => createHash('sha256').update(value).digest('hex'), sources = new Map()
const receipt = { schema: 'agentmux.browser-context-reading-proof.v1', passed: false, sharedTreeMutations: 0, runs: [] }
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify({ ...receipt, sources: Object.fromEntries(sources) }, null, 2))
const message = 'packages/client-ui/src/components/ConversationMessage.tsx'
const captured = 'packages/client-ui/src/components/CapturedConversationMessage.tsx'
const text = 'packages/client-ui/src/components/ConversationInputText.tsx'
const resource = 'packages/client-ui/src/components/ConversationResourceText.tsx'
const mailbox = 'packages/client-ui/src/components/InputMailboxRecords.tsx'
const mutants = [
  { id: 'shared-core-parser', file: message, from: 'const parsed = parseAgentMuxMessagePrefix(firstText)', to: 'const parsed = null', expected: 'reads the Core-parsed Browser declaration' },
  { id: 'declared-source', file: text, from: "source={index === matching ? inputContextSource ?? 'caller-declared' : 'caller-declared'}", to: "source={inputContextSource ?? 'host-capture'}", expected: 'reads the Core-parsed Browser declaration' },
  { id: 'confirmed-body-boundary', file: captured, from: "item.kind === 'user_message' && input.publicContent === 'confirmed' ? 'body'", to: "item.kind === 'user_message' && input.publicContent === 'confirmed' ? 'wire'", expected: 'consumes the actual captured conversation projection' },
  { id: 'complete-body-boundary', file: resource, from: "if (contentBoundary !== 'wire' || !(inputMode || a2aNotificationId)", to: 'if (!(inputMode || a2aNotificationId)', expected: 'complete body resources' },
  { id: 'frozen-mailbox-copy', file: mailbox, from: 'copyText: original.promptWire', to: 'copyText: original.prompt', expected: 'original controlled mailbox context' },
  { id: 'submission-mailbox-copy', file: mailbox, from: 'copyText: admission.intent.prompt', to: 'copyText: message?.userContent', expected: 'original submission mailbox context' }
]
const production = [message, captured, text, resource, mailbox,
  'packages/client-ui/src/components/ConversationBrowserContext.tsx', 'packages/client-ui/src/components/ConversationView.tsx',
  'packages/client-ui/src/styles/conversation-browser-context.css', 'packages/client-ui/src/styles/conversation-message.css',
  'packages/client-ui/test/conversation-browser-context.test.tsx', 'packages/client-ui/test/fixtures/browser-context-reading.ts',
  'packages/client-ui/scripts/verify-browser-context-reading.mjs']
for (const file of production) sources.set(file, digest(await readFile(join(root, file))))
for (const mutation of mutants) assert.equal((await readFile(join(root, mutation.file), 'utf8')).split(mutation.from).length, 2, 'Unique production anchor: ' + mutation.id)

// Use the candidate's original portable Core leaves rather than another worktree's dist.
const aliases = {}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  if (pkg.name !== '@agentmux/core') continue
  for (const [key, spec] of Object.entries(pkg.exports ?? {})) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (!target?.startsWith('./dist/')) continue
    const source = resolve(dirname(manifest), target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(source); aliases[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
  }
}

async function run(label, mutation) {
  const config = join(output, label + '.config.mts'), report = join(output, label + '.tests.json'), loads = join(output, label + '.loads.json')
  await writeFile(config, `import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const mutation=${JSON.stringify(mutation ?? null)},root=${JSON.stringify(root)},loads={};const hash=s=>createHash('sha256').update(s).digest('hex');
export default{root,resolve:{alias:${JSON.stringify(Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => b.length - a.length)))}},cacheDir:${JSON.stringify(join(output, label + '-cache'))},plugins:[{name:'private-browser-context-production',enforce:'pre',load(id){
if(!mutation||id.split('?')[0]!==root+'/'+mutation.file)return;const original=readFileSync(id.split('?')[0],'utf8'),source=original.replace(mutation.from,mutation.to);
loads[mutation.file]={original:hash(original),consumed:hash(source)};writeFileSync(${JSON.stringify(loads)},JSON.stringify(loads));return source;
}}],test:{include:['packages/client-ui/test/conversation-browser-context.test.tsx','packages/client-ui/test/conversation-leading-context.test.tsx'],environment:'happy-dom',passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:10000}};`)
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=default', '--reporter=json', '--outputFile.json=' + report], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(deadline); resolveRun({ code, signal, log, timedOut }) })
  })
  await writeFile(join(output, label + '.log'), result.log)
  assert.equal(result.timedOut, false, 'Timeout is not assertion RED'); assert.equal(result.signal, null, 'Crash is not assertion RED')
  const tests = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(tests.testResults.length, 2); assert.equal(tests.numTotalTests, 17); assert.equal(tests.numPendingTests, 0)
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/u)
  for (const file of tests.testResults) assert.equal(file.message, '', 'Collection failure is not behavioral RED')
  if (mutation) {
    const owning = tests.testResults.flatMap(file => file.assertionResults).filter(item => item.fullName.includes(mutation.expected))
    assert.ok(owning.length > 0); assert.notEqual(result.code, 0)
    assert.ok(owning.some(item => item.status === 'failed' && item.failureMessages.some(value => /AssertionError|Actual mounted/u.test(value))), 'Original mounted assertion must turn RED')
    const loaded = JSON.parse(await readFile(loads, 'utf8'))[mutation.file]
    assert.equal(loaded.original, sources.get(mutation.file))
    assert.equal(loaded.consumed, digest((await readFile(join(root, mutation.file), 'utf8')).replace(mutation.from, mutation.to)))
  } else { assert.equal(result.code, 0, result.log); assert.equal(tests.numFailedTests, 0) }
  receipt.runs.push({ label, mutation: mutation?.id ?? null, exit: result.code, tests: tests.numTotalTests }); await save()
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}
try {
  await run('baseline')
  for (const mutation of mutants) await run(mutation.id, mutation)
  await run('restored')
  for (const [file, hash] of sources) assert.equal(digest(await readFile(join(root, file))), hash, 'Candidate source changed: ' + relative(root, file))
  receipt.passed = true; await save(); console.log(relative(root, output))
} catch (error) { receipt.failure = { name: error.name, message: error.message }; await save(); throw error }
