import base from './vitest.native-input.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string]> = {
  'screen-grants-idle': ['let nativeFutureAdmissionReady = false', 'let nativeFutureAdmissionReady = true'],
  'reject-native-idle-queue': ["nativeFutureAdmissionReady = nativeIdleOnly && prepared.plan.operation === 'queue-idle'", 'nativeFutureAdmissionReady = false']
}
export default { ...base, plugins: [...base.plugins!, {
  name: 'automatic-input-actual-source', enforce: 'pre' as const, transform(source: string, id: string) {
    const mutation = process.env.AMX_INPUT_BOUNDARY_MUTATION
    if (!mutation || relative(root, id.split('?')[0]!) !== 'packages/core/src/prompt-submission.ts') return
    const edit = mutations[mutation]
    if (!edit || source.split(edit[0]).length !== 2) throw Error('Input boundary mutation anchor must be unique')
    const code = source.replace(edit[0], edit[1])
    if (!process.env.AMX_INPUT_BOUNDARY_LOADED) throw Error('Input boundary mutation needs a source receipt')
    appendFileSync(process.env.AMX_INPUT_BOUNDARY_LOADED, JSON.stringify({ mutation,
      original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/client-submit-prompt-run-binding.test.ts', 'packages/core/test/native-conversation-input.test.ts'],
  testNamePattern: /future|occurrence|automatic|conditional exact Run prompt admission|saved intent/ } }
