import { diffArrays } from 'diff'
import { Fragment, Mark, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Step } from '@tiptap/pm/transform'

export type NoteSnapshotTransaction = { status: 'unchanged' } | { status: 'ready'; transaction: Transaction } | { status: 'failed'; message: string }
type Unit = { node: ProseMirrorNode; text?: string }
const size = (unit: Unit) => unit.text === undefined ? unit.node.nodeSize : unit.text.length
const identity = (node: ProseMirrorNode): string | null => typeof node.attrs.blockId === 'string' && node.attrs.blockId ? 'block:' + node.attrs.blockId
  : typeof node.attrs.referenceId === 'string' && node.attrs.referenceId ? 'reference:' + node.attrs.referenceId : null

/** A confirmed target is mapped into the existing PM state; no Editor, history or draft owner is replaced. */
export function noteSnapshotTransaction(state: EditorState, target: ProseMirrorNode): NoteSnapshotTransaction {
  if (state.doc.eq(target)) return { status: 'unchanged' }
  try {
    if (target.type.schema !== state.schema || target.type !== state.doc.type) throw Error('The incoming document uses another editor schema.')
    target.check()
    const tr = state.tr
    const descendants = new WeakMap<ProseMirrorNode, Set<string>>()
    const ids = (node: ProseMirrorNode): Set<string> => {
      let found = descendants.get(node)
      if (!found) { found = new Set(); const own = identity(node); if (own) found.add(own); node.forEach(child => { for (const id of ids(child)) found!.add(id) }); descendants.set(node, found) }
      return found
    }
    const payload = new WeakMap<ProseMirrorNode, string>()
    const semantic = (node: ProseMirrorNode): string => {
      let value = payload.get(node)
      if (value === undefined) {
        const json = structuredClone(node.toJSON())
        const strip = (node: typeof json) => { if (node.attrs) { delete node.attrs.blockId; delete node.attrs.provenance }; node.content?.forEach(strip) }
        strip(json); value = JSON.stringify(json); payload.set(node, value)
      }
      return value
    }
    const aligned = (a: ProseMirrorNode, b: ProseMirrorNode): boolean => {
      if (a.eq(b)) return true
      const left = identity(a), right = identity(b)
      if (left && right) return left === right
      if (a.type !== b.type) return false
      // Canonical identity allocation is metadata, not deletion of a human's paragraph.
      if (left || right) return semantic(a) === semantic(b)
      const leftIds = ids(a), rightIds = ids(b)
      for (const id of leftIds) if (rightIds.has(id)) return true
      return semantic(a) === semantic(b)
    }
    const units = (parent: ProseMirrorNode): Unit[] => {
      const result: Unit[] = []
      parent.forEach(node => {
        if (parent.inlineContent && node.isText) for (const text of node.text!) result.push({ node, text })
        else result.push({ node })
      })
      return result
    }
    const fragment = (values: Unit[]): Fragment => {
      const nodes: ProseMirrorNode[] = []; let text: string[] = [], marks: readonly Mark[] = []
      const flush = () => { if (text.length) { nodes.push(state.schema.text(text.join(''), marks)); text = [] } }
      for (const unit of values) {
        if (unit.text === undefined) { flush(); nodes.push(unit.node) }
        else { if (!Mark.sameSet(marks, unit.node.marks)) flush(); marks = unit.node.marks; text.push(unit.text) }
      }
      flush(); return Fragment.fromArray(nodes)
    }
    const marks = (from: number, length: number, old: readonly Mark[], next: readonly Mark[]) => {
      for (const mark of old) if (!mark.isInSet(next)) tr.removeMark(from, from + length, mark)
      for (const mark of next) if (!mark.isInSet(old)) tr.addMark(from, from + length, mark)
    }
    const sync = (position: number, next: ProseMirrorNode): void => {
      let current = position < 0 ? tr.doc : tr.doc.nodeAt(position)
      if (!current) throw Error('The original block position is no longer present.')
      if (current.eq(next)) return
      if (current.type !== next.type) {
        if (position < 0) throw Error('The incoming document root changed.')
        if (!next.type.validContent(current.content)) { tr.replaceWith(position, position + current.nodeSize, next); return }
        tr.setNodeMarkup(position, next.type, next.attrs, next.marks)
        current = tr.doc.nodeAt(position)!
      }
      for (const name of Object.keys(next.attrs)) {
        if (current.hasMarkup(current.type, { ...current.attrs, [name]: next.attrs[name] }, current.marks)) continue
        if (position < 0) tr.setDocAttribute(name, next.attrs[name]); else tr.setNodeAttribute(position, name, next.attrs[name])
        current = position < 0 ? tr.doc : tr.doc.nodeAt(position)!
      }
      if (!Mark.sameSet(current.marks, next.marks) && position >= 0) {
        for (const mark of current.marks) if (!mark.isInSet(next.marks)) tr.removeNodeMark(position, mark)
        for (const mark of next.marks) if (!mark.isInSet(current.marks)) tr.addNodeMark(position, mark)
      }
      const before = units(current), after = units(next)
      // A node type alone is not paragraph identity: deleting an anonymous
      // paragraph must not shift every following human edit into its neighbour.
      const anonymous = (node: ProseMirrorNode) => !identity(node) && !ids(node).size
      if (!current.inlineContent && [...before, ...after].some(unit => anonymous(unit.node))) {
        const counts = (values: Unit[]) => {
          const result = new Map<string, number>()
          for (const { node } of values) { const key = semantic(node); result.set(key, (result.get(key) ?? 0) + 1) }
          return result
        }
        const oldCounts = counts(before), newCounts = counts(after)
        const anonymousKeys = new Set([...before, ...after].filter(unit => anonymous(unit.node)).map(unit => semantic(unit.node)))
        for (const key of anonymousKeys) {
          const oldCount = oldCounts.get(key) ?? 0, newCount = newCounts.get(key) ?? 0
          if (Math.max(oldCount, newCount) > 1 && oldCount !== newCount) throw Error('Repeated unanchored blocks have no unique mapping. The incoming document is retained for review.')
        }
      }
      // Completely disjoint text cannot contain a caret/history anchor. Avoid
      // Myers's quadratic search for a shared character which is known absent.
      const textOnly = before.every(unit => unit.text !== undefined) && after.every(unit => unit.text !== undefined)
      const characters = textOnly ? new Set(before.map(unit => unit.text)) : null
      const disjoint = characters && !after.some(unit => characters.has(unit.text))
      const changes = disjoint
        ? [{ count: before.length, removed: true, added: false, value: before }, { count: after.length, added: true, removed: false, value: after }]
        : diffArrays(before, after, { comparator: (a, b) => a.text !== undefined || b.text !== undefined ? a.text === b.text : aligned(a.node, b.node) })
      if (!current.inlineContent) {
        const deleted = changes.filter(part => part.removed).flatMap(part => part.value.map(unit => unit.node))
        const inserted = changes.filter(part => part.added).flatMap(part => part.value.map(unit => unit.node))
        const deletedIds = new Set(deleted.flatMap(node => [...ids(node)]))
        const movedId = inserted.some(node => [...ids(node)].some(id => deletedIds.has(id)))
        const deletedAnonymous = new Set(deleted.filter(anonymous).map(semantic)), insertedAnonymous = new Set(inserted.filter(anonymous).map(semantic))
        const movedText = inserted.some(node => deletedAnonymous.has(semantic(node))) || deleted.some(node => insertedAnonymous.has(semantic(node)))
        if (movedId || movedText) throw Error('Blocks moved or changed containers without a history-preserving mapping. The incoming document is retained for review.')
      }
      let oldIndex = 0, newIndex = 0, cursor = position + 1
      for (let i = 0; i < changes.length;) {
        const change = changes[i]!
        if (!change.added && !change.removed) {
          for (let n = 0; n < change.count;) {
            const a = before[oldIndex]!, b = after[newIndex]!
            if (b.text !== undefined) {
              let length = 0
              do { length += size(after[newIndex]!); oldIndex++; newIndex++; n++ }
              while (n < change.count && after[newIndex]!.text !== undefined && Mark.sameSet(a.node.marks, before[oldIndex]!.node.marks) && Mark.sameSet(b.node.marks, after[newIndex]!.node.marks))
              marks(cursor, length, a.node.marks, b.node.marks); cursor += length
            } else { oldIndex++; newIndex++; n++; sync(cursor, b.node); cursor += size(b) }
          }
          i++; continue
        }
        let removed = 0; const added: Unit[] = [], removedUnits: Unit[] = []
        while (i < changes.length && (changes[i]!.added || changes[i]!.removed)) {
          const part = changes[i++]!
          if (part.removed) for (let n = 0; n < part.count; n++) { const unit = before[oldIndex++]!; removed += size(unit); removedUnits.push(unit) }
          else for (let n = 0; n < part.count; n++) added.push(after[newIndex++]!)
        }
        if (!current.inlineContent && removedUnits.length && added.length && (removedUnits.some(unit => anonymous(unit.node)) || added.some(unit => anonymous(unit.node)))) {
          if (removedUnits.length !== added.length || removedUnits.some((unit, index) => unit.node.type !== added[index]!.node.type || !(anonymous(unit.node) && anonymous(added[index]!.node) || aligned(unit.node, added[index]!.node)))) throw Error('Unanchored blocks changed structure without a unique content match. The incoming document is retained for review.')
          for (const unit of added) { sync(cursor, unit.node); cursor += size(unit) }
          continue
        }
        const insert = fragment(added)
        tr.replaceWith(cursor, cursor + removed, insert)
        cursor += insert.size
      }
    }
    sync(-1, target)
    return finishSnapshotTransaction(state, target, tr)
  } catch (error) {
    return { status: 'failed', message: 'The incoming update is waiting; your current input is kept. ' + (error instanceof Error ? error.message : String(error)) }
  }
}


/** Decode worker-produced steps only against this exact live editor schema. */
export function noteSnapshotSteps(state: EditorState, target: ProseMirrorNode, steps: readonly unknown[]): NoteSnapshotTransaction {
  try {
    const tr = state.tr
    for (const json of steps) tr.step(Step.fromJSON(state.schema, json))
    return finishSnapshotTransaction(state, target, tr)
  } catch (error) {
    return { status: 'failed', message: 'The incoming update is waiting; your current input is kept. ' + (error instanceof Error ? error.message : String(error)) }
  }
}
function finishSnapshotTransaction(state: EditorState, target: ProseMirrorNode, tr: Transaction): NoteSnapshotTransaction {
  if (!tr.doc.eq(target)) throw Error('The mapped document differs from the confirmed incoming document.')
  const selection = state.selection.getBookmark().map(tr.mapping).resolve(tr.doc)
  tr.setSelection(selection)
  if (state.storedMarks) tr.setStoredMarks(selection.$from.parent.type.allowedMarks(state.storedMarks))
  return { status: 'ready', transaction: tr.setMeta('addToHistory', false).setMeta('noteSelectionRestore', true).setMeta('noteRemoteSnapshot', true).setMeta('preventUpdate', true) }
}
