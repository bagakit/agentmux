import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const repository = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--source-only', 'Use --source-only to execute the owning Source slice, then bind its independent UI review for T-007. Real model qualification belongs to T-006.')
const sourceOnly = args[0] === '--source-only', sha = bytes => createHash('sha256').update(bytes).digest('hex')
const output = join(repository, '.tmp/mote-daily-cooperation'); await mkdir(output, { recursive: true })
const sourceBase = '061a498a287daedc705f368214feb1a1311842ed'
const definition = 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts'
const materials = 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const caller = 'apps/desktop/src/renderer/src/components/MoteFirstCooperation.tsx'
const test = 'apps/desktop/test/mote-daily-cooperation.test.tsx'
const config = 'apps/desktop/scripts/fixtures/mote-daily-cooperation/vitest.config.mts'
const panel = 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx'
const style = 'apps/desktop/src/renderer/src/styles/mote-workface.css'
const own = [definition, materials, test, config, relative(repository, import.meta.filename)]
const overlays = [...own, caller, panel, style]
async function candidateBytes(path) {
  let bytes = await readFile(join(repository, path))
  if (path === panel) bytes = Buffer.from(bytes.toString().replace(/^import \{ MoteCurrentWork \} from '\.\/MoteCurrentWork'\r?\n/m, '')
    .replace(/^      <MoteCurrentWork scope=\{scope\} reference=\{reference\} \/>\r?\n/m, ''))
  if (path === style) {
    const text = bytes.toString(), split = text.indexOf('\n.mote-current-work {')
    if (split >= 0) {
      assert.ok(text.slice(split).trim().split('\n').every(line => line.startsWith('.mote-current-work')), 'Only the separately owned current-work CSS block may be excluded')
      bytes = Buffer.from(text.slice(0, split) + '\n')
    }
  }
  return bytes
}
function baseBytes(path) { return execFileSync('git', ['show', sourceBase + ':' + path], { cwd: repository, maxBuffer: 8 * 1024 * 1024 }) }
if (!sourceOnly) {
  try {
    const locator = JSON.parse(await readFile(join(output, 'approved.json'), 'utf8'))
    const pinned = async value => {
      assert.ok(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'Every evidence input needs an exact path and SHA')
      const bytes = await readFile(resolve(repository, value.path)); assert.equal(sha(bytes), value.sha256, 'Evidence bytes differ: ' + value.path)
      return JSON.parse(bytes)
    }
    const raw = await pinned(locator.sourceGate), ui = await pinned(locator.renderer), review = await pinned(locator.review)
    assert.equal(raw.taskId, 'T-007'); assert.equal(raw.sourceBase, sourceBase); assert.equal(raw.sourceQualified, true)
    assert.equal(review.status, 'approved'); assert.ok(review.taskIds?.includes('T-007'))
    assert.equal(review.sourceGate?.sha256, locator.sourceGate.sha256); assert.equal(review.renderer?.sha256, locator.renderer.sha256)
    assert.ok(raw.callers.length > 0 && Object.keys(raw.source).length > 0 && Object.keys(raw.harnessSource).length > 0)
    assert.ok(raw.runs.length > 1 && raw.runs.every(run => run.collected && run.tests > 0 && (run.expected === 'GREEN' ? run.code === 0 : run.assertion && run.code !== 0)))
    assert.ok(raw.types && raw.types.diagnostics.length === 0 && Object.keys(raw.types.source).length > 0)
    for (const [path, digest] of Object.entries({ ...raw.sourceContext, ...raw.source, ...raw.types.source }))
      assert.equal(sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), digest, 'Qualified Source differs: ' + path)
    for (const path of own) assert.equal(sha(await readFile(join(repository, path))), raw.harnessSource[path], 'Task gate differs: ' + path)
    assert.equal(ui.passed, true); assert.equal(ui.process.exitCode, 0); assert.equal(ui.process.timedOut, false)
    assert.ok(ui.renderer?.passed && ui.renderer.operations?.length > 0 && Object.keys(ui.images).length > 0)
    for (const [path, digest] of Object.entries(ui.source)) if (/^(apps\/desktop\/src|packages\/)/.test(path))
      assert.equal(sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), digest, 'Renderer production import differs: ' + path)
    for (const path of [definition, materials, store, caller, panel, style])
      assert.equal(ui.source[path], sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), 'Renderer did not load the exact cooperation Source: ' + path)
    for (const [path, digest] of Object.entries(ui.images))
      assert.equal(sha(await readFile(resolve(repository, dirname(locator.renderer.path), basename(path)))), digest, 'Reviewed full image differs: ' + path)
    console.log(JSON.stringify({ passed: true, taskId: 'T-007', sourceGate: locator.sourceGate, renderer: locator.renderer, review: locator.review,
      boundary: 'Source/UI qualification only; actual model use remains T-006.' }))
  } catch (error) { console.error('T-007 is unqualified. Execute --source-only and bind exact independent operated UI review in .tmp/mote-daily-cooperation/approved.json.\n' + error.stack); process.exitCode = 1 }
} else {
const attempt = await mkdtemp(join(output, 'attempt-')), snapshot = join(attempt, 'source')
const variants = [
  { id: 'material-scope', path: definition, from: 'paths.some(path => !fileExplorerContains(scope.rootPath, path) || path === scope.rootPath)', to: 'false' },
  { id: 'material-bound', path: definition, from: 'paths.length > 4 ||', to: 'false ||' },
  { id: 'source-revision', path: definition, from: 'revision: result.document.revision,', to: 'revision: "unconfirmed",' },
  { id: 'later-question', path: definition, from: 'if (changed || !stillCurrent()) throw', to: 'if (changed) throw' },
  { id: 'navigation-aba', path: definition, from: 'fileNavigationSelection(current) !== navigation || current.workspaceFileRevisions', to: 'false || current.workspaceFileRevisions' },
  { id: 'material-corrected-in-flight', path: definition, from: 'current.workspaceFileRevisions[scope.workspace.id] !== revision ||', to: 'false ||' },
  { id: 'original-question', path: definition, from: 'openMoteDiscussionDraft(scope, input.question,', to: 'openMoteDiscussionDraft(scope, "Wrong question",' },
  { id: 'frozen-context-delivery', path: definition, from: '{ reference, agentMuxNote })', to: '{ reference })' },
  { id: 'new-launcher-later-context', path: materials,
    from: "if (options.agentMuxNote !== undefined && current.agentComposerNotes[region.regionId] !== undefined)\n    return fail('The new Launcher already has later context. That context and your question are kept; review the Launcher before retrying.')",
    to: "useAppStore.setState(next => { const notes = { ...next.agentComposerNotes }; delete notes[region.regionId]; return { agentComposerNotes: notes } })" },
  { id: 'new-launcher-later-input', path: materials,
    from: "if (changed || next.tabs[tabId] !== tab || next.agentComposerDrafts[region.regionId] !== prompt ||\n          next.agentComposerNotes[region.regionId] !== undefined ||", to: 'if (false ||' },
  { id: 'new-launcher-context-resource', path: materials,
    from: "!confirmedMoteReference(next, owner, {\n            reference: { displayWorkspaceId: destination.displayWorkspaceId, groupId: destination.groupId, tabId, regionId: region.regionId }\n          })", to: 'false' },
  { id: 'original-store-context-consumer', path: store, from: 'const launchNote = agentMuxNote ?? state.agentComposerNotes[regionId]', to: 'const launchNote = agentMuxNote' },
  { id: 'profile-real-helper-caller', path: caller, from: 'onClick={() => void prepare()}', to: 'onClick={() => {}}' },
  { id: 'profile-later-input', path: caller, from: 'lifetime.current === epoch && useLauncherState.getState().drafts[key] === draft', to: 'lifetime.current === epoch' }
]
const receipt = { schema: 'agentmux.mote-daily-cooperation-source.v1', taskId: 'T-007', passed: false, sourceBase,
  sourceQualified: false, sourceOnly, source: {}, sourceContext: {}, overlay: {}, harnessSource: {}, callers: [], runs: [], failure: null,
  qualifications: { source: 'pending', actualUi: 'pending', realModel: 'separate-T006-pending-authentication' },
  boundary: 'Actual owning Source, original App/Store/Files protocol and real production Profile caller with isolated loaded mutants. DOM host and file observations are fixtures; no actual model, user App/Run, package, install, Native or visual approval claim.' }
const originals = {}, expectedTests = [], immutableSource = {}
async function run(label, expected, mutant) {
  const report = join(attempt, label + '.json'), sourceFile = join(attempt, label + '.loaded-source.ndjson')
  const child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(snapshot, config),
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { cwd: snapshot,
    env: { ...process.env, TMPDIR: _hygiene_fixturePath("tmp"), AGENTMUX_COOPERATION_SOURCE_RECEIPT: sourceFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
  clearTimeout(timer); await writeFile(join(attempt, label + '.log'), log)
  const row = { label, expected, ...status, collected: false, assertion: false, report: relative(repository, report), loadedSource: relative(repository, sourceFile) }
  receipt.runs.push(row)
  assert.equal(status.signal, null, 'A process termination is not behavior qualification')
  const raw = await readFile(report), value = JSON.parse(raw), tests = value.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(tests.length > 0, 'Owning assertions must be nonempty'); assert.equal(value.numPendingTests, 0)
  const names = tests.map(one => one.fullName).sort()
  if (!expectedTests.length) expectedTests.push(...names)
  assert.deepEqual(names, expectedTests, 'Every run must collect the same complete owning counterexamples')
  row.collected = true; row.tests = names.length; row.reportSha256 = sha(raw)
  row.assertion = tests.some(one => one.status === 'failed' && one.failureMessages.some(message =>
    /AssertionError:|expected .* to |promise resolved .* instead of rejecting|promise rejected .* instead of resolving/s.test(message)))
  const entries = (await readFile(sourceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), loaded = {}
  assert.ok(entries.length > 0, 'Loaded production Source cannot be empty')
  for (const entry of entries) {
    assert.ok(!loaded[entry.path] || loaded[entry.path] === entry.sha256, 'One run cannot mix two Source versions')
    loaded[entry.path] = entry.sha256
  }
  assert.ok(loaded[definition] && loaded[materials] && loaded[store] && loaded[caller] && loaded[test], 'Owning implementation, actual caller and counterexamples must all be loaded')
  if (mutant) assert.equal(loaded[mutant.path], sha(await readFile(join(snapshot, mutant.path))), 'The actual mutant must be loaded')
  row.loadedSha256 = sha(await readFile(sourceFile))
  if (expected === 'GREEN') {
    assert.equal(status.code, 0, log); assert.equal(value.success, true); assert.ok(tests.every(one => one.status === 'passed'))
    for (const [path, digest] of Object.entries(loaded)) {
      assert.ok(!receipt.source[path] || receipt.source[path] === digest, 'Restored runs must use the original Source')
      receipt.source[path] = digest
    }
  } else { assert.notEqual(status.code, 0, 'The real product mutant stayed GREEN'); assert.ok(row.assertion, 'A load or setup failure cannot qualify as AssertionRED') }
  console.log(label + ': ' + expected)
}
try {
  await mkdir(snapshot)
  const folders = ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers', 'packages/core/src', 'packages/client-ui/src', 'packages/demand/src', 'packages/layout/src']
  const context = ['apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'vitest.setup.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'apps/desktop/package.json',
    ...['core', 'client-ui', 'demand', 'layout'].flatMap(name => ['packages/' + name + '/package.json', 'packages/' + name + '/tsconfig.json'])]
  const archive = execFileSync('git', ['archive', '--format=tar', sourceBase, ...folders, ...context], { cwd: repository, maxBuffer: 64 * 1024 * 1024 })
  const tar = spawn('tar', ['-x', '-C', snapshot], { stdio: ['pipe', 'ignore', 'pipe'] }); let tarError = ''
  tar.stderr.on('data', bytes => { tarError += bytes }); tar.stdin.end(archive)
  const tarCode = await new Promise((done, reject) => { tar.once('error', reject); tar.once('exit', done) })
  assert.equal(tarCode, 0, tarError)
  async function inventory(folder) {
    for (const entry of await readdir(join(snapshot, folder), { withFileTypes: true })) {
      const path = folder ? folder + '/' + entry.name : entry.name
      if (entry.isDirectory()) await inventory(path)
      else if (entry.isFile()) immutableSource[path] = sha(await readFile(join(snapshot, path)))
    }
  }
  await inventory('')
  for (const path of overlays) {
    const bytes = await candidateBytes(path)
    await mkdir(dirname(join(snapshot, path)), { recursive: true }); await writeFile(join(snapshot, path), bytes)
    receipt.overlay[path] = sha(bytes)
  }
  for (const path of context) receipt.sourceContext[path] = sha(await readFile(join(snapshot, path)))
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'apps/desktop/resources', ...['core', 'client-ui', 'demand', 'layout'].map(name => 'packages/' + name + '/node_modules')])
    await symlink(join(repository, path), join(snapshot, path))
  await writeFile(join(snapshot, 'package.json'), '{"type":"module"}\n')
  for (const path of [definition, materials, store, caller]) originals[path] = await readFile(join(snapshot, path))
  const lines = originals[caller].toString().split('\n'), line = lines.findIndex(value => value.includes('await prepareMoteCooperationDraft('))
  assert.ok(line >= 0 && definition !== caller && !caller.includes('/test/'), 'The natural helper needs a definition-external production consumer')
  receipt.callers.push({ symbol: 'prepareMoteCooperationDraft', definition, caller, line: line + 1 })
  const storeLine = originals[store].toString().split('\n').findIndex(value => value.includes('const launchNote = agentMuxNote ?? state.agentComposerNotes[regionId]'))
  assert.ok(storeLine >= 0, 'Frozen material context needs the original Store launch consumer')
  receipt.callers.push({ symbol: 'agentComposerNotes → launchAgent', definition: materials, caller: store, line: storeLine + 1 })
  for (const path of own) receipt.harnessSource[path] = sha(await readFile(join(repository, path)))
  const desktopConfig = join(snapshot, 'apps/desktop/tsconfig.json'), rawConfig = ts.readConfigFile(desktopConfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, dirname(desktopConfig), {}, desktopConfig), paths = {}
  for (const name of ['core', 'client-ui', 'demand', 'layout']) {
    const manifest = JSON.parse(await readFile(join(snapshot, 'packages/' + name + '/package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const value = typeof target === 'string' ? target : name === 'client-ui' ? target.browser : target.import
      assert.ok(value, 'Every public type consumer must map to original Source')
      const source = value.startsWith('./src/') ? value : value.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      paths['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(snapshot, 'packages/' + name, source)]
    }
  }
  const program = ts.createProgram([definition, caller, test, 'apps/desktop/src/renderer/src/global.d.ts'].map(path => join(snapshot, path)),
    { ...parsed.options, paths, noEmit: true, incremental: false, composite: false })
  receipt.types = { source: {}, diagnostics: ts.getPreEmitDiagnostics(program).map(value => ({ code: value.code,
    path: value.file ? relative(snapshot, value.file.fileName) : null, message: ts.flattenDiagnosticMessageText(value.messageText, '\n') })) }
  for (const file of program.getSourceFiles()) {
    const path = relative(snapshot, file.fileName)
    if (!path.startsWith('../') && !path.includes('/node_modules/') && !path.startsWith('node_modules/')) receipt.types.source[path] = sha(await readFile(file.fileName))
  }
  assert.equal(receipt.types.diagnostics.length, 0, JSON.stringify(receipt.types.diagnostics))
  await run('baseline', 'GREEN')
  for (const variant of variants) {
    const before = originals[variant.path].toString(); assert.equal(before.split(variant.from).length, 2, 'Each mutant needs one exact implementation anchor')
    await writeFile(join(snapshot, variant.path), before.replace(variant.from, variant.to))
    try { await run(variant.id + '-red', 'RED', variant) }
    finally { await writeFile(join(snapshot, variant.path), originals[variant.path]) }
    await run(variant.id + '-restored', 'GREEN')
  }
  assert.ok(receipt.callers.length > 0 && receipt.runs.length > 1)
  for (const [path, digest] of Object.entries({ ...receipt.types.source, ...receipt.source }))
    assert.equal(overlays.includes(path) ? sha(await candidateBytes(path)) : immutableSource[path], digest, 'Loaded candidate Source changed before this qualification ended: ' + path)
  for (const [path, digest] of Object.entries(receipt.harnessSource)) assert.equal(sha(await readFile(join(repository, path))), digest, 'Task gate changed during execution')
  for (const [path, digest] of Object.entries(receipt.sourceContext)) assert.equal(immutableSource[path], digest, 'Source configuration differs from the immutable base')
  receipt.sourceQualified = true; receipt.qualifications.source = 'qualified'; receipt.passed = sourceOnly
} catch (error) { receipt.failure = error.stack; process.exitCode = 1 }
finally {
  const file = join(attempt, 'receipt.json'); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(output, 'last.json'), JSON.stringify({ receipt: relative(repository, file), sha256: sha(await readFile(file)) }) + '\n')
  if (receipt.sourceQualified) await rm(snapshot, { recursive: true })
  console.log(JSON.stringify({ passed: receipt.passed, sourceQualified: receipt.sourceQualified, receipt: relative(repository, file), qualifications: receipt.qualifications }))
  if (receipt.failure) console.error(receipt.failure)
}
}
