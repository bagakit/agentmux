import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './relay-carrier.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.SHORT_LINK_HELLO_MUTATION
const variants = {
  'skip-hello-host': { path: 'packages/core/src/relay-hosted.ts', from: 'if (result.hostId !== this.hostId) throw protocol()', to: 'void result; void this.hostId', pattern: 'foreign encrypted hello Host' },
  'skip-rpc-hello-host': { path: 'packages/core/src/public-rpc-client.ts', from: "if (method === 'device.hello' && this.endpoint.transport === 'relay' &&", to: "if (false && method === 'device.hello' && this.endpoint.transport === 'relay' &&", pattern: 'raw RPC hello refuses a foreign Host' }
} as const
if (mutation && !(mutation in variants)) throw Error('Unknown hello subject mutant')
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/relay-host-identity-cache', mutation ?? 'normal'),
  plugins: [...base.plugins!, { name: 'original-hello-host-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/relay-hosted.ts', 'packages/core/src/public-rpc-client.ts'].includes(path)) return
    const variant = mutation ? variants[mutation as keyof typeof variants] : undefined
    if (variant?.path === path && original.split(variant.from).length !== 2) throw Error('Hello host mutant must match the actual owner once')
    const code = variant?.path === path ? original.replace(variant.from, variant.to) : original
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.SHORT_LINK_HELLO_LOADED) appendFileSync(process.env.SHORT_LINK_HELLO_LOADED, JSON.stringify({ path, originalSHA256: digest(original), loadedSHA256: digest(code), mutation: mutation ?? null }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['packages/core/test/relay-host-identity.test.ts'],
    environmentMatchGlobs: [], ...(mutation ? { testNamePattern: variants[mutation as keyof typeof variants].pattern } : {}) }
})
