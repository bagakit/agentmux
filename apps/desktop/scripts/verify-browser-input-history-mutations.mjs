import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(root, '.tmp', `browser-input-history-mutations-${Date.now()}`))
const uiOnly = process.argv.includes('--ui-only')
const selectedLabels = process.argv.find(argument => argument.startsWith('--labels='))?.slice('--labels='.length).split(',')
const uiTests = 19
const copy = await mkdtemp('/tmp/amx-input-history-ui-')
const input = 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx'
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const css = 'apps/desktop/src/renderer/src/styles/browser.css'
const config = 'apps/desktop/scripts/fixtures/browser-input-history/vitest.owning.config.mts'
const tests = ['apps/desktop/test/browser-address-input.test.tsx', 'apps/desktop/test/browser-address-input-callers.test.tsx']
const product = [input, pane, 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx',
  'apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', css]
const inputs = [...product, ...tests, config, 'apps/desktop/scripts/fixtures/browser-input-history/tsconfig.owning.json',
  'apps/desktop/scripts/verify-browser-input-history-mutations.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = entries => Object.fromEntries([...entries].map(([file, bytes]) => [file, digest(bytes)]))
const mutations = [
  { label: 'actual-human-record-block-removed', file: input, test: 'uses the actual Main list',
    before: `    if (target) {
      // Capture this human submission before navigation/creation; never read a later draft.
      void Promise.resolve().then(() => api.browser.recordInputHistory(target, text)).then(result => {
        if (!live(key, token)) return
        setLoadedHistory({ key, snapshot: result })
        setNotice(result.outcome === 'url-userinfo' ? 'An address containing login information was not saved to input history.' : null)
      }).catch(error => {
        const message = \`Input history could not be saved: \${presentError(error)}. Browsing continues; retry history here.\`
        if (live(key, token)) setNotice(message)
        else onDeferredHistoryFailure(message)
      })
    } else setNotice('Input history cannot be saved until its Workspace and Profile are confirmed. Browsing continues.')
`, after: '' },
  { label: 'actual-history-reply-emptied', file: input, test: 'uses the actual Main list',
    before: '      setLoadedHistory({ key, snapshot: result }); setSelected(-1); setNotice(null)\n',
    after: '      setLoadedHistory({ key, snapshot: { ...result, entries: [] } }); setSelected(-1); setNotice(null)\n' },
  { label: 'escape-dismissal-block-removed', file: input, test: 'Escape invalidates a real deferred',
    before: "        if (event.key === 'Escape') { if (open) { event.preventDefault(); event.stopPropagation() }; dismiss(); return }\n", after: '' },
  { label: 'typing-reply-discarded-as-false-empty', file: input, test: 'typing during a real deferred',
    before: '      if (!live(key, token)) return\n',
    after: "      if (!live(key, token) || input.current?.value !== value) return\n", occurrence: 0 },
  { label: 'composition-live-read-not-cancelled', file: input, test: 'composition cancels the pending',
    before: 'onCompositionStart={event => { composing.current = true; dismiss(); ime.compositionStart(event.currentTarget.value) }}',
    after: 'onCompositionStart={event => { ime.compositionStart(event.currentTarget.value) }}' },
  { label: 'focus-leave-listener-removed', file: input, test: 'focus may enter deletion',
    before: "    document.addEventListener('focusin', outside, true)\n", after: '' },
  { label: 'scope-live-guard-removed', file: input, test: 'late old-Profile read cannot',
    before: '  const live = (key: string, token: number) => targetKey.current === key && request.current === token\n',
    after: '  const live = (_key: string, _token: number) => true\n' },
  { label: 'actual-deletion-block-removed', file: input, test: 'single and all deletion',
    before: '      const result = text === undefined ? await api.browser.clearInputHistory(target, snapshot.scope) : await api.browser.removeInputHistory(target, snapshot.scope, text)\n',
    after: '      const result = snapshot\n' },
  { label: 'unmounted-save-warning-dropped', file: input, test: 'save rejection never delays',
    before: '        else onDeferredHistoryFailure(message)\n', after: '' },
  { label: 'read-failure-warning-removed', file: input, test: 'read and deletion failures',
    before: "      if (live(key, token)) setNotice(`Input history could not be read: ${presentError(error)}. Your input and browsing remain available; retry history here.`)\n", after: '' },
  { label: 'keyboard-recall-block-removed', file: input, test: 'uses the actual Main list',
    before: '          const text = open && selected >= 0 ? entries[selected]?.text ?? value : value\n', after: '          const text = value\n' },
  { label: 'native-context-menu-propagation-restored-to-region', file: input, test: 'input right-click stops',
    before: 'onContextMenu={event => { event.stopPropagation(); dismiss(); onContextMenu?.(event) }}',
    after: 'onContextMenu={event => { dismiss(); onContextMenu?.(event) }}' },
  { label: 'native-context-menu-default-prevented', file: input, test: 'input right-click stops',
    before: 'onContextMenu={event => { event.stopPropagation(); dismiss(); onContextMenu?.(event) }}',
    after: 'onContextMenu={event => { event.preventDefault(); event.stopPropagation(); dismiss(); onContextMenu?.(event) }}' },
  { label: 'navigation-draft-owner-guard-removed', file: pane, test: 'a late real BrowserPane navigation',
    before: '    if (addressBrowser.current !== tab.browserId || !addressDraftEdited.current) {\n', after: '    {\n' },
  { label: 'opaque-popup-background-removed', file: css, test: 'the actual nonempty popup rules',
    before: 'color: var(--text-2); background: var(--surface-2); font: var(--fs-micro)/1.5 var(--font-sans); pointer-events: auto;',
    after: 'color: var(--text-2); background: transparent; font: var(--fs-micro)/1.5 var(--font-sans); pointer-events: auto;' },
  { label: 'popup-keyboard-focus-rule-removed', file: css, test: 'the actual nonempty popup rules',
    before: '.browser-address-history button:focus-visible { outline: 1px solid var(--focus-line); outline-offset: -1px; }\n', after: '' },
  { label: 'launcher-shared-form-submitter-removed', file: 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx',
    test: 'the actual compact Browser header expands',
    before: 'if (!disabled) browserInput.current?.submit()', after: 'if (!disabled) {}' }
]
const receipt = { schema: 'agentmux.browser-input-history-ui-source.v1', taskId: 'T-026', taskComplete: false, passed: false,
  observedHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceBefore: hashes(originals), mode: uiOnly ? 'ui-increment' : 'complete-source', sharedTreeMutations: 0,
  nativeRuns: 0, systemClipboard: [], userAppRuntimeControl: [], cases: [] }
let evidenceCreated = false
async function execute(command, args, cwd = root, env = process.env) {
  return await new Promise((yes, no) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
}
async function run(label, test) {
  const result = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(copy, 'shadow.config.mts'),
    '--maxWorkers=1', ...(test ? ['-t', test] : [])], root, { ...process.env, AGENTMUX_HISTORY_UI_SOURCE_ROOT: copy })
  await writeFile(join(evidence, `${label}.log`), result.output); return { ...result, log: `${label}.log` }
}
function green(result, count) {
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null)
  const matched = /Tests\s+(\d+) passed/.exec(result.output); assert.ok(matched, 'Actual nonempty tests ran'); assert.equal(Number(matched[1]), count)
}
try {
  await mkdir(dirname(evidence), { recursive: true }); await mkdir(evidence); evidenceCreated = true
  for (const [file, bytes] of originals) { await mkdir(dirname(join(copy, file)), { recursive: true }); await writeFile(join(copy, file), bytes) }
  const shadow = `import config from ${JSON.stringify(join(root, config))}
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const originals=${JSON.stringify(Object.fromEntries(product.filter(file => file !== css).map(file => [join(root, file), join(copy, file)])))}
export default { ...config, plugins:[{ name:'actual-history-source-shadow', enforce:'pre', load(id) {
  const path=id.split('?')[0], file=originals[path]; if(!file)return null
  const bytes=readFileSync(file);console.log('ACTUAL_HISTORY_SOURCE_LOAD',path,createHash('sha256').update(bytes).digest('hex'),bytes.length);return bytes.toString()
} }], test:{...config.test,include:${JSON.stringify(tests)}} }
`
  await writeFile(join(copy, 'shadow.config.mts'), shadow)
  receipt.projectionBytes = [...originals.values()].reduce((total, bytes) => total + bytes.length, Buffer.byteLength(shadow))
  assert.ok(receipt.projectionBytes < 2 * 1024 * 1024, 'Only owned small Source bytes are projected')
  execFileSync('tar', ['-czf', join(evidence, 'owned-source.tar.gz'), '-C', copy, '.'])
  if (!uiOnly) {
    const main = await execute(process.execPath, [join(root, 'apps/desktop/scripts/verify-browser-input-history-main-mutations.mjs'), join(evidence, 'main')])
    await writeFile(join(evidence, 'main-runner.log'), main.output); assert.equal(main.code, 0, main.output)
    const bytes = await readFile(join(evidence, 'main/receipt.json')); const original = JSON.parse(bytes)
    assert.equal(original.passed, true); assert.equal(original.cases.length, 13)
    receipt.main = { path: 'main/receipt.json', sha256: digest(bytes), bytes: bytes.length, cases: original.cases.length }
  }
  const baseline = await run('baseline-green'); green(baseline, uiTests)
  receipt.baseline = { exit: baseline.code, tests: uiTests, log: baseline.log }
  const selected = selectedLabels ? mutations.filter(mutation => selectedLabels.includes(mutation.label)) : mutations
  assert.ok(selected.length > 0, 'Nonempty actual mutation selection')
  if (selectedLabels) assert.equal(selected.length, selectedLabels.length, 'Every requested mutation must resolve')
  receipt.selection = { requested: selectedLabels ?? null, labels: selected.map(mutation => mutation.label) }
  for (const mutation of selected) {
    const source = originals.get(mutation.file).toString(), count = source.split(mutation.before).length - 1
    assert.ok(count > 0, `Nonempty actual Source block ${mutation.label}`)
    assert.equal(count, mutation.occurrence === undefined ? 1 : 2, `Exact Source occurrence count ${mutation.label}`)
    const changed = source.replace(mutation.before, mutation.after); let red
    try {
      await writeFile(join(copy, mutation.file), changed)
      red = await run(`${mutation.label}-red`, mutation.test)
      assert.ok(red.code > 0 && red.signal === null, red.output); assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
      if (mutation.file !== css) assert.ok(red.output.includes(` ${digest(changed)} `), 'The mutated actual module was loaded')
    } finally { await writeFile(join(copy, mutation.file), originals.get(mutation.file)) }
    const restored = await run(`${mutation.label}-restored-green`, mutation.test); green(restored, 1)
    receipt.cases.push({ ...mutation, mutantSha256: digest(changed), red: { exit: red.code, log: red.log }, restore: { exit: restored.code, tests: 1, log: restored.log } })
    console.log(`Actual Assertion RED / restored GREEN: ${mutation.label}`)
  }
  const final = await run('final-all-restored-green'); green(final, uiTests)
  receipt.final = { exit: final.code, tests: uiTests, log: final.log }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copy, file))]))))
  assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.liveSourceDrift = inputs.filter(file => receipt.sourceBefore[file] !== receipt.sourceAfter[file])
  receipt.candidateOnly = true; receipt.liveSourceMatchesCut = receipt.liveSourceDrift.length === 0; receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(copy, { recursive: true }); receipt.cleanup = { privateSourcePath: copy, removed: true, unrelatedPathsRemoved: [] }
  if (evidenceCreated) await writeFile(join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, scope: receipt.mode, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
