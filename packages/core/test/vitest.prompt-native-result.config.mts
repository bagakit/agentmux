import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/scripts/fixtures/agent-schedules/vitest.config.mjs'
import { relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { instrument } from './helpers/prompt-native-result-mutations.mjs'
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'prompt-native-result-baseline', enforce: 'pre', transform(code, id) {
  const file = relative(process.cwd(), id.split('?')[0]!)
  if (process.env.PROMPT_NATIVE_RESULT_BASELINE && ['client.ts', 'types.ts', 'agent-session-store.ts', 'prompt-submission-record.ts'].some(name => file === 'packages/core/src/' + name))
    code = execFileSync('git', ['show', 'HEAD:' + file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { code: instrument(code, file), map: null }
} }], test: { ...source.test,
  include: process.env.PROMPT_NATIVE_RESULT_MUTATION === 'refresh-unknown-result' ? ['packages/core/test/native-conversation-input.test.ts'] : process.env.PROMPT_NATIVE_RESULT_MUTATION ? [process.env.PROMPT_NATIVE_RESULT_MUTATION === 'block-original-ack-with-observation'
    ? 'packages/core/test/prompt-native-result-protocol.test.ts' : 'packages/core/test/prompt-native-result.test.ts']
    : ['packages/core/test/prompt-native-result.test.ts', 'packages/core/test/prompt-native-result-protocol.test.ts'], fileParallelism: false, maxWorkers: 1,
  passWithNoTests: false, testTimeout: 20000, hookTimeout: 15000 } })
