import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { productInputs as filterProductInputs, captureInputs as filterCaptureInputs } from './fixtures/focus-composable-filters/inputs.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const timelineIdentities = process.argv.includes('--timeline-identities'), projectTimeline = timelineIdentities || process.argv.includes('--project-timeline')
const identityMutant = process.env.AGENTMUX_TIMELINE_IDENTITY_MUTANT
assert.ok(!identityMutant || timelineIdentities && ['inline-pill', 'scroll-padding'].includes(identityMutant), 'Known timeline identity inverses require the bounded identity mode')
const args = process.argv.slice(2).filter(arg => !['--project-timeline', '--timeline-identities'].includes(arg))
assert.ok(args[0] === '--evidence' && args[1] && args.length === 2, 'Use [--project-timeline | --timeline-identities] --evidence <private evidence directory>')
const entryFile = projectTimeline ? 'project-timeline-entry.mjs' : 'entry.mjs', mainFile = projectTimeline ? 'project-timeline-main.cjs' : 'main.cjs'
const productInputs = projectTimeline ? [
  ...(timelineIdentities ? ['styles/agent-avatar.css', 'lib/focus-timeline-name-width.ts'].map(name => 'apps/desktop/src/renderer/src/' + name) : []),
  ...['App.tsx', 'store.ts', 'styles/focus.css', 'components/ProjectRail.tsx', 'components/WorkspaceSidebar.tsx', 'components/GlobalFocusSurface.tsx', 'components/RecentFocusTimeline.tsx', 'components/AgentAvatar.tsx', 'components/FocusMessagePreview.tsx', 'components/FocusTimelineEventPreview.tsx', 'components/FocusFilters.tsx', 'components/WorkspaceWorkbench.tsx', 'components/StableWorkbenchView.tsx', 'lib/workspace-projects.ts', 'lib/focus-project-lanes.ts', 'lib/focus-history-timeline.ts', 'lib/focus-timeline-event-facts.ts', 'lib/focus-context.ts', 'lib/focus-filters.ts', 'lib/desktop-focus-navigation.ts', 'lib/conversation-read-api.ts'].map(name => 'apps/desktop/src/renderer/src/' + name),
  ...['client.ts', 'agent-session-store.ts', 'conversation.ts', 'conversation-reader.ts', 'public-rpc-service.ts', 'public-rpc-server.ts', 'public-rpc-client.ts'].map(name => 'packages/core/src/' + name),
  'apps/desktop/src/main/conversation-read-ipc.ts', 'apps/desktop/src/preload/conversation-read.ts', 'apps/desktop/src/shared/conversation-read.ts'
] : filterProductInputs
const captureInputs = projectTimeline ? [filterCaptureInputs[0], filterCaptureInputs[3], 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', ...[entryFile, mainFile, ...(timelineIdentities ? ['timeline-identity-scene.cjs'] : [])].map(name => 'apps/desktop/scripts/fixtures/focus-composable-filters/' + name)] : filterCaptureInputs
const evidence = resolve(args[1]); await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-composable-filters-')), fixture = join(desktop, 'scripts/fixtures/focus-composable-filters')
const require = createRequire(join(desktop, 'package.json')), { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], aliases = [], logs = []
const receipt = { mode: timelineIdentities ? 'timeline-identities' : projectTimeline ? 'project-timeline' : 'composable-filters', identityMutant: identityMutant ?? null, schema: projectTimeline ? 'agentmux.focus-project-timeline-capture.v1' : 'agentmux.focus-composable-filters-capture.v1', capturedPass: false, captureOnly: true, aestheticReview: 'not-performed', userAppRunRuntimeControlled: false,
  boundary: projectTimeline ? 'Actual App, ProjectRail, GlobalFocusSurface, Timeline and shared Reader. Current-source private Core FileStore/public Unix RPC, original Main IPC/preload and strict Renderer conversation API; sealed captured producer records and typed native Provider leaves. PTY/unused Monaco painting isolated. No live Run, user Runtime, restart or installation.' : 'Private Electron Renderer with actual App, GlobalFocusSurface, FocusFilters, Store and Workbench; maintained typed preview API. Only PTY/Agent and unused Monaco painting leaves isolated. No live Runtime, native Run proof, installation, user navigation or restart.' }
try {
  receipt.sourceResolution = { loadedDist: false, resolution: 'Current workspace public export source aliases; no Desktop build or unrelated dist scan.' }
  const workspaceSource = { name: 'current-workspace-public-sources', setup(builder) {
    // Preserve Vite's asset URL contract for the unused PDF leaf; emit the real
    // installed worker asset rather than treating its module as a default export.
    builder.onResolve({ filter: /\?url$/ }, async args => {
      const result = await builder.resolve(args.path.slice(0, -4), { resolveDir: args.resolveDir, kind: 'import-statement' })
      if (result.errors.length) return { errors: result.errors }
      return { path: result.path, namespace: 'asset-url' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }))
    builder.onResolve({ filter: /^@agentmux\// }, async args => {
      const [scope, name, ...parts] = args.path.split('/'), directory = [join(root, 'packages', name), join(root, 'apps', name)].find(path => existsSync(join(path, 'package.json')))
      assert.ok(directory, 'Known current workspace package ' + args.path)
      const manifestPath = join(directory, 'package.json'), manifestSource = await readFile(manifestPath), manifest = JSON.parse(manifestSource)
      inputs.set(manifestPath, hash(manifestSource))
      const entry = parts.length ? './' + parts.join('/') : '.', declarations = Object.entries(manifest.exports ?? {}).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
      for (const [pattern, value] of declarations) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)'), match = new RegExp('^' + escaped + '$').exec(entry)
        if (!match) continue
        const target = typeof value === 'string' ? value : value.browser ?? value.import ?? value.default
        assert.equal(typeof target, 'string', 'Public browser/import export ' + args.path)
        let source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts').replace('*', match[1] ?? '')
        if (name === 'identity' && entry === './runtime') source = './src/runtime-entry.ts'
        if (name === 'identity' && entry === './runtime-source') source = target
        const path = [resolve(directory, source), resolve(directory, source.replace(/\.ts$/, '.tsx'))].find(existsSync)
        assert.ok(path, 'Current public source exists ' + args.path + ' → ' + source)
        aliases.push({ specifier: args.path, publicExport: pattern, path: relative(root, path) })
        return { path }
      }
      throw new Error('No current public export for ' + args.path)
    })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); const component = path.slice(path.lastIndexOf('/') + 1)
      if (component === 'SessionPane.tsx') {
        const code = `import{createElement as h,useEffect}from'react';import{useAppStore}from${JSON.stringify(join(desktop, 'src/renderer/src/store.ts'))};export function SessionPane({sessionId,linkOrigin}){const key=linkOrigin.tabId+'/'+linkOrigin.regionId;useEffect(()=>{window.presentationLeaves.mounts.push(key);return()=>window.presentationLeaves.unmounts.push(key)},[key]);const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',{'data-fixture-session':sessionId,'data-owner-tab':linkOrigin.tabId,'data-owner-region':linkOrigin.regionId,style:{display:'flex',flexDirection:'column',height:'100%',minHeight:0,padding:'16px',gap:'12px'}},h('small',{style:{color:'var(--text-muted)'}},'Isolated PTY painting · '+linkOrigin.regionId),h('strong',null,'Original Agent work surface'),h('textarea',{'aria-label':'Original draft '+key,value:draft,readOnly:true,style:{width:'100%',flex:1,minHeight:'80px',resize:'none'}}))}`
        transformations.push({ path: relative(root, path), isolated: 'PTY/Agent painting only', sourceSHA256: hash(source), loadedSHA256: hash(code) }); return { contents: code, loader: 'js' }
      }
      if (component === 'EditorPane.tsx' || component === 'GitBranchDiffPane.tsx') {
        const code = `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ path: relative(root, path), isolated: 'Unused Monaco painting; no file Region in scene', sourceSHA256: hash(source), loadedSHA256: hash(code) }); return { contents: code, loader: 'js' }
      }
      if (component === 'monaco.ts') {
        const code = 'export {}'
        transformations.push({ path: relative(root, path), isolated: 'Unused Monaco painting initialization; no file Region in scene', sourceSHA256: hash(source), loadedSHA256: hash(code) }); return { contents: code, loader: 'js' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source))
      if (identityMutant === 'scroll-padding' && path === join(desktop, 'src/renderer/src/styles/focus.css')) {
        const anchor = 'scroll-padding-block-start: var(--focus-ruler-height);'
        assert.equal(source.split(anchor).length, 2, 'Unique actual viewport scroll safety owner')
        const code = source.replace(anchor, '')
        transformations.push({ path: relative(root, path), mutant: identityMutant, sourceSHA256: hash(source), loadedSHA256: hash(code), anchorCount: 1 })
        return { contents: code, loader: 'css' }
      }
      if (identityMutant === 'inline-pill' && path === join(desktop, 'src/renderer/src/styles/focus.css')) {
        const anchor = /\.recent-focus__track \.recent-focus__gutter \.agent-avatar--inline \{[^}]*\}/g
        const matches = source.match(anchor); assert.equal(matches?.length, 1, 'Unique actual timeline identity CSS owner')
        const previous = `.recent-focus__track .recent-focus__gutter .agent-avatar--inline {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 2px;
  font: inherit;
  color: inherit;
}`
        assert.notEqual(matches[0], previous, 'The candidate identity reset must be present before inverse')
        const code = source.replace(anchor, previous)
        transformations.push({ path: relative(root, path), mutant: identityMutant, sourceSHA256: hash(source), loadedSHA256: hash(code), anchorCount: matches.length })
        return { contents: code, loader: 'css' }
      }
      return { contents: source, loader: 'css' }
    })
  } }
  for (const input of captureInputs) { const path = join(root, input); inputs.set(path, hash(await readFile(path))) }
  const out = join(privateRoot, 'out'); await mkdir(out)
  if (projectTimeline) {
    const absolute = name => JSON.stringify(join(root, name))
    const exports = [['AgentMuxClient', 'packages/core/src/client.ts'], ['AgentMuxFileAgentSessionStore', 'packages/core/src/agent-session-store.ts'], ['AgentMuxControlServer', 'packages/core/src/public-rpc-server.ts'], ['connectAgentMuxRpc', 'packages/core/src/public-rpc-client.ts'], ['registerConversationReadIpc', 'apps/desktop/src/main/conversation-read-ipc.ts']]
    await build({ stdin: { contents: exports.map(([name, file]) => `export{${name}}from${absolute(file)};`).join('\n'), resolveDir: root }, outfile: join(out, 'conversation-owner.mjs'), bundle: true, platform: 'node', format: 'esm', plugins: [workspaceSource, { name: 'original-node-dependency-locations', setup(builder) { builder.onResolve({ filter: /^[^./]/ }, async args => { if (args.pluginData?.nodeDependency) return; if (args.path.startsWith('node:')) return { path: args.path, external: true }; const resolved = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { nodeDependency: true } }); assert.equal(resolved.errors.length, 0, args.path); return { path: resolved.path, external: true } }) } }], banner: { js: `import{createRequire as privateRequire}from'node:module';const require=privateRequire(${absolute('packages/core/package.json')});` }, logLevel: 'silent' })
    await symlink(join(root, 'packages/core/node_modules'), join(out, 'node_modules'))
    await symlink(join(desktop, 'node_modules'), join(privateRoot, 'node_modules'))
    await build({ stdin: { contents: `import{contextBridge,ipcRenderer}from'electron';import{createPreloadConversationRead}from${absolute('apps/desktop/src/preload/conversation-read.ts')};contextBridge.exposeInMainWorld('projectTimelineConversation',createPreloadConversationRead(ipcRenderer));contextBridge.exposeInMainWorld('projectTimelineOwner',{seed:value=>ipcRenderer.invoke('project-timeline:seed',value),facts:()=>ipcRenderer.invoke('project-timeline:facts')});`, resolveDir: root }, outfile: join(out, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], plugins: [workspaceSource], logLevel: 'silent' })
  }
  const renderer = join(out, 'app.js'), buildResult = await build({ entryPoints: [join(fixture, entryFile)], outfile: renderer, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true,
    plugins: [workspaceSource], conditions: ['browser', 'import', 'production', 'default'], logLevel: 'silent', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.avif': 'file', '.webp': 'file', '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = buildResult.metafile; receipt.aliases = aliases; receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha])); receipt.transformations = transformations
  for (const suffix of ['App.tsx', 'GlobalFocusSurface.tsx', 'FocusFilters.tsx', 'WorkspaceWorkbench.tsx', 'StableWorkbenchView.tsx', 'store.ts', 'focus-lane-origin.ts']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Actual loaded ' + suffix)
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(renderer)), css: hash(await readFile(join(out, 'app.css'))), ...(projectTimeline ? { conversationOwner: hash(await readFile(join(out, 'conversation-owner.mjs'))), preload: hash(await readFile(join(out, 'preload.cjs'))) } : {}) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), ...(timelineIdentities ? { AGENTMUX_TIMELINE_IDENTITIES: '1' } : {}) }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, mainFile), html, privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => {
    try { return [relative(root, path), hash(await readFile(path))] }
    catch (error) { if (error.code === 'ENOENT') return [relative(root, path), null]; throw error }
  })))
  receipt.affectedInputs = [...productInputs, ...captureInputs]
  for (const path of receipt.affectedInputs) {
    assert.equal(typeof receipt.inputs[path], 'string', 'Actual loaded affected input ' + path)
    assert.equal(receipt.sourceAfter[path], receipt.inputs[path], 'Affected source stable during capture ' + path)
  }
  receipt.peripheralCaptureDrift = Object.entries(receipt.inputs).filter(([path, sha]) => !receipt.affectedInputs.includes(path) && receipt.sourceAfter[path] !== sha)
    .map(([path, before]) => ({ path, before, after: receipt.sourceAfter[path], gate: 'Peripheral provenance; outside shared affected input scope.' }))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  assert.ok(receipt.frames.length >= (projectTimeline ? 6 : 12), 'Nonempty mode-specific full App frame matrix')
  receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.errors ? { errors: error.errors } : {}) }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { privateRoot, remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
