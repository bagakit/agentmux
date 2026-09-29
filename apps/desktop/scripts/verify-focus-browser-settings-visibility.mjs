import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const slice = process.argv[process.argv.indexOf('--slice') + 1]
assert.ok(['source', 'native-visual'].includes(slice), 'Explicit Browser Settings verification slice')
if (slice === 'native-visual') {
  const { verifyBrowserSettingsNative } = await import('./fixtures/focus-browser-settings-visibility/native-proof.mjs')
  await verifyBrowserSettingsNative()
} else {
  const evidence = resolve(root, '.tmp', `focus-browser-settings-visibility-source-${Date.now()}`)
  await mkdir(evidence, { recursive: true })
  const sourcePaths = [
    'apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
    'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts',
    'apps/desktop/test/focus-browser-settings-visibility.test.tsx',
    'apps/desktop/scripts/fixtures/focus-browser-settings-visibility/vitest.owning.config.mts',
    'apps/desktop/scripts/fixtures/focus-browser-settings-visibility/tsconfig.owning.json'
  ]
  const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path,
    createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])))
  const receipt = { schema: 'agentmux.focus-browser-settings-source.v1', passed: false, sourceBefore: await binding(), stages: [],
    scope: 'Actual mounted App/SurfaceSwitch/Workspace/Stable/BrowserPane and actual existing other-Tab Mote. Native WebContentsView is a separate native-visual slice; typed Session/Run references do not certify real healthy Runs.',
    userAppRunRuntimeControl: false }
  const run = async (name, command, args, env = {}) => {
    const chunks = []
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => chunks.push(data)); child.stderr.on('data', data => chunks.push(data))
    const code = await new Promise((done, fail) => { child.on('error', fail); child.on('close', done) })
    const log = `${name}.log`; await writeFile(resolve(evidence, log), Buffer.concat(chunks))
    const stage = { name, command, args, env, code, log }; receipt.stages.push(stage)
    return stage
  }
  const owning = async (name, mutation) => {
    const reportPath = resolve(evidence, `${name}.json`), loadedPath = resolve(evidence, `${name}-loaded.jsonl`)
    const stage = await run(name, 'pnpm', ['exec', 'vitest', 'run', '--config',
      'apps/desktop/scripts/fixtures/focus-browser-settings-visibility/vitest.owning.config.mts', '--maxWorkers=1',
      '--reporter=json', `--outputFile=${reportPath}`], {
      AGENTMUX_BROWSER_SETTINGS_REPORT: resolve(evidence, `${name}-observations.json`),
      AGENTMUX_BROWSER_SETTINGS_LOADED: loadedPath,
      ...(mutation ? { AGENTMUX_BROWSER_SETTINGS_MUTATION: mutation } : {})
    })
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    assert.ok(report.numTotalTests >= 2, 'Actual nonempty dual App entries')
    const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    for (const path of sourcePaths.slice(0, 5)) assert.ok(loaded.some(item => item.path === path), `Product owner actually loaded: ${path}`)
    if (mutation) {
      assert.notEqual(stage.code, 0, 'Loaded mutant exits RED')
      const red = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed' && test.failureMessages.some(message => message.includes('AssertionError')))
      assert.ok(red.length > 0, 'Actual product assertion RED, not preparation/guard failure')
      assert.ok(loaded.some(item => item.mutation === mutation && item.originalSHA256 !== item.loadedSHA256), 'The actual product module consumed the mutant')
      stage.assertionRed = red.length
    } else {
      assert.equal(stage.code, 0, `${name} exact baseline GREEN`)
      assert.equal(report.numFailedTests, 0)
      assert.equal(report.numPendingTests, 0)
      stage.actualGreen = report.numPassedTests
    }
  }
  try {
    await owning('baseline')
    for (const mutation of ['settings-keeps-focus-visible', 'focus-target-ignores-visible']) {
      await owning(mutation, mutation); await owning(`${mutation}-exact-restore`)
    }
    const productionTypes = await run('production-types', 'pnpm', ['--filter', '@agentmux/desktop', 'typecheck'])
    const owningTypes = await run('owning-types', 'pnpm', ['exec', 'tsc', '--noEmit', '-p',
      'apps/desktop/scripts/fixtures/focus-browser-settings-visibility/tsconfig.owning.json'])
    for (const stage of [productionTypes, owningTypes]) assert.equal(stage.code, 0, stage.name)
    const products = [
      ['WorkspaceWorkbench', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/App.tsx'],
      ['LatestBrowserBoundsSynchronizer', 'apps/desktop/src/renderer/src/lib/browser-bounds-sync.ts', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx']
    ]
    receipt.callers = []
    for (const [symbol, definition, caller] of products) {
      assert.notEqual(definition, caller); assert.ok(!caller.includes('/test/'))
      const content = await readFile(resolve(root, caller), 'utf8')
      assert.ok(content.includes(symbol), `Nondefinition product caller: ${symbol}`)
      receipt.callers.push({ symbol, definition, caller })
    }
    receipt.sourceAfter = await binding()
    assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Exact source before/after qualification')
    receipt.passed = true
  } catch (error) {
    receipt.failure = { name: error.name, message: error.message, stack: error.stack }
    process.exitCode = 1
  } finally {
    receipt.sourceAfter ??= await binding()
    await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify({ evidence: relative(root, evidence), passed: receipt.passed, stages: receipt.stages.map(({ name, code, assertionRed, actualGreen }) => ({ name, code, assertionRed, actualGreen })) }))
  }
}
