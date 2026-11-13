import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { capturePrimaryReading } from '../scripts/fixtures/a2a-primary-reading/capture.mjs'

const root = resolve(import.meta.dirname, '../../..')

test('actual Vite and private Electron bind consumed inputs without unrelated sibling files', async () => {
  await mkdir(join(root, '.tmp'), { recursive: true })
  const scope = await mkdtemp(join(root, '.tmp/a2a-capture-inputs-')), fixture = join(scope, 'fixture'), evidence = join(scope, 'evidence')
  const stylesheet = 'packages/client-ui/src/styles/conversation-a2a.css'
  try {
    await mkdir(fixture)
    await writeFile(join(scope, 'scene.json'), '{}')
    await writeFile(join(fixture, 'index.html'), '<script type="module" src="./entry.js"></script>')
    await writeFile(join(fixture, 'entry.js'), 'import ' + JSON.stringify(resolve(root, stylesheet)) + '\n')
    await writeFile(join(fixture, 'scenario.md'), 'Unconsumed scenario notes')
    await writeFile(join(fixture, 'vitest.owning.config.mts'), 'export default {unconsumed: true}')
    // No visual claim: the actual private runner has no window, and produces no frames.
    await writeFile(join(fixture, 'main.cjs'), [
      "const {app} = require('electron'), {writeFileSync} = require('node:fs'), {join} = require('node:path')",
      'const privateRoot = process.argv[3], evidence = process.argv[4]',
      "app.setPath('userData', join(privateRoot, 'user-data')); app.setPath('sessionData', join(privateRoot, 'session-data'))",
      'app.disableHardwareAcceleration()',
      "app.whenReady().then(() => {writeFileSync(join(evidence, 'render.json'), JSON.stringify({passed: true, frames: []})); app.quit()})"
    ].join('\n'))
    const capture = await capturePrimaryReading({ root, evidence, scene: join(scope, 'scene.json'), fixtureDirectory: fixture,
      expectedFrames: 0, requiredConsumers: [stylesheet] })
    for (const file of ['index.html', 'main.cjs', 'entry.js']) assert.ok(capture.inputs[relative(root, join(fixture, file))], 'Consumed fixture input: ' + file)
    for (const file of [stylesheet, 'apps/desktop/scripts/fixtures/a2a-primary-reading/capture.mjs',
      'apps/desktop/scripts/candidate-package-resolve.mjs', 'apps/desktop/scripts/probe-process.mjs']) assert.ok(capture.inputs[file], 'Consumed product/runner input: ' + file)
    for (const file of ['scenario.md', 'vitest.owning.config.mts']) assert.equal(capture.inputs[relative(root, join(fixture, file))], undefined, 'Unexpected non-consumed input: ' + file)
    assert.equal(capture.privateRootRemoved, true); assert.deepEqual(capture.remainingPrivateProcesses, [])
  } finally { await rm(scope, { recursive: true, force: true }) }
})
