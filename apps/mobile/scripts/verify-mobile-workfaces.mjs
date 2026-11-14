import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { workfaceLayoutInputs } from './workface-layout-inputs.mjs'

const root = resolve(import.meta.dirname, '../../..'), mobile = resolve(root, 'apps/mobile')
const require = createRequire(resolve(mobile, 'package.json'))
const sha = value => createHash('sha256').update(value).digest('hex')
const topicInputs = JSON.parse(await readFile(resolve(import.meta.dirname, 'topics-navigation-sources.json'), 'utf8'))
const files = [...new Set([...Object.values(topicInputs).flat(), ...workfaceLayoutInputs,
  'apps/mobile/package.json', 'apps/mobile/tsconfig.json', 'apps/mobile/vite.config.ts', 'tsconfig.base.json',
  'apps/mobile/src/navigation/agent-row.css', 'apps/mobile/src/navigation/shell.css', 'apps/mobile/src/conversation/chrome.css',
  'apps/mobile/src/goals/MobileGoalsSurface.tsx', 'apps/mobile/src/goals/goals.css',
  'apps/mobile/src/conversation/mote-composer.tsx', 'apps/mobile/src/conversation/local-drafts.ts',
  'apps/mobile/test/mobile-workfaces.test.tsx', 'apps/mobile/test/mobile-workfaces.config.mts',
  'apps/mobile/test/mobile-topic-source.test.tsx', 'apps/mobile/test/mobile-topic-source-reference.test.tsx',
  'apps/mobile/test/wide-agent-workface.test.tsx', 'apps/mobile/test/wide-agent-workface.config.mts',
  'apps/mobile/test/wide-agent-directory-load.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx',
  'apps/mobile/test/responsive-goals.config.mts', 'apps/mobile/test/responsive-topics.config.mts',
  'apps/mobile/test/responsive-spatial-workfaces.config.mts', 'apps/mobile/scripts/verify-mobile-workfaces.mjs',
  ...['capture-ui.mjs', 'product-entry.tsx', 'product-main.cjs', 'responsive-primary-workfaces.cjs', 'density-workfaces.cjs']
    .map(file => 'apps/mobile/scripts/fixtures/mobile-product-redesign/' + file),
])]
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(resolve(root, file)))])))
const directory = resolve(root, '.tmp/mobile-workface-architecture/final-gate-' + randomUUID())
await mkdir(directory, { recursive: true })
const receipt = { passed: false, inputs, runs: [], boundary: 'Original MobileApp and public owner consumers; private Chromium, controlled SDK facts and two private OS processes. No live phone, installed App, user Session restart or business action claim.' }
const renderedInputs = {}
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const run = async (name, args, cwd = mobile, env = process.env) => {
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.once('error', reject); child.once('close', (exitCode, signal) => accept({ exitCode, signal, output }))
  })
  await writeFile(resolve(directory, name + '.log'), result.output)
  assert.equal(result.signal, null, 'Normal process completion: ' + name)
  return result
}
const groups = [
  { name: 'current', config: 'mobile-workfaces.config.mts', env: 'MOBILE_WORKFACE', min: 25,
    variants: ['source-ignores-primary', 'directory-ignores-session', 'relative-rejected', 'pause-hides', 'no-source-menu'] },
  { name: 'wide', config: 'wide-agent-workface.config.mts', env: 'WIDE_WORKFACE', min: 9,
    variants: ['hide-wide-focus', 'remount-width-editor', 'duplicate-catalog-reader'] },
  { name: 'goals', config: 'responsive-goals.config.mts', env: 'RESPONSIVE_GOALS', min: 4,
    variants: ['hide-wide-goal-list', 'remount-width-goal-editor', 'recreate-list-on-selection'] },
  { name: 'topics', config: 'responsive-topics.config.mts', env: 'MOBILE_RESPONSIVE_TOPICS_MUTANT', trace: 'MOBILE_RESPONSIVE_TOPICS_SOURCE_LOG', min: 4,
    variants: ['source-navigation-sticky', 'source-reader-active', 'topic-navigation-hidden', 'knowledge-navigation-hidden', 'knowledge-editor-remount'] },
  { name: 'spatial', config: 'responsive-spatial-workfaces.config.mts', env: 'RESPONSIVE_SPATIAL', min: 4,
    variants: ['space-navigation-lost', 'space-reader-remount'] },
]
try {
  const accepted = JSON.parse(await readFile(resolve(root, '.tmp/mobile-workface-architecture/acceptance.json'), 'utf8'))
  for (const name of ['product', 'density']) {
    const bytes = await readFile(resolve(root, accepted[name].receipt)), product = JSON.parse(bytes)
    assert.equal(sha(bytes), accepted[name].sha256)
    assert.equal(product.passed, true, name + ' product evidence passed')
    assert.ok(Object.keys(product.source).length > 0, 'Nonempty actual source graph: ' + name)
    assert.equal(Object.keys(product.images).length, name === 'product' ? 23 : 2, 'Complete affected scene images: ' + name)
    for (const [file, digest] of Object.entries(product.source)) {
      assert.equal(sha(await readFile(resolve(root, file))), digest, 'Actual rendered source: ' + file)
      if (renderedInputs[file]) assert.equal(renderedInputs[file], digest, 'Both captures consume the same candidate: ' + file)
      renderedInputs[file] = digest
    }
    for (const [file, digest] of Object.entries(product.images)) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Actual complete PNG: ' + file)
    const reviewBytes = await readFile(resolve(root, accepted[name].review)), review = JSON.parse(reviewBytes)
    assert.equal(sha(reviewBytes), accepted[name].reviewSHA256)
    assert.equal(review.verdict, 'deliverable', 'Independent complete-image judgment: ' + name)
    assert.ok(typeof review.reviewer === 'string' && review.reviewer !== '/root' && review.reviewer.length > 0)
    assert.equal(review.receipt, accepted[name].receipt)
    assert.equal(review.receiptSHA256, accepted[name].sha256)
    assert.equal(review.images.length, Object.keys(product.images).length)
    assert.deepEqual(Object.fromEntries(review.images.map(item => {
      assert.ok(typeof item.conclusion === 'string' && item.conclusion.length > 0, 'Actual image judgment: ' + item.file)
      return [item.file, item.sha256]
    })), product.images, 'Independent review covers these exact full images: ' + name)
    receipt[name] = accepted[name]
    if (name === 'product') {
      assert.equal(product.restoredRenderer.passed, true)
      for (const [process, renderer] of [[product.process, product.renderer], [product.restartProcess, product.restoredRenderer]]) {
        assert.ok(Number.isSafeInteger(process.originalPid) && process.originalPid > 0, 'Actual private OS PID')
        assert.equal(process.originalPid, renderer.environment.pid)
        assert.equal(process.exitCode, 0); assert.equal(process.exitSignal, null); assert.equal(process.exitConfirmed, true)
      }
      assert.notEqual(product.renderer.environment.pid, product.restoredRenderer.environment.pid, 'Different private OS processes restore the original workface')
    }
  }
  const knownInputs = { ...renderedInputs, ...inputs }
  for (const [name, file] of [['navigation', 'verify-topics-navigation.mjs'], ['layout', 'verify-workface-layout.mjs']]) {
    const result = await run(name, [resolve(import.meta.dirname, file)], root)
    assert.equal(result.exitCode, 0, result.output)
    receipt.runs.push({ name, exitCode: result.exitCode })
  }
  for (const group of groups) for (const variant of ['baseline', ...group.variants, 'restored']) {
    const name = group.name + '-' + variant, report = resolve(directory, name + '.json'), trace = resolve(directory, name + '-loaded.jsonl')
    await writeFile(trace, '')
    const mutation = !['baseline', 'restored'].includes(variant)
    const mutationKey = group.trace ? group.env : group.env + '_MUTATION'
    const env = { ...process.env, [group.trace ?? group.env + '_LOADED']: trace }
    delete env[mutationKey]
    if (mutation) env[mutationKey] = variant
    const result = await run(name, [vitest, 'run', '--config', 'test/' + group.config, '--reporter=json', '--outputFile=' + report], mobile, env)
    const bytes = await readFile(report), data = JSON.parse(bytes)
    const executed = data.testResults.flatMap(file => file.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
    // The original Goal probe appends only at evaluation; the other producers name that phase.
    const traceBytes = await readFile(trace), rows = traceBytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      .filter(row => group.name === 'goals' ? !row.phase : row.phase === 'evaluated')
      .map(row => ({ ...row, file: row.file ?? relative(root, row.path), mutation: row.mutation ?? row.mutant }))
    assert.ok(rows.length > 0, 'Actual evaluated modules: ' + name)
    assert.ok(data.testResults.every(file => !file.message), 'No collection error: ' + name)
    for (const row of rows) {
      assert.ok(knownInputs[row.file], 'Evaluated owner is bound to the verified candidate: ' + row.file)
      assert.equal(row.originalSHA256, knownInputs[row.file], 'Actual original source: ' + row.file)
    }
    if (mutation) {
      assert.equal(result.exitCode, 1); assert.equal(executed.length, 1); assert.equal(data.numFailedTests, 1)
      assert.ok(executed[0].failureMessages.some(message => message.includes('AssertionError')), 'One business assertion bears the counterexample: ' + name)
      assert.ok(rows.some(row => knownInputs[row.file] === row.originalSHA256 && row.mutation === variant
        && /^[a-f0-9]{64}$/.test(row.consumedSHA256 ?? row.loadedSHA256)
        && row.originalSHA256 !== (row.consumedSHA256 ?? row.loadedSHA256)), 'The selected original consumer mutation was evaluated: ' + name)
    } else {
      assert.equal(result.exitCode, 0, result.output); assert.equal(data.numFailedTests, 0); assert.ok(executed.length >= group.min, 'Nonempty original consumers: ' + name)
      assert.ok(executed.every(test => test.status === 'passed'))
    }
    receipt.runs.push({ name, exitCode: result.exitCode, executed: executed.length, failed: data.numFailedTests,
      report: relative(root, report), reportSHA256: sha(bytes), trace: relative(root, trace), traceSHA256: sha(traceBytes) })
  }
  // Execute the package's declared build directly through its installed CLI entries.
  // A package-manager dependency repair must not replace shared worktree dependencies.
  const pkg = JSON.parse(await readFile(resolve(mobile, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.build, 'tsc --noEmit && vite build')
  for (const [name, packageName, command] of [['typecheck', 'typescript', 'bin/tsc'], ['build', 'vite', 'bin/vite.js']]) {
    const entry = resolve(dirname(require.resolve(packageName + '/package.json')), command)
    const result = await run(name, [entry, name === 'typecheck' ? '--noEmit' : 'build'])
    assert.equal(result.exitCode, 0, result.output)
    receipt[name] = { exitCode: result.exitCode, cliSHA256: sha(await readFile(entry)), log: relative(root, resolve(directory, name + '.log')) }
  }
  for (const [file, digest] of Object.entries({ ...renderedInputs, ...inputs })) assert.equal(sha(await readFile(resolve(root, file))), digest, 'Candidate source retained through verification: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message }; process.exitCode = 1
} finally {
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(relative(root, resolve(directory, 'receipt.json')))
}
