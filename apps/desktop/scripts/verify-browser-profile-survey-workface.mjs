import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, symlink, copyFile, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { startProfileSurveyOrigins } from './fixtures/browser-profile-survey-workface/origin-server.mjs'
import { fixturePath } from './lib/fixture-values.mjs'
import { stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

// A current-source private consumer. It never builds, installs or restarts the user's App.
const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(join(root, 'packages/core/package.json'))('esbuild'))
const { build: viteBuild } = require('vite')
const args = process.argv.slice(2), outputIndex = args.indexOf('--output'), caseIndex = args.indexOf('--case'), mutationIndex = args.indexOf('--mutation')
const selectedCase = caseIndex < 0 ? 'complete' : args[caseIndex + 1]
assert.ok(['admission', 'profile-switch', 'settings', 'complete', 'surface-windows', 'context-menu', 'address-selection', 'survey-browsing', 'survey-drag', 'settings-layout'].includes(selectedCase), 'Choose an exact Browser workface case')
const mutation = mutationIndex < 0 ? null : args[mutationIndex + 1]
const mutationCases = { 'settings-layout': {
  'eager-browser-management': { file: 'apps/desktop/src/renderer/src/components/settings/BrowserSettingsPane.tsx',
    before: 'const observing = active && managementOpen', after: 'const observing = active' }
}, 'survey-browsing': {
  'skip-page-reuse': { file: 'apps/desktop/src/renderer/src/lib/survey-page-navigation.ts',
    before: 'if (!state.surveyPageReferences.length', after: 'if (true || !state.surveyPageReferences.length' },
  'ignore-site': { file: 'apps/desktop/src/renderer/src/lib/survey-page-organization.ts',
    before: "id = site ? 'site:' + site : 'other'", after: "id = site ? 'site' : 'other'" }
}, 'survey-drag': {
  'clip-survey-drag-preview': { file: 'apps/desktop/src/renderer/src/components/SurveyItemList.tsx',
    before: '    const y = top - initial.top',
    after: '    const y = belowPointer' },
  'omit-research-tab-order': { file: 'apps/desktop/src/renderer/src/components/SurveyItemList.tsx',
    before: "  : data?.kind === 'tab-order' ? data : data?.kind === 'page-target'",
    after: "  : data?.kind === 'tab-order' ? null : data?.kind === 'page-target'" }
}, 'surface-windows': {
  'omit-recall-content-edge': { file: 'apps/desktop/src/renderer/src/components/GlobalRecallSurface.tsx',
    before: "useKnowledgeWindowChrome('recall')", after: "useKnowledgeWindowChrome('survey')" },
  'steal-main-surface': { file: 'apps/desktop/src/renderer/src/lib/knowledge-surface-navigation.ts',
    before: 'if (!detached) setMainSurface(surface)', after: 'setMainSurface(surface)' },
  'misroute-surface-menu': { file: 'apps/desktop/src/renderer/src/components/KnowledgeSurfaceWindow.tsx',
    before: "onSelect={() => void openWorkbenchWindow({ kind: 'surface', surface })}",
    after: "onSelect={() => void openWorkbenchWindow({ kind: 'surface', surface: 'recall' })}" }
}, admission: {
  'omit-explicit-admission': { file: 'apps/desktop/src/renderer/src/store.ts', before: 'if (request.profileId !== undefined) {', after: 'if (false && request.profileId !== undefined) {' },
  'project-whole-task': { file: 'apps/desktop/src/renderer/src/lib/survey-page-references.ts', before: "entity: { kind: 'region', regionId: page.regionId }", after: "entity: { kind: 'tab', tabId: owner.tab.id }" },
  'duplicate-region-host': { file: 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', before: 'const nativeRegionTarget = projectedSurface\n', after: "const nativeRegionTarget = projectedSurface && projectedSurface.kind !== 'browser'\n" },
  'close-on-weak-save': { file: 'apps/desktop/src/renderer/src/store.ts', before: 'try { survey = await get().registerSurveyBrowserPage(reference, browser.profileId!) }', after: "try { survey = await get().registerSurveyBrowserPage(reference, browser.profileId!); if (survey.outcome !== 'registered') await api.browser.close(browserId) }" }
}, 'profile-switch': {
  'steal-environment-keyboard-focus': { file: 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', before: 'if (!toolsOpen && !selection && focused && surface?.contains(focused) &&', after: 'if (false && !toolsOpen && !selection && focused && surface?.contains(focused) &&' }
}, 'context-menu': {
  'omit-context-profile-admission': { file: 'apps/desktop/src/renderer/src/lib/browser-native-opening.ts',
    before: "if (event.opening?.collectInSurvey || (fromSurveyPage && destination !== 'region')) {",
    after: "if (fromSurveyPage && destination !== 'region') {" },
  'ignore-workbench-menu-direction': { file: 'apps/desktop/src/renderer/src/lib/browser-child-projection.ts',
    before: "event.opening?.splitDirection ?? 'right'", after: "'right'" }
}, 'address-selection': {
  'delay-saved-addresses': { file: 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx',
    before: 'if (!history) {', after: 'if (false && !history) {' },
  'submit-draft-instead-of-selected-address': { file: 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx',
    before: 'onClick={() => submit(entry.text)}', after: 'onClick={() => submit(value)}' }
} }
const mutations = mutationCases[selectedCase] ?? {}
assert.ok(mutation === null || Object.hasOwn(mutations, mutation), 'Only an exact production mutation for the selected case is supported')
assert.ok(args.every((arg, index) => ['--case', '--output', '--mutation'].includes(arg) || index === outputIndex + 1 && outputIndex >= 0 || index === caseIndex + 1 && caseIndex >= 0 || index === mutationIndex + 1 && mutationIndex >= 0), 'Only --case, --output and --mutation are supported')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const output = resolve(outputIndex < 0 ? join(root, '.tmp/browser-profile-survey-workface', randomUUID()) : args[outputIndex + 1])
const scratch = process.env.AGENTMUX_SURVEY_PROOF_TMPDIR
const directory = await mkdtemp(scratch ? join(scratch, 'amx-ps-') : fixturePath('tmp/amx-ps-'))
const fixtures = join(root, 'apps/desktop/scripts/fixtures/browser-profile-survey-workface')
const packageRoot = join(directory, 'package'), dist = join(packageRoot, 'dist')
const sources = new Map()
const artifacts = new Map()
const receipt = { schema: 'agentmux.browser-profile-survey-workface.proof.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceMode: 'current-worktree-source-private-bundles', directory, selectedCase, phases: [],
  mutation: mutation ? { name: mutation, applied: [] } : null,
  independentVisualReview: 'not-performed', physicalInputQualified: false, launches: [],
  boundary: 'Actual BrowserPane/Store and production sandbox preload/registerIpc/BrowserViewManager/RuntimeController, real isolated Core Sessions and stock Electron, public RPC and current-source CLI. A second private process reads the first process saved data. No user App, Browser, Run, clipboard, credentials or upstream model is used.' }
if (selectedCase === 'context-menu') receipt.boundary = 'Two private production App processes. Original guest hits drive the real workbench menu, Renderer placement and persistent Core/Browser state. Window focus observation is supplied by the fixture. No user App, Browser, Run, clipboard or credentials are used.'
if (selectedCase === 'address-selection') receipt.boundary = 'One private production App and Browser. Original sandbox IPC returns saved history and defers the optional details request. Native Chromium pointer and keyboard invoke the exact URL and default search; external search resolution is disabled.'
await mkdir(output, { recursive: true }); await mkdir(dist, { recursive: true })
async function bind(file) {
  const absolute = resolve(file), name = relative(root, absolute), bytes = await readFile(absolute), digest = hash(bytes)
  if (sources.has(name)) assert.equal(sources.get(name), digest, 'The original qualification input changed: ' + name)
  sources.set(name, digest)
}
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify({ ...receipt, sources: Object.fromEntries(sources), artifacts: Object.fromEntries(artifacts) }, null, 2))
async function bindArtifact(file) {
  const info=await stat(file)
  if(info.isDirectory()){for(const child of await readdir(file))await bindArtifact(join(file,child));return}
  const bytes=await readFile(file);artifacts.set(relative(directory,file),{bytes:bytes.length,sha256:hash(bytes)})
}
const workspacePackages = new Map()
for (const directory of [...(await readdir(join(root, 'packages'))).map(name => join(root, 'packages', name)), join(root, 'apps/host')]) {
  let manifest; try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch { continue }
  await bind(join(directory, 'package.json'))
  workspacePackages.set(manifest.name, { directory, exports: manifest.exports ?? {} })
}
async function workspaceSource(specifier, browser = false) {
  const parts = specifier.split('/'), name = specifier.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  const pkg = workspacePackages.get(name)
  if (!pkg) return null
  const key = parts.length ? './' + parts.join('/') : '.'
  if (name === '@agentmux/identity' && key === './runtime') return join(pkg.directory, 'src/runtime-entry.ts')
  for (const [pattern, declaration] of Object.entries(pkg.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const [prefix, suffix = ''] = pattern.split('*')
    if (pattern.includes('*') ? !key.startsWith(prefix) || !key.endsWith(suffix) : pattern !== key) continue
    const substitution = pattern.includes('*') ? key.slice(prefix.length, key.length - suffix.length) : ''
    const selected = typeof declaration === 'string' ? declaration : browser ? declaration.browser ?? declaration.import : declaration.import ?? declaration.browser
    if (typeof selected !== 'string') continue
    const declared = selected.replace('*', substitution)
    const stem = declared.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts')
    for (const candidate of [resolve(pkg.directory, stem), resolve(pkg.directory, stem.replace(/\.ts$/u, '.tsx'))]) {
      try { await stat(candidate); return candidate } catch {}
    }
    // This one export is an explicitly generated runtime program, not a missing source alias.
    if (name === '@agentmux/identity' && key === './runtime-source') { const file = resolve(pkg.directory, declared); await bind(file); return file }
    throw new Error('Current public workspace source is unavailable: ' + specifier)
  }
  return null
}
async function externalSource(specifier, importer) {
  const resolver = createRequire(importer || join(root, 'package.json')), parts = specifier.split('/')
  const name = specifier.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const manifestFile = join(directory, name, 'package.json')
    let manifest; try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')) } catch { continue }
    const entry = manifest.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (!parts.length ? manifest.exports : undefined)
    const target = typeof entry === 'string' ? entry : typeof entry?.import === 'string' ? entry.import : entry?.import?.default
    if (!target) continue
    const file = resolve(dirname(manifestFile), target)
    await stat(file); await bind(manifestFile); await bind(file)
    return file
  }
  return resolver.resolve(specifier)
}
const browserAliases = [...workspacePackages].flatMap(([name, pkg]) => Object.entries(pkg.exports)
  .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).flatMap(([entry, declaration]) => {
  const target = typeof declaration === 'string' ? declaration : declaration.browser
  if (!target?.startsWith('./') || target.startsWith('./dist/')) return []
  return [{ find: new RegExp('^' + (name + (entry === '.' ? '' : entry.slice(1))).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'),
    replacement: resolve(pkg.directory, target).replace('*', '$1') }]
}))
// The external origin outlives both App processes. Restart does not reseed any
// App/Core data, and the original saved URL remains a genuinely loadable page.
const origins = await startProfileSurveyOrigins(), pageUrl = origins.pageUrl
receipt.originBoundary = 'Synthetic local HTTP identities, actual two origins; no external account or system authentication claim'
async function execute(phase) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_PROFILE_SURVEY_ROOT: directory, AGENTMUX_PROFILE_SURVEY_SOURCE: root, AGENTMUX_PROFILE_SURVEY_PHASE: phase,
    AGENTMUX_PROFILE_SURVEY_ORIGINS: JSON.stringify({primaryOrigin:origins.primaryOrigin,secondaryOrigin:origins.secondaryOrigin,loginUrl:origins.loginUrl,identityUrl:origins.identityUrl,childUrl:origins.childUrl,downloadUrl:origins.downloadUrl,...(selectedCase==='complete'?{artifact:{filename:origins.artifactFor('workface-person').filename,sha256:origins.artifactFor('workface-person').sha256,base64:origins.artifactFor('workface-person').bytes.toString('base64')}}:{})}), AGENTMUX_PROFILE_SURVEY_PAGE_URL: pageUrl, AGENTMUX_PROFILE_SURVEY_CASE: selectedCase,
    AGENTMUX_PROFILE_SURVEY_NODE: process.execPath, AGENTMUX_PROFILE_SURVEY_CLI: join(dist, 'agentmux.js'),
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_SPATIAL_STATE_STORE: join(directory, 'state/spatial-state.json'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(require('electron'), [join(directory, 'bootstrap.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    receipt.launches.push({phase,pid:child.pid})
    let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, timedOut, pid: child.pid, log }) })
  })
  await writeFile(join(output, phase + '.log'), result.log)
  assert.equal(result.timedOut, false, 'Private observation timeout is not a behavioral result')
  assert.equal(result.signal, null, 'Private process failure is not a behavioral result')
  const native = JSON.parse(await readFile(join(directory, phase + '-receipt.json'), 'utf8'))
  await writeFile(join(output, phase + '.json'), JSON.stringify(native, null, 2))
  for (const file of await readdir(directory)) if (file.startsWith(phase + '-') && file.endsWith('.png')) await copyFile(join(directory, file), join(output, file))
  if (native.passed) {
    receipt.savedState ??= []
    for (const [path, owner] of [['state/spatial-state.json', 'core-spatial'], ['workbench-user-state.sqlite', 'desktop-user-state']]) {
      const bytes = await readFile(join(directory, path)), file = phase + '-saved-' + owner + (path.endsWith('.sqlite') ? '.sqlite' : '.json')
      await writeFile(join(output, file), bytes); receipt.savedState.push({ phase, owner, file, sha256: hash(bytes) })
    }
  }
  receipt.phases.push({ phase, pid: result.pid, code: result.code, receipt: phase + '.json', sha256: hash(await readFile(join(output, phase + '.json'))), passed: native.passed })
  await save()
  assert.equal(result.code, 0, native.failure?.stack ?? result.log)
  assert.equal(native.passed, true)
  assert.deepEqual(native.cleanupFailures, [], 'Test-owned native resources clean up')
  return native
}
try {
  receipt.executables = {node:{path:process.execPath,sha256:hash(await readFile(process.execPath)),version:process.version},electron:{path:require('electron'),sha256:hash(await readFile(require('electron'))),version:require('electron/package.json').version}}
  await bind(import.meta.filename)
  if (selectedCase === 'context-menu') await bind(join(fixtures, 'context-video.webm'))
  for (const input of ['apps/host/native/workspace-move.c','apps/host/scripts/build-workspace-move-helper.mjs','apps/desktop/scripts/build-workspace-move-helper.mjs','apps/desktop/scripts/fixtures/browser-profile-survey-workface/origin-server.mjs']) await bind(join(root,input))
  execFileSync(process.execPath,[join(root,'apps/desktop/scripts/build-workspace-move-helper.mjs')],{cwd:root,stdio:'inherit'})
  await bind(join(root,'apps/desktop/resources/bin/agentmux-workspace-move'))
  await bind(join(fixtures, 'index.html'))
  await bind(join(fixtures, 'tsconfig.native.json'))
  for (const name of ['bin', 'vendor', 'package.json', 'node_modules']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
  await symlink(join(root, 'apps/desktop/resources'), join(directory, 'resources'))
  const options = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', packages: 'external', external: ['electron'],
    metafile: true, logLevel: 'warning', banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
    plugins: [{ name: 'current-handoff-workspace-sources', setup(builder) {
      builder.onResolve({ filter: /codex-managed-run\.js$/ }, () => ({ path: join(dist, 'providers/codex-managed-run.js'), external: true }))
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        const workspace = await workspaceSource(args.path)
        if (workspace) return { path: workspace }
        if (isBuiltin(args.path) || args.path === 'electron') return null
        return { path: await externalSource(args.path, args.importer), external: true }
      })
    } }] }
  for (const [source, target] of [
    ['packages/core/src/providers/codex-managed-run.ts', 'providers/codex-managed-run.js'],
    ['packages/core/src/control-endpoint-listener-worker.ts', 'control-endpoint-listener-worker.js'],
    ['packages/core/src/agentmux.ts', 'agentmux.js'],
    ['apps/desktop/scripts/fixtures/browser-profile-survey-workface/main.ts', 'main.mjs']
  ]) {
    const compiled = await build({ ...options, entryPoints: [source], outfile: join(dist, target) })
    for (const file of Object.keys(compiled.metafile.inputs)) await bind(resolve(root, file))
    if (source.endsWith('/main.ts')) for (const required of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-view-manager.ts',
      'apps/desktop/src/main/runtime-controller.ts', 'packages/core/src/public-rpc-service.ts']) assert.ok(compiled.metafile.inputs[required], 'Real owning module is consumed: ' + required)
  }
  const preload = await build({ absWorkingDir: root, bundle: true, platform: 'browser', format: 'cjs', conditions: ['module', 'browser', 'production'],
    mainFields: ['browser', 'module', 'main'], external: ['electron'], metafile: true, logLevel: 'warning',
    plugins: [{ name: 'current-preload-workspaces', setup(builder) { builder.onResolve({ filter: /^@agentmux\// }, async args => ({ path: await workspaceSource(args.path, true) })) } }],
    entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(directory, 'preload.cjs') })
  for (const file of Object.keys(preload.metafile.inputs)) await bind(resolve(root, file))
  const rendererInputs = new Set()
  const rendererSourcePlugin = () => ({ name: 'current-handoff-renderer', enforce: 'pre', async resolveId(id) { return workspaceSource(id, true) },
      async load(id) {
        if (id.startsWith(root + '/') && !id.includes('/node_modules/') && !id.includes('?') && /\.(?:[cm]?[jt]sx?|css)$/u.test(id)) await bind(id)
        const rule = mutation && mutations[mutation]
        if (rule && id === join(root, rule.file)) {
          const original = await readFile(id, 'utf8')
          assert.equal(original.split(rule.before).length - 1, 1, 'Production mutation must hit one exact loaded branch')
          const effective = original.replace(rule.before, rule.after)
          receipt.mutation.applied.push({ file: rule.file, originalSha256: hash(original), effectiveSha256: hash(effective) })
          return effective
        }
      },
      moduleParsed(info) { if (info.id.startsWith(root + '/') && !info.id.includes('/node_modules/')) rendererInputs.add(info.id.split('?')[0]) } })
  await viteBuild({ configFile: false, logLevel: 'error', root: fixtures, base: './', define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, worker: { format: 'es', plugins: () => [rendererSourcePlugin()] },
    resolve: { dedupe: ['react', 'react-dom'], alias: browserAliases },
    css: { postcss: { plugins: [{ postcssPlugin: 'handoff-css-source-inputs', async OnceExit(_sheet, { result }) {
      for (const message of result.messages) if (message.type === 'dependency' && typeof message.file === 'string' && message.file.startsWith(root + '/') && !message.file.includes('/node_modules/')) await bind(message.file)
    } }] } },
    plugins: [rendererSourcePlugin()],
    build: { outDir: join(directory, 'renderer'), emptyOutDir: false, minify: false, sourcemap: false, target: 'esnext' } })
  if(selectedCase==='complete'||selectedCase==='surface-windows'){
    // Production's privileged App portals into this exact script-free auxiliary shell.
    const shell=join(root,'apps/desktop/src/renderer/workbench-window.html')
    await bind(shell);await copyFile(shell,join(directory,'renderer/workbench-window.html'))
  }
  for (const required of ['apps/desktop/src/renderer/src/main.tsx', 'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', 'apps/desktop/src/renderer/src/lib/workbench-projection.ts']) assert.ok(rendererInputs.has(join(root, required)), 'Real Renderer consumer is bundled: ' + required)
  await writeFile(join(directory, 'bootstrap.cjs'), `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(directory)};for(const key of['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}const fail=error=>{console.error(error);fs.writeFileSync(path.join(root,process.env.AGENTMUX_PROFILE_SURVEY_PHASE+'-receipt.json'),JSON.stringify({passed:false,failure:{name:error.name,message:error.message,stack:error.stack},cleanupFailures:[]}));app.exit(1)};process.on('uncaughtException',fail);app.whenReady().then(()=>import(${JSON.stringify(join(dist, 'main.mjs'))})).catch(fail);`)
  for(const file of [dist,join(directory,'renderer'),join(directory,'preload.cjs'),join(directory,'bootstrap.cjs')])await bindArtifact(file)
  receipt.sourceCount = sources.size; assert.ok(sources.size > 0); await save()
  if (mutation) assert.ok(receipt.mutation.applied.length > 0, 'The production mutation must reach the actual Renderer bundle')
  const first = await execute('first')
  assert.equal(first.businessPassed, true, 'Boot or gallery rendering cannot qualify admission')
  if (selectedCase === 'address-selection') {
    assert.ok(first.cases.some(item => item.kind === 'address-selection-exact-navigation' && item.passed))
  } else if (selectedCase === 'context-menu') {
    for (const kind of ['context-menu-profile-admission', 'context-menu-original-frame-reload', 'context-menu-directional-split', 'context-menu-object-hierarchy', 'context-menu-short-keyboard', 'context-menu-exact-video-frame'])
      assert.ok(first.cases.some(item => item.kind === kind && item.passed), 'The original workbench menu must complete ' + kind)
    const restart = await execute('restart')
    assert.notEqual(first.pid, restart.pid)
    assert.deepEqual(restart.recoveredIdentity, first.savedIdentity)
    assert.ok(restart.cases.some(item => item.kind === 'context-menu-original-workface-recovered' && item.passed))
  } else {
    const restart = await execute('restart')
    assert.notEqual(first.pid, restart.pid, 'Recovery uses a second physical process')
    assert.equal(restart.businessPassed, true); assert.deepEqual(restart.recoveredIdentity, first.savedIdentity, 'Second PID must read original Profile/Browser/Region/Survey and mixed Task data without reseeding')
    if (selectedCase === 'surface-windows') for (const phase of [first, restart]) assert.ok(phase.cases.some(item => item.kind === 'surface-windows' && item.passed), 'The two-window workface must complete its own oracle')
    if (selectedCase === 'survey-browsing') for (const phase of [first, restart]) assert.ok(phase.cases.some(item => item.kind === 'survey-browsing' && item.passed))
    if (selectedCase === 'survey-drag') for (const phase of [first, restart]) assert.ok(phase.cases.some(item => item.kind === 'survey-drag' && item.passed))
    if (selectedCase === 'settings-layout') for (const phase of [first, restart]) assert.ok(phase.cases.some(item => item.kind === 'settings-layout' && item.passed))
    if(selectedCase==='profile-switch')for(const phase of [first,restart]){assert.equal(phase.profileSwitch?.completed,true);assert.ok(phase.cases.some(item=>item.kind==='profile-switch-dedicated-oracle'&&item.passed),'No admission fallthrough can qualify profile-switch')}
    if(selectedCase==='complete')for(const phase of [first,restart]){assert.equal(phase.complete?.completed,true);assert.ok(phase.complete.cases.length>0);assert.ok(phase.cases.some(item=>item.kind==='complete-dedicated-oracle'&&item.passed),'No admission/profile-switch fallthrough can qualify complete')}
  }
  for (const [file, digest] of sources) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Qualification candidate remained unchanged: ' + file)
  for(const [file,binding] of artifacts)assert.equal(hash(await readFile(join(directory,file))),binding.sha256,'The exact loaded native artifact remained unchanged: '+file)
  receipt.passed = true; await save()
  process.stdout.write('Profile Survey workface proof: GREEN\n' + join(output, 'receipt.json') + '\n')
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }; await save(); throw error
} finally {
  for (const phase of receipt.launches) await stopProbeProcesses(phase.pid, directory)
  receipt.privateProcessesRemaining = await listProbeProcesses(-1, directory); assert.deepEqual(receipt.privateProcessesRemaining, [])
  receipt.sourceDrift = []
  for (const [file, digest] of sources) if (hash(await readFile(resolve(root, file))) !== digest) receipt.sourceDrift.push(file)
  receipt.artifactDrift=[]
  for(const [file,binding] of artifacts)if(hash(await readFile(join(directory,file)))!==binding.sha256)receipt.artifactDrift.push(file)
  receipt.originRequests = origins.requests
  await save()
  await origins.close()
  if (['surface-windows', 'context-menu', 'profile-switch', 'address-selection', 'survey-browsing', 'survey-drag', 'settings-layout'].includes(selectedCase)) await rm(directory, { recursive: true, force: true })
}
// Receipts and screenshots remain in the original evidence directory.
