import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_ADAPTER_SERVICE_MUTATION
if (mutation && mutation !== 'ignore-adapter-policy') throw Error('Unknown adapter service mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/adapter-service'),
  plugins: [{ name: 'original-adapter-service-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/connectors/src/') && !path.startsWith('packages/core/dist/')) return
    if (!/\.(?:ts|js)$/u.test(path)) return
    let code = source
    if (mutation && path === 'packages/connectors/src/connection-host.ts') {
      const anchor = 'return this.readService().enabled && this.readService({ adapterId }).enabled'
      if (source.split(anchor).length !== 2) throw Error('Expected one original adapter traffic qualification')
      code = source.replace(anchor, 'return this.readService().enabled')
    }
    const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
    if (process.env.AGENTMUX_ADAPTER_SERVICE_LOADED) appendFileSync(process.env.AGENTMUX_ADAPTER_SERVICE_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: code === source ? null : mutation }) + '\n')
    return source === code ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['packages/core/test/connection-service-scopes.test.ts', 'packages/connectors/test/connection-service-public-consumer.test.ts', 'packages/connectors/test/mote-chat-owner.test.ts'],
    testNamePattern: process.env.AGENTMUX_ADAPTER_SERVICE_CASES ?? 'strict scoped service|scoped adapter policy|scoped private chat|shares strict policy CAS|settles a late authoritative publication ACK|recovers a committed|after asynchronous authentication before durable', fileParallelism: false, passWithNoTests: false }
})
