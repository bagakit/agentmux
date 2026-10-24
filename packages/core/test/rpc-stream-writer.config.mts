import { resolve } from 'node:path'
import base from './control-admission-burst.config.mts'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutation = process.env.AGENTMUX_WRITER_MUTATION
const changes = {
  'aggregate-cap': ['if (this.closed) throw this.failure!', "if (this.closed) throw this.failure!\n    if (this.carrier.input.writableLength + Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new AgentMuxError('Aggregate writer rejected valid peer.', 'CONTROL_PROTOCOL_ERROR')"],
  'ignore-drain': ['this.waitingDrain = !this.carrier.input.write(entry.encoded)', 'this.carrier.input.write(entry.encoded); this.waitingDrain = false'],
  'keep-cancelled-queued': ['if (!this.writes.delete(entry)) return', 'if (false) return'],
  'forget-close-settlement': ['for (const entry of this.writes) { entry.signal?', 'for (const entry of [] as typeof this.writes) { entry.signal?']
} as const
if (mutation && !Object.hasOwn(changes, mutation)) throw new Error('Unknown private writer mutation')
const root = resolve(import.meta.dirname, '../../..')
const file = resolve(root, 'packages/core/src/rpc-stream-transport.ts')
export default { ...base, plugins: [{ name: 'actual-rpc-writer-review', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.split('?')[0] !== file) return
    let code = source
    if (mutation) { const [from, to] = changes[mutation as keyof typeof changes]; if (source.split(from).length !== 2) throw new Error('Writer mutation anchor must match once'); code = source.replace(from, to) }
    if (process.env.AGENTMUX_WRITER_LOADED) writeFileSync(process.env.AGENTMUX_WRITER_LOADED, JSON.stringify({ path: file, mutation: mutation ?? null,
      originalSHA256: createHash('sha256').update(source).digest('hex'), evaluatedSHA256: createHash('sha256').update(code).digest('hex') }))
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['packages/core/test/rpc-stream-writer.test.ts'], passWithNoTests: false } }
