import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { productInputs, captureInputs } from './fixtures/focus-project-appearance/inputs.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const combinedPreferences = process.argv[4] === '--focus-preferences'
const neutralSurfaces = process.argv[4] === '--neutral-surfaces'
const groupOrganization = process.argv[4] === '--group-organization' || combinedPreferences
const selectionSettings = process.argv[4] === '--selection-settings' || combinedPreferences
const containerOrder = process.argv[4] === '--container-order', compactDiscussion = process.argv[4] === '--group-compact'
const groupDiscussion = process.argv[4] === '--group-discussion' || compactDiscussion
assert.ok(process.argv[2] === '--evidence' && process.argv[3] && (process.argv.length === 4 || process.argv.length === 5 && (containerOrder || groupDiscussion || neutralSurfaces || groupOrganization || selectionSettings)), 'Use --evidence <private evidence directory> [--container-order|--group-discussion|--group-compact|--neutral-surfaces|--group-organization|--selection-settings|--focus-preferences]')
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-project-appearance-')), fixture = join(desktop, 'scripts/fixtures/focus-project-appearance')
const require = createRequire(join(desktop, 'package.json')), { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], aliases = [], logs = []
const receipt = { schema: 'agentmux.focus-project-appearance-capture.v1', capturedPass: false, captureOnly: true, aestheticReview: 'not-performed', mode: combinedPreferences ? 'focus-preferences' : selectionSettings ? 'selection-settings' : groupOrganization ? 'group-organization' : neutralSurfaces ? 'neutral-surfaces' : compactDiscussion ? 'group-compact' : groupDiscussion ? 'group-discussion' : containerOrder ? 'container-order' : 'appearance', userAppRunRuntimeControlled: false,
  boundary: 'Private Electron Renderer with actual App, GlobalFocusSurface, FocusFilters, Store and Workbench; maintained typed preview API. Only PTY/Agent and unused Monaco painting leaves isolated. No live Runtime, native Run proof, installation, user navigation or restart.' }
try {
  assert.ok(!process.env.AGENTMUX_FOCUS_APPEARANCE_STYLE_MUTANT || ['oversized-menu', 'unbounded-menu', 'search-overflow', 'wrapped-footer', 'starved-search', 'preferences-scale', 'selected-frame'].includes(process.env.AGENTMUX_FOCUS_APPEARANCE_STYLE_MUTANT), 'Known actual style inverse')
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
      let contents = source
      const mutant = process.env.AGENTMUX_FOCUS_APPEARANCE_STYLE_MUTANT
      if (mutant === 'selected-frame' && path.endsWith('/styles/focus-context.css')) {
        const anchor = '.focus-context.is-selected { background: var(--focus-selected-surface); color: var(--text); }'
        const previous = '.focus-context.is-selected { background: var(--surface-3); color: var(--text); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--green) 72%, transparent), inset 3px 0 0 var(--green); }'
        assert.equal(source.split(anchor).length, 2, 'One original selected style owner')
        contents = source.replace(anchor, previous)
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents), inverse: 'Restore only the previous selected green frame and side bar' })
      }
      if (mutant === 'preferences-scale' && path.endsWith('/styles/focus-project-menu.css')) {
        const anchor = ".focus-project-preferences.tab-context-menu[data-state='open'] { animation: none; }"
        assert.equal(source.split(anchor).length, 2, 'One original fixed-descendant host animation override')
        contents = source.replace(anchor, '')
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents), inverse: 'Restore inherited shared menu-in animation on the exact preferences host' })
      }
      if (['oversized-menu', 'unbounded-menu'].includes(mutant) && path.endsWith('/styles/focus-project-menu.css')) {
        assert.ok(['oversized-menu', 'unbounded-menu'].includes(mutant), 'Known original style inverse')
        const before = mutant === 'oversized-menu' ? 'width: min(248px, calc(100vw - 16px));' : 'max-height: calc(100vh - 16px);'
        const after = mutant === 'oversized-menu' ? 'width: min(500px, calc(100vw - 16px));' : 'max-height: none;'
        assert.equal(source.split(before).length, 2, 'Unique actual style source anchor')
        contents = source.replace(before, after)
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents) })
      }
      if (mutant === 'wrapped-footer' && path.endsWith('/styles/focus-context.css')) {
        const before = '.focus-zone-tags .focus-context__topic > span { display: block; overflow: hidden; white-space: nowrap;'
        assert.equal(source.split(before).length, 2, 'Unique footer line source anchor')
        contents = source.replace(before, '.focus-zone-tags .focus-context__topic > span { display: block; overflow: hidden; white-space: normal;')
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents) })
      }
      if (mutant === 'starved-search' && path.endsWith('/styles/focus.css')) {
        const before = '.global-focus-surface .global-focus-main:has(> .focus-search-results) > .global-board-columns { flex-basis: 0; }'
        assert.equal(source.split(before).length, 2, 'Unique search allocation source anchor')
        contents = source.replace(before, '')
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents) })
      }
      if (mutant === 'search-overflow' && path.endsWith('/styles/focus.css')) {
        const before = '.focus-search-results { display: flex; flex-direction: column; overflow: hidden;'
        assert.equal(source.split(before).length, 2, 'Unique search containment source anchor')
        contents = source.replace(before, '.focus-search-results {')
        transformations.push({ path: relative(root, path), mutant, before: hash(source), compiledSource: hash(contents) })
      }
      return { contents, loader: 'css' }
    })
  } }
  for (const input of captureInputs) { const path = join(root, input); inputs.set(path, hash(await readFile(path))) }
  inputs.set(join(desktop, 'src/main/project-appearance.ts'), hash(await readFile(join(desktop, 'src/main/project-appearance.ts'))))
  await build({ entryPoints: [join(desktop, 'src/main/project-appearance.ts')], outfile: join(privateRoot, 'project-appearance.cjs'), bundle: true, platform: 'node', format: 'cjs', plugins: [workspaceSource], logLevel: 'silent' })
  const out = join(privateRoot, 'out'); await mkdir(out)
  const renderer = join(out, 'app.js'), buildResult = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: renderer, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true,
    plugins: [workspaceSource], conditions: ['browser', 'import', 'production', 'default'], logLevel: 'silent', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.avif': 'file', '.webp': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = buildResult.metafile; receipt.aliases = aliases; receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha])); receipt.transformations = transformations
  for (const suffix of ['App.tsx', 'GlobalFocusSurface.tsx', 'FocusFilters.tsx', 'WorkspaceWorkbench.tsx', 'StableWorkbenchView.tsx', 'store.ts', 'focus-lane-origin.ts']) assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Actual loaded ' + suffix)
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(renderer)), css: hash(await readFile(join(out, 'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence, ...(combinedPreferences ? ['--focus-preferences'] : selectionSettings ? ['--selection-settings'] : groupOrganization ? ['--group-organization'] : neutralSurfaces ? ['--neutral-surfaces'] : compactDiscussion ? ['--group-compact'] : groupDiscussion ? ['--group-discussion'] : containerOrder ? ['--container-order'] : [])], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8')); assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  assert.ok(receipt.frames.length >= (combinedPreferences ? 14 : selectionSettings || groupOrganization ? 7 : neutralSurfaces ? process.env.AGENTMUX_FOCUS_APPEARANCE_STYLE_MUTANT === 'selected-frame' ? 1 : 4 : compactDiscussion ? 6 : groupDiscussion ? 8 : containerOrder ? 8 : 10), 'Actual complete App frames cover the selected bounded scenario')
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
  receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.errors ? { errors: error.errors } : {}) }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { privateRoot, remaining, removed: false, evidencePreserved: true }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
