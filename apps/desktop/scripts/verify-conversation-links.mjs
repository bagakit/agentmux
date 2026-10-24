import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { aliases, installedDependency, desktopRequire } from './fixtures/settings-resource-library/environment.mjs'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
const fixture = join(desktop, 'scripts/fixtures/conversation-links')
const markdown = 'packages/client-ui/src/components/AgentMarkdown.tsx', css = 'packages/client-ui/src/styles/markdown.css'
const formalCSS = 'apps/desktop/src/renderer/src/styles/index.css'
const actualModules = [markdown, 'packages/client-ui/src/components/ConversationLinkCard.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ContentCopyButton.tsx',
  'packages/client-ui/src/lib/agent-markdown.ts', 'packages/client-ui/src/lib/link-url.ts',
  'packages/client-ui/src/lib/use-content-copy-action.ts', 'packages/client-ui/src/theme/runtime.ts',
  'apps/desktop/src/renderer/src/lib/session-link-opening.ts', 'apps/desktop/src/renderer/src/lib/terminal-link-gesture.ts',
  'apps/desktop/src/renderer/src/lib/host-platform.ts', 'apps/desktop/src/shared/focus-preferences.ts']
const files = [...actualModules, css, formalCSS, 'packages/client-ui/src/lib/reading-find.ts',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx', 'apps/desktop/src/renderer/src/components/SessionResultReviewContent.tsx',
  'apps/desktop/src/renderer/src/lib/session-project-file-context.ts', 'apps/desktop/src/renderer/src/lib/workbench-presentation.ts',
  'apps/desktop/scripts/fixtures/settings-resource-library/environment.mjs', 'apps/desktop/scripts/probe-process.mjs',
  'packages/client-ui/test/conversation-link-cards.test.tsx', 'packages/client-ui/test/conversation-link-cards.config.mts',
  'apps/desktop/scripts/verify-conversation-links.mjs', ...(await readdir(fixture)).map(name => `apps/desktop/scripts/fixtures/conversation-links/${name}`)]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
await mkdir(join(root, '.tmp'), { recursive: true })
const evidence = await mkdtemp(join(root, '.tmp/conversation-links-')), temporary = await mkdtemp(join(root, '.tmp/conversation-links-build-'))
const report = { passed: false, evidence, sourceHashes: hashes, phases: [],
  boundary: 'Private hidden Chromium consumes actual ConversationMessage → AgentMarkdown → ConversationLinkCard, ContentCopyButton, formal Desktop stylesheet → shared Markdown CSS, and actual useSessionLinkOpening.activateHttp through original modifier/Focus destination policy. Only final Store/openHttpLink and Desktop API IO are adapted to recording/rejecting ports. This proves no metadata HTTP traffic or new window and exact original Host intent; real Browser acquisition, spatial commit, system application opening, full Workbench and user Session/Run are outside this receipt.' }
try {
  const vitest = join(dirname(desktopRequire.resolve('vitest/package.json')), 'vitest.mjs')
  report.unit = await runProbeProcess(process.execPath, [vitest, 'run', '--configLoader', 'runner', '--config', 'packages/client-ui/test/conversation-link-cards.config.mts'],
    { cwd: root, env: process.env, timeoutMs: 45000 })
  assert.equal(report.unit.exitCode, 0, 'The owning nonempty shared consumer unit suite must pass first')
  const entry = await readFile(join(fixture, 'entry.tsx'), 'utf8')
  assert.deepEqual([...entry.matchAll(/^import ['"]([^'"]+\.css)['"]/gm)].map(match => match[1]),
    ['../../../src/renderer/src/styles/index.css'], 'Private card styles must not repair or replace the formal Renderer entry')
  const hostIO = new Set([join(desktop, 'src/renderer/src/store'), join(desktop, 'src/renderer/src/lib/api')])
  for (const mode of ['green', 'nested-boundary', 'no-action-layout', 'restored']) {
    const loaded = [], styleInputs = new Set(), outDir = join(temporary, 'out')
    let removedCSS = 0
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"', __AGENTMUX_WEB_PREVIEW__: 'true' },
      esbuild: { jsx: 'automatic' }, resolve: { alias: [{ find: /^jsonc-parser$/, replacement: join(dirname(desktopRequire.resolve('jsonc-parser/package.json')), 'lib/esm/main.js') }, ...aliases] },
      plugins: [{ name: `actual-conversation-link-${mode}`, enforce: 'pre',
        resolveId(source, importer) {
          if (importer && source.startsWith('.') && hostIO.has(resolve(dirname(importer.split('?')[0]), source).replace(/\.(?:tsx?|js)$/u, ''))) return join(fixture, 'host.ts')
          return installedDependency(source, importer)
        },
        transform(code, id) {
          const file = relative(root, id.split('?')[0]); if (!actualModules.includes(file)) return null
          assert.equal(hash(code), hashes[file], `${file}: the live module must match the exact candidate bytes`)
          let actual = code
          if (mode === 'nested-boundary' && file === markdown) {
            const anchor = "if (topLevel && node.kind === 'paragraph' && !context.readOnly && !context.documentMode && context.openHttpLink !== defaultOpenHttpLink) {"
            assert.equal(code.split(anchor).length, 2, 'The actual top-level promotion boundary must be unique and present')
            actual = code.replace(anchor, anchor.replace('topLevel && ', ''))
          }
          loaded.push({ path: file, sourceSHA256: hash(code), loadedSHA256: hash(actual), mutated: code !== actual })
          return code === actual ? null : actual
        }
      }],
      css: { postcss: { plugins: [{ postcssPlugin: 'exact-formal-link-card-css', Once(sheet) {
        sheet.walk(node => {
          const input = node.source?.input, file = input?.file && relative(root, input.file)
          if (file === formalCSS || file === css) {
            assert.equal(hash(input.css), hashes[file], `${file}: the formal CSS graph must read exact candidate bytes`)
            styleInputs.add(file)
          }
          if (mode === 'no-action-layout' && file === css && node.type === 'rule' && node.selector === '.md-link-card__open') { removedCSS++; node.remove() }
        })
      } }] } }, worker: { format: 'es' }, build: { outDir, emptyOutDir: true } })
    assert.equal(loaded.length >= actualModules.length, true, 'The real product module set must be nonempty')
    for (const file of actualModules) assert.ok(loaded.some(item => item.path === file), `${file}: the actual product consumer must compile`)
    for (const file of [formalCSS, css]) assert.ok(styleInputs.has(file), `${file}: the formal stylesheet path must actually compile`)
    assert.equal(removedCSS, mode === 'no-action-layout' ? 1 : 0, 'The CSS counterexample must remove exactly the production action rule')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const logs = [], outcome = await runProbeProcess(desktopRequire('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(temporary, `profile-${mode}`), evidence, mode],
      { cwd: root, env, timeoutMs: 45000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${mode}.log`), logs.join('\n'))
    const render = JSON.parse(await readFile(join(evidence, `${mode}.render.json`), 'utf8'))
    report.phases.push({ mode, loaded, styleInputs: [...styleInputs], removedCSS, outcome, render })
    assert.equal(render.remainingWindows, 0, 'The private proof must destroy all its original windows')
    if (mode === 'nested-boundary' || mode === 'no-action-layout') {
      assert.notEqual(outcome.exitCode, 0, 'Changing production behavior must turn the consumer assertion red')
      assert.equal(render.failure?.name, 'AssertionError', 'A mutant must fail a behavior assertion, never startup')
      assert.match(render.failure.message, mode === 'nested-boundary' ? /Only top-level standalone paragraphs/ : /formal card action CSS/)
      if (mode === 'nested-boundary') assert.ok(loaded.some(item => item.mutated))
    } else {
      assert.equal(outcome.exitCode, 0, render.failure?.message); assert.equal(render.passed, true)
      assert.equal(render.scenarios.length, 3); assert.equal(render.keyboard.opened.length, 2)
    }
    await rm(join(temporary, `profile-${mode}`), { recursive: true, force: true })
  }
  report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const pid of await listProbeProcesses(-1, temporary)) await signalOwnedProbeProcess(pid, temporary, 'SIGKILL')
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  if (report.cleanup.remaining.length) { report.passed = false; report.failure ??= { name: 'CleanupError', message: 'Private Chromium processes remain' } }
  await rm(temporary, { recursive: true, force: true })
  report.sourceRetention = []
  for (const [file, expected] of Object.entries(hashes)) {
    const actual = hash(await readFile(join(root, file))); report.sourceRetention.push({ path: file, expected, actual, unchanged: actual === expected })
    if (actual !== expected) { report.passed = false; report.failure ??= { name: 'SourceDriftError', message: `${file}: candidate changed during proof` } }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, evidence, failure: report.failure ?? null })); process.exitCode = report.passed ? 0 : 1
}
