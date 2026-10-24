import { createHash } from 'node:crypto'
export const contentMutations = {
  'shared-scope': ['apps/host/src/content-owner.ts', 'complete: workspaces.length === (raw as { workspaces: unknown[] }).workspaces.length', 'complete: true'],
  'content-owner': ['apps/host/src/host.ts', 'const content = configurationPath ? createHostContent({ configurationPath, spatial: spatialState }) : undefined', 'const content = undefined'],
  'note-history-owner': ['apps/host/src/content-owner.ts', 'actual => writer.write(actual, input, context)', 'actual => files.write(actual, input, context)']
}
const observed = new Set(['apps/host/src/host.ts', 'apps/host/src/content-owner.ts', 'apps/host/src/note-file-writer.ts', 'apps/host/src/note-resource-write.ts', 'apps/host/src/topic-knowledge.ts', 'apps/host/src/topic-spatial-owner.ts'])
export function instrumentContentSource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.MOBILE_CONTENT_TEST_MUTANT
  if (mutant && !Object.hasOwn(contentMutations, mutant)) throw Error('Unknown content-owner mutation')
  if (mutant && contentMutations[mutant][0] === path) {
    const [, anchor, replacement] = contentMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Content mutation requires one original implementation anchor')
    source = source.replace(anchor, replacement)
  }
  const report = process.env.MOBILE_CONTENT_TEST_LOADED
  if (report) {
    const hash = text => createHash('sha256').update(text).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __contentEvaluated } from 'node:fs'; __contentEvaluated(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
