import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Bind to this actual tree, never invocation cwd or the old Feature evidence workspace.
const root = resolve(import.meta.dirname, '../../..')
const spec = {"owners": ["apps/desktop/src/renderer/src/components/TerminalView.tsx", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx"], "tests": ["apps/desktop/test/terminal-parking-facts.test.tsx"], "regressions": ["apps/desktop/test/terminal-cold-parking-coordinator.test.ts", "apps/desktop/test/terminal-cold-parking-policy.test.ts"], "count": 4, "mutants": [["directory-path-invalidation-removed", "apps/desktop/src/renderer/src/components/TerminalView.tsx", "[terminalConfig, session.kind, session.hostId, session.workspacePath]", "[terminalConfig]"], ["directory-config-invalidation-removed", "apps/desktop/src/renderer/src/components/TerminalView.tsx", "[terminalConfig, linkOrigin.workspaceId]", "[linkOrigin.workspaceId]"], ["directory-memo-bypassed", "apps/desktop/src/renderer/src/components/TerminalView.tsx", "const activeWorkspaceRoot = useMemo", "const activeWorkspaceRoot = ((_read) => _read())"], ["parking-browser-projection-bypassed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "workbenchNavigationTabs(state?.tabs ?? EMPTY_TABS)", "(state?.tabs ?? EMPTY_TABS)"], ["parking-fact-cache-bypassed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "const known = previous.get(id)", "const known = undefined"], ["parking-health-invalidation-removed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "known.canRebuild === facts.canRebuild && known.hasPendingInteraction === facts.hasPendingInteraction", "known.hasPendingInteraction === facts.hasPendingInteraction"], ["parking-pending-invalidation-removed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "known.canRebuild === facts.canRebuild && known.hasPendingInteraction === facts.hasPendingInteraction", "known.canRebuild === facts.canRebuild"], ["parking-execution-identity-invalidation-removed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "known.kind === facts.kind && known.hostId === facts.hostId && known.runId === facts.runId && ", ""], ["parking-visible-close-cleanup-removed", "apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "new Set([...hiddenSinceByRegionRef.current.keys(), ...activationOrderByRegionRef.current.keys(), ...navigationContextByRegionRef.current.keys()])", "hiddenSinceByRegionRef.current.keys()"]], "callers": [["apps/desktop/src/renderer/src/components/TerminalView.tsx", "workspaceRootForPath(terminalConfig ?? null, session)", 1], ["apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "createTerminalParkingSessionSelector(sessionIds)", 1], ["apps/desktop/src/renderer/src/lib/terminal-cold-parking-coordinator.tsx", "collectTerminalColdParkCandidates({", 1], ["apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx", "useTerminalColdParking(", 1]], "slice": "parking-facts"}
const hash = value => createHash('sha256').update(value).digest('hex')
const owners = new Map(spec.owners.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const evidence = join(root, '.local/state/terminal-owner-cost', spec.slice, String(globalThis.crypto.randomUUID()))
mkdirSync(evidence, { recursive: true })
const receipt = { passed: false, root, invocationCwd: process.cwd(), sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
 verifierSHA256: hash(readFileSync(import.meta.filename)), sourceSHA256: Object.fromEntries([...owners].map(([path, text]) => [path, hash(text)])),
 testSHA256: Object.fromEntries([...spec.tests, ...spec.regressions].map(path => [path, hash(readFileSync(join(root, path)))])), callers: [], runs: [], sourceWritten: false, userRunTouched: false,
 limitation: 'Kitty/live are actual modules; continuation/drain/directory exercise exact production AST declarations with controlled dependencies. Parking uses mounted React+Zustand production hook. No native PTY/installed/15s attribution is claimed.' }
function command(label, args) {
 const child = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
 writeFileSync(join(evidence, label + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
 assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.ok(Number.isInteger(child.status)); assert.equal(child.status, 0, label)
}
function run(name, replacement, tests, exactCount) {
 const sources = Object.fromEntries([...owners].map(([path, source]) => [join(root, path), replacement?.path === path ? replacement.text : source]))
 const report = join(evidence, name + '.json'), loadedPath = join(evidence, name + '.loaded.json'), configPath = join(evidence, name + '.config.mts')
 const terminal = join(root, 'apps/desktop/src/renderer/src/components/TerminalView.tsx')
 const astSource = sources[terminal]
 const config = `import { mergeConfig } from 'vitest/config'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const sources = ${JSON.stringify(sources)}, loaded = {}
const config = mergeConfig(base, { root: ${JSON.stringify(root)}, define: { __AGENTMUX_TERMINAL_VIEW_SOURCE__: ${JSON.stringify(JSON.stringify(astSource))} },
 plugins: [{ name: 'actual-terminal-owner-source', enforce: 'pre', transform(code, id) {
 const path = id.split('?')[0]; if (!(path in sources)) return
 const source = sources[path]; loaded[path] = createHash('sha256').update(source).digest('hex')
 writeFileSync(${JSON.stringify(loadedPath)}, JSON.stringify(loaded)); return { code: source, map: null }
 } }] })
config.test = { ...config.test, include: ${JSON.stringify(tests)}, maxWorkers: 1 }
export default config
`
 writeFileSync(configPath, config); rmSync(report, { force: true }); rmSync(loadedPath, { force: true })
 const child = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', configPath, '--reporter=json', '--outputFile=' + report], { cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 16 * 1024 * 1024 })
 writeFileSync(join(evidence, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
 assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.ok(Number.isInteger(child.status))
 const result = JSON.parse(readFileSync(report, 'utf8'))
 const assertions = result.testResults.flatMap(test => test.assertionResults)
 assert.ok(assertions.length > 0); if (exactCount !== null) assert.equal(assertions.length, exactCount, 'Nonempty complete owned behavior set')
 assert.ok(assertions.every(test => ['passed', 'failed'].includes(test.status)), 'No skipped/todo substitute')
 const failed = assertions.filter(test => test.status === 'failed')
 if (!replacement) { assert.equal(child.status, 0); assert.equal(failed.length, 0) }
 else { assert.notEqual(child.status, 0); assert.ok(failed.length > 0 && failed.every(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Only actual behavioral Assertion RED qualifies') }
 const loaded = JSON.parse(readFileSync(loadedPath, 'utf8'))
 // TerminalView is exercised from exact AST instead of a full React/native Terminal mount.
 assert.equal(hash(astSource), hash(replacement?.path === 'apps/desktop/src/renderer/src/components/TerminalView.tsx' ? replacement.text : owners.get('apps/desktop/src/renderer/src/components/TerminalView.tsx')))
 for (const [path, text] of Object.entries(sources)) if (path !== terminal) assert.equal(loaded[path], hash(text), 'Actual module input consumed: ' + path)
 receipt.runs.push({ name, status: child.status, assertions: assertions.length, failed: failed.map(test => test.fullName), loadedSHA256: loaded, executedTerminalASTSHA256: hash(astSource), configSHA256: hash(config) })
 console.log(JSON.stringify({ slice: spec.slice, name, assertions: assertions.length, failed: failed.length }))
}
try {
 for (const [path, anchor, minimum] of spec.callers) {
  const source = readFileSync(join(root, path), 'utf8'), count = source.split(anchor).length - 1
  assert.ok(count >= minimum, 'Nonempty external production consumer: ' + path + ' ' + anchor)
  receipt.callers.push({ path, anchor, count, sha256: hash(source) })
 }
 command('core-build', ['--filter', '@agentmux/core...', 'build'])
 command('client-ui-build', ['--filter', '@agentmux/client-ui', 'build'])
 command('desktop-types', ['--filter', '@agentmux/desktop', 'typecheck'])
 const testTypes = join(evidence, 'test-types.json')
 writeFileSync(testTypes, JSON.stringify({ extends: join(root, 'apps/desktop/tsconfig.test.json'), compilerOptions: { types: ['node'] },
   files: [join(root, 'apps/desktop/node_modules/vite/client.d.ts'), join(root, 'apps/desktop/src/renderer/src/global.d.ts')],
   include: spec.tests.map(path => join(root, path)) }))
 command('owned-test-types', ['exec', 'tsc', '--noEmit', '-p', testTypes])
 run('candidate', null, spec.tests, spec.count)
 for (const [name, path, anchor, replacement] of spec.mutants) {
  const source = owners.get(path); assert.equal(source.split(anchor).length - 1, 1, 'Unique nonempty actual source anchor: ' + name)
  run(name, { path, text: source.replace(anchor, replacement) }, spec.tests, spec.count)
 }
 // Adjacent owners are unchanged and consumed through normal package exports after a normal build.
 // Omit mutated owner-load checks for regression-only sets which legitimately do not load every owner.
 command('regression', ['exec', 'vitest', 'run', ...spec.regressions, '--maxWorkers=1'])
 for (const [path, text] of owners) assert.equal(hash(readFileSync(join(root, path))), hash(text), 'Source stable during gate')
 for (const [path, sha] of Object.entries(receipt.testSHA256)) assert.equal(hash(readFileSync(join(root, path))), sha, 'Test input stable during gate')
 receipt.passed = true
} finally {
 writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
 console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json') }))
}
