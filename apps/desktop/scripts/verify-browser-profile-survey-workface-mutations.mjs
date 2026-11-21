import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Change loaded production bytes, never the shared worktree. A compile error,
// timeout, cleanup failure or source drift cannot count as a killed mutation.
const root = resolve(import.meta.dirname, '../../..')
const args=process.argv.slice(2), onlyIndex=args.indexOf('--only'), caseIndex=args.indexOf('--case'), only=onlyIndex<0?null:args[onlyIndex+1], redOnly=args.includes('--red-only')
const selectedCase=caseIndex<0?'admission':args[caseIndex+1]
assert.ok(['admission','profile-switch','context-menu','survey-drag'].includes(selectedCase),'Choose an implemented exact business case')
assert.ok(args.every((value,index)=>value==='--only'||value==='--red-only'||value==='--case'||onlyIndex>=0&&index===onlyIndex+1||caseIndex>=0&&index===caseIndex+1),'Only --case CASE, --only NAME and --red-only are supported')
const output = join(root, '.tmp/browser-profile-survey-workface-mutations', randomUUID())
const script = join(root, 'apps/desktop/scripts/verify-browser-profile-survey-workface.mjs')
await mkdir(output, { recursive: true })
const receipt = { selectedCase, passed: false, redPassed: false, productionMutations: [], restored: null }
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const caseRules = { admission: [
  ['omit-explicit-admission', 'registered', native => native.cases.some(value => value.kind === 'explicit-CLI-profile-open' && value.created.survey.outcome === 'not-requested')],
  ['project-whole-task', 'Exact Survey projection cannot include mixed Task siblings', native => Boolean(native.nativePage)],
  ['duplicate-region-host', 'Exact Region presentation fills the original Survey stage', native => Boolean(native.nativePage)],
  ['close-on-weak-save', 'Weak Survey failure must preserve the Main-created Browser', native => ['partial', 'unknown'].includes(native.weak?.survey.outcome)]
], 'profile-switch': [
  ['steal-environment-keyboard-focus', 'Changing the Survey environment keeps keyboard focus', native=>native.profileSwitch.cases.some(value=>value.kind==='default-no-custom-shared-native-sign-in')&&native.profileSwitch.input.some(value=>value.kind==='keyboard-select'&&value.steps.some(step=>step.changes?.some(change=>change.trusted)))]
], 'context-menu': [
  ['omit-context-profile-admission', 'Only the explicit context Profile page is admitted', native => native.contextMenu?.frameChild && native.contextMenu.hits.length === 2]
], 'survey-drag': [
  ['clip-survey-drag-preview', 'The same gesture and preview must survive leaving the sidebar', native => native.surveyDrag?.far?.active === true && native.surveyDrag.far.preview === false],
  ['omit-research-tab-order', 'A sibling Tab must show its insertion edge', native => native.surveyDrag?.far?.active === true && native.surveyDrag.far.preview === true]
] }
const rules=caseRules[selectedCase]
assert.ok(rules.length>0,'An implemented case must have nonempty production mutation rules')
assert.ok(only===null||rules.some(([name])=>name===only),'Choose an exact production mutation')
async function run(name) {
  const destination = join(output, name ?? 'restored')
  const args = [script, '--case', selectedCase, '--output', destination, ...(name ? ['--mutation', name] : [])]
  const code = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    child.once('error', reject)
    child.once('close', async code => {
      try { await writeFile(join(output, (name ?? 'restored') + '.log'), log); resolveRun(code) } catch (error) { reject(error) }
    })
  })
  const proof = JSON.parse(await readFile(join(destination, 'receipt.json'), 'utf8'))
  assert.deepEqual(proof.sourceDrift, [], 'A changed source cannot qualify a mutation')
  assert.deepEqual(proof.artifactDrift, [], 'Changed native artifacts cannot qualify a mutation')
  assert.deepEqual(proof.privateProcessesRemaining, [], 'Every private process must be cleaned')
  return { code, proof, destination }
}
try {
  for (const [name, message, reached] of rules) {
    if(only!==null&&name!==only)continue
    const { code, proof, destination } = await run(name)
    assert.equal(code, 1, 'The actual business oracle must reject the mutated product')
    assert.equal(proof.passed, false)
    assert.equal(proof.mutation.name, name)
    assert.equal(proof.mutation.applied.length, 1)
    const mutation = proof.mutation.applied[0]
    assert.notEqual(mutation.originalSha256, mutation.effectiveSha256)
    assert.equal(digest(await readFile(join(root, mutation.file))), mutation.originalSha256, 'Shared source stays original')
    const native = JSON.parse(await readFile(join(destination, 'first.json'), 'utf8'))
    assert.deepEqual(native.cleanupFailures, [])
    assert.equal(native.failure?.name, 'AssertionError', 'Bootstrap failure cannot kill a business mutation')
    assert.ok(native.failure.message.includes(message), native.failure.message)
    assert.ok(reached(native), 'The real public/Main/Renderer chain must reach the changed behavior')
    receipt.productionMutations.push({ name, killed: true, destination, mutation, failure: native.failure.message })
    await save()
  }
  assert.ok(receipt.productionMutations.length>0,'An empty run cannot qualify production mutation evidence')
  assert.equal(receipt.productionMutations.length,only===null?rules.length:1)
  receipt.redPassed=true
  if(redOnly){
    process.stdout.write('Profile Survey native mutation RED confirmed. The original build is checked by the task gate.\n'+join(output,'receipt.json')+'\n')
  }else{
    const restored = await run(null)
    assert.equal(restored.code, 0)
    assert.equal(restored.proof.passed, true)
    assert.equal(restored.proof.mutation, null)
    assert.equal(restored.proof.phases.length, selectedCase === 'context-menu' ? 1 : 2)
    receipt.restored = { passed: true, destination: restored.destination, phases: restored.proof.phases }
    receipt.passed = true
    process.stdout.write('Profile Survey native mutations: RED → restored GREEN\n' + join(output, 'receipt.json') + '\n')
  }
} finally { await save() }
