import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_BOT_LIBRARY_MUTATION
if (mutation && mutation !== 'manage-first-bot') throw Error('Unknown bot library mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/channel-bot-library'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'actual-channel-bot-library', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) || !/\.tsx?$/u.test(path)) return
    let code = source
    if (mutation && path === 'apps/desktop/src/renderer/src/components/settings/ConnectionBotList.tsx') {
      const anchor = 'onClick={() => onManage(record)}'
      if (source.split(anchor).length !== 2) throw Error('Expected one original bot-library selection action')
      code = source.replace(anchor, 'onClick={() => onManage(records[0]!)}')
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_BOT_LIBRARY_LOADED) appendFileSync(process.env.AGENTMUX_BOT_LIBRARY_LOADED, JSON.stringify({ path,
      originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/channel-bot-library.test.tsx'], fileParallelism: false, passWithNoTests: false }
})
