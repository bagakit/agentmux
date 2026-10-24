import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { fixturePath } from './lib/fixture-values.mjs'
import { aliases, desktopRequire } from './fixtures/settings-resource-library/environment.mjs'
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
const fixture = join(desktop, 'scripts/fixtures/conversation-keyframes')
const hook = 'apps/desktop/src/renderer/src/lib/use-conversation-keyframes.ts'
const sourceFiles = [hook, 'apps/desktop/src/renderer/src/lib/conversation-ruler.ts', 'apps/desktop/src/renderer/src/components/ConversationReadingRuler.tsx',
  'apps/desktop/src/renderer/src/components/ConversationRuler.tsx', 'apps/desktop/src/renderer/src/components/ConversationAxis.tsx',
  'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx', 'apps/desktop/src/renderer/src/styles/conversation-axis.css',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationImage.tsx',
  'packages/client-ui/src/components/AgentProviderIcon.tsx',
  'packages/client-ui/src/lib/conversation-message-location.ts', 'packages/client-ui/src/theme/runtime.ts']
const fixtureFiles = ['verify-conversation-keyframes.mjs', 'fixtures/settings-resource-library/environment.mjs',
  ...(await readdir(fixture)).map(file => `fixtures/conversation-keyframes/${file}`)].map(file => `apps/desktop/scripts/${file}`)
fixtureFiles.push('apps/desktop/test/conversation-keyframes.config.mts')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
const fixtureHashes = Object.fromEntries(await Promise.all(fixtureFiles.map(async file => [file, hash(await readFile(join(root, file)))])))
await mkdir(join(root, '.tmp'), { recursive: true })
const evidence = await mkdtemp(join(root, '.tmp/conversation-keyframes-')), temporary = await mkdtemp(fixturePath('tmp/amx-conversation-keyframes-'))
const report = { passed: false, evidence, sourceHashes: hashes, fixtureHashes, phases: [], boundary: 'Private Chromium over production ConversationReadingRuler → Ruler → Axis, actual keyframe hook, and shared ConversationMessage → ConversationImage. ClientUiPlatform supplies original configured avatars and an exact bounded image reader; only Desktop window portal and unused Store avatar fallback are adapted. Full Workbench/store navigation and native Browser/capsule acquisition are outside this probe; no user Session or Browser is operated.' }
try {
  const vitest = join(dirname(desktopRequire.resolve('vitest/package.json')), 'vitest.mjs')
  report.unit = await runProbeProcess(process.execPath, [vitest, 'run', '--configLoader', 'runner', '--config', 'test/conversation-keyframes.config.mts'], { cwd: desktop, env: process.env, timeoutMs: 45000 })
  assert.equal(report.unit.exitCode, 0, 'The owning isolated keyframe unit suite must pass first')
  for (const mode of ['green', 'blank-capture', 'repeat-capture', 'restored']) {
    const loaded = [], outDir = join(temporary, 'out')
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      resolve: { alias: aliases },
      plugins: [{ name: `conversation-keyframe-proof-${mode}`, enforce: 'pre',
        resolveId(source, importer) {
          if (source === './WindowOverlayHost' && importer?.endsWith('/HoverDropdownMenu.tsx') || source === './ConversationMessageAvatar' && importer?.endsWith('/ConversationAxis.tsx')) return join(fixture, 'host.tsx')
        },
        transform(code, id) {
          const file = relative(root, id.split('?')[0]); if (!sourceFiles.includes(file)) return null
          assert.equal(hash(code), hashes[file], `${file}: loaded source must match the candidate`)
          let actual = code
          if (mode === 'blank-capture' && file === hook) {
            const anchor = 'context.drawImage(media, 0, 0, canvas.width, canvas.height)'
            assert.equal(code.split(anchor).length - 1, 1, 'The mutation must reach the production pixel capture')
            actual = code.replace(anchor, 'context.clearRect(0, 0, canvas.width, canvas.height)')
          }
          if (mode === 'repeat-capture' && file === hook) {
            const anchor = 'if (!force && cached && paint.recordId === record.id && cached.version === record.version &&'
            assert.equal(code.split(anchor).length - 1, 1, 'The mutation must reach the production exact-frame reuse guard')
            actual = code.replace(anchor, 'if (false && !force && cached && paint.recordId === record.id && cached.version === record.version &&')
          }
          loaded.push({ path: file, sourceSHA256: hash(code), loadedSHA256: hash(actual), mutated: actual !== code })
          return actual === code ? null : actual
        }
      }], worker: { format: 'es' }, build: { outDir, emptyOutDir: true } })
    for (const file of sourceFiles) assert.ok(loaded.some(item => item.path === file), `${file}: actual nonempty product consumer must compile`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const logs = [], outcome = await runProbeProcess(desktopRequire('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(temporary, `profile-${mode}`), evidence, mode],
      { cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${mode}.log`), logs.join('\n'))
    const render = JSON.parse(await readFile(join(evidence, `${mode}.render.json`), 'utf8')); report.phases.push({ mode, loaded, outcome, render })
    if (mode === 'blank-capture') {
      assert.notEqual(outcome.exitCode, 0, 'Blanking the actual capture must turn pixels red')
      assert.equal(render.failure?.name, 'AssertionError', 'The mutation must fail a behavior assertion, not startup')
      assert.match(render.failure?.message ?? '', /decoded original red image pixels/)
      assert.ok(loaded.some(item => item.mutated))
    } else if (mode === 'repeat-capture') {
      assert.notEqual(outcome.exitCode, 0, 'Removing exact-frame reuse must repeat actual WebP encoding')
      assert.equal(render.failure?.name, 'AssertionError', 'The reuse mutation must fail a behavior assertion, not startup')
      assert.match(render.failure?.message ?? '', /Unrelated record refresh must not repeat WebP encoding/)
      assert.ok(render.performance?.refreshes[0].after.encodes > render.performance?.refreshes[0].before.encodes)
      assert.ok(loaded.some(item => item.mutated))
    } else {
      assert.equal(outcome.exitCode, 0, render.failure?.message); assert.equal(render.passed, true)
      assert.equal(render.scenarios.length, 6); assert.equal(render.remainingWindows, 0)
    }
    await rm(join(temporary, `profile-${mode}`), { recursive: true, force: true })
  }
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  assert.equal(report.cleanup.remaining.length, 0, 'Private keyframe probe processes must be cleaned up')
  await rm(temporary, { recursive: true, force: true })
  report.sourceRetention = []
  for (const [file, expected] of Object.entries({ ...hashes, ...fixtureHashes })) {
    const actual = hash(await readFile(join(root, file))); report.sourceRetention.push({ path: file, expected, actual, unchanged: actual === expected })
    if (actual !== expected) { report.passed = false; report.failure ??= { name: 'SourceDriftError', message: `${file}: candidate changed during proof` } }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null })); process.exitCode = report.passed ? 0 : 1
}
