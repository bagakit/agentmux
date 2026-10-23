import originalOwner from './connection-owner-consumer.config.mts'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'wrong-hosting-runtime': ['apps/host/src/connections.ts', 'return { hostingRuntimeId, executionRuntimeId: expectedRuntimeId }', 'return { hostingRuntimeId: expectedRuntimeId, executionRuntimeId: expectedRuntimeId }'],
  'wrong-execution-runtime-accepted': ['apps/host/src/external-input-authority.ts', 'if (source && source.executionRuntimeId !== runtimeId) throw unavailable()', 'if (false) throw unavailable()'],
  'revoked-grant-accepted': ['apps/host/src/external-input-authority.ts', "if (result.authority !== 'current') {", 'if (false) {'],
  'final-destination-fence-lost': ['packages/connectors/src/core-ingress-port.ts',
    "const response = await client.forwardRpc!('runtime.invoke', { consumerId, fence,\n        invocation: encodeHostedValue({ method, args }) as import('@agentmux/core/hosted').AgentMuxHostedInvocation }, {}, fence)\n      return decodeHostedValue(response.value) as T",
    'return await (client[method] as (...args: unknown[]) => Promise<T>)(...args)']
} as const
const mutant = process.env.CROSS_HOST_MUTANT as keyof typeof variants | undefined
if (mutant && !variants[mutant]) throw Error('Unknown cross-Host authority mutation')

// The original actual-Host harness resolves the complete Core and connector
// owners to this tree and records executed module identities, never a mock barrel.
export default { ...originalOwner, plugins: [{ name: 'cross-host-owning-mutation', enforce: 'pre' as const,
  transform(original: string, id: string) {
    if (!mutant) return
    const [path, before, after] = variants[mutant]
    if (relative(root, id.split('?')[0]!) !== path) return
    if (original.split(before).length !== 2) throw Error('Cross-Host mutation must match one original owning expression')
    return { code: original.replace(before, after), map: null }
  }
}, ...(originalOwner.plugins ?? [])], test: { ...originalOwner.test,
  include: ['apps/host/test/cross-host-authority.test.ts'], testTimeout: 35_000 } }
