import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const dir = resolve(process.env.AGENTMUX_PERF_EVIDENCE_DIR ?? resolve(root, '.local/presentation-geometry-demand'))
mkdirSync(dir, { recursive: true })
const files = { strip: 'apps/desktop/src/renderer/src/components/WorkbenchTabStrip.tsx', motion: 'packages/client-ui/src/lib/mote-face-motion.ts',
 overlay: 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts', hook: 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts',
 browser: 'apps/desktop/src/main/browser-view-manager.ts' }
const source = Object.values(files), original = new Map(source.map(path => [path, readFileSync(resolve(root, path), 'utf8')]))
const tests = ['apps/desktop/test/presentation-geometry-demand.test.tsx', 'apps/desktop/test/native-overlay-regions.test.ts',
 'apps/desktop/test/native-overlay-chrome.test.tsx', 'apps/desktop/test/native-overlay-pointer.test.tsx']
const run = (name, browserOnly = false, mutant) => {
 const loaded = resolve(dir, name + '-loaded.ndjson'); writeFileSync(loaded, '')
 const args = browserOnly ? ['apps/desktop/test/browser-view-manager.test.ts', '-t', 'native chrome demand follows'] : tests
 const sourceMap = Object.fromEntries(original); if (mutant) sourceMap[mutant.path] = mutant.code
 const frozen=resolve(dir,name+'-sources.json'), report=resolve(dir,name+'-vitest.json');writeFileSync(frozen,JSON.stringify(sourceMap))
 const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.performance-reading.config.mts', ...args,'--reporter=json','--outputFile='+report],
  { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, AGENTMUX_PERFORMANCE_LOADED: loaded, AGENTMUX_PERFORMANCE_SOURCES: frozen } })
 writeFileSync(resolve(dir, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
 if (result.error || result.signal) throw new Error('Interrupted gate cannot certify source')
 const collected=JSON.parse(readFileSync(report,'utf8')).testResults.flatMap(test=>test.assertionResults)
 const assertions=browserOnly ? collected.filter(test=>['passed','failed'].includes(test.status)) : collected
 if (assertions.length !== (browserOnly ? 1 : 29) || assertions.some(test=>!['passed','failed'].includes(test.status))) throw new Error('Incomplete actual geometry assertions')
 if (mutant && !assertions.some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError')))) throw new Error('Mutant lacks executed Assertion RED')
 const input=readFileSync(loaded,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
 for (const [path,code] of Object.entries(sourceMap)) if ((!browserOnly&&path!==files.browser||browserOnly&&path===files.browser) && !input.some(row=>row.path===path&&row.sha256===createHash('sha256').update(code).digest('hex'))) throw new Error('Frozen source was not consumed: '+path)
 return { exit: result.status, loaded, assertionRed: assertions.some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError'))) }
}
const baseline = run('baseline'), browserBaseline = run('browser-baseline', true)
if (baseline.exit !== 0 || browserBaseline.exit !== 0) throw new Error('Geometry-demand baseline failed; see ' + dir)
const inputs = [baseline, browserBaseline].flatMap(result => readFileSync(result.loaded, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
const binds = source.map(path => {
 const sha256 = createHash('sha256').update(original.get(path)).digest('hex')
 if (!inputs.some(input => input.path === path && input.sha256 === sha256)) throw new Error('Missing actual loaded source: ' + path)
 return { path, sha256 }
})
const mutants = [
 { name: 'hidden-strip-measurement', path: files.strip, from: 'if (!visible || !element) return\n    const nextState', to: 'if (!element) return\n    const nextState' },
 { name: 'hidden-strip-observer', path: files.strip, from: 'if (!visible || !element) return\n    let active', to: 'if (!element) return\n    let active' },
 { name: 'mote-read-write-interleaving', path: files.motion,
  from: "const measured = Array.from(rigs, identity => ({ identity,\n      rect: identity.node.querySelector('.mote-face, .mote-image-follow')?.getBoundingClientRect() }))\n    // Read every active rig before any style/dataset write can invalidate the next rig's layout.\n    for (const { identity, rect } of measured) {",
  to: "for (const identity of rigs) {\n      const rect = identity.node.querySelector('.mote-face, .mote-image-follow')?.getBoundingClientRect()" },
 { name: 'zero-native-demand-retains-observers', path: files.overlay, from: 'if (visibility.bounds.length === 0) {', to: 'if (false && visibility.bounds.length === 0) {' },
 { name: 'hidden-portal-content-fanout', path: files.overlay, from: "if (relevant) schedule('mutation')", to: "schedule('mutation')" },
 { name: 'duplicate-overlay-geometry', path: files.overlay, from: 'const rect = rectOf(node)\n      if (rect.width <= 0', to: 'const rect = node.getBoundingClientRect()\n      if (rect.width <= 0' },
 { name: 'same-bounds-content-drop', path: files.overlay, apply: before => before.replace('let nextId = 0', 'let nextId = 0\n  let previousBounds: string | undefined').replace('    publish(regions, warning)', '    const signature = JSON.stringify(regions)\n    if (nativeDemand && signature === previousBounds) return\n    if (nativeDemand) previousBounds = signature\n    publish(regions, warning)') },
 { name: 'initial-demand-race', path: files.hook, from: 'disposed || visibility.revision <= demandRevision', to: 'disposed' },
 { name: 'missing-real-native-show-demand', path: files.browser, from: 'if (becomingVisible || boundsChanged) this.notifyNativeVisibility()', to: 'if (false) this.notifyNativeVisibility()', browserOnly: true }
]
const results = []
try {
 for (const mutant of mutants) {
  const path = resolve(root, mutant.path), before = original.get(mutant.path)
  if (!mutant.apply && (!before.includes(mutant.from) || before.indexOf(mutant.from) !== before.lastIndexOf(mutant.from))) throw new Error('Mutation anchor absent/nonunique: ' + mutant.name)
  const next = mutant.apply ? mutant.apply(before) : before.replace(mutant.from, mutant.to)
  if (next === before) throw new Error('Empty production mutation: ' + mutant.name)
  const result = run(mutant.name, mutant.browserOnly, { path: mutant.path, code: next })
  if (result.exit === 0 || !result.assertionRed) throw new Error('Mutant not killed by behavior assertion: ' + mutant.name)
  results.push({ name: mutant.name, exit: result.exit, killed: true })
 }
} finally { for (const [path, bytes] of original) if (readFileSync(resolve(root,path),'utf8') !== bytes) throw new Error('Source changed during gate: '+path) }
const callers = [
 ['Workbench visible and retained Strips', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', /<WorkbenchTabStrip visible=\{/],
 ['Client UI motion owner', 'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', /observeMoteMotion/],
 ['App unique native overlay hook', 'apps/desktop/src/renderer/src/App.tsx', /useNativeOverlayChrome\(\)/],
 ['Native demand and telemetry consumer', files.hook, /onNativeBrowserVisibility\(onDemand\)/],
 ['Main current Browser owner subscription', 'apps/desktop/src/main/ipc.ts', /browsers\.onNativeVisibilityChange =/],
 ['Preload demand subscription', 'apps/desktop/src/preload/index.ts', /ipcRenderer\.on\(NATIVE_BROWSER_VISIBILITY_CHANNEL/],
 ['Main trusted demand getter', 'apps/desktop/src/main/ipc.ts', /return browsers\.nativeBrowserVisibility\(\)/],
 ['Existing public recorder consumed', files.hook, /rendererPerformance\.observeOverlay\(reading\)/]
].map(([name, path, pattern]) => {
 if (!pattern.test(readFileSync(resolve(root, path), 'utf8'))) throw new Error('Actual caller absent: ' + name)
 return { name, path }
})
if (callers.length === 0) throw new Error('Empty caller proof')
const receipt = { sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceRoot: root,
 source: binds, tests, baseline: { exit: baseline.exit, tests: 29, browserTests: 1 }, mutants: results, callers,
 boundary: 'Mounted source behavior, native owner fixture and actual parameters only; no installed native paint, fifteen-second causality, Run or durable restoration claim.' }
writeFileSync(resolve(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, tests: 30, mutants: results.length, callers: callers.length, evidence: dir }))
