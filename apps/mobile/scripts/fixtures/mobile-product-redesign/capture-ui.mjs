import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../../../desktop/scripts/probe-process.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, `.tmp/mobile-product-redesign/renderer-${randomUUID()}`), compiled = path.join(directory, 'compiled')

await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, captureSubset: 'mobile-product-redesign', aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Actual MobileApp, DeviceWorkface, original ConversationSurface and shared Composer in private Electron Chromium; controlled original SDK/Space/Mote/Goal facts and acknowledgements. Real CDP touch events and browser insertText are simulation, not a physical phone, OS keyboard, live Relay/Host/model/Run, package or install claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const loadedSource = {}
try {
  const mutationId = process.argv.find(value => value.startsWith('--mutation='))?.slice('--mutation='.length)
  const variants = {
    'avatar-oversize': { file: 'packages/client-ui/src/components/AgentAvatarFace.tsx', before: 'size = 18, mark', after: 'size = 28, mark' },
    'resource-leading-icon': { file: 'apps/mobile/src/mobile.css', before: '.mobile-session-list button > svg { flex: 0 0 auto;', after: '.mobile-session-list button > svg { margin-left: auto; flex: 0 0 auto;' },
    'duplicate-connection': { file: 'apps/mobile/src/MobileApp.tsx', before: '!conversationVisible ? connection.issue', after: 'true ? connection.issue' },
    'hide-unknown': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: "{attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}", after: "{attempt && attempt.phase === 'sending' ? renderPromptAttempt([draftKey, attempt]) : null}" },
    'persistent-confirmed-diagnostic': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: "{attempt && (attempt.phase !== 'confirmed' || Boolean(attempt.logId)) ? renderPromptAttempt([draftKey, attempt]) : null}", after: "{attempt && (attempt.phase !== 'confirmed' || attempt.manualInput) ? renderPromptAttempt([draftKey, attempt]) : null}" },
    'evidence-touch-target': { file: 'apps/mobile/src/mobile.css', before: '.mobile-goal-evidence button { min-width: 44px; min-height: 44px; padding: 6px 10px;', after: '.mobile-goal-evidence button { min-width: 12px; min-height: 12px; height: 12px; padding: 0;' },
    'density-padding': { file: 'apps/mobile/src/conversation/conversation.css', edits: [
      { before: 'padding: 0 6px 4px;', after: 'padding: 0 12px 10px;' },
      { before: 'padding: 2px 4px 0;', after: 'padding: 4px 6px 2px;' },
      { before: '--composer-input-pad-top: 2px; --composer-input-pad-bottom: 2px;', after: '--composer-input-pad-top: 4px; --composer-input-pad-bottom: 4px;' },
      { before: '.mobile-app .mobile-conversation .composer__editor .tiptap { padding-inline: 6px; }', after: '.mobile-app .mobile-conversation .composer__editor .tiptap { padding-inline: 12px; }' }
    ] },
    'density-tools': { file: 'apps/mobile/src/conversation/conversation.css', before: 'grid-template-columns: minmax(0,1fr) auto; min-height: 44px;', after: 'grid-template-columns: max-content minmax(0,1fr) max-content; min-height: 44px;' },
    'menu-directory': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: 'const locations = (id: string) => directory.places.get(id) ?? []',
      after: 'const locations = (id: string) => catalog?.locations.filter(location => catalog.regions.some(region => region.tabId === location.tabId && region.regionId === location.regionId && region.agentSessionId === id)) ?? []' },
    'menu-notice-spacing': { file: 'apps/mobile/src/mobile.css', before: '.mobile-agent-usage > .mobile-notice { margin: 4px 0 8px; font-size: 13px; line-height: 1.5; }', after: '' },
    'menu-sid-wrap': { file: 'packages/client-ui/src/styles/conversation-message.css', before: '.log-turn__sender-id code { flex: 1 1 0;', after: '.log-turn__sender-id code { flex: 1 1 auto;' },
    'menu-full-snapshot': { file: 'apps/mobile/src/MobileApp.tsx', edits: [
      { before: 'client && workface.selectedSessionId ? client.agentSession(workface.selectedSessionId) : undefined', after: 'client?.agentSessions().find(value => value.agentSessionId === workface.selectedSessionId)' },
      { before: '[client, connection.state, workface.selectedSessionId, sessionRevision])', after: '[client, connection.state, workface.selectedSessionId, sessionRevision, sheet, home, secondary])' }
    ] }
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
      plugin.onLoad({ filter: /\.(?:tsx|css)$/ }, args => {
        if (args.path !== path.join(root, variant.file)) return
        loadedSource[variant.file] = sha(source)
        return { contents: source, loader: variant.file.endsWith('.css') ? 'css' : 'tsx', resolveDir: path.dirname(args.path) }
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
        assert.ok(source?.startsWith('./src/'), 'Original browser Source export required')
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
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
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
  await fs.copyFile(path.join(root, 'apps/desktop/resources/icon-128.png'), path.join(iconProject, 'logo.png'))
  const iconOwner = path.join(compiled, 'project-appearance-owner.mjs')
  await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/main/project-appearance.ts'], outfile: iconOwner, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  const projectAppearance = await (await import(pathToFileURL(iconOwner).href)).projectAppearance(iconProject)
  const providerOwner = path.join(compiled, 'provider-catalog-owner.cjs')
  await build({ absWorkingDir: root, entryPoints: ['packages/core/src/agent-provider.ts'], outfile: providerOwner, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  const providerCatalog = new (require(providerOwner)).AgentProviderRegistry().catalog()
  assert.ok(providerCatalog.find(value => value.id === 'codex')?.composer?.commands?.length, 'Original Provider owner declares the captured Commands')
  assert.ok(projectAppearance.icon?.startsWith('data:image/'), 'The original App filesystem owner returns the real bounded project image')
  receipt.projectAppearance = { owner: 'apps/desktop/src/main/project-appearance.ts', kind: projectAppearance.kind, source: 'apps/desktop/resources/icon-128.png', imageSha256: sha(projectAppearance.icon) }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'product-entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [...overrides, clientSources, workers, sourceProof],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_MOBILE_PROVIDER_CATALOG__: JSON.stringify(providerCatalog), __AGENTMUX_MOBILE_PROJECT_APPEARANCE__: JSON.stringify(projectAppearance), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('(disabled):') && !file.startsWith('<define:'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  if (receipt.sourceOverride) {
    assert.equal(receipt.source[receipt.sourceOverride.file], receipt.sourceOverride.originalSha256, 'Mutation targets an actual nonempty production input')
    receipt.source[receipt.sourceOverride.file] = receipt.sourceOverride.sha256
  }
  receipt.loadedSource = loadedSource
  receipt.virtualInputs = Object.fromEntries(Object.entries(built.metafile.inputs).filter(([name]) => name.startsWith('(disabled):') || name.startsWith('<define:')))
  for (const name of ['capture-ui.mjs', 'product-main.cjs', ...(process.argv.includes('--conversation-density') ? ['conversation-density.cjs'] : []), ...(process.argv.includes('--conversation-density-hit') ? ['conversation-density-hit.cjs'] : []), ...(process.argv.includes('--conversation-attachments') ? ['conversation-attachments.cjs'] : [])]) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  for (const file of ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/conversation/MobileAttachments.tsx', 'apps/mobile/src/platform/native/device.ts', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(receipt.source[file], 'Nonempty original product inputs are required')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="product-entry.css"></head><body><div id="root"></div><script type="module" src="product-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  const subset = ['conversation-attachments', 'conversation-density-hit', 'conversation-density', 'agent-menu-notice', 'agent-menu', 'mote-home', 'spatial-resources', 'commands-entry', 'notice-light', 'notice-center', 'parity-final', 'baseline', 'navigation', 'source-recovery', 'input-history'].find(value => process.argv.includes('--' + value))
  if (subset) receipt.captureSubset = subset
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'product-main.cjs'), path.join(compiled, 'index.html'), directory, ...(subset ? [subset] : [])],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  if (subset === 'spatial-resources' && JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8')).passed) {
    receipt.restartProcess = await runProbeProcess(require('electron'), [path.join(fixture, 'product-main.cjs'), path.join(compiled, 'index.html'), directory, subset, 'restore'],
      { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
    receipt.restoredRenderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result-restored.json'), 'utf8'))
    assert.equal(receipt.restartProcess.exitCode, 0)
    assert.equal(receipt.restoredRenderer.passed, true, receipt.restoredRenderer.error?.message)
  }
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  for (const [file, digest] of Object.entries(loadedSource)) {
    assert.equal(digest, receipt.source[file], 'Captured byte identity matches the actual compiled source input: ' + file)
    if (file !== receipt.sourceOverride?.file) assert.equal(sha(await fs.readFile(path.join(root, file))), digest, 'Source retained through actual product capture: ' + file)
  }
  if (receipt.sourceOverride) assert.equal(sha(await fs.readFile(path.join(root, receipt.sourceOverride.file))), receipt.sourceOverride.originalSha256, 'Private mutation never changes the shared source')
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
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
