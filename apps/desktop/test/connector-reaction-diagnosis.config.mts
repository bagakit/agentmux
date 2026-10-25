import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './connector-input-recovery.config.mts'
const root = resolve(import.meta.dirname, '../../..'),
  mutant = process.env.CONNECTOR_REACTION_MUTANT
export default defineConfig({
  ...base,
  cacheDir: resolve(root, '.cache/connector-reaction-diagnosis'),
  plugins: [
    ...base.plugins!,
    {
      name: 'typed-reaction-diagnosis',
      enforce: 'pre',
      transform(source, id) {
        const path = relative(root, id.split('?')[0]!)
        if (!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
        let code = source
        if (mutant && path === 'packages/core/src/connection-diagnosis.ts') {
          const anchor = "delivery.reference.source.kind === 'ingress' ? 'query-feedback' as const"
          if (mutant !== 'feedback-as-conversation' || source.split(anchor).length !== 2) throw Error('Unknown or non-unique reaction mutation')
          code = source.replace(anchor, "delivery.reference.source.kind === 'ingress' ? 'conversation' as const")
        }
        if (process.env.CONNECTOR_REACTION_LOADED) {
          const sha = (value: string) => createHash('sha256').update(value).digest('hex')
          appendFileSync(
            process.env.CONNECTOR_REACTION_LOADED,
            JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), ...(source === code ? {} : { mutant }) }) + '\n'
          )
        }
        return source === code ? undefined : { code, map: null }
      }
    }
  ],
  test: { ...base.test, include: ['apps/desktop/test/connector-reaction-diagnosis.test.tsx'], ...(mutant ? { testNamePattern: 'reaction-only' } : {}) }
})
