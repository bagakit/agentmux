import { createHash } from 'node:crypto'
export const workspaceMutations = {
  'settings-route': ['packages/core/src/public-rpc-service.ts', "if (originalControlOperation === 'settings.resource.list' || originalControlOperation === 'settings.resource.get')", "if (context.transport !== 'relay' && (originalControlOperation === 'settings.resource.list' || originalControlOperation === 'settings.resource.get'))"],
  'appearance-publication': ['apps/host/src/host-appearance.ts', 'if (previous) listener?.(next, previous)', 'if (false && previous) listener?.(next, previous)']
}
const observed = new Set(['packages/core/src/public-rpc-service.ts', 'apps/host/src/host.ts', 'apps/host/src/settings-resource-read.ts', 'apps/host/src/host-appearance.ts', 'apps/host/src/theme-observation.ts', 'apps/mobile/src/appearance/useHostAppearance.ts', 'apps/mobile/src/conversation/use-mobile-commands.ts'])
export function instrumentWorkspaceSource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.HEADLESS_MOBILE_WORKSPACE_MUTANT
  if (mutant && !Object.hasOwn(workspaceMutations, mutant)) throw Error('Unknown original workspace mutation')
  if (mutant && workspaceMutations[mutant][0] === path) {
    const [, anchor, replacement] = workspaceMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Workspace mutation requires one evaluated original owner: ' + mutant)
    source = source.replace(anchor, replacement)
  }
  const file = process.env.HEADLESS_MOBILE_WORKSPACE_LOADED
  if (file) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __workspaceEvaluated } from 'node:fs'; __workspaceEvaluated(" + JSON.stringify(file) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
