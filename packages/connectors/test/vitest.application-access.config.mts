import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_TEST_APPLICATION_ACCESS_MUTATION
if (mutation && mutation !== 'ignore-local-override') throw Error('Unknown application access mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/application-access'), plugins: [{ name: 'actual-application-access', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^packages\/(core\/(src|dist)|connectors\/src)\//u.test(path)) return
  let code = source
  if (mutation && path === 'packages/connectors/src/room-binding.ts') {
    const anchor = 'if (local) return local.bindingRevision === revision || local.state === \'revoked\' ? effectiveRoomGrant(local) : null'
    if (source.split(anchor).length !== 2) throw Error('Original local precedence seam missing')
    code = source.replace(anchor, 'if (false && local) return null')
  }
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  if (process.env.AGENTMUX_TEST_APPLICATION_ACCESS_LOADED) appendFileSync(process.env.AGENTMUX_TEST_APPLICATION_ACCESS_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: source === code ? null : mutation }) + '\n')
  return source === code ? undefined : { code, map: null }
} }], test: { ...original.test, include: ['packages/connectors/test/application-access.test.ts', 'packages/connectors/test/feishu-permission-actions.test.ts', 'packages/connectors/test/feishu-question-actions.test.ts'], testNamePattern: process.env.AGENTMUX_TEST_APPLICATION_ACCESS_CASES ?? 'application access', fileParallelism: false, passWithNoTests: false } })
