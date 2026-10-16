import base from './vitest.a2a-message-data.config.mts'
import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const mutants = {
  mainOwner: ['apps/desktop/src/main/ipc.ts',
    'callOriginalCore: (hostId, method, params, context) => args.runtime.callOriginalCore(hostId, method, params, context),', ''],
  caller: ['apps/desktop/src/main/desktop-host.ts',
    '...(context.caller ? { credentials: context.caller } : {}),', ''],
  messageId: ['packages/core/src/public-rpc-service.ts',
    'messageId: original?.envelope.messageId ?? messageId,', "messageId: 'replacement-message',"],
  sourceConflict: ['packages/core/src/agent-global-message-queue.ts',
    'existing.sourceChannel === sourceChannel &&', 'true &&'],
  freshDevice: ['packages/core/src/public-rpc-service.ts',
    'const observedDevice = this.ports.operationSource?.(context)', 'const observedDevice = undefined']
} as const
const mutation = process.env.AGENTMUX_TEST_ORIGINAL_SEND_MUTATION as keyof typeof mutants | undefined
assert.ok(!mutation || Object.hasOwn(mutants, mutation), 'Select an existing original public-send mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), ...(mutation ? [{
  name: 'original-public-send-mutation', enforce: 'pre' as const, transform(source: string, id: string) {
    const [file, before, after] = mutants[mutation]
    if (!id.endsWith('/' + file)) return
    assert.equal(source.split(before).length, 2, 'Exactly one imported product mutation anchor: ' + mutation)
    const changed = source.replace(before, after)
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_ORIGINAL_SEND_MUTATION_RECEIPT) appendFileSync(process.env.AGENTMUX_ORIGINAL_SEND_MUTATION_RECEIPT,
      JSON.stringify({ mutation, file, before: sha256(source), after: sha256(changed) }) + '\n')
    return changed
  }
}] : [])], test: { ...base.test, include: ['apps/desktop/test/desktop-agent-send-origin.test.tsx'] } })
