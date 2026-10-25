import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { mergeConfig } from 'vitest/config'
import recipient from './vitest.input-recipient-continuation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_TEST_SEMANTIC_MUTATION
if (mutation && !['human-only', 'unproven-resume'].includes(mutation)) throw Error('Unknown semantic continuation mutation')
export default mergeConfig(recipient, {
  cacheDir: resolve(root, '.local/channel-current-session-regression/external-input-semantic-continuation/cache', mutation ?? 'candidate'),
  plugins: [{ name: 'semantic-continuation-owner', enforce: 'pre', transform(original: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/client.ts', 'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/rpc-native-codec.ts'].includes(path)) return
    let served = original
    const replace = (anchor: string, value: string) => { if (served.split(anchor).length !== 2) throw Error('Mutation needs one owner anchor: ' + anchor); served = served.replace(anchor, value) }
    if (path === 'packages/core/src/client.ts') {
      if (mutation === 'human-only') replace('return eligible && expected.providerId', 'return this.isRetainedHumanInput(intent) && expected.providerId')
      if (mutation === 'unproven-resume') replace('sessionSemanticResumeSourceRuns(session).includes(intent.key.expectedRun.runId)', 'true')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_TEST_RECIPIENT_LOADED) appendFileSync(process.env.AGENTMUX_TEST_RECIPIENT_LOADED, JSON.stringify({ path,
      consumer: 'semantic-owner', originalSHA256: sha(original), sha256: sha(served), ...(served === original ? {} : { mutation }) }) + '\n')
    return served === original ? undefined : { code: served, map: null }
  } }],
  test: { testNamePattern: 'semantic continuation' }
})
