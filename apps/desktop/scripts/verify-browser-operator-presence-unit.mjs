import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..')
const output = resolve(process.argv[2] ?? join(root, '.tmp/browser-operator-presence-unit', randomUUID()))
const configuration = 'apps/desktop/test/browser-operator-presence.config.mts'
const action = 'apps/desktop/src/main/browser-operation-feedback.ts'
const owner = 'apps/desktop/src/main/browser-view-manager.ts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const mutations = [
  { name: 'label-does-not-move-with-pointer', file: action,
    before: 'if (label && preferences.showCursorLabel) {', after: 'if (false && label && preferences.showCursorLabel) {',
    oracle: 'moves the label on the same clock' },
  { name: 'saved-tween-switch-ignored', file: action,
    before: 'preferences.showCursor && preferences.pointerTween && payload.moveMs > 0',
    after: 'preferences.showCursor && payload.moveMs > 0', oracle: 'turns tween off without losing the actual point' },
  { name: 'ripple-before-dispatch-acknowledgement', file: action,
    before: '  state.decorate(payload)\n', after: '  state.decorate(payload); state.click(payload)\n',
    oracle: 'plays a click only on acknowledged dispatch' },
  { name: 'original-dispatch-acknowledgement-disconnected', file: owner,
    before: 'dispatched: () => feedback.clickConfirmed(action)', after: 'dispatched: () => undefined',
    oracle: 'consumes the saved pointer preferences and dispatch acknowledgement' },
  { name: 'avatar-load-cancels-original-motion', file: action,
    before: 'avatar.appendChild(image); label.prepend(avatar); placeLabel()',
    after: 'avatar.appendChild(image); label.prepend(avatar); stopMotion(); placeLabel()',
    oracle: 'keeps the original pointer and label clocks' }
]
const inputs = [action, owner, 'apps/desktop/src/main/browser-control-feedback.ts', 'apps/desktop/src/main/browser-page-dispatch.ts',
  'apps/desktop/src/main/browser-operator-avatar.ts', 'apps/desktop/src/shared/browser-agent-control.ts', configuration,
  'apps/desktop/test/browser-control-feedback.test.ts', 'apps/desktop/test/browser-operation-feedback.test.ts',
  'apps/desktop/test/browser-page-action-feedback.test.ts', 'apps/desktop/scripts/verify-browser-operator-presence-unit.mjs']
await mkdir(output, { recursive: true })
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
for (const [file, bytes] of original) {
  const snapshot = join(output, 'source-inputs', file)
  await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
}
const receipt = { schema: 'agentmux.browser-operator-presence-unit.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: Object.fromEntries([...original].map(([file, bytes]) => [file, hash(bytes)])),
  sharedSourceMutations: 0, runs: [] }

async function run(name, mutation) {
  const resultPath = join(output, `${name}.json`), marker = join(output, `${name}-source.json`)
  const configPath = join(output, `${name}.config.mts`)
  let plugin = ''
  if (mutation) {
    const source = original.get(mutation.file).toString('utf8')
    assert.equal(source.split(mutation.before).length - 1, 1, 'One exact production mutation anchor')
    plugin = `plugins:[{name:'presence-semantic-mutation',enforce:'pre',async transform(code,id){
      if(id.split('?')[0]!==${JSON.stringify(join(root, mutation.file))})return;
      if(code.split(${JSON.stringify(mutation.before)}).length-1!==1)throw new Error('Production mutation anchor drift');
      const changed=code.replace(${JSON.stringify(mutation.before)},${JSON.stringify(mutation.after)});
      await writeFile(${JSON.stringify(marker)},JSON.stringify({source:${JSON.stringify(mutation.file)},before:hash(code),after:hash(changed)}));
      return changed;}}],`
  }
  await writeFile(configPath, `import base from ${JSON.stringify(pathToFileURL(join(root, configuration)).href)};
    import {writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
    const hash=value=>createHash('sha256').update(value).digest('hex');
    export default {...base,${plugin}};`)
  const log = []
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath,
      '--reporter=json', `--outputFile=${resultPath}`], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => log.push(bytes)); child.stderr.on('data', bytes => log.push(bytes))
    child.once('error', reject); child.once('exit', (status, signal) => signal ? reject(new Error(`Unit probe signal: ${signal}`)) : done(status))
  })
  await writeFile(join(output, `${name}.log`), Buffer.concat(log))
  const results = JSON.parse(await readFile(resultPath, 'utf8'))
  const assertions = results.testResults.flatMap(result => result.assertionResults)
  const failed = assertions.filter(result => result.status === 'failed')
  assert.ok(assertions.length >= 69, 'The actual owning test set is nonempty and complete')
  const row = { name, exitCode: code, total: assertions.length, failed: failed.map(result => ({ title: result.fullName, messages: result.failureMessages })), resultPath }
  receipt.runs.push(row)
  if (mutation) {
    row.transformation = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(row.transformation.before, hash(original.get(mutation.file)), 'The actual transformed production bytes match their source snapshot')
    assert.notEqual(row.transformation.before, row.transformation.after)
    assert.notEqual(code, 0, 'The semantic mutation must fail')
    assert.ok(failed.some(result => result.fullName.includes(mutation.oracle) && result.failureMessages.some(message => message.includes('AssertionError'))),
      'The intended product assertion must turn RED, rather than setup or compilation failure')
  } else {
    assert.equal(code, 0); assert.equal(failed.length, 0); assert.equal(results.success, true)
  }
}
try {
  await run('source')
  for (const mutation of mutations) await run(mutation.name, mutation)
  await run('restored')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
  receipt.sourceUnchanged = JSON.stringify(receipt.sourceBefore) === JSON.stringify(receipt.sourceAfter)
  if (!receipt.sourceUnchanged) { receipt.passed = false; receipt.failure ??= { message: 'Source changed during the owning proof' } }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), runs: receipt.runs.map(({ name, total, failed }) => ({ name, total, failed: failed.length })) }))
if (!receipt.passed) process.exitCode = 1
