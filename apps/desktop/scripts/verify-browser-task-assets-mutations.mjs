import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const main = 'apps/desktop/src/main/browser-task-assets.ts'
const compiler = 'apps/desktop/src/main/browser-replay-compiler.ts'
const editor = 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx'
const test = 'apps/desktop/test/browser-task-assets.test.tsx'
const inputs = [main, compiler, editor, test, 'apps/desktop/src/shared/browser-task-assets.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/browser-operation.ts',
  'apps/desktop/src/shared/browser-step-evidence.ts', 'packages/core/src/durable-write.ts', 'packages/core/src/browser-page-capability.ts']
const tests = [test]
const cases = [
  [main, 'deleted-steps-resurrected', 'asset.draft = content(replacement)', 'asset.draft = content({ ...replacement, steps: replacement.steps.length ? replacement.steps : asset.draft.steps })'],
  [main, 'version-ignores-selection', 'asset.versions.find(item => item.version === input.version)', 'asset.versions.at(-1)'],
  [main, 'edit-overwrites-immutable-version', 'asset.draft = content(replacement)', 'asset.draft = content(replacement); asset.versions.forEach(version => Object.assign(version, content(replacement)))'],
  [main, 'continuation-restarts-first-step', "next.status = 'ready'", "next.status = 'ready'; next.nextStep = 0"],
  [main, 'checkpoint-does-not-yield-control', 'host.yieldControl(browserId)', 'void 0'],
  [main, 'human-control-guard-removed', "host.control(browserId) !== 'agent'", 'false'],
  [main, 'continuation-version-binding-removed', 'existing.version !== version.version', 'false'],
  [main, 'parameter-value-retained', 'delete next.pendingCheckpointId; delete next.warning', 'delete next.pendingCheckpointId; delete next.warning; next.parameters = parameters'],
  [main, 'parameter-values-drift-mid-run', 'const parameters = { ...input.parameters }', 'const parameters = input.parameters'],
  [main, 'unreviewed-step-runs', '!step.reviewed', 'false'],
  [main, 'unknown-target-runs', "step.kind !== 'navigate' && (!step.target || step.target.count !== 1 || step.target.ordinal !== 1)", 'false'],
  [main, 'restart-cursor-resumes', "run.status = 'interrupted'; run.warning = 'Restart", "run.status = 'ready'; run.warning = 'Restart"],
  [main, 'completed-action-cursor-does-not-advance', "if (report.outcome.kind === 'completed') run!.nextStep += 1", "if (report.outcome.kind === 'completed') run!.nextStep = version.steps.length"],
  [main, 'stop-progress-ignored', "run.status = 'stopped'; run.warning = 'Task stopped", "run.status = 'ready'; run.warning = 'Task stopped"],
  [main, 'wrong-operation-identity-accepted', "!report.runOperation.id || report.runOperation.browserId !== browserId", 'false'],
  [main, 'storage-failure-silent', 'throw new Error(this.warning)', 'return'],
  [main, 'cursor-projection-not-notified', `    for (const listener of [...this.listeners]) {
      try { void Promise.resolve(listener(browserId)).catch(() => {}) }
      catch { /* A failed projection cannot change the durable action/cursor fact. */ }
    }`, ''],
  [main, 'unrelated-browser-projection-updated', 'listener(browserId)', "listener('browser-other')"],
  [main, 'async-projection-rejection-unhandled', 'Promise.resolve(listener(browserId)).catch(() => {})', 'Promise.resolve(listener(browserId))'],
  [main, 'later-blocked-step-preflight-removed', 'compileAssetStep(step, values)', "''"],
  [compiler, 'partial-observation-claimed-complete', "if (!observed || observed.scope.kind !== 'page' || observed.scope.document !== null ||\n            observed.truncated || observed.omittedFrames.length || (page.missingFrames && page.missingFrames.length))", 'if (false)'],
  [editor, 'editor-delete-does-nothing', 'draft.steps.filter(item => item.id !== step.id)', 'draft.steps'],
  [editor, 'unresolved-review-enabled', "step.kind !== 'navigate' && (!step.target || step.target.count !== 1)", 'false'],
  [editor, 'checkpoint-appended-after-all-actions', '...draft.steps.slice(0, index + 1), { id: crypto.randomUUID(), kind: \'checkpoint\', url: step.url, label: \'Human checkpoint\', reviewed: true }, ...draft.steps.slice(index + 1)', "...draft.steps, { id: crypto.randomUUID(), kind: 'checkpoint', url: step.url, label: 'Human checkpoint', reviewed: true }"],
  [editor, 'waiting-state-hidden', "{continuing ? 'Return control and continue' : 'Run version'}", "{'Run version'}"]
]

const name = `browser-task-assets-source-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`
assert.ok(cases.length > 0, 'The actual Source mutation matrix must be nonempty')
const mutations = await Promise.all(cases.map(async ([file, label, before, after]) => {
  const source = await fs.readFile(path.join(root, file), 'utf8')
  const occurrences = source.split(before).length - 1
  assert.ok(occurrences > 0, `Mutation anchor missing: ${label}`)
  // The original runner changed every matching guard. Preserve that exact scope
  // as one unique whole-source mutation when the guard occurs in two branches.
  return occurrences === 1 ? { file, label, before, after }
    : { file, label, before: source, after: source.replaceAll(before, after) }
}))
await verifyRendererSourceMutations({ name, tests,
  sources: [...inputs, 'apps/desktop/scripts/verify-browser-task-assets-mutations.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'], mutations })

// Default runs only create a fresh ignored attempt. Publication is explicit and
// refuses an existing destination, preserving every historical receipt and log.
const publishIndex = process.argv.indexOf('--publish-evidence')
if (publishIndex >= 0) {
  const destination = process.argv[publishIndex + 1]
  assert.ok(destination, 'Publishing requires an explicit new immutable evidence directory')
  const published = path.resolve(root, destination)
  await fs.mkdir(path.dirname(published), { recursive: true })
  await fs.mkdir(published)
  await fs.cp(path.join(root, '.tmp', name), published, { force: false, errorOnExist: true })
}
