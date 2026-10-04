import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const dir = resolve(process.env.AGENTMUX_PERF_EVIDENCE_DIR ?? resolve(root, '.local/performance-reading-demand'))
mkdirSync(dir, { recursive: true })
const source = ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/ConversationRuler.tsx']
const original = new Map(source.map(path => [path, readFileSync(resolve(root, path), 'utf8')]))
const tests = ['apps/desktop/test/activity-reading-demand.test.tsx', 'apps/desktop/test/session-pane-reading-demand.test.tsx']
const run = (name, mutant) => {
 const loaded = resolve(dir, name + '-loaded.ndjson'); writeFileSync(loaded, '')
 const sourceMap = Object.fromEntries(original); if (mutant) sourceMap[mutant.path] = mutant.code
 const frozen = resolve(dir,name+'-sources.json'), report = resolve(dir,name+'-vitest.json');writeFileSync(frozen,JSON.stringify(sourceMap))
 const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.performance-reading.config.mts', ...tests,'--reporter=json','--outputFile='+report],
  { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, AGENTMUX_PERFORMANCE_LOADED: loaded, AGENTMUX_PERFORMANCE_SOURCES: frozen } })
 writeFileSync(resolve(dir, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
 if (result.error || result.signal) throw new Error('Interrupted gate cannot certify source')
 const assertions = JSON.parse(readFileSync(report,'utf8')).testResults.flatMap(test=>test.assertionResults)
 if (assertions.length !== 3 || assertions.some(test=>!['passed','failed'].includes(test.status))) throw new Error('Incomplete actual reading assertions')
 if (mutant && !assertions.some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError')))) throw new Error('Mutant lacks executed Assertion RED')
 const input = readFileSync(loaded,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
 for (const [path,code] of Object.entries(sourceMap)) if (!input.some(row=>row.path===path&&row.sha256===createHash('sha256').update(code).digest('hex'))) throw new Error('Frozen source was not consumed: '+path)
 return { exit: result.status, loaded, assertionRed: assertions.some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError'))) }
}
const baseline = run('baseline')
if (baseline.exit !== 0) throw new Error('Reading-demand baseline failed; see ' + dir)
const inputs = readFileSync(baseline.loaded, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const binds = source.map(path => {
 const sha256 = createHash('sha256').update(original.get(path)).digest('hex')
 if (!inputs.some(input => input.path === path && input.sha256 === sha256)) throw new Error('Missing actual loaded source: ' + path)
 return { path, sha256 }
})
const mutants = [
 { name: 'native-facts-object-fanout', path: source[0], from: 'readingWindow.historical, Boolean(conversationReading?.nativeSourceFacts)])', to: 'readingWindow.historical, conversationReading?.nativeSourceFacts])' },
 { name: 'hidden-record-observer', path: source[0], from: 'if (!readingEnabled || !feedEl) return\n    const expected = new Map', to: 'if (!feedEl) return\n    const expected = new Map' },
 { name: 'hidden-follow-geometry', path: source[0], from: 'if (!readingEnabled) return\n    const geometry = feedGeometry()', to: 'const geometry = feedGeometry()' },
 { name: 'sessionpane-whole-session-facts', path: source[1], from: 'identity: activitySourceKey, nativeSourceFacts, enabled:', to: 'identity: activitySourceKey, nativeSourceFacts: session, enabled:' },
 { name: 'hidden-ruler-measurement', path: source[2], from: 'if (!visible || !track) return\n    let active', to: 'if (!track) return\n    let active' }
]
const results = []
try {
 for (const mutant of mutants) {
  const path = resolve(root, mutant.path), before = original.get(mutant.path)
  if (!before.includes(mutant.from) || before.indexOf(mutant.from) !== before.lastIndexOf(mutant.from)) throw new Error('Mutation anchor absent/nonunique: ' + mutant.name)
  const result = run(mutant.name, { path: mutant.path, code: before.replace(mutant.from, mutant.to) })
  if (result.exit === 0 || !result.assertionRed) throw new Error('Mutant not killed by behavior assertion: ' + mutant.name)
  results.push({ name: mutant.name, exit: result.exit, killed: true })
 }
} finally { for (const [path, bytes] of original) if (readFileSync(resolve(root,path),'utf8') !== bytes) throw new Error('Source changed during gate: '+path) }
const callers = [
 ['ActivityView → Ruler demand', source[0], /<Ruler visible=\{readingEnabled\}/],
 ['SessionPane → Activity current and retained', source[1], /<ActivityView \{\.\.\.activityProps\}/],
 ['SessionPane → retained Activity reading facts', source[1], /cloneElement\(activityContent\.current, \{ conversationReading \}\)/],
 ['Workbench → SessionPane', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', /<SessionPane/]
].map(([name, path, pattern]) => {
 if (!pattern.test(readFileSync(resolve(root, path), 'utf8'))) throw new Error('Actual caller absent: ' + name)
 return { name, path }
})
if (callers.length === 0) throw new Error('Empty caller proof')
const receipt = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceRoot: root,
 source: binds, tests, baseline: { exit: baseline.exit, tests: 3 }, mutants: results, callers,
 boundary: 'Mounted source behavior and source parameters only; no installed fifteen-second causality, native paint, Run or durable restoration claim.' }
writeFileSync(resolve(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, tests: 3, mutants: results.length, callers: callers.length, evidence: dir }))
