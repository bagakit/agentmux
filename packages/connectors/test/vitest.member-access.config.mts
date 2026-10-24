import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_MEMBER_ACCESS_MUTATION
if (mutation && mutation !== 'require-equal-scope') throw Error('Unknown member-access mutation')
const owners = new Set(['packages/connectors/src/room-binding.ts', 'packages/connectors/src/connection-services.ts', 'packages/connectors/src/connection-host.ts',
  'packages/core/src/room-binding-codec.ts', 'packages/core/dist/public-rpc-service.js', 'packages/core/dist/public-rpc-server.js', 'packages/core/dist/room-binding-codec.js'])
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/member-access-owner'),
  plugins: [{ name: 'actual-member-access-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.has(path)) return
    let code = source
    if (mutation && path === 'packages/connectors/src/room-binding.ts') {
      const anchor = '&& equal(left.inputTarget, right.inputTarget)'
      if (source.split(anchor).length !== 2) throw Error('Expected one original member-subject qualification')
      code = source.replace(anchor, '&& equal(left.scope, right.scope) ' + anchor)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_MEMBER_ACCESS_LOADED) appendFileSync(process.env.AGENTMUX_MEMBER_ACCESS_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['packages/connectors/test/room-binding.test.ts', 'packages/connectors/test/room-binding-public-consumer.test.ts'],
    testNamePattern: process.env.AGENTMUX_MEMBER_ACCESS_CASES ?? 'scopes actor grants|releases only stale grant routing|carries unchanged member decisions|continues grants across a Connection alias|carries exact|does not carry a member decision|keeps exact public bind and relink usable|preserves saved member decisions|keeps one exact grant head', fileParallelism: false, passWithNoTests: false }
})
