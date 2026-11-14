import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import base from './vitest.workbench-recovery-bootstrap.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_GOAL_INPUT_MUTATION
const edits: Record<string, [string,string,string]> = {
  'drop-main-dispatch-cut': ['apps/desktop/src/main/ipc.ts', 'goalDispatch.inputEpoch === undefined ? {} : { inputEpoch: goalDispatch.inputEpoch }', 'condition.inputEpoch === undefined ? {} : { inputEpoch: condition.inputEpoch }'],
  'drop-qualified-cut': ['apps/desktop/src/renderer/src/components/GoalFiniteStartControl.tsx', 'inputEpoch = qualified.inputEpoch === null ? undefined : qualified.inputEpoch', 'inputEpoch = undefined'],
  'mint-on-partial-selection': ['apps/desktop/src/renderer/src/components/GoalFiniteStartControl.tsx', "if (!value?.source || reference.source.admission.kind === 'association' && !value.coordinator)", 'if (!value?.source)'],
  'renew-original-cut': ['apps/desktop/src/renderer/src/components/GoalFiniteStartControl.tsx', 'if (intent?.agentReference) next = { ...intent, accessDraft: value }', "if (intent?.agentReference) next = { ...intent, accessDraft: value, inputEpoch: (await api.demands.inputEpoch({ agentReference: intent.agentReference, access: value })).inputEpoch ?? undefined }"],
  'drop-submission-cut': ['apps/desktop/src/renderer/src/lib/goal-finite-start.ts', ', ...optionalInputEpoch(intent.inputEpoch) } as const', ' } as const'],
  'accept-wrong-goal-runtime': ['apps/desktop/src/renderer/src/components/GoalFiniteStartControl.tsx', 'if (qualified.runtimeId !== reference.execution.runtimeId)', 'if (false)'],
  'drop-main-goal-reader': ['apps/desktop/src/main/ipc.ts', "await callUserRpc('goal.input.epoch', input)", "({ runtimeId: input.agentReference.execution.runtimeId, inputEpoch: null })"],
  'upgrade-old-store-cut': ['apps/desktop/src/renderer/src/store.ts', 'original.access, original.inputEpoch]', 'original.access, intent.inputEpoch]']
}
if (mutation && !edits[mutation]) throw Error('Unknown Goal birth mutation')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/goal-input-birth'),
  plugins: [...base.plugins ?? [], { name: 'current-goal-owner-source', enforce: 'pre', transform(source,id) {
    const path = id.split('?')[0]!, edit = mutation && edits[mutation]
    let code = source
    if (edit && path === resolve(root,edit[0])) { if (!code.includes(edit[1])) throw Error('Missing exact Goal mutation anchor'); code = code.replaceAll(edit[1],edit[2]) }
    const output = process.env.AGENTMUX_GOAL_INPUT_SOURCE_PROOF
    if (output && (path.startsWith(root + '/apps/') || path.startsWith(root + '/packages/'))) appendFileSync(output, JSON.stringify({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),compiledSHA256:createHash('sha256').update(code).digest('hex'),mutation:source===code?null:mutation})+'\n',{mode:0o600})
    return source === code ? undefined : {code,map:null}
  } }], test: { ...base.test, include: ['apps/desktop/test/goal-input-birth.test.tsx','apps/desktop/test/goal-input-birth-public.test.tsx','apps/desktop/test/goal-qualified-finite-start.test.tsx'], maxWorkers:1, fileParallelism:false, passWithNoTests:false, testTimeout:30000 }
})
