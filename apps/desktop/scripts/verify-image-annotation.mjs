import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
let slice, mutations = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--slice') { assert.equal(slice, undefined, 'Choose one verification slice'); slice = args[++index] }
  else if (args[index] === '--mutations') mutations = true
  else throw new Error('Unsupported image annotation proof option: ' + args[index])
}
assert.ok(['boundary', 'editing', 'documents'].includes(slice), 'Use --slice boundary|editing|documents')
// Later slices must acquire their real consumer and mutation before they can pass.
assert.equal(slice, 'boundary', 'This candidate provides boundary proof; the requested later slice has no verified consumer yet')
const tests = ['workface.test.tsx', 'native-overlay.test.tsx', 'toolbar.test.tsx', 'model.test.ts', 'compose.test.ts', 'context.test.ts']
  .map(name => 'apps/desktop/test/browser-screenshot-' + name)
const adapter = 'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx'
const require = createRequire(resolve('package.json'))
const cli = require.resolve('vitest/vitest.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const work = await mkdtemp(join(tmpdir(), 'agentmux-image-annotation-'))
const out = resolve('.local/browser-image-annotation/' + slice)
await mkdir(out, { recursive: true }); await rm(join(out, 'receipt.json'), { force: true })
const directories = ['apps/desktop/src/renderer/src/components/image-annotation', 'apps/desktop/src/renderer/src/components/browser-screenshot']
const inputs = [...tests, adapter, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/scripts/verify-image-annotation.mjs', 'vitest.config.ts', 'vitest.dist-freshness.ts']
for (const directory of directories) for (const name of await readdir(directory)) {
  const file = directory + '/' + name
  if (/\.(?:tsx?|css)$/.test(name) && !inputs.includes(file)) inputs.push(file)
}
const sourceInputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(path))])))
const source = await readFile(adapter, 'utf8')
const anchor = '<ImageAnnotationEditor {...props} />'
assert.equal(source.split(anchor).length - 1, 1, 'The production host adapter forwards its props exactly once')
const target = 'Cancel exits the real editor and restores the same Browser bounds'
const evidence = { slice, passed: false, sourceInputs, cases: [] }
function child(argv) {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, [cli, ...argv], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', expired = false, escalation
    processChild.stdout.on('data', data => { output += data }); processChild.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGTERM'); escalation = setTimeout(() => processChild.kill('SIGKILL'), 1000) }, 45000)
    processChild.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(new Error('The exact private Vitest child timed out and exited')) : done({ code, signal, output })
    })
  })
}
async function run(label, mutate = false) {
  const report = join(work, label + '.json'), config = join(work, label + '.config.mjs')
  const mutant = join(work, label + '.tsx'), loaded = join(work, label + '.loaded.json')
  let mutationSource
  if (mutate) {
    mutationSource = source.replace(anchor, '<ImageAnnotationEditor {...props} onCancel={() => {}} />')
    await writeFile(mutant, mutationSource)
    await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(resolve('vitest.config.ts')).href)};
import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
export default {...base,plugins:[...(base.plugins??[]),{name:'private-original-adapter-cancel-mutation',enforce:'pre',load(id){
 if(id.split('?')[0]!==${JSON.stringify(resolve(adapter))})return;
 const code=readFileSync(${JSON.stringify(mutant)},'utf8');
 writeFileSync(${JSON.stringify(loaded)},JSON.stringify({source:${JSON.stringify(adapter)},sha256:createHash('sha256').update(code).digest('hex')}));
 return {code,map:null};}}]};`)
  }
  const selected = mutate ? ['apps/desktop/test/browser-screenshot-workface.test.tsx'] : tests
  const result = await child(['run', ...selected, ...(mutate ? ['--config', config, '-t', target] : []),
    '--maxWorkers=1', '--reporter=json', '--outputFile', report])
  const raw = JSON.parse(await readFile(report, 'utf8').catch(error => {
    throw new Error('The owning test produced no fresh result: ' + result.output.replaceAll(process.cwd(), '<repository>'), { cause: error })
  }))
  const assertions = raw.testResults.flatMap(suite => suite.assertionResults)
  if (mutate) {
    const consumed = JSON.parse(await readFile(loaded, 'utf8'))
    assert.deepEqual(consumed, { source: adapter, sha256: sha(mutationSource) }, 'The original adapter loads the exact private mutation')
    const cases = assertions.filter(row => row.title === target)
    assert.equal(cases.length, 1, 'The actual Cancel consumer is unique and nonempty')
    assert.equal(result.code, 1); assert.equal(cases[0].status, 'failed')
    assert.match(cases[0].failureMessages.join('\n'), /null|Screenshot editor|image-annotation-editor/i, 'The loaded mutant fails to close its actual Editor')
    evidence.cases.push({ label, result: 'RED', consumer: target, mutation: { source: adapter, sha256: sha(mutationSource) } })
  } else {
    assert.equal(result.code, 0, result.output.replaceAll(process.cwd(), '<repository>'))
    assert.ok(assertions.length > 0, 'The real mounted/model suites are nonempty')
    assert.deepEqual(assertions.map(row => row.status), assertions.map(() => 'passed'))
    const observed = raw.testResults.map(suite => relative(process.cwd(), suite.name))
    assert.deepEqual([...observed].sort(), [...tests].sort(), 'Each requested original suite executes')
    evidence.cases.push({ label, result: 'GREEN', tests: assertions.length, suites: observed,
      consumers: assertions.map(row => row.fullName) })
  }
  console.log(slice + ' ' + label + ': ' + (mutate ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (mutations) { await run('adapter-cancel-omitted', true); await run('restored-source') }
  for (const [path, digest] of Object.entries(sourceInputs)) assert.equal(sha(await readFile(path)), digest, 'Proof input changed: ' + path)
  evidence.passed = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
