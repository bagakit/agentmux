import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const main = 'apps/desktop/src/main/browser-demonstration-recorder.ts'
const test = 'apps/desktop/test/browser-demonstration-recorder.test.ts'
const capture = 'apps/desktop/src/main/browser-demonstration-capture.ts'
const target = 'apps/desktop/src/main/browser-semantic-target.ts'
const surface = 'apps/desktop/src/renderer/src/components/BrowserDemonstrationSurface.tsx'
const tests = [test, 'apps/desktop/test/browser-demonstration-capture.test.ts', 'apps/desktop/test/browser-demonstration-surface.test.tsx']
const inputs = [main, capture, target, surface, ...tests,
  'apps/desktop/src/main/browser-cdp-session.ts', 'apps/desktop/src/main/browser-page-snapshot.ts',
  'apps/desktop/src/main/browser-snapshot-query.ts', 'apps/desktop/src/main/browser-selection-script.ts',
  'apps/desktop/src/shared/browser-demonstration.ts', 'apps/desktop/src/shared/browser-operation.ts',
  'apps/desktop/src/shared/browser-step-evidence.ts', 'apps/desktop/src/shared/browser-snapshot-query.ts']
const cases = [
  ['capture-time-follows-slow-storage', 'const recordedAt = this.now()\n    const gesture = this.recentGesture(input.browserId, input.navigationId)\n    return this.change(async () => {', 'return this.change(async () => {\n      const recordedAt = this.now()\n      const gesture = this.recentGesture(input.browserId, input.navigationId)'],
  ['page-synthetic-event-accepted', 'input.isTrusted !== true', 'false'],
  ['native-input-not-required', "if (!gesture || !(input.kind === 'fill' ? FILL_INPUTS : CLICK_INPUTS).has(gesture.type)) return null", 'if (false) return null'],
  ['input-value-retained', 'args: [], ...(target ? { target } : {}),', 'args: (input.value ? [input.value] : []), ...(target ? { target } : {}),'],
  ['restart-recording-resumes', "draft.status = 'interrupted'", "draft.status = 'recording'"],
  ['unread-history-overwritten', 'if (this.loadUnavailable) return', 'if (false) return'],
  ['unknown-navigation-claimed-human', "source: human ? 'native-human' : 'navigation'", "source: 'native-human'"],
  ['step-budget-one-extra', 'draft.steps.length >= MAX_STEPS', 'draft.steps.length > MAX_STEPS'],
  ['target-proof-not-awaited', 'safeTarget(await input.target)', 'safeTarget(input.target)']
].map(([name, before, after]) => [main, name, before, after])
cases.push(
  [capture, 'untrusted-event-enters-capture', 'if (event.isTrusted !== true) return;', 'if (false) return;'],
  [capture, 'hover-triggers-observation', '!NATIVE_INPUTS.has(input.type)', 'false'],
  [target, 'backend-identity-guessed', 'candidate.backendNodeId === backendNodeId', 'candidate.backendNodeId > 0'],
  [target, 'ambiguous-target-approved', 'matches.length !== 1', 'matches.length < 1'],
  [capture, 'isolated-world-unproven', 'response.result?.value === true', 'true'],
  [capture, 'owner-not-released', 'this.session?.detach()', 'void 0'],
  [capture, 'cleanup-warning-discarded', 'if (cleanupWarning) this.warning = cleanupWarning', 'void 0'],
  [capture, 'slow-start-reacquires-owner', 'if (generation !== this.generation) return draft', 'if (false) return draft'],
  [capture, 'budget-stop-keeps-debugger', "if (draft && draft.status !== 'recording' && this.active) this.release()", 'void 0'],
  [capture, 'event-budget-removed', 'state.events.length >= ${MAX_EVENTS}', 'false'],
  [surface, 'blocked-reason-hidden', '{step.blockedReason ? <small', '{false ? <small'],
  [surface, 'interrupted-claims-recording', "const recording = draft?.status === 'recording'", "const recording = draft !== null"]
)

const name = `browser-demonstration-recorder-source-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`
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
  sources: [...inputs, 'apps/desktop/scripts/verify-browser-demonstration-recorder-mutations.mjs',
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
