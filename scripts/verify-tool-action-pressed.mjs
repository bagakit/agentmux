import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runProbeProcess } from '../apps/desktop/scripts/probe-process.mjs'

const root = resolve(import.meta.dirname, '..')
const desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const fixture = join(desktop, 'scripts/fixtures/tool-action-pressed')
const output = join(root, '.tmp/tool-action-pressed')
await mkdir(output, { recursive: true })
const evidence = await mkdtemp(join(output, 'capture-'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const results = {}
const captureOutput = promisify(execFile)

async function desktopProof(name, mutate) {
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const target = join(evidence, name), app = join(target, 'app')
  await mkdir(target)
  const style = 'packages/client-ui/src/styles/buttons.css'
  const indexed = [style, 'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx',
    'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx',
    'apps/desktop/src/renderer/src/components/image-annotation/AnnotationToolbar.tsx',
    'packages/client-ui/src/components/IconButton.tsx']
  const markerSelector = ':is(.agent-button, .agent-icon-button)[aria-pressed="true"]::after'
  let removed = 0
  try {
    let source = {}
    await build({ root: fixture, configFile: false, logLevel: 'error', base: './', worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      esbuild: { jsx: 'automatic' },
      css: mutate ? { postcss: { plugins: [{ postcssPlugin: 'remove-persistent-action-mark', Rule(node) {
        if (node.selector === markerSelector && node.source?.input.file?.endsWith(style)) { removed++; node.remove() }
      } }] } } : undefined,
      plugins: [{ name: 'pressed-real-consumer', async generateBundle() {
        const loaded = this.getWatchFiles()
        source = Object.fromEntries(await Promise.all(indexed.map(async file => {
          assert.ok(loaded.includes(join(root, file)), 'Actual toolbar source must load: ' + file)
          return [file, digest(await readFile(join(root, file)))]
        })))
      } }],
      build: { outDir: app, emptyOutDir: true, target: 'esnext', reportCompressedSize: false }
    })
    if (mutate) assert.ok(removed > 0, 'The mutation must remove the loaded shared marker rule')
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(app, 'index.html'), target],
      { temporaryRoot: target, cwd: root, env, timeoutMs: 40_000 })
    const result = JSON.parse(await readFile(join(target, 'renderer.json'), 'utf8'))
    assert.equal(execution.exitConfirmed, true)
    assert.equal(execution.exitCode, mutate ? 1 : 0, result.failure)
    if (mutate) assert.match(result.failure, /Shared persistent marker must be visible/)
    else { assert.equal(result.cases.length, 2); assert.equal(result.images.length, 3) }
    const images = Object.fromEntries(await Promise.all(result.images.map(async image => [image, digest(await readFile(join(target, image)))])))
    results[name] = { source, images, result, renderer: relative(root, join(target, 'renderer.json')) }
  } finally { await rm(app, { recursive:true, force:true }) }
}

async function mobileProof(name, mutation, expectedFailure) {
  const fixture = 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'
  const { stdout, stderr, exitCode } = await captureOutput(process.execPath, [join(root, fixture), '--auxiliary-density', '--tool-action-pressed',
    ...(mutation ? ['--mutation=' + mutation] : [])], { cwd: root, env }).then(
    execution => ({ ...execution, exitCode: 0 }),
    error => {
      if (typeof error.code !== 'number') throw error
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code }
    }
  )
  const path = stdout.split('\n').find(line => /^\.tmp\/mobile-product-redesign\/renderer-[\w-]+\/receipt\.json$/.test(line))
  assert.ok(path, stderr)
  const receipt = JSON.parse(await readFile(join(root, path), 'utf8'))
  assert.equal(exitCode, mutation ? 1 : 0, receipt.error?.message)
  assert.equal(receipt.process?.exitConfirmed, true, receipt.error?.message)
  assert.equal(receipt.passed, !mutation, receipt.error?.message)
  if (mutation) {
    assert.equal(receipt.sourceOverride.id, mutation)
    assert.ok(receipt.renderer?.error, 'The loaded renderer must reject the mutated behavior')
    assert.match(receipt.renderer.error.message, expectedFailure)
  } else {
    assert.equal(receipt.renderer.toolActionPressed.instances.length, 2)
    assert.equal(receipt.renderer.toolActionPressed.final.same, true)
    assert.ok(receipt.renderer.readingFollow.following.scrollTop > receipt.renderer.readingFollow.atTail.scrollTop)
  }
  results[name] = { receipt: path }
}

const args = process.argv.slice(2)
const groups = []
if (!args.includes('--mobile-only')) groups.push((async () => {
  await desktopProof('desktop', false)
  if (!args.includes('--positive-only')) await desktopProof('desktop-without-marker', true)
})())
if (!args.includes('--desktop-only')) groups.push((async () => {
  await mobileProof('mobile')
  if (!args.includes('--positive-only')) {
    await mobileProof('mobile-without-state', 'tool-format-drops-state', /aria-pressed/)
    await mobileProof('mobile-without-reading-position', 'tool-format-follows-tail', /format action stays fully visible/)
  }
})())
assert.ok(groups.length > 0, 'Choose at least one actual client')
const checks = await Promise.allSettled(groups)
const failures = checks.filter(check => check.status === 'rejected').map(check => String(check.reason))
const path = join(evidence, 'receipt.json')
await writeFile(path, JSON.stringify({ passed: failures.length === 0, failures, results }, null, 2) + '\n')
console.log(relative(root, path))
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
