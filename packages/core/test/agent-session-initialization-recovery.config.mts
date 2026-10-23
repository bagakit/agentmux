import base from './hook-postcommit-observation.vitest.config.mts'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const mutations: Record<string, { file: string; before: string; after: string }> = {
  'ignore-managed-delivery': { file: 'client.ts', before: "managedLaunch?.promptDelivery === 'post-launch' || deferredPrompt.trim()",
    after: 'deferredPrompt.trim()' },
  'reject-native-ack': { file: 'client.ts', before: "claim?.acknowledged && (claim.transport !== 'native' || claim.native.outcome === 'admitted')",
    after: "claim?.acknowledged && claim.transport !== 'native'" },
  'leak-private-input': { file: 'agent-session-identity.ts', before: 'const { initialInput: _initialInput, nativeActor:', after: 'const { nativeActor:' },
  'drop-original-authority': { file: 'client.ts', before: '...(assertCurrent ? { authority: { assertCurrent } } : {})', after: '...{}' },
  'drop-create-authority': { file: 'client.ts', before: 'this.continueInitialInput(readySession, run, () => this.assertCreationInputCurrent(session, run))',
    after: 'this.continueInitialInput(readySession, run)' },
  'drop-native-dispatch-authority': { file: 'prompt-submission.ts',
    before: '// Provider/Runtime reads can yield to an accepted recovery cancellation.\n          await control?.authority?.assertCurrent()',
    after: '// Mutation: omit the final original recovery authority.' }
}
export default { ...base, plugins: [{ name: 'original-initial-input-mutation', enforce: 'pre' as const,
  transform(code: string, id: string) {
    const name = process.env.AGENTMUX_INITIAL_INPUT_MUTATION
    if (!name) return
    const mutation = mutations[name]
    if (!mutation) throw new Error('Unknown initial input implementation mutation')
    if (id !== fileURLToPath(new URL('../src/' + mutation.file, import.meta.url))) return
    if (code.split(mutation.before).length !== 2) throw new Error('Initial input mutation must change one actual implementation site')
    const changed = code.replace(mutation.before, mutation.after)
    if (process.env.AGENTMUX_INITIAL_INPUT_LOADED) appendFileSync(process.env.AGENTMUX_INITIAL_INPUT_LOADED,
      JSON.stringify({ id, mutation: name, originalSHA256: createHash('sha256').update(code).digest('hex'),
        loadedSHA256: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return { code: changed, map: null }
  }
}], resolve: { ...base.resolve, alias: [
  // Generated identity browser source has no .ts counterpart; avoid the parent index alias swallowing its subpath.
  { find: '@agentmux/identity/runtime-source', replacement: fileURLToPath(new URL('../../identity/dist/runtime-source.js', import.meta.url)) },
  ...base.resolve.alias
] }, test: { ...base.test, include: ['packages/core/test/agent-session-initialization-recovery.test.ts',
  'packages/core/test/durable-local-creation.test.ts', 'packages/core/test/providers/post-launch-prompt-delivery.test.ts'],
  fileParallelism: false, maxWorkers: 1, passWithNoTests: false, testTimeout: 20_000, hookTimeout: 20_000 } }
