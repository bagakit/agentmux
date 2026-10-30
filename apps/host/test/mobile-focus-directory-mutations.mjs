import { createHash } from 'node:crypto'

export const focusDirectoryMutations = {
  'focus-order': ['packages/client-ui/src/lib/focus-order.ts', '  return [...rows].sort((a, b) => {', '  return [...rows]; return [...rows].sort((a, b) => {'],
  'focus-owner': ['apps/host/src/spatial-presentation.ts', 'const originalObject = objects.length === 1 ? objects[0] : undefined', 'const originalObject = undefined'],
  'focus-activity': ['apps/host/src/spatial-presentation.ts', 'const lastActivityAt = focusLastTaskActivityAt(timeline?.items ?? [], entered)', 'const lastActivityAt = original?.updatedAt ?? null']
}
const observed = new Set(['packages/client-ui/src/lib/focus-order.ts', 'apps/host/src/spatial-presentation.ts',
  'apps/host/src/mote-resources.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/space-control-parser.ts',
  'apps/mobile/src/navigation/MobileSpatialNavigation.tsx'])

export function instrumentFocusDirectorySource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.MOBILE_FOCUS_DIRECTORY_MUTANT
  if (mutant && !Object.hasOwn(focusDirectoryMutations, mutant)) throw Error('Unknown bounded Focus directory mutation')
  if (mutant && focusDirectoryMutations[mutant][0] === path) {
    const [, anchor, replacement] = focusDirectoryMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Focus mutation must match one actual implementation: ' + mutant)
    source = source.replace(anchor, replacement)
  }
  const report = process.env.MOBILE_FOCUS_DIRECTORY_LOADED
  if (report) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __focusDirectoryEvaluated } from 'node:fs'; __focusDirectoryEvaluated(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
