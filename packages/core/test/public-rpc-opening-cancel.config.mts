import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './relay-carrier.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.RPC_OPENING_CANCEL_MUTATION, trace = process.env.RPC_OPENING_CANCEL_LOADED
const variants = {
  'skip-client-stream-cancel': { file: 'packages/core/src/public-rpc-client.ts',
    from: 'opening = route.unix.open(payload, receive, end, controller.signal, () => { sharedDispatch = \'dispatched\'; armDeadline() }, { cancelOpening: true })',
    to: 'opening = route.unix.open(payload, receive, end, controller.signal, () => { sharedDispatch = \'dispatched\'; armDeadline() }, { cancelOpening: handlers === undefined })' },
  'skip-service-opening-signal': { file: 'packages/core/src/public-rpc-server.ts',
    from: '...(openingStream ? { signal: openingSignal } : {})', to: '...{}' }
} as const
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown original opening cancellation mutation')
const variant = mutation ? variants[mutation as keyof typeof variants] : undefined
const owners = new Set(['packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts',
  'packages/core/src/rpc-stream-transport.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/test/hosted-metadata-opening.test.ts', 'packages/core/test/rpc-stream-writer.test.ts',
  'packages/core/test/public-rpc-transports.test.ts'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/hosted-exact-first-read/opening-cancel-cache', mutation ?? 'baseline'),
  plugins: [...base.plugins ?? [], { name: 'actual-public-opening-cancellation', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (variant?.file === file) {
      if (code.split(variant.from).length !== 2) throw Error('One current original opening cancellation anchor is required')
      code = code.replace(variant.from, variant.to)
    }
    if (!trace) return code === source ? undefined : { code, map: null }
    const row = { file, mutation: code === source ? null : mutation, sourceSHA256: sha(source), loadedSHA256: sha(code) }
    return code + `\nimport{appendFileSync as __openingCancelTrace}from'node:fs';__openingCancelTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify(row)+'\n')});\n`
  } }], test: { ...base.test, include: ['packages/core/test/hosted-metadata-opening.test.ts', 'packages/core/test/rpc-stream-writer.test.ts',
    'packages/core/test/public-rpc-transports.test.ts'],
    testNamePattern: variant ? 'cancels an actual Unix opening promptly' : 'cancels an actual Unix opening promptly|cancels only the original pending Unix stream|slow writable preserves|cancelling a queued reader|cancelling before transport readiness|dispatched opening cancellation|preserves an admitted finite layout write|treats unknown and settled opening-cancel|real SSH finite dispatched cancellation observes the outbound opening-cancel: \'control\'',
    environmentMatchGlobs: [], maxWorkers: 1, fileParallelism: false, testTimeout: 20_000, hookTimeout: 20_000, passWithNoTests: false } })
