import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const target = 'apps/desktop/src/renderer/src/lib/focus-work-history.ts'
const sourcePaths = new Set([target, 'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx',
  'apps/desktop/test/focus-work-subscription.test.tsx', 'packages/client-ui/src/platform.tsx'])
const guard = 'timeline?.items === sourceItems && timeline?.revision === revision'
const mutations: Record<string, string> = {
  'repeat-unrelated-scan': 'false',
  'ignore-revision': 'timeline?.items === sourceItems',
  'ignore-items': 'timeline?.revision === revision'
}
const mutation = process.env.AGENTMUX_FOCUS_SUBSCRIPTION_MUTATION
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error('Unknown Focus subscription mutation')
export default defineConfig({ ...original,
  root,
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  cacheDir: resolve(root, '.tmp/focus-work-subscription-vitest-cache'),
  plugins: [...(original.plugins ?? []), { name: 'focus-work-subscription-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!sourcePaths.has(path)) return
    let code = source
    if (mutation && path === target) {
      if (source.split(guard).length !== 2) throw new Error('Expected one actual Focus subscription guard')
      code = source.replace(guard, mutations[mutation]!)
    }
    if (process.env.AGENTMUX_FOCUS_SUBSCRIPTION_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_SUBSCRIPTION_LOADED, JSON.stringify({
      path, sourceSHA256: createHash('sha256').update(source).digest('hex'),
      effectiveSHA256: createHash('sha256').update(code).digest('hex'), mutation: code === source ? null : mutation
    }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...original.test, server: { deps: { inline: ['@agentmux/client-ui'] } },
    include: ['apps/desktop/test/focus-work-subscription.test.tsx'], fileParallelism: false, maxWorkers: 1 }
})
