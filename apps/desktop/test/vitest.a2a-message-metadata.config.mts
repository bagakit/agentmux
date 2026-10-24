import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { transformMessageMetadata } from '../scripts/fixtures/a2a-message-metadata/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const bridge = process.env.AGENTMUX_MESSAGE_METADATA_BRIDGE === '1'
export default defineConfig({ ...base, cacheDir: resolve(root, '.local/a2a-message-metadata/vite'),
  define: { ...base.define, __AGENTMUX_WEB_PREVIEW__: bridge ? 'false' : 'true' },
  resolve: { ...base.resolve, conditions: ['node', 'import', 'default'] },
  ssr: { ...base.ssr, resolve: { conditions: ['node', 'import', 'default'] } },
  plugins: [...(base.plugins ?? []), { name: 'message-metadata-actual-input', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    const path = relative(root, file), code = transformMessageMetadata(source, path, process.env.AGENTMUX_MESSAGE_METADATA_MUTATION)
    const output = process.env.AGENTMUX_MESSAGE_METADATA_LOADED
    if (output) appendFileSync(output, JSON.stringify({ path, original: hash(readFileSync(file)), input: hash(source), compiled: hash(code), consumer: 'vitest' }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', maxWorkers: 1, include: bridge ? ['apps/desktop/test/a2a-message-data-bridge.test.tsx'] : [
    'packages/core/test/a2a-message-metadata.test.ts',
    'apps/desktop/test/a2a-primary-reading-consumers.test.tsx',
    'packages/client-ui/test/a2a-original-reading.test.tsx',
    'packages/client-ui/test/a2a-message-metadata.test.tsx'
  ] }
})
