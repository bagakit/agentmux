import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_GROUP_DETAIL_MUTATION
if (mutation && mutation !== 'omit-member-grant') throw Error('Unknown group detail mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/group-connection-detail'),
  resolve: { alias: [{ find: /^@agentmux\/connectors$/, replacement: resolve(root, 'packages/connectors/src/index.ts') }] },
  plugins: [{ name: 'actual-group-detail-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if ((!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/connectors/src/')) || !/\.tsx?$/u.test(path)) return
    let code = source
    if (mutation && path === 'apps/desktop/src/renderer/src/components/AgentConnectorDialog.tsx') {
      const anchor = 'onClick={grant}'
      if (source.split(anchor).length !== 2) throw Error('Expected one original explicit member grant action')
      code = source.replace(anchor, 'onClick={() => {}}')
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_GROUP_DETAIL_LOADED) appendFileSync(process.env.AGENTMUX_GROUP_DETAIL_LOADED, JSON.stringify({ path,
      originalSHA256: sha(source), loadedSHA256: sha(code), mutation: source === code ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/group-connection-detail.test.tsx'], fileParallelism: false, passWithNoTests: false }
})
