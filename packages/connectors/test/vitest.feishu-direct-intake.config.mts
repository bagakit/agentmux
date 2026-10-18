import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/feishu-direct-intake'),
  plugins: [{ name: 'native-private-intake-proof', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (file !== 'packages/connectors/src/adapters/feishu/index.ts') return
    let code = source
    if (process.env.AGENTMUX_FEISHU_DIRECT_MUTATION) {
      const anchor = "!['group', 'p2p'].includes(payload.event.message.chat_type)"
      if (source.split(anchor).length !== 2) throw Error('Actual native intake scope changed')
      code = source.replace(anchor, "payload.event.message.chat_type !== 'group'")
    }
    if (process.env.AGENTMUX_FEISHU_DIRECT_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_FEISHU_DIRECT_LOADED, JSON.stringify({ file, originalSha256: sha(source), loadedSha256: sha(code), mutation: !!process.env.AGENTMUX_FEISHU_DIRECT_MUTATION }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/feishu-direct-intake.test.ts'], passWithNoTests: false, fileParallelism: false }
})
