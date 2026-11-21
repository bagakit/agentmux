import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../../../desktop/scripts/probe-process.mjs'
import { workspaceSourceExport } from '../../../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../../../packages/identity/scripts/runtime-bundle.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = process.env.AMUX_MOBILE_CAPTURE_ROOT
  ? path.resolve(process.env.AMUX_MOBILE_CAPTURE_ROOT, `renderer-${randomUUID()}`)
  : path.join(root, process.argv.includes('--focus-availability') ? `.bagakit/feature-tracker/mobile-focus-availability/capture-${randomUUID()}` : process.argv.includes('--exact-first-read') ? `.tmp/mobile-loading-review/exact-first-read-capture/renderer-${randomUUID()}` : process.argv.includes('--density-workfaces') ? `.tmp/mobile-workface-architecture/density-workfaces/renderer-${randomUUID()}` : `.tmp/mobile-product-redesign/renderer-${randomUUID()}`)
const compiled = path.join(directory, 'compiled')

await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, captureSubset: 'mobile-product-redesign', aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Actual MobileApp, DeviceWorkface, original ConversationSurface and shared Composer in private Electron Chromium; controlled original SDK/Space/Mote/Goal facts and acknowledgements. Real CDP touch events and browser insertText are simulation, not a physical phone, OS keyboard, live Relay/Host/model/Run, package or install claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const loadedSource = {}
let privateServer
try {
  const identitySource = (await bundleIdentityRuntime()).source
  const identityModule = `export const identityRuntimeSource = ${JSON.stringify(identitySource)};\n`
  receipt.generated = { identityRuntimeSource: { sourceSHA256: sha(identitySource), moduleSHA256: sha(identityModule), loads: 0 } }
  const workspaceSources = { name: 'original-declared-workspace-source', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\// }, args => {
      if (args.path === '@agentmux/identity/runtime-source') return { path: args.path, namespace: 'original-identity-source' }
      const source = workspaceSourceExport(root, args.path)
      return source ? { path: source } : undefined
    })
    plugin.onLoad({ filter: /.*/, namespace: 'original-identity-source' }, () => {
      receipt.generated.identityRuntimeSource.loads++
      return { loader: 'js', contents: identityModule }
    })
  } }
  const mutationId = process.argv.find(value => value.startsWith('--mutation='))?.slice('--mutation='.length)
  const variants = {
    'mote-direct-main-disconnected': { file: 'apps/mobile/src/MobileApp.tsx',
      before: '{!historyVisible && moteConversation && !moteDirectAgent && moteTarget &&',
      after: '{false && !historyVisible && moteConversation && !moteDirectAgent && moteTarget &&' },
    'mote-private-assignment-unbound': { file: 'packages/client-ui/src/components/MoteAssignment.tsx',
      before: 'threadId: conversationId, mote: target.mote, messageId',
      after: 'threadId: conversationId, mote: target.mote' },
    'mote-group-files-unpinned': { file: 'apps/mobile/src/navigation/MobileMoteGroups.tsx',
      before: 'expectedFileRoot={target} rpc={request}', after: 'expectedFileRoot={undefined} rpc={request}' },
    'mote-groups-missing-threads-entry': { file: 'apps/mobile/src/MobileApp.tsx',
      before: '{teamSpaceId && <button type="button" className="mobile-text-button mobile-mote-groups-entry"',
      after: '{false && teamSpaceId && <button type="button" className="mobile-text-button mobile-mote-groups-entry"' },
    'mote-thread-tabs-disconnected': { file: 'packages/client-ui/src/components/MoteConversationThreads.tsx',
      before: 'value={view} onValueChange={setView}', after: 'value={view} onValueChange={() => {}}' },
    'mote-thread-layout-remounts': { file: 'packages/client-ui/src/components/MoteConversationThreads.tsx',
      before: 'detailHost={open === event.id ? pane : undefined}',
      after: 'detailHost={open === event.id && window.innerWidth >= 640 ? pane : undefined}' },
    'sheet-close-stays-open': { file: 'apps/mobile/src/navigation/MobileSheetHeader.tsx',
      before: 'aria-label={closeLabel}', after: 'aria-label={closeLabel} onClick={event => event.preventDefault()}' },
    'tool-format-follows-tail': { file: 'packages/client-ui/src/lib/conversation-body-work.ts', before: '    pauseFollowing()\n    this.anchor = { node: control', after: '    this.anchor = { node: control' },
    'tool-format-drops-state': { file: 'packages/client-ui/src/components/ConversationToolPayload.tsx', before: 'aria-pressed={formatted}', after: 'aria-pressed={false}' },
    'directory-retains-closed-issue': { file: 'apps/mobile/src/navigation/MobileDirectoryNotice.tsx', edits: [
      { before: 'return props.issues.length ? <DirectoryIssueDialog {...props} /> : null',
        after: 'return <DirectoryIssueDialog {...props} />' },
      { before: '  const [open, setOpen] = useState(false)',
        after: '  const [open, setOpen] = useState(false)\n  if (!issues.length) return null' }
    ] },
    'posture-menu-no-return-focus': { file: 'packages/client-ui/src/components/HoverDropdownMenu.tsx',
      before: 'if (menu.hover.current) event.preventDefault()\n        onCloseAutoFocus?.(event)',
      after: 'event.preventDefault()\n        onCloseAutoFocus?.(event)' },
    'agent-locations-stale-membership': { file: 'apps/mobile/src/navigation/mobile-agent-locations.ts', before: 'if (!catalog.locations.some(value => locationContextKey(value) === exact)) return false', after: 'void exact' },
    'search-enter-inserts': { file: 'packages/client-ui/src/components/SearchChoiceDialog.tsx',
      before: "if (event.target === input.current && event.key === 'Enter') { event.preventDefault(); return }",
      after: "if (event.target === input.current && event.key === 'Enter') { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>('button[data-choice]')?.click(); return }" },
    'agent-locations-transparent-sheet': { file: 'apps/mobile/src/navigation/agent-locations.css', before: "animation-name: mobile-agent-locations-enter;", after: 'animation-name: mobile-sheet-enter;' },
    'connection-inline-notice': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: '      {readers}', after: '      {readers}\n      {connection.issue ? <div className="mobile-conversation__connection">{connection.issue}</div> : null}' },
    'metadata-bottom-notice': { file: 'apps/mobile/src/MobileApp.tsx', before: '    <div className="mobile-notice-stack">', after: '    <div className="mobile-notice-stack">\n      {conversationStatus?.metadata.issue ? <div className="mobile-service-notice">{conversationStatus.metadata.issue}</div> : null}' },
    'focus-attention-rail': { file: 'apps/mobile/src/navigation/focus-home.css', before: 'background: var(--mobile-group); box-shadow: none; }', after: 'background: var(--mobile-group); box-shadow: inset 3px 0 0 var(--amber); }' },
    'interaction-attention-rail': { file: 'apps/mobile/src/conversation/chrome.css', before: 'border: 0; background: var(--mobile-attention-wash); box-shadow: none; }', after: 'border: 0; background: var(--mobile-attention-wash); box-shadow: inset 3px 0 0 var(--amber), 0 0 0 1px var(--mobile-hairline); }' },
    'header-extra-pixel': { file: 'apps/mobile/src/conversation/chrome.css', before: 'z-index: 3; border-bottom: 0; box-shadow: inset 0 -1px 0 var(--mobile-hairline);', after: 'z-index: 3; border-bottom: 1px solid var(--mobile-hairline);' },
    'dismiss-button-highlight': { file: 'apps/mobile/src/conversation/chrome.css', before: 'background: transparent; border: 0; box-shadow: none;', after: 'background: transparent; border: 0; box-shadow: var(--hl);' },
    'narrow-avatar-hidden': { file: 'apps/mobile/src/conversation/chrome.css', before: '/* The tab bar returns', after: '@media (max-width: 359px) { .mobile-app .mobile-session-toolbar > .mobile-session-identity > .mobile-object-avatar { display: none; } }\n/* The tab bar returns' },

    'notice-stack-unbounded': { file: 'apps/mobile/src/mobile.css', before: '.mobile-notice-stack { grid-row: 4; min-width: 0; max-height: min(12dvh, 96px); overflow-y: auto; overscroll-behavior: contain; }', after: '.mobile-notice-stack { grid-row: 4; min-width: 0; }' },
    'directory-notice-touch': { file: 'apps/mobile/src/mobile.css', before: 'gap: var(--sp-1); flex: none; min-width: 44px; min-height: 44px;', after: 'gap: var(--sp-1); flex: none; min-width: 28px; min-height: 28px;' },
    'mote-short-top': { file: 'apps/mobile/src/conversation/chrome.css', before: '.mobile-app .mobile-conversation__reading > .mote-conversation > :first-child { margin-top: auto; }', after: '.mobile-app .mobile-conversation__reading > .mote-conversation > :first-child { margin-top: 0; }' },
    'mote-sheet-gap': { file: 'apps/mobile/src/mobile.css', before: 'inset: -6px -12px 0; z-index: -1; border-radius: var(--radius-lg)', after: 'inset: 0; z-index: -1; border-radius: var(--radius-lg)' },
    'floating-background': { file: 'apps/mobile/src/conversation/conversation.css', before: '.mobile-conversation__floating-tools { display: flex;', after: '.mobile-conversation__floating-tools { background: var(--surface-1); display: flex;' },
    'floating-reading-overlap': { file: 'apps/mobile/src/conversation/conversation.css', before: '.mobile-conversation__floating-tools { display: flex;', after: '.mobile-conversation__floating-tools { transform: translateY(44px); display: flex;' },
    'floating-blank-row': { file: 'apps/mobile/src/conversation/conversation.css', before: '.mobile-conversation__reader { position: relative;', after: '.mobile-conversation__reader { margin-top: 44px; position: relative;' },
    'floating-focus-clipped': { file: 'apps/mobile/src/conversation/conversation.css', before: '.mobile-session-tool-slot .mobile-conversation__floating-tools > button:focus-visible { outline-offset: -3px; }', after: '.mobile-session-tool-slot .mobile-conversation__floating-tools > button:focus-visible { outline-offset: 2px; }' },
    'spacing-sender-row': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: 'sourceLabelsInDetails detailsOnlyMetadata coverageSummary=', after: 'sourceLabelsInDetails coverageSummary=' },
    'spacing-tools-overlay': { file: 'apps/mobile/src/conversation/conversation.css', before: 'position: relative; align-self: flex-end; flex: none; margin-inline-end: 8px; display: flex; align-items: center; isolation: isolate; pointer-events: none;', after: 'position: absolute; inset-inline-end: 8px; bottom: 4px; display: flex; align-items: center; isolation: isolate; pointer-events: none;' },
    'focus-oversize': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: '<FocusStateMark kind={row.stateMark} presenceUnknown={row.presenceUnknown} />', after: '<FocusStateMark kind={row.stateMark} presenceUnknown={row.presenceUnknown} size={16} />' },
    'controls-terminal-route': { file: 'apps/mobile/src/MobileApp.tsx', before: "panel: value.panel === 'terminal' && !showGoalWork ? 'conversation' : 'terminal'", after: 'panel: value.panel' },
    'controls-goal-route': { file: 'apps/mobile/src/MobileApp.tsx', before: 'goalReturn.current = { trigger, sessionId: workface.selectedSessionId }; setShowGoalWork(true)', after: 'goalReturn.current = { trigger, sessionId: workface.selectedSessionId }; setShowGoalWork(false)' },
    'avatar-oversize': { file: 'packages/client-ui/src/components/AgentAvatarFace.tsx', before: 'size = 18, mark', after: 'size = 28, mark' },
    'resource-leading-icon': { file: 'apps/mobile/src/mobile.css', before: '.mobile-session-list button > svg { flex: 0 0 auto;', after: '.mobile-session-list button > svg { margin-left: auto; flex: 0 0 auto;' },
    'duplicate-connection': { file: 'apps/mobile/src/MobileApp.tsx', before: '!conversationVisible ? connection.issue', after: 'true ? connection.issue' },
    'hide-unknown': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: "{attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}", after: "{attempt && attempt.phase === 'sending' ? renderPromptAttempt([draftKey, attempt]) : null}" },
    'persistent-confirmed-diagnostic': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: "{attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}", after: "{attempt && (attempt.phase !== 'confirmed' || attempt.manualInput) ? renderPromptAttempt([draftKey, attempt]) : null}" },
    'evidence-touch-target': { file: 'apps/mobile/src/goals/evidence.css', before: '.mobile-goal-evidence button { min-width: 44px; min-height: 44px; padding: 0 var(--sp-2);', after: '.mobile-goal-evidence button { width: 12px; min-width: 12px; min-height: 12px; height: 12px; padding: 0;' },
    'auxiliary-spacing': { file: 'apps/mobile/src/conversation/chrome.css', before: '/* Compact auxiliary records', after: '.mobile-app .mobile-conversation .native-process-observation > .wf-card--observation { margin: var(--sp-1) var(--sp-2) !important; }\n/* Compact auxiliary records' },
    'auxiliary-touch': { file: 'apps/mobile/src/conversation/chrome.css', before: '/* Compact auxiliary records', after: '.mobile-app .mobile-conversation .conversation-reply-observation__toggle { min-height: 28px !important; }\n/* Compact auxiliary records' },
    'auxiliary-source-labels': { file: 'packages/client-ui/src/components/CapturedConversationMessage.tsx', before: 'sourceLabelsInDetails={props.sourceLabelsInDetails}', after: 'sourceLabelsInDetails={false}' },
    'density-padding': { file: 'apps/mobile/src/conversation/conversation.css', edits: [
      { before: 'padding: 0 6px 4px;', after: 'padding: 0 12px 10px;' },
      { before: 'padding: 2px 4px 0;', after: 'padding: 4px 6px 2px;' },
      { before: '--composer-input-pad-top: 2px; --composer-input-pad-bottom: 2px;', after: '--composer-input-pad-top: 4px; --composer-input-pad-bottom: 4px;' },
      { before: '.mobile-app .mobile-conversation .composer__editor .tiptap { padding-inline: 6px; }', after: '.mobile-app .mobile-conversation .composer__editor .tiptap { padding-inline: 12px; }' }
    ] },
    'density-tools': { file: 'apps/mobile/src/conversation/conversation.css', before: 'grid-template-columns: minmax(0,1fr) auto; min-height: 44px;', after: 'grid-template-columns: max-content minmax(0,1fr) max-content; min-height: 44px;' },
    'menu-directory': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: 'const locations = (id: string) => locationGroup(id, sessionById.get(id)?.hostId ?? directory.rows.get(id)?.projectGroup?.hostId)?.addresses ?? []',
      after: 'const locations = (id: string) => catalog?.locations.filter(location => catalog.regions.some(region => region.tabId === location.tabId && region.regionId === location.regionId && region.agentSessionId === id)) ?? []' },
    'menu-notice-spacing': { file: 'apps/mobile/src/mobile.css', before: '.mobile-agent-usage > .mobile-notice { margin: 4px 0 8px; font-size: 13px; line-height: 1.5; }', after: '' },
    'menu-sid-wrap': { file: 'packages/client-ui/src/styles/conversation-message.css', before: '.log-turn__sender-id code { flex: 1 1 0;', after: '.log-turn__sender-id code { flex: 1 1 auto;' },
    'menu-full-snapshot': { file: 'apps/mobile/src/MobileApp.tsx', edits: [
      { before: 'client && workface.selectedSessionId ? client.agentSession(workface.selectedSessionId) : undefined', after: 'client?.agentSessions().find(value => value.agentSessionId === workface.selectedSessionId)' },
      { before: '[client, connection.state, workface.selectedSessionId, sessionRevision])', after: '[client, connection.state, workface.selectedSessionId, sessionRevision, sheet, home, secondary])' }
    ] },
    'mote-strip-overlap': { file: 'apps/mobile/src/conversation/chrome.css', edits: [
      { before: '.mobile-app .mobile-mote-context .mobile-mote-source-status__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }', after: '.mobile-app .mobile-mote-context .mobile-mote-source-status__label { white-space: nowrap; }' },
      { before: '.mobile-app .mobile-mote-context .mobile-mote-source-status__subject, .mobile-app .mobile-mote-context .mobile-mote-source-status__chevron { display: none; }', after: '.mobile-app .mobile-mote-context .mobile-mote-source-status__chevron { display: none; }' }
    ] },
    'actions-always-visible': { file: 'apps/mobile/src/conversation/chrome.css', before: '.mobile-app .mobile-conversation .log-turn:not([data-actions-revealed],', after: '.mobile-app .mobile-conversation .log-turn[data-mutation-never]:not([data-actions-revealed],' },
    'human-bubble-icons': { file: 'apps/mobile/src/conversation/chrome.css', edits: [
      { before: '.mobile-app .mobile-conversation .log-turn:not([data-actions-revealed],', after: ".mobile-app .mobile-conversation .log-turn:not([data-speaker-role='human'], [data-actions-revealed]," },
      { before: "[data-speaker-role='external']):not([data-actions-revealed],", after: "[data-speaker-role='external'])[data-mutation-never]:not([data-actions-revealed]," }
    ] },
    'dismiss-small-hit': { file: 'apps/mobile/src/conversation/chrome.css', before: '.agent-interaction__actions > .agent-interaction__dismiss { order: 1; flex: 1 0 100%; margin: 0;', after: '.agent-interaction__actions > .agent-interaction__dismiss { order: 1; flex: 0 0 auto; margin: 0; min-height: 28px; height: 28px;' },
    'mote-team-label-hidden': { file: 'apps/mobile/src/conversation/chrome.css', before: '  .mobile-app .mobile-mote-context .mobile-mote-source-status__count { display: none; }',
      after: '  .mobile-app .mobile-mote-team-button__label, .mobile-app .mobile-mote-context .mobile-mote-source-status__count { display: none; }' }
  }
  const variant = mutationId ? variants[mutationId] : null
  if (mutationId) assert.ok(variant, 'Known bounded Mobile presentation mutation is required')
  const overrides = []
  if (variant) {
    const original = await fs.readFile(path.join(root, variant.file), 'utf8')
    let source = original
    for (const edit of variant.edits ?? [variant]) {
      assert.equal(source.split(edit.before).length - 1, 1, 'Actual production mutation anchor is unique')
      source = source.replace(edit.before, edit.after)
    }
    receipt.sourceOverride = { id: mutationId, file: variant.file, originalSha256: sha(original), sha256: sha(source) }
    overrides.push({ name: 'bounded-mobile-presentation-mutation', setup(plugin) {
      plugin.onLoad({ filter: /\.(?:tsx?|css)$/ }, args => {
        if (args.path !== path.join(root, variant.file)) return
        loadedSource[variant.file] = sha(source)
        return { contents: source, loader: path.extname(args.path).slice(1), resolveDir: path.dirname(args.path) }
      })
    } })
  }
  if (process.argv.includes('--floating-tools')) {
    const file = 'apps/mobile/scripts/fixtures/mobile-product-redesign/product-entry.tsx', original = await fs.readFile(path.join(root, file), 'utf8')
    const edits = [
      { before: '  const [webUpdateScene, setWebUpdateScene] = useState(false)\n', after: '  const [webUpdateScene, setWebUpdateScene] = useState(false)\n  const [nativeHeaderScene, setNativeHeaderScene] = useState(false)\n' },
      { before: '  Object.assign(window, { mobileProductScene: {\n', after: '  Object.assign(window, { mobileProductScene: {\n    setNativeHeaderScene,\n' },
      { before: 'platform={platform} webObservation={webUpdateScene ? webUpdateObservation : null}', after: 'platform={platform} native={nativeHeaderScene} webObservation={webUpdateScene ? webUpdateObservation : null}' }
    ]
    let source = original
    for (const edit of edits) { assert.equal(source.split(edit.before).length - 1, 1, 'Private native fixture injection anchor is unique'); source = source.replace(edit.before, edit.after) }
    receipt.fixtureOverride = { file, purpose: 'Only this controlled product scenario toggles the native header prop', originalSha256: sha(original), sha256: sha(source) }
    overrides.push({ name: 'private-native-header-fixture', setup(plugin) {
      plugin.onLoad({ filter: /product-entry\.tsx$/ }, args => {
        if (args.path !== path.join(root, file)) return
        loadedSource[file] = sha(source)
        return { contents: source, loader: 'tsx', resolveDir: path.dirname(args.path) }
      })
    } })
  }
  const alias = {}
  const clientFolder = path.join(root, 'packages/client-ui')
  const clientExports = Object.entries(JSON.parse(await fs.readFile(path.join(clientFolder, 'package.json'), 'utf8')).exports)
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  const clientSources = { name: 'original-client-ui-source', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => {
      const subpath = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length)
      for (const [key, target] of clientExports) {
        const [prefix, suffix = ''] = key.split('*')
        if (key.includes('*') ? !subpath.startsWith(prefix) || !subpath.endsWith(suffix) : subpath !== key) continue
        const source = typeof target === 'string' ? target : target.browser
        assert.ok((source?.startsWith('./src/') || source?.startsWith('./brand/')), 'Original browser Source export required')
        return { path: path.join(clientFolder, source.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined))) }
      }
      throw new Error('Missing actual client-ui Source export: ' + subpath)
    })
  } }
  const workerInputs = {}
  const sourceProof = { name: 'actual-mobile-input-bytes', setup(plugin) {
    plugin.onLoad({ filter: /\.(?:tsx?|css)$/ }, async args => {
      const file = path.relative(root, args.path)
      if (!file.startsWith('apps/mobile/src/') && !file.startsWith('packages/client-ui/src/') && args.path !== path.join(fixture, 'product-entry.tsx')) return
      const bytes = await fs.readFile(args.path)
      loadedSource[file] = sha(bytes)
      return { contents: bytes.toString(), loader: path.extname(args.path).slice(1), resolveDir: path.dirname(args.path) }
    })
  } }
  const workers = { name: 'original-monaco-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
    })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error', plugins: [clientSources, workspaceSources] })
      Object.assign(workerInputs, output.metafile.inputs)
      return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
    })
  } }
  for (const name of ['core', 'layout', 'demand', 'relay']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*')) continue
      const source = target.import.replace('./dist/', ['core', 'relay'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  const iconProject = path.join(directory, 'original-project')
  await fs.mkdir(iconProject)
  await fs.copyFile(path.join(root, 'packages/client-ui/src/assets/app-icons/qingzhuan.png'), path.join(iconProject, 'logo.png'))
  const iconOwner = path.join(compiled, 'project-appearance-owner.mjs')
  const iconBuild = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/main/project-appearance.ts'], outfile: iconOwner, bundle: true, platform: 'node', format: 'esm', logLevel: 'error', metafile: true, plugins: [workspaceSources] })
  const projectAppearance = await (await import(pathToFileURL(iconOwner).href)).projectAppearance(iconProject)
  let retentionFixtures = null
  if (process.argv.includes('--mote-main-retention')) {
    const evidenceRoot = process.env.AGENTMUX_MOTE_RETENTION_EVIDENCE
    assert.ok(evidenceRoot, 'Use the fresh actual-consumer fixture output, not a hand-authored setup DTO')
    retentionFixtures = {}
    receipt.retentionFixtures = {}
    for (const surface of ['welcome', 'profile']) {
      const file = path.resolve(evidenceRoot, surface + '-fixture.json'), bytes = await fs.readFile(file)
      retentionFixtures[surface] = JSON.parse(bytes)
      receipt.retentionFixtures[surface] = { file: path.relative(root, file), sha256: sha(bytes) }
      assert.equal(retentionFixtures[surface].result.binding, 'confirmed')
      assert.ok(retentionFixtures[surface].result.issue)
    }
  }
  const providerOwner = path.join(compiled, 'provider-catalog-owner.mjs')
  const providerBuild = await build({ absWorkingDir: root, entryPoints: ['packages/core/src/agent-provider.ts'], outfile: providerOwner, bundle: true, platform: 'node', format: 'esm',
    banner: { js: "import { createRequire as __providerRequire } from 'node:module'; const require = __providerRequire(import.meta.url);" }, logLevel: 'error', metafile: true, plugins: [workspaceSources] })
  await fs.symlink(path.join(root, 'packages/core/node_modules'), path.join(compiled, 'node_modules'), 'dir')
  const providerCatalog = new (await import(pathToFileURL(providerOwner).href)).AgentProviderRegistry().catalog()
  await fs.unlink(path.join(compiled, 'node_modules'))
  assert.ok(providerCatalog.find(value => value.id === 'codex')?.composer?.commands?.length, 'Original Provider owner declares the captured Commands')
  assert.ok(projectAppearance.icon?.startsWith('data:image/'), 'The original App filesystem owner returns the real bounded project image')
  receipt.projectAppearance = { owner: 'apps/desktop/src/main/project-appearance.ts', kind: projectAppearance.kind, source: 'packages/client-ui/src/assets/app-icons/qingzhuan.png', imageSha256: sha(projectAppearance.icon) }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'product-entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [...overrides, clientSources, workspaceSources, workers, sourceProof],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_MOBILE_SETUP_RETENTION__: JSON.stringify(retentionFixtures), __AGENTMUX_MOBILE_PROVIDER_CATALOG__: JSON.stringify(providerCatalog), __AGENTMUX_MOBILE_PROJECT_APPEARANCE__: JSON.stringify(projectAppearance), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  if (process.argv.includes('--tool-action-pressed')) {
    const worker = await build({ absWorkingDir: root, entryPoints: ['packages/client-ui/src/lib/markdown-render.worker.ts'],
      outfile: path.join(compiled, 'markdown-render.worker.js'), bundle: true, platform: 'browser', format: 'esm', target: 'esnext',
      metafile: true, logLevel: 'error', plugins: [clientSources, workspaceSources] })
    Object.assign(workerInputs, worker.metafile.inputs)
  }
  const inputs = { ...iconBuild.metafile.inputs, ...providerBuild.metafile.inputs, ...built.metafile.inputs, ...workerInputs }
  for (const file of Object.keys(inputs).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('original-identity-source:') && !file.startsWith('(disabled):') && !file.startsWith('<define:'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  for (const file of ['packages/core/test/helpers/workspace-source-export.mjs', 'packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts', 'packages/identity/src/index.ts']) receipt.source[file] = sha(await fs.readFile(path.join(root, file)))
  for (const directory of new Set(Object.keys(receipt.source).flatMap(file => /^packages\/[^/]+\/src\//.test(file) ? [file.split('/').slice(0, 2).join('/')] : file.startsWith('apps/host/src/') ? ['apps/host'] : []))) {
    const file = directory + '/package.json'; receipt.source[file] = sha(await fs.readFile(path.join(root, file)))
  }
  if (receipt.sourceOverride) {
    assert.equal(receipt.source[receipt.sourceOverride.file], receipt.sourceOverride.originalSha256, 'Mutation targets an actual nonempty production input')
    receipt.source[receipt.sourceOverride.file] = receipt.sourceOverride.sha256
  }
  if (receipt.fixtureOverride) {
    assert.equal(receipt.source[receipt.fixtureOverride.file], receipt.fixtureOverride.originalSha256, 'Private fixture injection targets original input')
    receipt.source[receipt.fixtureOverride.file] = receipt.fixtureOverride.sha256
  }
  if (process.argv.includes('--quiet-run-status')) receipt.source['apps/mobile/scripts/fixtures/mobile-product-redesign/quiet-run-status.cjs'] = sha(await fs.readFile(path.join(fixture, 'quiet-run-status.cjs')))
  receipt.loadedSource = loadedSource
  receipt.virtualInputs = Object.fromEntries(Object.entries(inputs).filter(([name]) => name.startsWith('original-identity-source:') || name.startsWith('(disabled):') || name.startsWith('<define:')))
  for (const name of ['capture-ui.mjs', 'product-main.cjs', ...(process.argv.includes('--mote-start') ? ['mote-start.cjs'] : []), ...(process.argv.includes('--mote-dialogue') ? ['mote-dialogue.cjs', 'thread-discovery.cjs'] : []), ...(process.argv.includes('--mote-main-setup') ? ['mote-main-setup.cjs'] : []), ...(process.argv.includes('--mote-discussion-restore') ? ['mote-discussion-restore.cjs'] : []), ...(process.argv.includes('--mote-notice-join') ? ['mote-notice-join.cjs'] : []), ...(process.argv.includes('--creation-update') ? ['creation-update.cjs'] : []), ...(process.argv.includes('--creation-recovery') ? ['creation-recovery.cjs'] : []), ...(process.argv.includes('--polish-followup') ? ['polish-followup.cjs'] : []), ...(process.argv.includes('--floating-tools') ? ['floating-tools.cjs'] : []), ...(process.argv.includes('--attachment-upload-exit') ? ['attachment-upload-exit.cjs'] : []), ...(process.argv.includes('--attachment-selection') ? ['attachment-selection.cjs'] : []), ...(process.argv.includes('--focus-state') ? ['focus-state.cjs'] : []), ...(process.argv.includes('--mature-shell') ? ['mature-shell.cjs'] : []), ...(process.argv.includes('--directory-notices') ? ['directory-notices.cjs'] : []), ...(process.argv.includes('--conversation-spacing') ? ['conversation-spacing.cjs'] : []), ...(process.argv.includes('--auxiliary-density') ? [process.argv.includes('--tool-action-pressed') ? 'tool-action-pressed.cjs' : 'auxiliary-density.cjs', 'auxiliary-density-fixture.ts'] : []), ...(process.argv.includes('--web-update') ? ['web-update.cjs'] : []), ...(process.argv.includes('--goal-recovery') ? ['goal-recovery.cjs'] : []), ...(process.argv.includes('--goal-exit') ? ['goal-exit.cjs'] : []), ...(process.argv.includes('--chat-start') ? ['chat-start.cjs'] : []), ...(process.argv.includes('--conversation-controls') ? ['conversation-controls.cjs'] : []), ...(process.argv.includes('--conversation-density') ? ['conversation-density.cjs'] : []), ...(process.argv.includes('--conversation-density-hit') ? ['conversation-density-hit.cjs'] : []), ...(process.argv.includes('--conversation-attachments') ? ['conversation-attachments.cjs'] : [])]) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  for (const file of ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/conversation/MobileAttachments.tsx', 'apps/mobile/src/platform/native/device.ts', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(receipt.source[file], 'Nonempty original product inputs are required')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="product-entry.css"></head><body><div id="root"></div><script type="module" src="product-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  const subset = ['topic-directory-search', 'question-receipts', 'focus-availability', 'exact-first-read', 'density-workfaces', 'mote-composer', 'responsive-primary-workfaces', 'compact-navigation', 'wide-agent-workface', 'auxiliary-density', 'agent-locations', 'conversation-status', 'brand-attention', 'brand-refinement', 'chrome-motion', 'terminal-restore', 'mature-shell', 'mote-start', 'mote-main-retention', 'quiet-run-status', 'directory-notices', 'mote-discussion-restore', 'mote-main-setup', 'mote-dialogue', 'mote-direct', 'mote-groups', 'creation-update', 'mote-notice-join', 'mote-host-boundaries', 'mote-cooperation', 'creation-recovery', 'polish-followup', 'floating-tools', 'attachment-upload-exit', 'attachment-selection', 'focus-state', 'conversation-spacing', 'web-update', 'goal-recovery', 'goal-exit', 'chat-start', 'conversation-controls', 'conversation-attachments', 'conversation-density-hit', 'conversation-density', 'agent-menu-notice', 'agent-menu', 'mote-home', 'spatial-resources', 'commands-entry', 'notice-light', 'notice-center', 'parity-final', 'baseline', 'navigation', 'source-recovery', 'input-history'].find(value => process.argv.includes('--' + value))
  if (['brand-attention', 'brand-refinement'].includes(subset)) for (const name of ['brand-attention.cjs', ...(subset === 'brand-refinement' ? ['brand-goals.cjs'] : [])]) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  if (subset === 'mote-composer') receipt.source[path.relative(root, path.join(fixture, 'mote-composer.cjs'))] = sha(await fs.readFile(path.join(fixture, 'mote-composer.cjs')))
  if (subset === 'agent-locations') receipt.source[path.relative(root, path.join(fixture, 'agent-locations.cjs'))] = sha(await fs.readFile(path.join(fixture, 'agent-locations.cjs')))
  if (subset === 'conversation-status') receipt.source[path.relative(root, path.join(fixture, 'conversation-status.cjs'))] = sha(await fs.readFile(path.join(fixture, 'conversation-status.cjs')))
  if (subset === 'chrome-motion') receipt.source[path.relative(root, path.join(fixture, 'chrome-motion.cjs'))] = sha(await fs.readFile(path.join(fixture, 'chrome-motion.cjs')))
  if (subset === 'mote-main-retention') receipt.source[path.relative(root, path.join(fixture, 'mote-main-retention.cjs'))] = sha(await fs.readFile(path.join(fixture, 'mote-main-retention.cjs')))
  if (['chat-start', 'goal-recovery', 'terminal-restore'].includes(subset)) for (const name of ['restart-chrome.cjs', ...(subset === 'terminal-restore' ? ['terminal-restore.cjs'] : [])]) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  if (subset === 'question-receipts') receipt.source[path.relative(root, path.join(fixture, 'question-receipts.cjs'))] = sha(await fs.readFile(path.join(fixture, 'question-receipts.cjs')))
  if (subset === 'exact-first-read') receipt.source[path.relative(root, path.join(fixture, 'exact-first-read.cjs'))] = sha(await fs.readFile(path.join(fixture, 'exact-first-read.cjs')))
  if (subset === 'density-workfaces') receipt.source[path.relative(root, path.join(fixture, 'density-workfaces.cjs'))] = sha(await fs.readFile(path.join(fixture, 'density-workfaces.cjs')))
  if (subset === 'responsive-primary-workfaces') receipt.source[path.relative(root, path.join(fixture, 'responsive-primary-workfaces.cjs'))] = sha(await fs.readFile(path.join(fixture, 'responsive-primary-workfaces.cjs')))
  if (subset === 'compact-navigation') for (const name of ['compact-navigation.cjs', 'wide-agent-workface.cjs']) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  if (subset === 'wide-agent-workface') receipt.source[path.relative(root, path.join(fixture, 'wide-agent-workface.cjs'))] = sha(await fs.readFile(path.join(fixture, 'wide-agent-workface.cjs')))
  if (subset === 'mote-direct') receipt.source[path.relative(root, path.join(fixture, 'mote-direct.cjs'))] = sha(await fs.readFile(path.join(fixture, 'mote-direct.cjs')))
  if (subset === 'mote-groups') receipt.source[path.relative(root, path.join(fixture, 'mote-groups.cjs'))] = sha(await fs.readFile(path.join(fixture, 'mote-groups.cjs')))
  if (subset) receipt.captureSubset = subset
  if (subset === 'focus-availability') receipt.source[path.relative(root, path.join(fixture, 'focus-availability.cjs'))] = sha(await fs.readFile(path.join(fixture, 'focus-availability.cjs')))
  if (process.argv.includes('--positions-only')) receipt.captureMode = 'positions-only'
  let productPage = path.join(compiled, 'index.html')
  if (['responsive-primary-workfaces', 'density-workfaces', 'exact-first-read'].includes(subset) || process.argv.includes('--tool-action-pressed')) {
    // A private HTTP origin supports persisted drafts and the shared Markdown Worker.
    privateServer = createServer(async (request, response) => {
      try {
        const file = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html'
        if (file !== path.basename(file)) { response.writeHead(404).end(); return }
        const bytes = await fs.readFile(path.join(compiled, file))
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' }).end(bytes)
      } catch { response.writeHead(404).end() }
    })
    await new Promise((accept, reject) => { privateServer.once('error', reject); privateServer.listen(0, '127.0.0.1', accept) })
    productPage = `http://127.0.0.1:${privateServer.address().port}/index.html?${subset}=1`
    receipt.privateOrigin = new URL(productPage).origin
  }
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'product-main.cjs'), productPage, directory, ...(subset ? [subset] : []), ...(process.argv.includes('--tool-action-pressed') ? ['tool-action-pressed'] : []), ...(process.argv.includes('--positions-only') ? ['positions-only'] : []), ...(process.argv.includes('--quiet-status-details-only') ? ['details-only'] : []), ...(process.argv.includes('--mote-start-visual-fixes') ? ['visual-fixes'] : [])],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  if (['exact-first-read', 'mote-composer', 'responsive-primary-workfaces', 'compact-navigation', 'wide-agent-workface', 'spatial-resources', 'chat-start', 'goal-recovery', 'terminal-restore', 'mote-discussion-restore', 'mote-groups'].includes(subset) && !process.argv.includes('--positions-only') && JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8')).passed) {
    receipt.restartProcess = await runProbeProcess(require('electron'), [path.join(fixture, 'product-main.cjs'), productPage, directory, subset, 'restore'],
      { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
    receipt.restoredRenderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result-restored.json'), 'utf8'))
    assert.equal(receipt.restartProcess.exitCode, 0)
    assert.equal(receipt.restoredRenderer.passed, true, receipt.restoredRenderer.error?.message)
  }
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  if (subset === 'mote-composer' && receipt.restoredRenderer) {
    const before = receipt.renderer.operations.find(value => value.action === 'same-editor-reading-welcome-main-no-input-replay')
    const after = receipt.restoredRenderer.operations.find(value => value.action === 'original-device-address-and-both-drafts-restored')
    assert.ok(before && after, 'Both actual process consumers observed the original Device owner')
    for (const key of ['recordId', 'sid', 'address', 'body', 'sessionB', 'route']) assert.deepEqual(after[key], before[key], 'Original Device field survives process restart: ' + key)
  }
  for (const [file, digest] of Object.entries(loadedSource)) {
    assert.equal(digest, receipt.source[file], 'Captured byte identity matches the actual compiled source input: ' + file)
    if (file !== receipt.sourceOverride?.file && file !== receipt.fixtureOverride?.file) assert.equal(sha(await fs.readFile(path.join(root, file))), digest, 'Source retained through actual product capture: ' + file)
  }
  if (receipt.sourceOverride) assert.equal(sha(await fs.readFile(path.join(root, receipt.sourceOverride.file))), receipt.sourceOverride.originalSha256, 'Private mutation never changes the shared source')
  if (receipt.fixtureOverride) assert.equal(sha(await fs.readFile(path.join(root, receipt.fixtureOverride.file))), receipt.fixtureOverride.originalSha256, 'Private fixture injection never changes the shared source')
  if (receipt.restoredRenderer) {
    assert.notEqual(receipt.renderer.environment.pid, receipt.restoredRenderer.environment.pid, 'Fresh OS process owns the restored product')
    receipt.renderer.images.push(...receipt.restoredRenderer.images)
  }
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  await fs.writeFile(path.join(directory, 'review.md'), '# Mobile product Renderer capture\n\nCapture only; independent aesthetic review has not run. Controlled Chromium is not physical phone validation.\n\nRenderer scenario: ' + (receipt.renderer.passed ? 'completed' : 'failed: ' + receipt.renderer.error?.message) + '\n\n' + receipt.renderer.images.map(file => '- [' + file + '](' + file + ')').join('\n') + '\n')
  assert.equal(receipt.renderer.passed, true, receipt.renderer.error?.message)
  assert.equal(receipt.process.exitCode, 0)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
if (privateServer) await new Promise(resolve => privateServer.close(resolve))
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.rm(compiled, { recursive: true, force: true })
if (receipt.captureSubset === 'exact-first-read' && receipt.process?.exitConfirmed === true && receipt.restartProcess?.exitConfirmed === true) {
  await fs.rm(path.join(directory, 'userData'), { recursive: true, force: true })
  receipt.profileCleanup = { removed: true, reason: 'Both private OS processes confirmed exit; original raw evidence retained.' }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
