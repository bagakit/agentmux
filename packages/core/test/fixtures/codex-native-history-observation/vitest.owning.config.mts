import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../../../..')
const target = 'packages/core/src/providers/codex.ts'

export default defineConfig({ ...original, root,
  plugins: [...(original.plugins ?? []), { name: 'codex-observation-actual-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !/\.ts$/u.test(path)) return
    const before = code, mutation = process.env.AGENTMUX_CODEX_OBSERVATION_MUTATION
    if (mutation && mutation !== 'remove-codex-observer') throw new Error('Unknown Codex observation mutation ' + mutation)
    if (mutation && path === target) {
      const anchor = '    observeSessionHistory: observeNativeJsonlHistory,\n'
      if (code.split(anchor).length !== 2) throw new Error('Missing unique Codex observation registration')
      code = code.replace(anchor, '')
    }
    const output = process.env.AGENTMUX_CODEX_OBSERVATION_LOADED
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (output) appendFileSync(output, JSON.stringify({ path, originalSHA256: hash(before), sha256: hash(code), bytes: Buffer.byteLength(code), ...(before !== code ? { mutation } : {}) }) + '\n')
    if (before !== code) return { code, map: null }
  } }],
  // This literal slice imports public Core implementation from Source, never dist.
  // The installed/dist identity remains the earlier live receipt, not this qualification.
  test: { ...original.test, globalSetup: [], include: ['packages/core/test/codex-native-history-observation.test.ts'], passWithNoTests: false, fileParallelism: false }
})
