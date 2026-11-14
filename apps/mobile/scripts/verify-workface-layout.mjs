import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { workfaceLayoutInputs } from './workface-layout-inputs.mjs'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json'))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const directory = resolve(root, '.tmp/mobile-workface-architecture/workface-layout/run-' + randomUUID())
await mkdir(directory, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = Object.fromEntries(await Promise.all(workfaceLayoutInputs.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const receipt = { passed: false, inputs, runs: [], boundary: 'Real Goals/Space Surfaces, original Goal/Files owners and public RPC, one original viewport producer. No user App/Browser/Session actions. Actual CSS geometry, motion and private process recovery belong to the integrated product gate.' }
const run = async (name, args, env = process.env, cwd = root) => {
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal, log }))
  })
  await writeFile(resolve(directory, name + '.log'), result.log)
  assert.equal(result.signal, null, 'Command exits normally: ' + name)
  return result
}
const variants = {
  'landscape-remains-compact': { assertion: 'A usable phone landscape budget must present the original Goal navigation.', owner: 'apps/mobile/src/layout/workface-presentation.ts' },
  'inactive-erases-background': { assertion: 'Inactive observation must keep the original Goal background presented.', owner: 'apps/mobile/src/layout/workface-presentation.ts' },
  'space-catalog-follows-hidden-navigation': { assertion: 'The selected original Space still needs its catalog when only its content is presented.', owner: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx' },
}
try {
  const helper = await run('native-file-helper', [resolve(root, 'apps/desktop/scripts/build-workspace-move-helper.mjs')])
  assert.equal(helper.code, 0, helper.log)
  receipt.nativeHelper = { exitCode: helper.code, platform: process.platform, arch: process.arch,
    sha256: sha(await readFile(resolve(root, 'apps/desktop/resources/bin/agentmux-workspace-move'))) }
  for (const label of ['baseline', ...Object.keys(variants), 'restored', 'related']) {
    const mutation = variants[label], report = resolve(directory, label + '.json'), trace = resolve(directory, label + '-loaded.jsonl')
    await writeFile(trace, '')
    const env = { ...process.env, WORKFACE_LAYOUT_LOADED: trace }; delete env.WORKFACE_LAYOUT_MUTATION
    if (mutation) env.WORKFACE_LAYOUT_MUTATION = label
    const args = [vitest, 'run', '--config', 'test/workface-layout.config.mts', '--reporter=json', '--outputFile=' + report]
    if (label === 'related') args.push('--testNamePattern=^(responsive Goals|responsive Space|responsive Focus|public OS ports|keeps [0-9]+ hidden Focus rows)')
    const result = await run(label, args, env, mobile), data = JSON.parse(await readFile(report, 'utf8'))
    const tests = data.testResults.flatMap(file => file.assertionResults).filter(test => !['pending', 'skipped'].includes(test.status))
    const rows = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.phase === 'evaluated')
    assert.ok(tests.length > 0, 'Actual consumers execute: ' + label)
    for (const row of rows) assert.equal(row.originalSHA256, inputs[row.file], 'Actual evaluated input: ' + row.file)
    for (const file of ['apps/mobile/src/layout/MobileWorkfaceFrame.tsx', 'apps/mobile/src/layout/workface-presentation.ts']) assert.ok(rows.some(row => row.file === file), 'Actual shared producer evaluated: ' + file)
    if (mutation) {
      assert.equal(result.code, 1, label)
      const failed = tests.filter(test => test.status === 'failed')
      assert.equal(failed.length, 1); assert.equal(data.numFailedTests, 1)
      assert.ok(failed[0].failureMessages.some(message => message.includes('AssertionError') && message.includes(mutation.assertion)), 'The original bearing assertion kills ' + label)
      const changed = [...new Map(rows.filter(row => row.originalSHA256 !== row.loadedSHA256).map(row => [row.file + ':' + row.loadedSHA256, row])).values()]
      assert.equal(changed.length, 1); assert.equal(changed[0].file, mutation.owner)
    } else {
      assert.equal(result.code, 0, result.log); assert.equal(data.numFailedTests, 0)
      assert.equal(tests.length, label === 'related' ? 17 : 4, 'Exact nonempty consumer set: ' + label)
      for (const file of ['apps/mobile/src/goals/MobileGoalsSurface.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx']) assert.ok(rows.some(row => row.file === file), 'Actual Surface evaluated: ' + file)
      assert.ok(rows.every(row => row.originalSHA256 === row.loadedSHA256))
    }
    receipt.runs.push({ name: label, exitCode: result.code, executed: tests.length, failed: data.numFailedTests, report: relative(root, report), trace: relative(root, trace) })
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Original source retained through verification: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally {
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(relative(root, resolve(directory, 'receipt.json')))
}
