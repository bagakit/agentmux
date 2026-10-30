import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.user-cards.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/feishu-mixed-intake'),
  plugins: [...original.plugins ?? [], { name: 'loaded-mixed-post', enforce: 'pre', transform(input, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/src/adapters/feishu/message.ts') return
    let output = input
    if (process.env.AGENTMUX_MIXED_POST_MUTATION) {
      const anchor = "if (node.tag === 'img') {"
      if (input.split(anchor).length !== 2) throw Error('Original mixed image owner changed')
      output = input.replace(anchor, 'if (false) {')
    }
    const marker = process.env.AGENTMUX_MIXED_POST_LOADED
    if (marker) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = JSON.stringify({ file, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input !== output })
      return { code: "import { appendFileSync as __markMixedPost } from 'node:fs'; __markMixedPost(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
    }
    return output === input ? undefined : { code: output, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/feishu-post-intake-consumer.test.ts'], passWithNoTests: false }
})
