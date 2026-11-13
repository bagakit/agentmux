import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { listProbeProcesses } from './probe-process.mjs'
import { verifySettingsNavigationNative, SETTINGS_NAVIGATION_PRODUCT_SOURCES } from './fixtures/settings-navigation/native.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), fixture = path.join(root, 'apps/desktop/scripts/fixtures/settings-navigation')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.local/bootstrap-capture/settings-navigation'))
const privateRoot = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'amux-settings-nav-')))
const require = createRequire(path.join(root, 'packages/core/package.json'))
const { build: buildNode } = require('esbuild')
const execFile = promisify(execFileCallback), hash = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.settings-navigation-proof.v1', passed: false, mutations: [], sourceBefore: {}, compiledSource: {},
  limitations: ['Actual App/Store/SettingsPanel and Mote Composer run in ordinary Electron through the production Control IPC bridge and actual public CLI.',
    'Runtime, Provider execution and filesystem resources are isolated leaves; no lifecycle or semantic input operation is admitted. This does not claim upstream Agent or installed-package verification.',
    'Composition events and a real Chromium Range exercise caret preservation; platform IME candidate UI is not asserted.',
    'Screenshots are capture evidence; independent aesthetic review remains separate.'] }
const owned = ['packages/core/src/desktop-focus-control.ts','packages/core/src/desktop-focus-parser.ts','packages/core/src/agentmux-cli-commands.ts',
  ...SETTINGS_NAVIGATION_PRODUCT_SOURCES,'apps/desktop/test/desktop-focus-navigation.test.tsx',
  'apps/desktop/scripts/verify-settings-navigation.mjs', ...['index.html','preload.cjs','entry.mjs','main.mjs','native.mjs','vitest.config.mts'].map(file => 'apps/desktop/scripts/fixtures/settings-navigation/'+file)]
const hashes = async () => Object.fromEntries(await Promise.all(owned.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const command = async (name, args, env = {}) => {
  let result
  try { const value = await execFile(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', path.join(fixture, 'vitest.config.mts'), '-t', ...args],
    { cwd: root, env: { ...process.env, ...env }, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }); result = { code: 0, signal: null, output: value.stdout + value.stderr } }
  catch (error) { result = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await fs.writeFile(path.join(evidence, name + '.log'), result.output)
  return result
}
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.sourceBefore = await hashes()
  // The real public listener requires this executable asset even when business owners use source aliases.
  await buildNode({ entryPoints: [path.join(root,'packages/core/src/control-endpoint-listener-worker.ts')],
    outfile: path.join(root,'packages/core/dist/control-endpoint-listener-worker.js'), bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  const baseline = await command('baseline', ['Settings semantic navigation'])
  assert.equal(baseline.code, 0, baseline.output); assert.match(baseline.output, /Tests\s+2 passed/)
  const mutations = [
    { label: 'original-app-router-disconnected', file: 'apps/desktop/src/renderer/src/App.tsx',
      before: "open: sectionId => navigateSettings({ section: sectionId as SettingsPageId }, 'preserve')", after: 'open: _sectionId => {}', test: 'consumes the actual public CLI and Settings owner' },
    { label: 'manual-page-hidden-by-initial-route', file: 'apps/desktop/src/renderer/src/App.tsx',
      before: 'read: () => settingsObservation.current,', after: "read: () => settingsObservation.current ? { ...settingsObservation.current, sectionId: settingsRoute?.section ?? settingsObservation.current.sectionId } : null,", test: 'consumes the actual public CLI and Settings owner' },
    { label: 'settings-steals-composing-input', file: 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx',
      before: "const preserveInput = inputPolicy === 'preserve'", after: 'const preserveInput = false', test: 'preserves the real Mote caret and composition' }
  ]
  for (const mutation of mutations) {
    const source = await fs.readFile(path.join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.before).length - 1, 1, 'Unique mutation anchor: ' + mutation.label)
    const descriptor = path.join(evidence, 'mutation.json'), loaded = path.join(evidence, mutation.label + '-loaded.jsonl')
    await fs.writeFile(descriptor, JSON.stringify(mutation)); await fs.writeFile(loaded, '')
    const result = await command(mutation.label, [mutation.test], { AGENTMUX_SETTINGS_NAVIGATION_MUTATION_PATH: descriptor, AGENTMUX_SETTINGS_NAVIGATION_LOADED_PATH: loaded })
    assert.equal(result.signal, null); assert.ok(Number.isInteger(result.code) && result.code > 0, result.output)
    assert.match(result.output, /Tests\s+[1-9]\d* failed/); assert.match(result.output, /AssertionError/)
    const modules = (await fs.readFile(loaded, 'utf8')).trim().split('\n').map(value => JSON.parse(value))
    const original = modules.find(value => value.path === mutation.file && value.mutated)
    assert.ok(original, 'Actual changed product consumer was loaded')
    assert.equal(original.sourceSHA256, hash(source)); assert.equal(original.loadedSHA256, hash(source.replace(mutation.before,mutation.after)))
    receipt.mutations.push({ ...mutation, code: result.code, loaded: original }); console.log('settings-navigation mutation killed: ' + mutation.label)
  }
  await fs.rm(path.join(evidence, 'mutation.json'))
  await verifySettingsNavigationNative({root,fixture,evidence,privateRoot,receipt})
  receipt.sourceAfter=await hashes();assert.deepEqual(receipt.sourceAfter,receipt.sourceBefore,'Task source changed during proof')
  receipt.passed=true
} catch(error){receipt.failure={message:error.message,stack:error.stack}}
finally {
  receipt.remaining=await listProbeProcesses(-1,privateRoot)
  if(!receipt.remaining.length){await fs.rm(privateRoot,{recursive:true,force:true});receipt.temporaryRootRemoved=true}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
}
assert.equal(receipt.passed,true,JSON.stringify(receipt.failure));assert.deepEqual(receipt.remaining,[])
console.log('Settings navigation proved through the real public CLI and App owners; mutations killed.')
