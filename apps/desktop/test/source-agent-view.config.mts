import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.focus-source-unification.config.mts'

const root = resolve(import.meta.dirname, '../../..'), owner = 'apps/desktop/src/renderer/src/lib/workface-agent-view.ts'
const variants = {
  'wrong-runtime': ['request.runtimeId === undefined || value.runtimeId === request.runtimeId', 'true'],
  'local-mode-key': ['selectedSource?.[0] ?? original?.id ?? retainedId ?? id', 'original?.id ?? retainedId ?? id']
} as const
const mutation = process.env.AGENTMUX_SOURCE_VIEW_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown original view mutation')
export default { ...base, cacheDir: resolve(root, '.tmp/source-agent-view'),
  plugins: [...base.plugins ?? [], { name: 'original-agent-view-consumer-proof', enforce: 'pre' as const,
    transform(original: string, id: string) {
      if (relative(root, id.split('?')[0]!) !== owner) return
      let code = original
      if (mutation) {
        const [from, to] = variants[mutation]
        if (original.split(from).length !== 2) throw Error('Original view mutation requires one owning anchor')
        code = original.replace(from, to)
      }
      if (process.env.AGENTMUX_SOURCE_VIEW_LOADED) appendFileSync(process.env.AGENTMUX_SOURCE_VIEW_LOADED,
        JSON.stringify({ file: owner, mutation: mutation ?? null, original: createHash('sha256').update(original).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
      return { code, map: null }
    }
  }],
  test: { ...base.test, passWithNoTests: false }
}
