import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/channel-entry')
const conversationSharing = process.argv.includes('--conversation-sharing')
const composerSharing = process.argv.includes('--composer-sharing')
const popoverClarity = process.argv.includes('--popover-clarity')
const applicationAccess = process.argv.includes('--application-access'), memberAccess = process.argv.includes('--member-access'), headerStatus = popoverClarity || process.argv.includes('--header-status'), focused = headerStatus || memberAccess || applicationAccess || conversationSharing || composerSharing
const main = composerSharing ? 'composer-sharing-main.cjs' : conversationSharing ? 'sharing-main.cjs' : applicationAccess ? 'application-main.cjs' : memberAccess ? 'member-main.cjs' : headerStatus ? 'status-main.cjs' : 'main.cjs'
const evidenceRoot = composerSharing ? '.local/channel-protocol/T-028/visual' : popoverClarity ? '.local/channel-protocol/T-026/visual' : conversationSharing ? '.local/channel-protocol/T-021/visual' : applicationAccess ? '.local/member-access/application-visual' : memberAccess ? '.local/member-access/visual' : headerStatus ? '.local/group-readiness/connection-surface-visual' : '.local/channel-protocol/channel-entry'
const evidence = resolve(root, evidenceRoot, 'runs', randomUUID()), temporary = await mkdtemp(resolve(tmpdir(), 'amux-channel-entry-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs: {}, loadedTransforms: {},
  scope: composerSharing ? 'Four T028 original SessionPane/Composer notice frames: saved long Lark/Discord audiences wide and split-Region narrow, retained names after failed reads, and explicit paused/global-off. Native composer draft/caret/focus and zero writes; synthetic typed public DTO leaves, no live platform or Host/SDK qualification.' : popoverClarity ? 'Four T026 production Renderer frames: mixed recent confirmed requests and earlier unknown effects at wide/split-Region widths, expanded details, and unbound. Synthetic typed public DTOs; native hover/keyboard, original geometry and zero connection writes. No live platform or Host/SDK qualification.' : conversationSharing ? 'Original AgentConnectorDialog partial saved scope and explicit whole-conversation confirmation, synthetic typed original Lark/Discord audiences, native controls and zero authorization/platform writes. Actual owner/SDK propagation is qualified separately.' : applicationAccess ? 'Original saved-bot and group application/member access through native input with synthetic typed access/profile/operation leaves. Public authorization is qualified separately; no live grants.' : memberAccess ? 'Original group Member access through native input and complete Renderer, with synthetic typed original Binding/grant/operation leaves. Real public Host/CLI authorization is qualified separately; no live grants.' : headerStatus ? 'Original channel header, popover and group details; controlled public DTOs and native pointer/keyboard. Header narrow uses an actual split Region; details narrow uses the actual narrow window.' : 'Original controlled channel-entry journey.' }
const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false' }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const path of ['apps/desktop/scripts/capture-channel-entry.mjs', ...['entry.tsx', main, 'index.html', 'scenario.md'].map(name => 'apps/desktop/scripts/fixtures/channel-entry/' + name), ...(composerSharing ? ['apps/desktop/scripts/fixtures/settings-connections/native-input.cjs'] : [])]) receipt.inputs[path] = sha(await readFile(resolve(root, path)))
  // PostCSS follows local CSS @imports internally, outside Vite's transform hook.
  if (focused) {
    const seen = new Set()
    async function pinCss(file) {
      if (seen.has(file)) return
      seen.add(file)
      const bytes = await readFile(file); receipt.inputs[relative(root, file)] = sha(bytes)
      for (const match of bytes.toString().matchAll(/@import\s+["']([^"']+)["']/gu)) {
        if (match[1].startsWith('.')) await pinCss(resolve(dirname(file), match[1]))
      }
    }
    await pinCss(resolve(root, 'apps/desktop/src/renderer/src/styles/index.css'))
  }
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href), compiled = resolve(temporary, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: aliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-channel-entry-renderer', enforce: 'pre', resolveId: browserInstalledDependency, transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
      receipt.inputs[relative(root, file)] = sha(readFileSync(file))
      receipt.loadedTransforms[relative(root, id)] = sha(code)
    } } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  if (!focused) await cp(compiled, resolve(evidence, 'compiled'), { recursive: true })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name)).map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = [], execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, main), resolve(compiled, 'index.html'), temporary, visual, ...(popoverClarity ? ['--popover-clarity'] : [])], { cwd: root, temporaryRoot: temporary, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  receipt.execution = execution
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.equal(render.frames.length, composerSharing ? 6 : popoverClarity || conversationSharing ? 4 : applicationAccess ? 5 : memberAccess ? 4 : 8)
  receipt.render = render; receipt.images = Object.fromEntries(await Promise.all(render.frames.map(async file => [file, sha(await readFile(resolve(visual, file)))])))
  for (const [file, expected] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(resolve(root, file))), expected, 'A loaded source changed during capture: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }; assert.deepEqual(receipt.cleanup.remaining, [])
  await rm(temporary, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await writeFile(resolve(root, evidenceRoot, 'latest.json'), JSON.stringify({ evidence, receipt: resolve(evidence, 'receipt.json') }, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence }))
}
