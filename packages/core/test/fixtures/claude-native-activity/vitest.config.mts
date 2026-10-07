import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../../../..')
const edits: Record<string, [string, string, string]> = {
  'main-turn': ['packages/core/src/client.ts', 'event.nativeTurnId !== previous.event.nativeTurnId', 'false'],
  'child-turn': ['packages/core/src/hook-normalizer.ts', 'previous.nativeTurnId !== identity.nativeTurnId', 'false'],
  projection: ['packages/core/src/client.ts', 'if (currentActivity) projected.currentActivity = currentActivity', 'if (false) projected.currentActivity = currentActivity']
}
export default defineConfig({ root, cacheDir: resolve(root, '.local/claude-native-activity/cache'),
  plugins: [{ name: 'native-activity-source-mutation', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    const mutation = process.env.AGENTMUX_ACTIVITY_MUTATION
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error('Unknown source mutation')
    if (!edit || edit[0] !== path) return
    if (source.split(edit[1]).length !== 2) throw new Error('Source mutation must match once')
    const changed = source.replace(edit[1], edit[2])
    if (!process.env.AGENTMUX_ACTIVITY_MUTATION_RECEIPT) throw new Error('Missing source mutation receipt')
    appendFileSync(process.env.AGENTMUX_ACTIVITY_MUTATION_RECEIPT, JSON.stringify({ path, mutation,
      original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(changed).digest('hex') }) + '\n')
    return {code:changed,map:null}
  } }], test: {include:['packages/core/test/claude-native-current-activity.test.ts','packages/core/test/providers/claude.test.ts'],
    globalSetup:[resolve(root,'vitest.dist-freshness.ts')],setupFiles:[resolve(root,'vitest.setup.ts')],
    fileParallelism:false,maxWorkers:1,testTimeout:20000,hookTimeout:15000,passWithNoTests:false} })
