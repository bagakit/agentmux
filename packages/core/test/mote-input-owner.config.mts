import { defineConfig } from 'vitest/config'
import source from './a2a-resumed-inbox.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  ...source,
  plugins: [
    {
      name: 'mote-input-source',
      enforce: 'pre',
      transform(code, id) {
        const path = relative(root, id.split('?')[0]!)
        if (!/^(packages|apps\/host)\//u.test(path) || !path.endsWith('.ts')) return
        let next = code
        if (
          process.env.AGENTMUX_TEST_MOTE_MUTATION === 'wrong-primary' &&
          path === 'packages/core/src/mote-input-owner.ts'
        )
          next = code.replace(
            "sourceStatus = binding ? 'confirmed' : 'self'",
            "if (binding) binding.primary.agentSessionId = 'stranger'; sourceStatus = binding ? 'confirmed' : 'self'"
          )
        if (
          process.env.AGENTMUX_TEST_MOTE_MUTATION === 'wrong-result' &&
          path === 'packages/core/src/mote-input-owner.ts'
        )
          next = code.replace('isDeepStrictEqual(value.original.item.conversation?.adoptedInput?.key, inputKey)', 'true')
        if(process.env.AGENTMUX_TEST_MOTE_MUTATION && path==='packages/core/src/mote-input-owner.ts' && next===code)throw new Error('The selected production mutation was not applied')
        if (process.env.AGENTMUX_TEST_MOTE_LOADED)
          appendFileSync(
            process.env.AGENTMUX_TEST_MOTE_LOADED,
            JSON.stringify({
              path,
              originalSHA256: createHash('sha256').update(code).digest('hex'),
              sha256: createHash('sha256').update(next).digest('hex')
            }) + '\n'
          )
        if (next !== code) return { code: next, map: null }
      }
    },
    ...(source.plugins ?? [])
  ],
  test: {
    ...source.test,
    include: ['packages/core/test/mote-input-owner.test.ts'],
    testTimeout: 30_000,
    passWithNoTests: false
  }
})
