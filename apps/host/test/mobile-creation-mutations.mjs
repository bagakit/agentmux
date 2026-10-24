import { createHash } from 'node:crypto'
export const creationMutations = {
  'creation-route': ['packages/core/src/public-rpc-service.ts', '&& !(this.ports.spatialAgentControl && independentSpatial)', '&& !(false && this.ports.spatialAgentControl && independentSpatial)'],
  'creation-association': ['packages/core/src/spatial-agent-open.ts', 'original.requests = Object.fromEntries([...Object.entries(original.requests), [record.requestId, record]])', 'void record'],
  'creation-session': ['packages/core/src/spatial-agent-open.ts', 'previous.agentSessionId !== input.agentSessionId || ', ''],
  'creation-admission-device': ['apps/host/src/spatial-agent-control.ts', 'context.signal?.throwIfAborted(); await context.assertCurrent?.()\n    const admission', 'const admission'],
  'creation-device': ['apps/host/src/spatial-agent-control.ts', 'context.signal?.throwIfAborted(); await context.assertCurrent?.()\n      await client.createAgentWithDelivery', 'await client.createAgentWithDelivery'],
  'creation-continue': ['apps/host/src/spatial-agent-control.ts', "if (observed.agent || observed.outcome === 'retired')", 'if (true)'],
  'creation-foreign-owner': ['packages/core/src/spatial-agent-open-contract.ts', "!graph?.zones.some(zone => zone.zoneId === destination.zoneId && zone.hostId && zone.hostId !== 'local')", 'true']
}
const observed = new Set(['packages/core/src/client.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/spatial-state.ts', 'packages/core/src/spatial-agent-open.ts',
  'packages/core/src/spatial-agent-open-contract.ts', 'packages/core/src/spatial-destination.ts', 'apps/host/src/mote-resources.ts',
  'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/host/src/spatial-agent-control.ts', 'apps/host/src/host.ts', 'apps/mobile/src/navigation/MobileAgentCreate.tsx', 'apps/mobile/src/recovery/agent-create-intents.ts'])
export function instrumentCreationSource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.HEADLESS_MOBILE_CREATION_MUTANT
  if (process.env.HEADLESS_MOBILE_CREATION_CRASH_PROOF === '1' && path === 'apps/host/src/spatial-agent-control.ts') {
    const anchor = "    const admission = await options.spatial.admitAgentOpen({ request, agentSessionId, execution, regionResource: regionDescriptor({ agentSessionId, execution }, 'launching') })"
    if (source.split(anchor).length !== 2) throw Error('The private crash seam requires the actual original spatial admission')
    source = "import { existsSync as __creationPauseExists, readFileSync as __creationPauseRead, writeFileSync as __creationPauseWrite } from 'node:fs'; import { join as __creationPausePath } from 'node:path';\n" + source.replace(anchor, anchor + `
    if (admission.admitted && process.env.AGENTMUX_STATE_DIRECTORY) {
      const pause = __creationPausePath(process.env.AGENTMUX_STATE_DIRECTORY, 'mobile-test-creation-pause')
      if (__creationPauseExists(pause) && ['*', request.requestId].includes(__creationPauseRead(pause, 'utf8'))) {
        __creationPauseWrite(__creationPausePath(process.env.AGENTMUX_STATE_DIRECTORY, 'mobile-test-creation-paused'), request.requestId)
        await new Promise(() => {})
      }
    }`)
  }
  if (mutant && !Object.hasOwn(creationMutations, mutant)) throw Error('Unknown original creation mutation')
  if (mutant && creationMutations[mutant][0] === path) {
    const [, anchor, replacement] = creationMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Creation mutation requires one evaluated original owner: ' + mutant)
    source = source.replace(anchor, replacement)
  }
  const file = process.env.HEADLESS_MOBILE_CREATION_LOADED
  if (file) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __creationEvaluated } from 'node:fs'; __creationEvaluated(" + JSON.stringify(file) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
