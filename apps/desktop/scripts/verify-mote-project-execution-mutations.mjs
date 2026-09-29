import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const out = join(base, '.tmp/mote-project-execution/mutations')
await mkdir(out, { recursive: true })
const attempt = await mkdtemp(join(out, 'attempt-'))
const root = join(attempt, 'source'); await mkdir(root)
const paths = ['apps/desktop/src/main/scratch-topics.ts', 'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/agentmux-cli-help.ts']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const original = Object.fromEntries(await Promise.all(paths.map(async path => [path, await readFile(join(base, path))])))
const receipt = { schema: 'agentmux.mote-project-mutations.v1', passed: false, root, source: Object.fromEntries(paths.map(path => [path, digest(original[path])])), runs: [], failure: null, cleanup: {} }
const tests = ['apps/desktop/test/mote-project-execution.test.tsx', 'apps/desktop/test/pmo-teams-topic-role.test.ts']
const run = async (label, expected) => {
  const child = spawn(join(base, 'node_modules/.bin/vitest'), ['run', '--root', root, '--config', join(root, 'vitest.config.mts'), ...tests, '--maxWorkers=1'], { cwd: base, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const exit = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
  await writeFile(join(attempt, label + '.stdout'), stdout); await writeFile(join(attempt, label + '.stderr'), stderr)
  const result = { label, ...exit, expected, assertionObserved: expected === 'RED' ? /AssertionError|expected .* to|expected.*\[|to contain/.test(stdout + stderr) : false }
  receipt.runs.push(result)
  assert.equal(exit.signal, null, 'Environment termination is not a mutation RED')
  if (expected === 'GREEN') assert.equal(exit.code, 0, stdout + stderr)
  else { assert.notEqual(exit.code, 0, 'Mutant remained green'); assert.ok(result.assertionObserved, 'Failure was not the owning behavioral Assertion') }
  console.log(label + ': ' + expected)
}
try {
  await cp(join(base, 'apps/desktop/src'), join(root, 'apps/desktop/src'), { recursive: true })
  await cp(join(base, 'packages/core/src'), join(root, 'packages/core/src'), { recursive: true })
  await mkdir(join(root, 'apps/desktop/test/helpers'), { recursive: true })
  for (const path of [...tests, 'apps/desktop/test/helpers/config-owner-fixture.ts']) await cp(join(base, path), join(root, path))
  await symlink(join(base, 'node_modules'), join(root, 'node_modules'))
  await symlink(join(base, 'apps/desktop/node_modules'), join(root, 'apps/desktop/node_modules'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'vitest.config.mts'), 'import { defineConfig } from "vitest/config"; export default defineConfig({test:{include:["apps/desktop/test/mote-project-execution.test.tsx","apps/desktop/test/pmo-teams-topic-role.test.ts"],fileParallelism:false}})')
  for (const path of paths) assert.equal(digest(await readFile(join(root, path))), receipt.source[path], 'Private copy differs from its selected baseline')
  await run('baseline', 'GREEN')
  const variants = [
    { id: 'generic-mote-role', path: paths[0], from: '...(snapshot.soul ? [MOTE_COORDINATION_ROLE] : []),', to: '...(topicId === PMO_TEAMS_TOPIC_ID ? [MOTE_COORDINATION_ROLE] : []),' },
    { id: 'actual-session-binding', path: paths[1], from: 'await get().updateDemand(request.demandId, { sessionIds })', to: 'await get().updateDemand(request.demandId, { sessionIds: [] })' },
    { id: 'published-routing-risk', path: paths[2], from: '  --risk low|medium|high|unknown\n', to: '  --unpublished-risk low|medium|high|unknown\n' }
  ]
  for (const variant of variants) {
    const text = original[variant.path].toString('utf8')
    assert.equal(text.split(variant.from).length, 2, 'Mutation anchor must occur exactly once')
    await writeFile(join(root, variant.path), text.replace(variant.from, variant.to))
    try { await run(variant.id + '-red', 'RED') }
    finally { await writeFile(join(root, variant.path), original[variant.path]); assert.equal(digest(await readFile(join(root, variant.path))), receipt.source[variant.path], 'Restore differs from baseline') }
    await run(variant.id + '-restore', 'GREEN')
  }
  receipt.passed = true
} catch (error) { receipt.failure = error.stack; process.exitCode = 1 }
finally {
  receipt.sharedAfter = Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(base, path)))])))
  await rm(root, { recursive: true, force: true })
  receipt.cleanup = { privateCopyRemoved: true, sharedSourceUnmodifiedByRunner: true }
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(out, 'last.json'), JSON.stringify({ attempt, receiptSHA256: digest(await readFile(join(attempt, 'receipt.json'))) }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, runs: receipt.runs.length, receipt: join(attempt, 'receipt.json') }))
}
