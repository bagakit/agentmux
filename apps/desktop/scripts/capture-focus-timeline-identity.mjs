import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, mkdir, mkdtemp, copyFile, symlink, rm, writeFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const args = process.argv.slice(2); assert.equal(args.length, 2); assert.equal(args[0], '--slice')
assert.ok(['current-name', 'mote-avatar'].includes(args[1]))
const slice = args[1], root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/focus-timeline-identity')
const evidence = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts', slice, 'scene-' + globalThis.crypto.randomUUID())
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amux-timeline-identity-")), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const receipt = { schema: 'agentmux.focus-timeline-identity-scene.v1', passed: false, slice, inputs: {}, loaded: [], images: [], boundary: 'Current Vite compiled production Timeline/common body with actual Chromium input. Isolated data and profile; no user Runtime, Run, restart, installation or whole-product claim.' }
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', __AGENTMUX_FOCUS_IDENTITY_SLICE__: JSON.stringify(slice), 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-actual-identity-source', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0]
      if (file.startsWith(join(desktop, 'src') + '/') || file.startsWith(fixture + '/') || file.startsWith(join(root, 'packages/client-ui/src') + '/')) {
        receipt.inputs[relative(root, file)] = sha(code); receipt.loaded.push({ file: relative(root, file), sha256: sha(code) })
      }
    } }], build: { target: 'esnext', outDir: join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: join(fixture, 'index.html') } } })
  const source = 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
  assert.ok(receipt.loaded.some(item => item.file === source)); assert.equal(receipt.inputs[source], sha(await readFile(join(root, source))))
  await copyFile(join(fixture, 'main.mjs'), join(privateRoot, 'main.mjs'))
  await mkdir(join(privateRoot, 'node_modules')); await symlink(join(desktop, 'node_modules/electron'), join(privateRoot, 'node_modules/electron'))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = []
  const result = await runProbeProcess(process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron'),
    [join(privateRoot, 'main.mjs'), join(privateRoot, 'renderer/index.html'), privateRoot, evidence, slice],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await writeFile(join(evidence, 'scene.log'), lines.join('\n'))
  const actual = JSON.parse(await readFile(join(evidence, 'scene.json'), 'utf8')); receipt.actual = actual
  for (const frame of actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: sha(await readFile(join(evidence, frame.image))) })
  assert.equal(result.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true); assert.ok(receipt.images.length >= 3)
  for (const [file, hash] of Object.entries(receipt.inputs)) {
    if (/\.(tsx?|jsx?|css)$/.test(file) && !file.includes('?')) assert.equal(sha(await readFile(join(root, file))), hash, 'Scene source changed: ' + file)
  }
  receipt.passed = true
} catch (cause) { receipt.failure = { message: cause.message, stack: cause.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, slice, receipt: join(evidence, 'receipt.json'), images: receipt.images.length }))
