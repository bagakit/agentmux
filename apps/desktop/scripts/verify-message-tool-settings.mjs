import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), at = args.indexOf('--output')
const directory = path.resolve(root, at >= 0 ? args[at + 1] : `.tmp/message-tool-settings/${randomUUID()}`)
await fs.mkdir(directory, { recursive: true })
const sources = [
  'apps/desktop/src/renderer/src/components/settings/settings-modules.ts',
  'apps/desktop/src/renderer/src/components/settings/modules/message-tool.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/automation.tsx',
  'apps/desktop/src/renderer/src/components/settings/modules/a2a.tsx',
  'apps/desktop/src/renderer/src/components/settings/continuity-settings-fields.ts',
  'apps/desktop/src/renderer/src/components/settings/save-continuity-settings.ts',
  'apps/desktop/src/renderer/src/components/settings/ContinuationSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/ContinuitySettingsPane.tsx',
  'apps/desktop/scripts/fixtures/message-tool-settings/scenario.cjs',
  'apps/desktop/scripts/fixtures/message-tool-settings/vitest.config.mts',
  'apps/desktop/scripts/verify-message-tool-settings.mjs'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceIdentity = Object.fromEntries(await Promise.all(sources.map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
const receipt = { completed: false, captureOnly: true, aestheticReview: 'not-performed', sourceIdentity }
if (!args.includes('--visual-only')) {
  const output = [], report = path.join(directory, 'tests.json')
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/message-tool-settings/vitest.config.mts', '--maxWorkers=1', '--reporter=json', '--outputFile.json=' + report], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => output.push(bytes)); child.once('error', reject); child.once('close', resolve)
  })
  const log = Buffer.concat(output).toString(); await fs.writeFile(path.join(directory, 'tests.log'), log)
  assert.equal(exit, 0, log)
  const tests = JSON.parse(await fs.readFile(report, 'utf8'))
  assert.equal(tests.testResults.length, 2); assert.equal(tests.numPassedTests, 5); assert.equal(tests.numFailedTests, 0)
  assert.ok(tests.testResults.every(suite => suite.assertionResults.length > 0 && suite.message === ''))
  assert.doesNotMatch(log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception|ENOSPC/)
  receipt.tests = { passed: tests.numPassedTests, report: 'tests.json' }
}
if (!args.includes('--test-only')) {
  const native = await qualify(path.join(directory, 'renderer'), false, false, { modes: ['message-tool-settings'], sources })
  assert.equal(native.completed, true, JSON.stringify(native.failure))
  const raw = JSON.parse(await fs.readFile(path.join(directory, 'renderer/message-tool-settings.json'), 'utf8'))
  assert.ok(raw.surface.exact && raw.completed && raw.messageTool.promptDraftRetained)
  assert.deepEqual(raw.messageTool.ids, ['message-tool', 'a2a', 'automation', 'prompts', 'amux-protocols'])
  assert.ok(native.png.length > 0)
  receipt.renderer = { receipt: 'renderer/receipt.json', frames: native.png.map(frame => frame.file), boundary: native.boundary }
}
for (const [file, expected] of Object.entries(sourceIdentity)) assert.equal(sha(await fs.readFile(path.join(root, file))), expected, 'Source drift: ' + file)
receipt.completed = true
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ completed: true, directory, tests: receipt.tests?.passed, frames: receipt.renderer?.frames.length, aestheticReview: 'not-performed' }))
