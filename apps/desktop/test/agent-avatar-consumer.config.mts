import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = source.root!
const mutation = process.env.AGENTMUX_AVATAR_MUTATION
if (mutation && mutation !== 'global-subscription') throw Error('Unknown Avatar observation mutation')
export default defineConfig({
  ...source, cacheDir: resolve(root, '.cache/avatar-consumer'),
  plugins: [{ name: 'actual-avatar-session-consumer', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/AgentAvatar.tsx', 'apps/desktop/src/renderer/src/lib/use-observed-app-store.ts'].includes(path)) return
    let code = original
    const avatar = path.endsWith('/AgentAvatar.tsx')
    if (avatar) {
      const anchor = 'const entry = sessionId ? sessionPresentationById(store.sessions).get(sessionId) : undefined'
      if (code.split(anchor).length !== 2) throw Error('Expected one actual Avatar Session selector')
      code = code.replace(anchor, `globalThis.__avatarSelectorReads ??= {};
        globalThis.__avatarSelectorReads[sessionId ?? ''] = (globalThis.__avatarSelectorReads[sessionId ?? ''] ?? 0) + 1;
        ${anchor}`)
      if (mutation) {
        const boundary = "useObservedAppStore('avatar', visible, consumerScope, useShallow("
        if (code.split(boundary).length !== 2) throw Error('Expected one original Avatar notification boundary')
        code = `import { useAppStore } from '../store'\n` + code.replace(boundary, 'useAppStore(useShallow(')
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_AVATAR_LOADED) appendFileSync(process.env.AGENTMUX_AVATAR_LOADED,
      JSON.stringify({ path, original: hash(original), loaded: hash(code), mutation: avatar ? mutation ?? null : null, instrumented: avatar }) + '\n')
    return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/agent-avatar-consumer.test.tsx', 'apps/desktop/test/agent-avatar.test.tsx'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
})
