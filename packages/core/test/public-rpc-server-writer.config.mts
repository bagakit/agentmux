import base from './control-admission-burst.config.mts'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..'), file = resolve(root, 'packages/core/src/public-rpc-server.ts')
const mutation = process.env.AGENTMUX_SERVER_WRITER_MUTATION
const rewrites = {
  'ignore-drain': ['if (!ready && current) return', 'if (false) return'],
  'aggregate-refusal': ['const encoded = encode(entry.frame)', 'const encoded = encode(entry.frame)\n        if (output.writableLength + Buffer.byteLength(encoded) > AGENTMUX_RPC_MAX_MESSAGE_BYTES) { fail(); return }'],
  'forget-waiters': ['for (const entry of pending) entry.resolve()', 'for (const entry of [] as Write[]) entry.resolve()'],
  'parse-error-bypass': ["void writer.send(createJSONRPCErrorResponse(null, -32700, 'Invalid JSON RPC frame.'), true)", "socket.end(rpcEncode(createJSONRPCErrorResponse(null, -32700, 'Invalid JSON RPC frame.')))"]
} as const
if (mutation && !Object.hasOwn(rewrites, mutation)) throw new Error('Unknown server writer mutation')
export default { ...base, plugins: [{ name: 'original-server-writer', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.split('?')[0] !== file) return
    let loaded = source
    if (mutation) { const [from, to] = rewrites[mutation as keyof typeof rewrites]
      if (source.split(from).length !== 2) throw new Error('Server writer mutation needs one exact source anchor')
      loaded = source.replace(from, to)
    }
    if (process.env.AGENTMUX_SERVER_WRITER_LOADED) writeFileSync(process.env.AGENTMUX_SERVER_WRITER_LOADED, JSON.stringify({ file, mutation: mutation ?? null,
      sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }))
    return loaded === source ? undefined : { code: loaded, map: null }
  } }], test: { ...base.test, include: ['packages/core/test/public-rpc-server-writer.test.ts'], testTimeout: 15_000,
    ...(process.env.AGENTMUX_SERVER_WRITER_CASE ? { testNamePattern: process.env.AGENTMUX_SERVER_WRITER_CASE } : {}), passWithNoTests: false } }
