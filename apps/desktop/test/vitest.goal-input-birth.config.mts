import { defineConfig } from 'vitest/config'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Alias } from 'vite'
import base from './vitest.workbench-recovery-bootstrap.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const owner = process.env.AGENTMUX_GOAL_INPUT_OWNER_ROOT ?? dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
const aliases: Alias[] = []
for (const [name, folder] of [['demand', 'packages/demand'], ['host', 'apps/host']]) {
  const manifest = JSON.parse(readFileSync(resolve(owner, folder, 'package.json'), 'utf8'))
  for (const [entry, value] of Object.entries(manifest.exports ?? {}) as [string, string | { import?: string; browser?: string }][]) {
    const target = typeof value === 'string' ? value : value.browser ?? value.import
    if (!target) continue
    const source = resolve(owner, folder, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
    const specifier = '@agentmux/' + name + (entry === '.' ? '' : entry.slice(1))
    if (existsSync(source)) aliases.push({ find: specifier, replacement: source })
  }
}
aliases.sort((a,b) => String(b.find).length - String(a.find).length)
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
  resolve: { ...base.resolve, alias: [...aliases, ...base.resolve!.alias as Alias[]] },
  plugins: [...base.plugins ?? [], { name: 'current-goal-owner-source', enforce: 'pre', async resolveId(specifier, importer) {
    if (!importer || !specifier.startsWith('.') && !isAbsolute(specifier)) return
    const path = isAbsolute(specifier) ? specifier : resolve(dirname(importer.split('?')[0]!), specifier)
    if (['packages/core', 'packages/demand', 'apps/host'].some(folder => path.startsWith(resolve(root, folder) + '/')))
      return await this.resolve(resolve(owner, relative(root,path)), undefined, { skipSelf: true })
  }, transform(source,id) {
    const path = id.split('?')[0]!, edit = mutation && edits[mutation]
    let code = source
    if (edit && path === resolve(root,edit[0])) { if (!code.includes(edit[1])) throw Error('Missing exact Goal mutation anchor'); code = code.replaceAll(edit[1],edit[2]) }
    const output = process.env.AGENTMUX_GOAL_INPUT_SOURCE_PROOF
    if (output && (path.startsWith(root + '/apps/') || path.startsWith(owner + '/packages/') || path.startsWith(owner + '/apps/host/'))) appendFileSync(output, JSON.stringify({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),compiledSHA256:createHash('sha256').update(code).digest('hex'),mutation:source===code?null:mutation})+'\n',{mode:0o600})
    return source === code ? undefined : {code,map:null}
  } }], test: { ...base.test, include: ['apps/desktop/test/goal-input-birth.test.tsx','apps/desktop/test/goal-input-birth-public.test.tsx','apps/desktop/test/goal-qualified-finite-start.test.tsx'], maxWorkers:1, fileParallelism:false, passWithNoTests:false, testTimeout:30000 }
})
