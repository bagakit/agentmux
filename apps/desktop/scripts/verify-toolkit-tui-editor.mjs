import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { captureToolkitEditor } from './fixtures/toolkit-tui-editor/capture.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), evidence = path.join(root, '.local/toolkit-tui-polish/editor')
await fs.mkdir(evidence, { recursive: true })
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--consume-native', 'Use no arguments or explicit --consume-native')
const consumeNative = args[0] === '--consume-native'
const previous = consumeNative ? JSON.parse(await fs.readFile(path.join(evidence, 'receipt.json'), 'utf8')) : null
if (previous) { assert.equal(previous.status, 'passed'); assert.equal(previous.native.length, 2) }
const hash = value => createHash('sha256').update(value).digest('hex')
const files = ['apps/desktop/src/renderer/src/components/settings/ToolkitToolEditor.tsx', 'apps/desktop/src/renderer/src/components/settings/ToolkitScriptEditor.tsx',
  'apps/desktop/src/renderer/src/lib/monaco-theme.ts', 'apps/desktop/src/renderer/src/styles/settings-toolkit.css', 'apps/desktop/test/toolkit-custom-identity.test.tsx',
  'apps/desktop/src/shared/config-edit.ts', 'packages/core/src/toolkit.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/toolkit-config.ts',
  'apps/desktop/src/renderer/src/components/settings/use-toolkit-drafts.ts', 'apps/desktop/src/renderer/src/components/settings/ToolkitSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/ToolkitWorkingDirectoryField.tsx', 'apps/desktop/src/shared/toolkit-preferences.ts',
  'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts', 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'vitest.setup.ts',
  'packages/core/package.json', 'pnpm-lock.yaml', 'apps/desktop/test/monaco-theme.test.ts', 'apps/desktop/test/toolkit-tui-editor.config.mts', 'apps/desktop/scripts/verify-toolkit-tui-editor.mjs']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const result = { status: 'running', inputs, results: [], native: [] }
try {
  for (const mutation of [null, 'icon-edit', 'icon-label', 'display-presence', 'variable-colors']) {
    const name = mutation ?? 'baseline', output = path.join(evidence, name + '.json'), receipt = path.join(evidence, name + '.jsonl')
    await fs.writeFile(receipt, '')
    let log = ''
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/toolkit-tui-editor.config.mts', ...(mutation ? [mutation === 'variable-colors' ? 'apps/desktop/test/monaco-theme.test.ts' : 'apps/desktop/test/toolkit-custom-identity.test.tsx'] : []), '--reporter=json', '--outputFile=' + output],
      { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_EDITOR_MUTATION: mutation ?? '', AGENTMUX_TOOLKIT_EDITOR_RECEIPT: receipt }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    await fs.writeFile(path.join(evidence, name + '.log'), log)
    const suite = JSON.parse(await fs.readFile(output, 'utf8'))
    assert.ok(suite.numTotalTests > 0 && suite.numPassedTests + suite.numFailedTests > 0 && suite.testResults.length > 0, 'Nonempty editor consumers')
    if (mutation) {
      assert.notEqual(code, 0, 'Editor mutant survived: ' + mutation)
      const failed = suite.testResults.flatMap(file => file.assertionResults ?? []).filter(test => test.status === 'failed')
      assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError|expected|__VITEST_RESOLVES__/iu.test(message))), 'Mutation must fail a consumer assertion')
      const loaded = (await fs.readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.ok(loaded.some(item => item.sourceSHA256 !== item.loadedSHA256), 'Actual production mutant must load')
    } else { assert.equal(code, 0, 'Editor baseline failed; see its log'); assert.equal(suite.success, true) }
    result.results.push({ name, total: suite.numPassedTests + suite.numFailedTests, passed: suite.numPassedTests, failed: suite.numFailedTests, mutation })
    console.log(name + ': ' + (mutation ? 'mutant killed' : 'passed'))
  }
  for (const mutation of [null, 'shell-language']) {
    const directory = path.join(evidence, mutation ? 'native-shell-language' : 'native-baseline')
    let receipt
    if (consumeNative) {
      const bound = previous.native.find(item => item.path === path.relative(root, directory))
      assert.ok(bound?.passed, 'Explicit original Native receipt')
      const bytes = await fs.readFile(path.join(directory, 'receipt.json'))
      assert.equal(hash(bytes), bound.sha256, 'Original Native receipt is unchanged')
      receipt = JSON.parse(bytes)
      assert.equal(receipt.passed, true); assert.equal(receipt.mutation, mutation)
      assert.deepEqual(receipt.remaining, []); assert.equal(receipt.privateRootRemoved, true)
      assert.equal(receipt.process.timedOut, false)
      assert.ok(Object.keys(receipt.inputs).length > 0)
      for (const [file, digest] of Object.entries(receipt.inputs)) assert.equal(hash(await fs.readFile(path.join(root, file))), digest, 'Consumed Native source changed: ' + file)
      if (mutation) { assert.notEqual(receipt.process.exitCode, 0); assert.equal(receipt.native.failure?.name, 'AssertionError'); assert.ok(receipt.loaded.some(item => item.sourceSHA256 !== item.loadedSHA256)) }
      else { assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.native.passed, true) }
    } else receipt = await captureToolkitEditor({ evidence: directory, mutation })
    result.native.push({ path: path.relative(root, directory), sha256: hash(await fs.readFile(path.join(directory, 'receipt.json'))), passed: receipt.passed, consumed: consumeNative })
    console.log((mutation ?? 'native-baseline') + ': ' + (mutation ? 'mutant killed' : 'passed'))
  }
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await fs.readFile(path.join(root, file))), digest, 'Editor source changed: ' + file)
  result.status = 'passed'
} catch (error) { result.status = 'failed'; result.failure = { name: error.name, message: error.message }; throw error }
finally { await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n') }
