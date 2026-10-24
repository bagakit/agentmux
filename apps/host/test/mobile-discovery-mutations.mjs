import { createHash } from 'node:crypto'
export const discoveryMutations = {
  'discovery-route': ['packages/core/src/public-rpc-service.ts', "if (this.ports.spatialState && (method === 'space.ls' || method === 'space.inspect'))", "if (context.transport !== 'relay' && this.ports.spatialState && (method === 'space.ls' || method === 'space.inspect'))"],
  'discovery-name': ['apps/host/src/spatial-presentation.ts', 'userName: label, firstPrompt:', 'userName: null, firstPrompt:'],
  'discovery-scope': ['apps/host/src/spatial-presentation.ts', 'for (const region of catalog.regions)', 'for (const region of graph.regions)']
}
const observed = new Set(['packages/core/src/public-rpc-service.ts', 'apps/host/src/host.ts', 'apps/host/src/spatial-presentation.ts', 'apps/host/src/presentation-configuration.ts', 'apps/host/src/snapshot-observation.ts', 'packages/client-ui/src/lib/display-name.ts', 'packages/client-ui/src/lib/conversation-recap.ts', 'packages/client-ui/src/lib/agent-presentation.ts'])
export function instrumentDiscoverySource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.HEADLESS_MOBILE_DISCOVERY_MUTANT
  if (mutant && !Object.hasOwn(discoveryMutations, mutant)) throw Error('Unknown original discovery mutation')
  if (mutant && discoveryMutations[mutant][0] === path) {
    const [, anchor, replacement] = discoveryMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Discovery mutation requires one evaluated original owner: ' + mutant)
    source = source.replace(anchor, replacement)
  }
  const file = process.env.HEADLESS_MOBILE_DISCOVERY_LOADED
  if (file) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    // Record actual evaluation; a collected but unexecuted source cannot prove a mutation.
    source = "import { appendFileSync as __discoveryEvaluated } from 'node:fs'; __discoveryEvaluated(" + JSON.stringify(file) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
