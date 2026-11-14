import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.workbench-recovery-bootstrap.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_INPUT_EPOCH_MUTATION
const edits: Record<string, [string, string, string]> = {
  'drop-new-manual-epoch': ['apps/desktop/src/renderer/src/store.ts', "{ expectedRun: { ...session.control.run }, ...(session.inputEpoch === undefined ? {} : { inputEpoch: session.inputEpoch }), admissionIntent: { kind: 'manual-actor' } }", "{ expectedRun: { ...session.control.run }, admissionIntent: { kind: 'manual-actor' } }"],
  'drop-create-epoch': ['apps/desktop/src/main/runtime-controller.ts', '...(request.inputEpoch === undefined ? {} : { inputEpoch: request.inputEpoch }),', ''],
  'drop-resume-epoch': ['apps/desktop/src/main/runtime-controller.ts', 'input: request.input, ...(request.inputEpoch === undefined ? {} : { inputEpoch: request.inputEpoch })', 'input: request.input'],
  'renew-old-queue-epoch': ['apps/desktop/src/renderer/src/store.ts', '...(pending.inputEpoch === undefined ? {} : { inputEpoch: pending.inputEpoch })', '...(fresh.inputEpoch === undefined ? {} : { inputEpoch: fresh.inputEpoch })'],
  'skip-new-create-reader': ['apps/desktop/src/renderer/src/store.ts', 'await api.sessions.readInputEpoch(executionHostId) ?? undefined', 'undefined'],
  'skip-native-import-reader': ['apps/desktop/src/renderer/src/components/LauncherResumePicker.tsx', 'await api.sessions.readInputEpoch(row.candidate.hostId) ?? undefined', 'undefined'],
  'skip-coordinator-reader': ['apps/desktop/src/renderer/src/components/GoalSourceCreation.tsx', 'await api.sessions.readInputEpoch(selection.coordinator.hostId) ?? undefined', 'undefined'],
  'drop-main-epoch-projection': ['apps/desktop/src/main/runtime-controller.ts', '...(subject.agentSession.inputEpoch === undefined ? {} : { inputEpoch: subject.agentSession.inputEpoch }),', ''],
  'drop-renderer-epoch-projection': ['apps/desktop/src/renderer/src/lib/session-state.ts', '...(core.session.inputEpoch === undefined ? {} : { inputEpoch: core.session.inputEpoch }),', ''],
  'renew-goal-epoch': ['apps/desktop/src/renderer/src/store.ts', "const inputEpoch = options?.goalContinuation ? options.goalContinuation.condition.inputEpoch\n    : options?.goalPmo ? options.goalPmo.inputEpoch : options?.goalDispatch ? options.goalDispatch.inputEpoch : session.inputEpoch", 'const inputEpoch = session.inputEpoch']
}
if (mutation && !edits[mutation]) throw Error('Unknown input epoch mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/input-epoch-consumer'),
  plugins: [...base.plugins ?? [], { name: 'original-input-epoch-consumer', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), edit = mutation && edits[mutation]
    let code = source
    if (edit && path === edit[0]) {
      if (!code.includes(edit[1])) throw Error('Missing input epoch consumer mutation anchor')
      code = code.replaceAll(edit[1], edit[2])
    }
    const output = process.env.AGENTMUX_INPUT_EPOCH_SOURCE_PROOF
    if (output && (path.startsWith('apps/desktop/src/') || path.startsWith('packages/client-ui/src/'))) appendFileSync(output,
      JSON.stringify({ path, absolutePath: id.split('?')[0], sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'),
        compiledSHA256: createHash('sha256').update(code).digest('hex'), mutation: source === code ? null : mutation }) + '\n', { mode: 0o600 })
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: process.env.AGENTMUX_INPUT_EPOCH_UI === '1'
    ? ['apps/desktop/test/launcher-resume-picker.test.tsx', 'apps/desktop/test/goal-source-creation.test.tsx'] : ['apps/desktop/test/input-epoch-consumer.test.tsx'],
    testNamePattern: process.env.AGENTMUX_INPUT_EPOCH_UI === '1' ? /keeps the exact native operation|an original Reach C with an unknown ACK/ : undefined,
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 40_000 }
})
