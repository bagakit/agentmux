import { parseArgs } from 'node:util'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { build, loadConfigFromFile } from 'vite'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

const repository = resolve(import.meta.dirname, '../../..'), fixture = join(import.meta.dirname, 'fixtures/goal-cross-host')
const { values } = parseArgs({ options: { evidence: { type: 'string' } } })
assert.ok(values.evidence, 'Supply --evidence DIR for this capture output.')
const evidence = resolve(values.evidence), privateRoot = await mkdtemp(join(tmpdir(), 'amx-goal-message-visual-'))
await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['apps/desktop/src/renderer/src/components/settings/HostMessageTrustPanel.tsx', 'apps/desktop/src/renderer/src/components/settings/HostSettingsPane.tsx',
  'apps/desktop/src/renderer/src/styles/settings-connections.css', 'apps/desktop/src/shared/contracts.ts',
  'apps/desktop/scripts/fixtures/goal-cross-host/entry.tsx', 'apps/desktop/scripts/fixtures/goal-cross-host/capture.cjs']
const sources = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(repository, file)))])))
const receipt = { captureOnly: true, aestheticReview: 'not-performed', scope: 'Original HostSettingsPane / preview facts only; no real approval, Session or input mutation.', evidence, privateRoot, sourceBefore: await sources() }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
try {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(repository, 'apps/desktop/test/vitest.goals-workflow.config.mts'))
  const outDir = join(evidence, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: loaded.config.resolve,
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    build: { outDir, minify: false, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  const compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiled[file.slice(outDir.length + 1)] = hash(await readFile(file))
  }
  receipt.compiled = compiled
  const electron = createRequire(import.meta.url)('electron')
  receipt.process = await runProbeProcess(electron, [join(fixture, 'capture.cjs'), join(outDir, 'index.html'), privateRoot, evidence], {
    temporaryRoot: privateRoot, cwd: repository, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, timeoutMs: 60000
  })
  receipt.render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.render.passed, true)
  receipt.sourceAfter = await sources(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Goal worker access — independent visual review pending', '', receipt.scope, '',
    ...receipt.render.frames.map(frame => `- ${frame.theme} ${frame.width} ${frame.state}: [complete screenshot](${frame.file})`), '',
    'Review the complete normal and narrow images against Remote trust and shared presentation rules. Capture is not approval.'].join('\n'))
} catch (error) { receipt.passed = false; receipt.error = String(error.stack || error); process.exitCode = 1 }
finally {
  receipt.cleanup = await stopProbeProcesses(receipt.process?.originalPid, privateRoot); receipt.remainingProcesses = await listProbeProcesses(receipt.process?.originalPid, privateRoot)
  assert.equal(receipt.remainingProcesses.length, 0)
  await rm(privateRoot, { recursive: true, force: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ evidence, passed: receipt.passed, error: receipt.error }))
}
