import base from './connection-owner-consumer.config.mts'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'action-source-lost': ['apps/host/src/external-input-authority.ts',
    'const ingress = await sourceIngress(author.authoritySource)', 'const ingress = await options.ingress()'],
  'action-fence-lost': ['packages/connectors/src/core-ingress-port.ts',
    "return fence ? await invoke('respondAgentInteraction', [input], fence) : await client.respondAgentInteraction(input)", 'return await client.respondAgentInteraction(input)'],
  'action-recovery-lost': ['packages/connectors/src/durable-ingress.ts',
    '...this.permissions.recoveryCandidates(connectionId, Number(after?.sequence ?? 0), limit + 1)', '...[]'],
  'action-recovery-index-lost': ['packages/connectors/src/conversation-actions.ts',
    '=+work.operation_id', '=work.operation_id'],
  'saved-action-replayed': ['packages/connectors/src/durable-ingress.ts',
    'if (observed.started) { this.permissions.executionObserved(input.operationId); return observed.inspection }', 'if (false) { this.permissions.executionObserved(input.operationId); return observed.inspection }']
} as const
const mutant = process.env.EXTERNAL_ACTION_MUTANT as keyof typeof variants | undefined
if (mutant && !variants[mutant]) throw Error('Unknown external action mutation')
export default { ...base, plugins: [{ name: 'external-action-owning-mutation', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!mutant || variants[mutant][0] !== path) return
    const [, before, after] = variants[mutant]
    const count = source.split(before).length - 1
    if (count !== (mutant === 'action-source-lost' ? 3 : 1)) throw Error('Missing exact external action mutation anchor')
    const loaded = source.replaceAll(before, after)
    const row = { path, mutant, sourceSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex') }
    return { code: (process.env.EXTERNAL_ACTION_MUTATION_TRACE ? "import { appendFileSync as __externalActionMutation } from 'node:fs'; __externalActionMutation(" + JSON.stringify(process.env.EXTERNAL_ACTION_MUTATION_TRACE) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' : '') + loaded, map: null }
  }
}, ...(base.plugins ?? [])], test: { ...base.test, include: ['apps/host/test/external-action-authority.test.ts'], testTimeout: 30_000 } }
