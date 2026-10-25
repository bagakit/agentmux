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
const hostExports = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports
const hostAliases = Object.entries(hostExports).map(([key, value]) => ({ find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)),
  replacement: resolve(root, value.import.replace('./dist/', 'apps/host/src/').replace(/\.js$/u, '.ts')) }))
const conversationSharing = process.argv.includes('--conversation-sharing')
const conversationSync = process.argv.includes('--conversation-sync')
const popoverClarity = process.argv.includes('--popover-clarity')
const questionValidation = process.argv.includes('--question-validation')
const refusalClarity = questionValidation || process.argv.includes('--refusal-clarity')
const entityOverview = process.argv.includes('--entity-overview')
const groupClarityOverview = process.argv.includes('--clarity-overview-only')
const groupClarity = groupClarityOverview || process.argv.includes('--group-clarity')
const groupDetails = groupClarity || process.argv.includes('--group-details')
const connectorDetails = groupDetails || entityOverview || process.argv.includes('--connector-details-modern')
const inputRecovery = process.argv.includes('--input-recovery')
const statusPriorityDetails = process.argv.includes('--status-priority-details')
const statusPriority = statusPriorityDetails || process.argv.includes('--status-priority')
const groupActivityActions = process.argv.includes('--group-activity-actions')
const applicationAccess = process.argv.includes('--application-access'), memberAccess = process.argv.includes('--member-access'), headerStatus = connectorDetails || inputRecovery || statusPriority || groupActivityActions || refusalClarity || popoverClarity || process.argv.includes('--header-status'), focused = headerStatus || memberAccess || applicationAccess || conversationSharing || conversationSync
const main = conversationSync ? 'sync-main.cjs' : conversationSharing ? 'sharing-main.cjs' : applicationAccess ? 'application-main.cjs' : memberAccess ? 'member-main.cjs' : headerStatus ? 'status-main.cjs' : 'main.cjs'
const evidenceRoot = groupClarity ? '.local/connector-group-clarity/visual' : groupDetails ? '.local/connector-quality-review/group-details/visual' : entityOverview ? '.local/connector-entity-components/group-visual' : connectorDetails ? '.local/channel-current-session-regression/connector-details-modern/visual' : inputRecovery ? '.local/channel-current-session-regression/input-recovery-visual' : questionValidation ? '.local/channel-current-session-regression/question-form-visual' : statusPriority ? '.local/channel-current-session-regression/status-visual' : groupActivityActions ? '.local/channel-protocol/T-048/visual' : refusalClarity ? '.local/channel-protocol/T-046/visual' : conversationSync ? '.local/channel-protocol/T-036/visual' : popoverClarity ? '.local/channel-protocol/T-026/visual' : conversationSharing ? '.local/channel-protocol/T-021/visual' : applicationAccess ? '.local/member-access/application-visual' : memberAccess ? '.local/member-access/visual' : headerStatus ? '.local/group-readiness/connection-surface-visual' : '.local/channel-protocol/channel-entry'
const evidence = resolve(root, evidenceRoot, 'runs', randomUUID()), temporary = await mkdtemp(resolve(tmpdir(), 'amux-channel-entry-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs: {}, loadedTransforms: {},
  scope: connectorDetails ? 'Original connector dialog, saved member summaries and retained draft editors; controlled typed Host DTO leaves, actual Electron native navigation at wide/narrow light/dark. No live authorization, source repair or delivery claim.' : inputRecovery ? 'Production original connector recovery and separate reaction receipts, native wide/narrow navigation with controlled typed DTOs; no live rejoin, platform effect or installed App claim.' : questionValidation ? 'Production original-group diagnosis presents a correctable Question answer validation refusal at wide and split-Region narrow widths. Controlled safe DTO; actual Host/SDK wire qualified separately. No live callback, writes or card replacement.' : statusPriority ? 'Production current-group header and details, mixed content gap/refused action alongside four confirmed conversation effects and one separate connection notice, then normal results. Wide/narrow and dark/light; native navigation and zero writes. Synthetic safe DTOs, not live delivery or installed App.' : groupActivityActions ? 'Production group activity, typed contextual navigation and shared header at normal/split/narrow widths. Synthetic safe diagnosis with two approved members and a separate refused sender, confirmed deliveries, content gap and old unknown. Native input; no live platform, writes or installed App claim.' : refusalClarity ? 'Two production Renderer header popovers: one unsupported inbound message and independently confirmed outgoing reply, normal and true split Region narrow. Controlled typed safe diagnosis; no live platform effects or authorization changes.' : conversationSync ? 'Four T036 original SessionPane/Header/Composer frames: replies-only and full-conversation platform popovers at wide and split-Region narrow widths, with Terminal/InApp views. Native composer draft/caret/focus, retained pending input and zero writes; synthetic typed public DTO leaves, no live platform or Host/SDK qualification.' : popoverClarity ? 'Four T026 production Renderer frames: mixed recent confirmed requests and earlier unknown effects at wide/split-Region widths, expanded details, and unbound. Synthetic typed public DTOs; native hover/keyboard, original geometry and zero connection writes. No live platform or Host/SDK qualification.' : conversationSharing ? 'Original AgentConnectorDialog partial saved scope and explicit whole-conversation confirmation, synthetic typed original Lark/Discord audiences, native controls and zero authorization/platform writes. Actual owner/SDK propagation is qualified separately.' : applicationAccess ? 'Original saved-bot and group application/member access through native input with synthetic typed access/profile/operation leaves. Public authorization is qualified separately; no live grants.' : memberAccess ? 'Original group Member access through native input and complete Renderer, with synthetic typed original Binding/grant/operation leaves. Real public Host/CLI authorization is qualified separately; no live grants.' : headerStatus ? 'Original channel header, popover and group details; controlled public DTOs and native pointer/keyboard. Header narrow uses an actual split Region; details narrow uses the actual narrow window.' : 'Original controlled channel-entry journey.' }
const env = { ...process.env, pnpm_config_verify_deps_before_run: 'false' }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const path of ['apps/desktop/scripts/capture-channel-entry.mjs', 'apps/host/package.json', ...['entry.tsx', main, ...(groupClarity ? ['clarity-scene.cjs'] : []), 'index.html', 'scenario.md'].map(name => 'apps/desktop/scripts/fixtures/channel-entry/' + name), ...(conversationSync ? ['apps/desktop/scripts/fixtures/settings-connections/native-input.cjs'] : [])]) receipt.inputs[path] = sha(await readFile(resolve(root, path)))
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
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: [...hostAliases, ...aliases] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-channel-entry-renderer', enforce: 'pre', resolveId: browserInstalledDependency, transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
      receipt.inputs[relative(root, file)] = sha(readFileSync(file))
      receipt.loadedTransforms[relative(root, id)] = sha(code)
    } } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  if (!focused) await cp(compiled, resolve(evidence, 'compiled'), { recursive: true })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name)).map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = [], execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, main), resolve(compiled, 'index.html'), temporary, visual, ...(groupDetails ? ['--group-details', ...(groupClarity ? ['--group-clarity', ...(groupClarityOverview ? ['--clarity-overview-only'] : [])] : []), ...(process.argv.includes('--skip-reference') ? ['--skip-reference'] : [])] : []), ...(connectorDetails ? ['--connector-details-modern'] : []), ...(entityOverview ? ['--entity-overview'] : []), ...(inputRecovery ? ['--input-recovery'] : []), ...(popoverClarity ? ['--popover-clarity'] : []), ...(refusalClarity ? ['--refusal-clarity'] : []), ...(questionValidation ? ['--question-validation'] : []), ...(groupActivityActions ? ['--group-activity-actions'] : []), ...(statusPriority ? ['--status-priority'] : []), ...(statusPriorityDetails ? ['--status-priority-details'] : [])], { cwd: root, temporaryRoot: temporary, env, timeoutMs: connectorDetails ? 100000 : 60000, onLine: line => lines.push(line) })
  receipt.execution = execution
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.equal(render.frames.length, groupClarityOverview ? 2 : groupClarity ? 8 : groupDetails ? 4 : entityOverview ? 2 : connectorDetails ? 8 : inputRecovery ? 4 : statusPriority ? statusPriorityDetails ? 4 : 6 : groupActivityActions ? 6 : refusalClarity ? 2 : conversationSync ? 4 : popoverClarity || conversationSharing ? 4 : applicationAccess ? 5 : memberAccess ? 4 : 8)
  receipt.render = render; receipt.images = Object.fromEntries(await Promise.all([...render.frames, ...(render.references ?? []).map(item => item.file)].map(async file => [file, sha(await readFile(resolve(visual, file)))])))
  receipt.changedAfterLoad = []
  for (const [file, expected] of Object.entries(receipt.inputs)) {
    const current = sha(await readFile(resolve(root, file)))
    if (current === expected) continue
    // A controlled UI probe binds its compiled input, not concurrent unrelated Core work.
    // T071 still requires every changed product owner and its capture fixture to stay exact.
    const owned = /(?:components\/(?:AgentConnectorDialog|ConnectorDeliveryDetails|ConnectorGroupDetails|ConnectorMemberAccess|ConnectorRoomJoinLink|ConnectorTrafficSummary|ConnectorEntityIdentity|ConnectorRoomSelection)\.tsx|lib\/(?:connector-group-status|use-connector-group-diagnosis|use-connector-room-name)\.ts|styles\/(?:agent-connector|connector-group-details|connector-traffic-summary|connector-entity-identity)\.css|scripts\/(?:capture-channel-entry\.mjs|fixtures\/channel-entry\/))/u.test(file)
    assert.ok(connectorDetails && !owned, 'A loaded source changed during capture: ' + file)
    receipt.changedAfterLoad.push({ file, loaded: expected, current })
  }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }; assert.deepEqual(receipt.cleanup.remaining, [])
  await rm(temporary, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await writeFile(resolve(root, evidenceRoot, 'latest.json'), JSON.stringify({ evidence, receipt: resolve(evidence, 'receipt.json') }, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence }))
}
