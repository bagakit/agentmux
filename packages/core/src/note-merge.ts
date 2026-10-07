import { diffArrays } from 'diff'
import { diff3Merge, type IDiffIndicesResult } from 'node-diff3'

/** Adapt maintained Myers edits to diff3's exact region contract, without fuzzy matching. */
function myersIndices<T>(before: T[], after: T[]): IDiffIndicesResult<T>[] {
  const result: IDiffIndicesResult<T>[] = []
  let oldOffset = 0, newOffset = 0, pending: IDiffIndicesResult<T> | undefined
  const complete = (region: IDiffIndicesResult<T>) => {
    region.buffer1Content = before.slice(region.buffer1[0], region.buffer1[0] + region.buffer1[1])
    region.buffer2Content = after.slice(region.buffer2[0], region.buffer2[0] + region.buffer2[1])
    result.push(region)
  }
  for (const change of diffArrays(before, after)) {
    if (!change.added && !change.removed) {
      if (pending) { complete(pending); pending = undefined }
      oldOffset += change.count; newOffset += change.count
    } else {
      pending ??= { buffer1: [oldOffset, 0], buffer2: [newOffset, 0], buffer1Content: [], buffer2Content: [] }
      if (change.removed) { pending.buffer1[1] += change.count; oldOffset += change.count }
      else { pending.buffer2[1] += change.count; newOffset += change.count }
    }
  }
  if (pending) complete(pending)
  return result
}

export type NoteTextMerge = { status: 'merged'; content: string } | { status: 'conflict' }
/** Exact line buffers retain every separator. Upstream diff3 owns overlap and false-conflict semantics. */
export function mergeNoteText(base: string, current: string, proposed: string): NoteTextMerge {
  if (current === base || current === proposed) return { status: 'merged', content: proposed }
  if (proposed === base) return { status: 'merged', content: current }
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  const regions = diff3Merge(lines(current), lines(base), lines(proposed), { excludeFalseConflicts: true, diffIndices: myersIndices })
  if (regions.some(region => region.conflict)) return { status: 'conflict' }
  return { status: 'merged', content: regions.flatMap(region => region.ok ?? []).join('') }
}
