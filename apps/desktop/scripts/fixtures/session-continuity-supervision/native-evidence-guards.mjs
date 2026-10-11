import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [projectArg, initialArg, outputArg, surfaceArg] = process.argv.slice(2)
assert.ok(projectArg && initialArg && outputArg, 'Exact original Native receipt locators are required')
const project = path.resolve(projectArg), output = path.resolve(outputArg)
const helper = path.join(project, 'apps/desktop/scripts/session-supervision-native-evidence.mjs')
const sha = value => createHash('sha256').update(value).digest('hex')
const source = await fs.readFile(helper, 'utf8'), owner = await import(pathToFileURL(helper).href)
await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'receipt.json'), { force: true })
const originalFile = path.resolve(project, initialArg), original = JSON.parse(await fs.readFile(originalFile, 'utf8'))
const before = { helper: sha(source), guards: sha(await fs.readFile(new URL(import.meta.url))) }
const results = []
await owner.readSupervisionInitialWaitOwner(project, originalFile); results.push({ id: 'original-initial-owner', passed: true })
if (surfaceArg) { await owner.readSupervisionNativeSurfaceOwner(project, surfaceArg); results.push({ id: 'original-admitted-owner', passed: true }) }
async function tamper(id, change) {
  const directory = path.join(output, id), raw = structuredClone(original)
  await fs.mkdir(directory, { recursive: true })
  for (const entry of await fs.readdir(path.dirname(originalFile))) {
    if (['receipt.json', 'seed.json', 'compiled.json'].includes(entry)) continue
    await fs.symlink(path.join(path.dirname(originalFile), entry), path.join(directory, entry)).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  change(raw)
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(raw))
  await fs.writeFile(path.join(directory, 'seed.json'), JSON.stringify(raw.phases[0].native))
  await fs.writeFile(path.join(directory, 'compiled.json'), JSON.stringify(raw.compiled))
  await assert.rejects(owner.readSupervisionInitialWaitOwner(project, path.join(directory, 'receipt.json')), { name: 'AssertionError' })
  results.push({ id, passed: true }); return path.join(directory, 'receipt.json')
}
await tamper('missing-source', raw => {
  delete raw.inputs['apps/desktop/src/renderer/src/components/ContinuitySupervisionNotice.tsx']
  delete raw.inputsAfter['apps/desktop/src/renderer/src/components/ContinuitySupervisionNotice.tsx']
})
const changedCount = await tamper('changed-count', raw => { raw.phases[0].native.supervision.before.supervision.attemptCount = 1 })
await tamper('missing-compiled-consumer', raw => { delete raw.compiled['main/main.mjs'] })
await tamper('changed-image', raw => { raw.phases[0].native.supervision.frames[0].sha256 = '0'.repeat(64) })
await tamper('unknown-cleanup', raw => { raw.cleanup.errors = ['Original private process identity remains unknown'] })
const anchor = 'assert.equal(root.supervision.attemptCount, 0);'
assert.equal(source.split(anchor).length, 2)
const changed = source.replace(anchor, 'void 0;').replace("'./session-capability-evidence.mjs'", JSON.stringify(path.join(project, 'apps/desktop/scripts/session-capability-evidence.mjs')))
const moduleFile = path.join(output, 'loaded-count.mjs'), targetFile = path.join(output, 'loaded-count-test.mjs')
await fs.writeFile(moduleFile, changed)
await fs.writeFile(targetFile, `import assert from 'node:assert/strict';import{readSupervisionInitialWaitOwner as read}from ${JSON.stringify(pathToFileURL(moduleFile).href)};await assert.rejects(read(${JSON.stringify(project)},${JSON.stringify(changedCount)}),{name:'AssertionError'});\n`)
let log = ''
const child = spawn(process.execPath, [targetFile], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
await fs.writeFile(path.join(output, 'loaded-count.log'), log)
assert.equal(exitCode, 1); assert.match(log, /AssertionError.*Missing expected rejection/su); assert.doesNotMatch(log, /TypeError|SyntaxError|ReferenceError/u)
assert.equal(sha(await fs.readFile(moduleFile)), sha(changed)); assert.notEqual(sha(changed), before.helper)
results.push({ id: 'loaded-count', passed: true, exitCode, original: before.helper, loaded: sha(changed), assertion: 'Missing expected rejection' })
const after = { helper: sha(await fs.readFile(helper)), guards: sha(await fs.readFile(new URL(import.meta.url))) }
assert.deepEqual(after, before)
await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ schema: 'agentmux.supervision-native-evidence-guards.v1', passed: true,
  before, after, initial: { file: originalFile, sha256: sha(await fs.readFile(originalFile)) }, ...(surfaceArg ? { surface: path.resolve(surfaceArg) } : {}), results }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, cases: results.length, loadedCounterexamples: 1 }))
