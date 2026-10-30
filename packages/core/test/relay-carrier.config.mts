import { defineConfig } from 'vitest/config'
import { buildSync } from 'esbuild'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import base from './mobile-terminal-coalescing.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const listener = resolve(root, '.tmp/relay-carrier-listener.mjs')
buildSync({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
process.env.HOST_LIFECYCLE_LISTENER_ENTRY = listener
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import', JSON.stringify(resolve(root, 'apps/host/test/host-lifecycle-recovery-node-loader.mjs'))].filter(Boolean).join(' ')

const leaf = 'packages/core/src/public-rpc-relay.ts'
export const carrierVariants = {
  reopen: { path: leaf, from: '!stream && idle ? idle : createCarrier()', to: 'false && !stream && idle ? idle : createCarrier()', pattern: 'reuses sequential finite' },
  'borrow-busy': { path: leaf, from: '!stream && idle ? idle : createCarrier()', to: '(!stream && idle ? idle : (!stream ? [...carriers].find(value => value.lease && !value.lease.stream) : undefined)) ?? createCarrier()', pattern: 'held native ACK' },
  'early-idle': { path: leaf, from: 'lease.complete = !lease.stream', to: 'lease.complete = !lease.stream; if (lease.complete) idle = carrier', pattern: 'actual reader release' },
  'loose-reply': { path: leaf, from: 'if (parseRpcResponse(frame).id !== lease.request.id)', to: 'if (false)', pattern: 'rejects foreign-id|rejects partial-envelope' },
  'cancel-peer': { path: leaf, from: 'if (!lease.complete) close(carrier, cancelled())', to: 'if (!lease.complete) { for (const peer of carriers) close(peer, cancelled()) }', pattern: 'pending cancellation reaches' },
  'dispose-idle-leak': { path: 'packages/core/src/relay-hosted.ts', from: 'try { rpc.dispose() }', to: 'try { void rpc }', pattern: 'held native ACK' },
  'callback-stops-cleanup': { path: 'packages/core/src/relay-hosted.ts', from: 'try { abort() } catch (error) { errors.push(error) }', to: 'abort()', pattern: 'original Hosted stream callback failure' },
  'leaf-callback-stops-cleanup': { path: leaf, from: 'try { close(carrier, cancelled()) } catch (error) { errors.push(error) }', to: 'close(carrier, cancelled())', pattern: 'leaf callback failure' },
  'retain-extra-idle': { path: leaf, from: 'carrier.socket.readyState === WebSocket.OPEN && !idle', to: 'carrier.socket.readyState === WebSocket.OPEN', pattern: 'held native ACK' }
} as const
const mutation = process.env.HOST_RELAY_CARRIER_MUTATION as keyof typeof carrierVariants | undefined
if (mutation && !carrierVariants[mutation]) throw Error('Unknown carrier source mutant')
const baseline = process.env.HOST_RELAY_CARRIER_BASELINE
if (baseline && !/^[a-f0-9]{40}$/u.test(baseline)) throw Error('Original baseline must name an immutable commit')
const baselineFiles = new Set([leaf, 'packages/core/src/public-rpc-client.ts', 'packages/core/src/relay-hosted.ts'])
const instrument = { name: 'actual-exclusive-relay-source', enforce: 'pre' as const, transform(original: string, id: string) {
  const path = relative(root, id.split('?')[0]!)
  let code = original
  const selected = mutation && carrierVariants[mutation]
  if (baseline && baselineFiles.has(path)) code = execFileSync('git', ['show', baseline + ':' + path], { cwd: root, encoding: 'utf8' })
  if (selected && path === selected.path) {
    if (original.split(selected.from).length !== 2) throw Error('Carrier mutant must replace one exact production expression: ' + mutation)
    code = original.replace(selected.from, selected.to)
  }
  const loaded = process.env.AGENTMUX_RELAY_INPUT_LOADED
  if (loaded && code !== original) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(loaded, JSON.stringify({ path, originalSHA256: hash(original), servedSHA256: hash(code),
      ...(mutation ? { mutation } : { baseline }) }) + '\n')
  }
  return code === original ? undefined : { code, map: null }
} }

export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/relay-carrier-test-cache', mutation ?? (baseline ? 'baseline' : 'normal')),
  plugins: [...base.plugins!, instrument],
  test: { ...base.test, include: ['packages/core/test/relay-carrier.test.ts', 'packages/core/test/mobile-terminal-coalescing.test.ts',
      'apps/mobile/test/terminal-control.test.ts', 'apps/mobile/test/terminal-viewer-initial-binding.test.tsx'], environmentMatchGlobs: [['apps/mobile/test/terminal-viewer-initial-binding.test.tsx', 'happy-dom']],
    testTimeout: 30_000, hookTimeout: 20_000 }
})
