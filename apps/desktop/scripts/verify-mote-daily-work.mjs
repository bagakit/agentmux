import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), sourceOnly = process.argv.includes('--source-only'), rebindOnly = process.argv.includes('--rebind-only')
if (!sourceOnly && !rebindOnly) {
 await import('./fixtures/mote-daily-autonomy/qualify-work-gate.mjs')
} else {
const output = join(root, '.tmp/mote-daily-work'); await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), snapshot = join(attempt, 'source')
const definition = 'apps/desktop/src/renderer/src/lib/mote-goals.ts', caller = 'apps/desktop/src/renderer/src/components/MoteCurrentWork.tsx'
const host = 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', test = 'apps/desktop/test/mote-daily-work.test.tsx'
const config = 'apps/desktop/scripts/fixtures/mote-daily-autonomy/vitest.work.config.mts'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const variants = [
 { id: 'foreign-goal', path: definition, from: 'goal.sessionIds.some(id => members.has(id))', to: 'true' },
 { id: 'legal-foreign-zone', path: definition, from: 'tab.zoneId !== null && zoneIds.has(tab.zoneId)', to: 'tab.workspaceId === scope.workspace.id && state.tabs[tab.tabId]?.topicId === scope.topic.id && tab.zoneId !== null && zoneIds.has(tab.zoneId)' },
 { id: 'unplaced-reference', path: definition, from: 'tabIds.has(region.tabId) && region.kind', to: 'catalog.locations.some(location => location.tabId === region.tabId) && tabIds.has(region.tabId) && region.kind' },
 { id: 'partial-results', path: definition, from: 'next: goalNextStep(goal)', to: "next: 'Accepted'" },
 { id: 'later-ui-intent', path: caller, from: 'associationIntent.current === submittedIntent && !moved', to: '!moved' },
 { id: 'cold-navigation-aba', path: caller, from: "if (fileNavigationSelection(next) !== navigation && !(next.mainSurface === 'board' && (id === null || next.selectedDemandId === id))) cancel()", to: 'void next' }
]
const receipt = { schema: 'agentmux.mote-daily-work-source.v1', task: 'T-002', passed: false, sourceQualified: false, source: {}, callers: [], runs: [],
 boundary: 'Actual original App/Profile/Goal/Store consumers and private original DemandStore with isolated loaded mutants; no model, package, installation or real Native qualification.' }
const names = [], originals = {}
async function run(label, expected, variant) {
 const report = join(attempt, label + '.json'), loadedPath = join(attempt, label + '.loaded.ndjson')
 const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(snapshot, config), '--reporter=json', '--outputFile=' + report],
  { cwd: snapshot, env: { ...process.env, AGENTMUX_WORK_SOURCE_RECEIPT: loadedPath }, stdio: ['ignore', 'pipe', 'pipe'] })
 let log = ''; child.stdout.on('data', b => { log += b }); child.stderr.on('data', b => { log += b })
 const timer = setTimeout(() => child.kill('SIGTERM'), 60000)
 const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) }); clearTimeout(timer)
 await writeFile(join(attempt, label + '.log'), log)
 const row = { label, expected, ...status, report: relative(root, report), loaded: relative(root, loadedPath) }; receipt.runs.push(row)
 assert.equal(status.signal, null)
 const raw = await readFile(report), value = JSON.parse(raw), tests = value.testResults.flatMap(suite => suite.assertionResults)
 assert.ok(tests.length && !value.numPendingTests, 'Assertions must be collected and executed')
 const currentNames = tests.map(one => one.fullName).sort(); if (!names.length) names.push(...currentNames); assert.deepEqual(currentNames, names)
 const loadedRaw = await readFile(loadedPath), loaded = {}
 for (const line of loadedRaw.toString().trim().split('\n')) { const entry = JSON.parse(line); assert.ok(!loaded[entry.path] || loaded[entry.path] === entry.sha256); loaded[entry.path] = entry.sha256 }
 for (const path of [definition, caller, host, test, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx']) assert.ok(loaded[path], 'Actual product consumer must load: ' + path)
 row.collected = tests.length; row.reportSha256 = sha(raw); row.loadedSha256 = sha(loadedRaw)
 if (expected === 'GREEN') { assert.equal(status.code, 0, log); assert.ok(value.success && tests.every(one => one.status === 'passed')); for (const [path, digest] of Object.entries(loaded)) { assert.ok(!receipt.source[path] || receipt.source[path] === digest); receipt.source[path] = digest } }
 else { assert.notEqual(status.code, 0); assert.ok(tests.some(one => one.status === 'failed' && one.failureMessages.some(message => /AssertionError:|expected .* to /s.test(message))), 'Load failures are not AssertionRED'); assert.equal(loaded[variant.path], sha(await readFile(join(snapshot, variant.path)))) }
 console.log(label + ': ' + expected)
}
try {
 await mkdir(snapshot)
 for (const folder of ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers', 'packages/core/src', 'packages/client-ui/src', 'packages/demand/src', 'packages/layout/src']) { await mkdir(dirname(join(snapshot, folder)), { recursive: true }); await cp(join(root, folder), join(snapshot, folder), { recursive: true }) }
 const context = ['vitest.setup.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'apps/desktop/package.json', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', ...['core','client-ui','demand','layout'].flatMap(name => ['packages/' + name + '/package.json', 'packages/' + name + '/tsconfig.json'])]
 for (const path of [test, config, ...context]) { await mkdir(dirname(join(snapshot, path)), { recursive: true }); await cp(join(root, path), join(snapshot, path)) }
 for (const path of ['node_modules','apps/desktop/node_modules', 'apps/desktop/resources', ...['core','client-ui','demand','layout'].map(name => 'packages/' + name + '/node_modules')]) await symlink(join(root, path), join(snapshot, path))
 await writeFile(join(snapshot, 'package.json'), '{"type":"module"}\n')
 for (const path of [definition, caller]) originals[path] = await readFile(join(snapshot, path))
 for (const [symbol, file, expression] of [['moteGoalContext', caller, 'moteGoalContext('], ['goalsForMote', caller, 'goalsForMote('], ['MoteCurrentWork', host, '<MoteCurrentWork'], ['GoalContinuationControl', caller, '<GoalContinuationControl']]) {
  const lines = (await readFile(join(snapshot, file), 'utf8')).split('\n'), index = lines.findIndex(line => line.includes(expression)); assert.ok(index >= 0); receipt.callers.push({ symbol, file, line: index + 1 })
 }
 await run('baseline', 'GREEN')
 if (!rebindOnly) for (const variant of variants) { const bytes = originals[variant.path].toString(); assert.equal(bytes.split(variant.from).length, 2, 'Exact mutant anchor'); try { await writeFile(join(snapshot, variant.path), bytes.replace(variant.from, variant.to)); await run(variant.id, 'RED', variant) } finally { await writeFile(join(snapshot, variant.path), originals[variant.path]) } await run(variant.id + '-restored', 'GREEN') }
 for (const path of [definition, caller, test, config]) assert.equal(sha(await readFile(join(root, path))), sha(await readFile(join(snapshot, path))), 'Owning candidate changed during proof')
 if (rebindOnly) {
  const { default: ts } = await import('typescript')
  const desktopConfig = join(snapshot, 'apps/desktop/tsconfig.json')
  const raw = ts.readConfigFile(desktopConfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(desktopConfig), {}, desktopConfig), paths = {}
  for (const name of ['core', 'client-ui', 'demand', 'layout']) {
   const manifest = JSON.parse(await readFile(join(snapshot, 'packages/' + name + '/package.json'), 'utf8'))
   for (const [subpath, target] of Object.entries(manifest.exports)) {
    const value = typeof target === 'string' ? target : name === 'client-ui' ? target.browser : target.import
    assert.ok(value, 'Original Source export required')
    const source = value.startsWith('./src/') ? value : value.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    paths['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(snapshot, 'packages/' + name, source)]
   }
  }
  const program = ts.createProgram([definition, caller, test, 'apps/desktop/src/renderer/src/global.d.ts'].map(path => join(snapshot, path)).concat([join(root, 'apps/desktop/node_modules/vite/client.d.ts')]),
   { ...parsed.options, paths, noEmit: true, incremental: false, composite: false })
  receipt.types = { source: {}, diagnostics: ts.getPreEmitDiagnostics(program).map(value => ({ code: value.code, path: value.file ? relative(snapshot, value.file.fileName) : null,
   message: ts.flattenDiagnosticMessageText(value.messageText, '\n') })) }
  for (const file of program.getSourceFiles()) {
   const path = relative(snapshot, file.fileName)
   if (!path.startsWith('../') && !path.includes('/node_modules/') && !path.startsWith('node_modules/')) receipt.types.source[path] = sha(await readFile(file.fileName))
  }
  assert.equal(receipt.types.diagnostics.length, 0, JSON.stringify(receipt.types.diagnostics))
  for (const [path, digest] of Object.entries({ ...receipt.source, ...receipt.types.source })) assert.equal(sha(await readFile(join(root, path))), digest, 'Current production changed during bounded Source rebind: ' + path)
  receipt.sourceRebound = true
 } else receipt.sourceQualified = true
 receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
finally { await rm(snapshot, { recursive: true, force: true }); receipt.temporarySourceRemoved = true; await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(relative(root, join(attempt, 'receipt.json'))); if (!receipt.passed) process.exitCode = 1

}
