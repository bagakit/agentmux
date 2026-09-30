import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '../../..')
const outIndex = process.argv.indexOf('--evidence-root')
const out = resolve(root, outIndex >= 0 ? process.argv[outIndex + 1] : `docs/reviews/evidence/browser-text-edit-source-2026-10-04/mutations/attempt-${Date.now()}`)
mkdirSync(out, { recursive: true })
const helper = 'apps/desktop/src/main/text-edit-context-menu.ts', bvm = 'apps/desktop/src/main/browser-view-manager.ts', index = 'apps/desktop/src/main/index.ts'
const paths = [helper, bvm, index]
const original = new Map(paths.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const sha = value => createHash('sha256').update(value).digest('hex')
const definitions = [
  { id: 'renderer-binding', path: index, before: '    installTextEditContextMenu(window.webContents, window, { isCurrent: () => workbenchWindow === window })', after: '', test: 'executes the exact renderer-host registration call' },
  { id: 'page-binding', path: bvm, before: '    installTextEditContextMenu(contents, this.window, {\n      isCurrent: () => this.nativeOwner(entry.id)?.view === view,\n      origin: () => view.getBounds()\n    })', after: '', test: 'actual BVM attaches to each original page' },
  { id: 'wrong-host-target', path: helper, before: '            contents[item.action]()', after: '            window.webContents[item.action]()', test: 'targets original contents for all four native commands' },
  { id: 'disabled-action', path: helper, before: '        if (chosen || ended || !item.enabled) return', after: '        if (chosen || ended) return', test: 'derives disabled actions from real editFlags' },
  { id: 'same-frame-target', path: helper, before: '            if (!sameTarget || ended || !current()) { finish(); notice(); return }', after: '            if (ended || !current()) { finish(); notice(); return }', test: 'same frame changed input invalidates' },
  { id: 'native-owner', path: helper, before: ' && owner.isCurrent()', after: '', test: 'changed owner invalidates the old menu' },
  { id: 'navigation-cancel', path: helper, before: '      if (event.isMainFrame || ancestors.some(original => original.frame === event.frame)) finish()', after: '      // mutated: original navigation no longer cancels its menu', test: 'navigation cancels before a delayed local identity result' },
  { id: 'focused-frame', path: helper, before: ' && contents.focusedFrame === frame', after: '', test: 'rechecks actual native frame focus after awaiting' },
  { id: 'window-focus', path: helper, before: ' && window.isFocused()', after: '', test: 'lost OS window focus during identity await' },
  { id: 'pending-input-press', path: helper, before: "      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown') finish()", after: '      // mutated: later press cannot cancel an awaiting capture', test: 'before deferred capture cannot relabel another input' }
]
const onlyIndex = process.argv.indexOf('--only')
const mutants = onlyIndex >= 0 ? definitions.filter(item => item.id === process.argv[onlyIndex + 1]) : definitions
assert.ok(mutants.length > 0, 'A requested actual Source mutation must exist')
const scratch = mkdtempSync(join(tmpdir(), 'agentmux-text-edit-mutants-'))
let passed = false
const runs = []
function run(id) {
  const dir = join(out, id); mkdirSync(dir, { recursive: true })
  const report = join(dir, 'loaded-source.json')
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/browser-text-edit/vitest.owning.config.mts', '--maxWorkers=1'], {
    cwd: root, env: { ...process.env, AGENTMUX_TEXT_EDIT_MUTATION_ROOT: scratch, AGENTMUX_TEXT_EDIT_SOURCE_REPORT: report }, encoding: 'utf8', timeout: 60_000
  })
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(join(dir, 'raw.log'), log)
  const loaded = JSON.parse(readFileSync(report, 'utf8'))
  assert.equal(loaded.length, 2, 'Both actual helper and BVM must have been loaded')
  for (const item of loaded) assert.equal(item.sha256, sha(readFileSync(item.loadedPath)), `Loaded original bytes must bind ${item.path}`)
  return { exitCode: result.status, log, dir, loaded }
}
try {
  for (const [path, code] of original) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true }); writeFileSync(join(scratch, path), code)
    mkdirSync(dirname(join(out, 'original-source', path)), { recursive: true }); writeFileSync(join(out, 'original-source', path), code)
  }
  const baseline = run('baseline'); assert.equal(baseline.exitCode, 0, baseline.log)
  for (const mutant of mutants) {
    const code = original.get(mutant.path)
    assert.equal(code.split(mutant.before).length - 1, 1, `Unique nonempty actual Source block: ${mutant.id}`)
    const changed = code.replace(mutant.before, mutant.after)
    writeFileSync(join(scratch, mutant.path), changed)
    const red = run(mutant.id)
    writeFileSync(join(red.dir, 'mutated-source.ts'), changed)
    assert.notEqual(red.exitCode, 0, `Mutation survived: ${mutant.id}`)
    assert.match(red.log, /AssertionError:/, `Mutation must fail a semantic Assertion, not import/parse/hash: ${mutant.id}`)
    assert.ok(red.log.includes(mutant.test), `Intended actual consumer Assertion must fail: ${mutant.id}`)
    writeFileSync(join(scratch, mutant.path), code)
    const restored = run(`${mutant.id}-restored`); assert.equal(restored.exitCode, 0, restored.log)
    runs.push({ id: mutant.id, source: mutant.path, originalSha256: sha(code), changedSha256: sha(changed), blockSha256: sha(mutant.before), intendedAssertion: mutant.test, redExit: red.exitCode, restoredExit: restored.exitCode })
  }
  passed = true
} finally {
  const drift = [...original].flatMap(([path, code]) => readFileSync(join(root, path), 'utf8') === code ? [] : [{ path, beforeSha256: sha(code), afterSha256: sha(readFileSync(join(root, path))) }])
  if (drift.length > 0) passed = false
  rmSync(scratch, { recursive: true })
  writeFileSync(join(out, 'receipt.json'), JSON.stringify({ schema: 'agentmux.browser-text-edit-source-mutations.v1', author: '/root/browser_source_closeout', passed, scope: 'Source-only; no Native or clipboard calls', drift, scratchRoot: scratch, scratchRemoved: true, originalInputs: [...original].map(([path, code]) => ({ path, sha256: sha(code), bytes: Buffer.byteLength(code) })), runs }, null, 2) + '\n')
}
assert.equal(passed, true, 'All Source assertions and input identities must pass')
process.stdout.write(JSON.stringify({ passed, mutants: runs.length, evidenceRoot: out }) + '\n')
