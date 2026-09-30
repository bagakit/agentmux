import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

// Source qualification only. Actual Renderer captures/restart and independent visual review
// remain with verify-launcher-launchpad.mjs; this command never packages or installs the app.
const root = resolve(import.meta.dirname, '../../..')
const flags = {}
for (let index = 2; index < process.argv.length; index++) {
  const [flag, inline] = process.argv[index].split('=')
  assert(['--slice', '--output'].includes(flag), `Unknown verifier argument: ${flag}`)
  const value = inline ?? process.argv[++index]
  assert(value && !value.startsWith('--'), `Missing verifier value: ${flag}`)
  flags[flag.slice(2)] = value
}
assert.equal(flags.slice ?? 'source', 'source', 'This verifier owns only the source slice')
const evidence = resolve(root, flags.output ?? 'docs/reviews/evidence/launcher-entry-polish-2026-10-04')
mkdirSync(evidence, { recursive: true })
const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const sourcePaths = [
  component('NewTabSurface'), component('LauncherEnvironment'), component('LauncherSecondarySurfaces'),
  component('LaunchOptionControls'), component('LauncherMoteAction'), component('LauncherResumePicker'),
  'apps/desktop/src/renderer/src/lib/launcher-state.ts',
  'apps/desktop/src/renderer/src/lib/copy-path-display.ts',
  'apps/desktop/src/renderer/src/styles/launcher.css', 'apps/desktop/src/renderer/src/styles/resume.css'
]
const testPaths = [
  'apps/desktop/test/launcher-entry-polish.test.tsx', 'apps/desktop/test/launcher-launchpad.test.tsx',
  'apps/desktop/test/launcher-secondary-surfaces.test.tsx', 'apps/desktop/test/launcher-mote-create.test.tsx',
  'apps/desktop/test/launch-option-controls.test.tsx', 'apps/desktop/test/launcher-composer-layout.test.tsx',
  'apps/desktop/test/launcher-draft-binding.test.ts'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bind = path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })
const sourceBindings = sourcePaths.map(bind)
const testBindings = [...testPaths, 'apps/desktop/test/helpers/composer-dom-fixture.tsx'].map(bind)

function runTests(label, paths = testPaths, name) {
  const report = resolve(evidence, `${label}.vitest.json`)
  const args = ['run', ...paths, '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`]
  if (name) args.push('-t', name)
  const result = spawnSync(resolve(root, 'node_modules/.bin/vitest'), args, { cwd: root, encoding: 'utf8', timeout: 120_000 })
  writeFileSync(resolve(evidence, `${label}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`)
  assert(!result.error, `${label}: test command could not complete`)
  const parsed = JSON.parse(readFileSync(report, 'utf8'))
  assert(parsed.numTotalTests > 0, `${label}: the actual tests must be collected`)
  const failed = parsed.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed')
    .map(test => ({ file: file.name.replace(`${root}/`, ''), name: test.fullName, messages: test.failureMessages })))
  return { label, command: `node_modules/.bin/vitest ${args.join(' ')}`, exitCode: result.status,
    tests: parsed.numTotalTests, passed: parsed.numPassedTests, failed, report: report.replace(`${root}/`, '') }
}
const baseline = runTests('source-baseline')
assert.equal(baseline.exitCode, 0, 'The unchanged candidate must be green before mutations')

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `Mutation anchor must occur exactly once: ${from}`)
  return source.replace(from, to)
}
const mutants = [
  { id: 'fresh-agent-expanded', path: 'apps/desktop/src/renderer/src/lib/launcher-state.ts',
    from: "agents: 'collapsed', terminal: 'expanded', browser: 'collapsed', note: 'collapsed'",
    to: "agents: 'expanded', terminal: 'expanded', browser: 'collapsed', note: 'collapsed'", test: 'a fresh Space' },
  { id: 'ignore-absolute-path-setting', path: component('NewTabSurface'),
    from: 'copyPathsAsAbsolute: config?.copyPathsAsAbsolute', to: 'copyPathsAsAbsolute: false', test: 'path representation' },
  { id: 'abbreviate-remote-or-unknown-host', path: component('NewTabSurface'),
    from: "home: host?.kind === 'local' ? localHome : ''", to: 'home: localHome', test: 'path representation|absent Host' },
  { id: 'raw-path-details', path: component('LauncherEnvironment'),
    from: "{displayPath || 'Not selected'}", to: "{workspace?.path || 'Not selected'}", test: 'path representation' },
  { id: 'assume-missing-host-shell', path: component('LauncherEnvironment'),
    from: "{host ? 'Configured host shell' : 'Host not configured'}", to: "{'Configured host shell'}", test: 'absent Host' },
  { id: 'launch-footer-without-agent-input', path: component('NewTabSurface'),
    from: "{sections.agents === 'expanded' ? <div className=\"launch-surface__footer\">",
    to: "{sections.agents !== 'hidden' ? <div className=\"launch-surface__footer\">", test: 'a fresh Space|expanding the real editing context' },
  { id: 'options-outside-input-toolbar', path: component('NewTabSurface'),
    from: '</div><LaunchRefine options={launchOptions}', to: '</div></div><div><LaunchRefine options={launchOptions}', test: 'expanding the real editing context' },
  { id: 'duplicate-browser-heading', path: component('LauncherSecondarySurfaces'),
    from: '<Globe2 size={15} aria-label="Browser" />', to: '<header className="launcher-utility__head">Browser</header><Globe2 size={15} aria-label="Browser" />', test: 'Browser expands into one working row' },
  { id: 'browser-collapse-not-durable', path: component('LauncherSecondarySurfaces'),
    from: "    onSectionChange('browser', 'collapsed')", to: "    // mutation: the user's collapsed intent was not saved", test: 'Browser collapse saves|hiding and unmounting' },
  { id: 'stale-browser-exit-overwrites-reopen', path: component('LauncherSecondarySurfaces'),
    from: '      browserCloseTimer.current = null\n      setBrowserClosing(false)',
    to: "      browserCloseTimer.current = null\n      setBrowserClosing(false)\n      onSectionChange('browser', 'collapsed')",
    test: 'Browser collapse saves',
    // Remove the cancellation as a whole production block to simulate the actual stale completion.
    extra: source => replaceOnce(source, "useEffect(() => { if (sections.browser !== 'collapsed') cancelBrowserClose() }, [sections.browser])",
      'useEffect(() => {}, [sections.browser])') },
  { id: 'hide-nondefault-risk-cue', path: component('LaunchOptionControls'),
    from: '{chosen.length ? <span className="launch-refine__count"', to: '{false ? <span className="launch-refine__count"',
    test: 'keeps dangerous posture', testPath: 'apps/desktop/test/launch-option-controls.test.tsx' }
]
const mutations = []
for (const mutant of mutants) {
  const path = resolve(root, mutant.path), original = readFileSync(path)
  assert.equal(sha(original), sourceBindings.find(binding => binding.path === mutant.path)?.sha256, 'Source changed since the baseline; preserve the concurrent work and retry qualification')
  let mutated = replaceOnce(original.toString('utf8'), mutant.from, mutant.to)
  if (mutant.extra) mutated = mutant.extra(mutated)
  writeFileSync(path, mutated)
  let red
  try {
    red = runTests(`mutation-${mutant.id}`, [mutant.testPath ?? testPaths[0]], mutant.test)
    assert.notEqual(red.exitCode, 0, `${mutant.id}: mutant survived`)
    assert(red.failed.length > 0, `${mutant.id}: a tooling failure is not Assertion RED`)
    assert(red.failed.some(test => test.messages.some(message => /AssertionError|expected .*(?:to be|to equal|to contain|not to be|to have)/s.test(message))), `${mutant.id}: actual assertions must fail`)
  } finally {
    // Never overwrite a peer edit made while a mutation is in flight.
    assert.equal(sha(readFileSync(path)), sha(mutated), `${mutant.id}: owning source changed concurrently; preserve it and recover the mutation manually`)
    writeFileSync(path, original)
    assert.equal(sha(readFileSync(path)), sha(original), `${mutant.id}: original bytes must be restored exactly`)
  }
  const restored = runTests(`restore-${mutant.id}`, [mutant.testPath ?? testPaths[0]], mutant.test)
  assert.equal(restored.exitCode, 0, `${mutant.id}: restored product must be green`)
  mutations.push({ id: mutant.id, path: mutant.path, originalSha256: sha(original), mutatedSha256: sha(mutated),
    status: 'assertion-red-exact-restore-green', red, restored })
  process.stdout.write(`${mutant.id}: Assertion RED / exact restore GREEN\n`)
}

// Actual AST use is required. Import names, definitions, comments and tests cannot close a slice.
const callerPaths = [...sourcePaths.filter(path => /\.tsx?$/.test(path)), component('WorkspaceWorkbench')]
const products = callerPaths.map(path => ({ path, text: readFileSync(resolve(root, path), 'utf8') }))
const owners = [
  ['NewTabSurface', component('NewTabSurface')], ['LauncherEnvironment', component('LauncherEnvironment')],
  ['LauncherSecondarySurfaces', component('LauncherSecondarySurfaces')], ['LaunchRefine', component('LaunchOptionControls')],
  ['LauncherMoteAction', component('LauncherMoteAction')], ['LauncherResumePicker', component('LauncherResumePicker')],
  ['applyCopyPathStyle', 'apps/desktop/src/renderer/src/lib/copy-path-display.ts'],
  ['DEFAULT_LAUNCHER_SECTIONS', 'apps/desktop/src/renderer/src/lib/launcher-state.ts']
]
const callers = owners.map(([symbol, definition]) => {
  const uses = []
  for (const { path, text } of products) {
    if (path === definition) continue
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    function visit(node) {
      const expression = ts.isCallExpression(node) ? node.expression : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : ts.isSpreadAssignment(node) ? node.expression : null
      if (expression && ts.isIdentifier(expression) && expression.text === symbol) {
        const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
        uses.push({ path, line: position.line + 1, use: node.getText(parsed).slice(0, 180) })
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  assert(uses.length > 0, `${symbol}: no product caller outside its definition/import/tests`)
  return { symbol, definition, uses }
})
const restored = runTests('source-final-restored')
assert.equal(restored.exitCode, 0)
for (const binding of [...sourceBindings, ...testBindings]) assert.equal(bind(binding.path).sha256, binding.sha256, `Candidate drifted: ${binding.path}`)
const typecheck = spawnSync(resolve(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'apps/desktop/tsconfig.json'], { cwd: root, encoding: 'utf8', timeout: 120_000 })
writeFileSync(resolve(evidence, 'source-typecheck.log'), `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}`)
assert.equal(typecheck.status, 0, 'The actual product typecheck must pass')
const receipt = { schema: 'agentmux.launcher-entry-polish-source.v1', status: 'passed', recordedAt: new Date().toISOString(),
  feature: 'f-2hm8f4ca7', slice: 'source', sourceBindings, testBindings, sourceDigest: sha(JSON.stringify(sourceBindings)),
  baseline, mutations, callers, restored, verificationBinding: bind('apps/desktop/scripts/verify-launcher-entry-polish.mjs'), typecheck: { command: 'node_modules/.bin/tsc --noEmit -p apps/desktop/tsconfig.json', exitCode: typecheck.status },
  packaging: 'not-requested-not-run', installation: 'not-requested-not-run',
  boundary: 'Mounted production components and Store are real; native desktop API boundaries are controlled. Actual Renderer visuals/restart and healthy native Run evidence are separate qualification.' }
const receiptPath = resolve(evidence, 'source-receipt.json')
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ status: receipt.status, tests: restored.tests, mutations: mutations.length, callers: callers.length, receipt: receiptPath.replace(`${root}/`, '') })}\n`)
