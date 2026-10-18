import type { NoteCorpusPage, NoteCorpusReference, NoteCorpusHit } from '@agentmux/core'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import { matchingNoteLinkBlocks, normalizeNoteLinkName, parseNoteWikiQuery } from '@agentmux/core/note-links'
import { noteKnowledge, parseNoteFile, resolveNoteBlock, type NoteFileDocument } from './note-knowledge.js'
import { noteContentSchema } from './note-content-schema.js'
import { noteSemanticText } from './note-wikilinks.js'

const locationKey = (resource: { workspaceId: string; path: string }) => JSON.stringify([resource.workspaceId, resource.path])
const textBlockTypes = new Set(['paragraph', 'heading', 'codeBlock', 'noteRawBlock'])

/** One original parser/index, reused by corpus outline, backlinks, graph and literal fulltext. */
export function deriveNoteCorpus(originals: readonly { resource: NoteResource; document: NoteFileDocument }[], complete: boolean, query?: string, limit = 30) {
  const knowledge = noteKnowledge(originals.map(({ resource, document }) => ({ location: { workspaceId: resource.workspaceId, path: resource.path }, document })), complete ? 'complete' : 'partial')
  complete = complete && knowledge.invalid.length === 0
  const byPath = new Map(originals.map(original => [locationKey(original.resource), original]))
  const pages: NoteCorpusPage[] = knowledge.sources.map(source => {
    const original = byPath.get(locationKey(source.location))!, parsed = parseNoteFile(original.document)
    return {
      resource: original.resource, noteId: source.note.noteId, title: source.note.title ?? null, revision: source.revision,
      ...(source.note.kind ? { kind: source.note.kind } : {}), ...(source.blockForwardings.length ? { blockForwardings: [...source.blockForwardings] } : {}),
      unanchoredBlockCount: parsed.status === 'valid' ? parsed.unanchoredBlockCount : 0,
      blocks: [...source.blocks.values()].map(block => ({
        blockId: block.blockId, type: block.content.type!,
        // Container text repeats its descendants and must not multiply the projection's size.
        text: textBlockTypes.has(block.content.type!) ? block.text : '',
        ...(block.content.type === 'heading' ? { headingLevel: Number(block.content.attrs?.level ?? 1) } : {})
      }))
    }
  })
  const byId = new Map<string, NoteCorpusPage[]>(), byTitle = new Map<string, NoteCorpusPage[]>()
  for (const page of pages) {
    const identities = byId.get(page.noteId) ?? []
    identities.push(page); byId.set(page.noteId, identities)
    if (page.title) {
      const title = normalizeNoteLinkName(page.title), names = byTitle.get(title) ?? []
      names.push(page); byTitle.set(title, names)
    }
  }
  const duplicateNoteIds = [...byId].filter(([, pages]) => pages.length > 1).map(([id]) => id)
  const duplicates = new Set(duplicateNoteIds), titlesKnown = pages.every(page => page.title !== null)
  const references: NoteCorpusReference[] = knowledge.references.map(reference => {
    let target = reference.target, resolution: NoteCorpusReference['resolution'] = 'unknown', queryText: string | undefined
    if (target.kind === 'unbound') {
      queryText = target.text
      const parsed = parseNoteWikiQuery(queryText)
      if (parsed.status === 'valid') {
        const candidates = byTitle.get(parsed.query.page) ?? [], selected = candidates.length === 1 ? candidates[0] : undefined
        if (candidates.length > 1) resolution = 'ambiguous'
        else if (!selected) resolution = complete && titlesKnown ? 'missing' : 'unknown'
        else if (duplicates.has(selected.noteId)) resolution = 'ambiguous'
        else if (!complete || !titlesKnown) resolution = 'unknown'
        else if (!parsed.query.fragment) { target = { kind: 'page', noteId: selected.noteId }; resolution = 'resolved' }
        else {
          const matches = matchingNoteLinkBlocks(selected.blocks, parsed.query.fragment)
          if (matches.length === 1 && (!selected.unanchoredBlockCount || parsed.query.fragment.kind === 'block')) {
            target = { kind: 'block', noteId: selected.noteId, blockId: matches[0]!.blockId }; resolution = 'resolved'
          } else resolution = matches.length > 1 ? 'ambiguous' : selected.unanchoredBlockCount ? 'unknown' : 'missing'
        }
      }
    } else {
      const targets = byId.get(target.noteId) ?? []
      if (targets.length > 1) resolution = 'ambiguous'
      else if (!targets.length) resolution = complete ? 'missing' : 'unknown'
      else if (!complete) resolution = 'unknown'
      else if (target.kind === 'page') resolution = reference.mode === 'embed' && targets[0]!.kind !== 'shared-block' ? 'unknown' : 'resolved'
      else {
        const blockId = target.blockId
        resolution = resolveNoteBlock(knowledge, { noteId: target.noteId, blockId }).status
      }
    }
    return {
      source: { noteId: reference.source.note.noteId, blockId: reference.blockId },
      sourceResource: byPath.get(locationKey(reference.source.location))!.resource,
      revision: reference.source.revision, target, occurrence: reference.occurrence, mode: reference.mode, resolution,
      ...(queryText === undefined ? {} : { query: queryText })
    }
  })
  const hits: NoteCorpusHit[] = []
  let total = 0
  if (query !== undefined) for (const source of knowledge.sources) {
    const page = byPath.get(locationKey(source.location))!
    // External Markdown edits can introduce text without an anchor. Search the original parsed
    // textblocks rather than the stable-ID map; missing identity never makes read text disappear.
    noteContentSchema.nodeFromJSON(source.note.content).descendants(node => {
      if (!node.isTextblock && node.type.name !== 'noteRawBlock') return
      const text = noteSemanticText(node), from = text.indexOf(query)
      if (from < 0) return
      total++
      if (hits.length >= limit) return
      const start = Math.max(0, from - 80), end = Math.min(text.length, from + query.length + 160)
      hits.push({
        resource: page.resource, noteId: source.note.noteId, title: source.note.title ?? null,
        blockId: typeof node.attrs.blockId === 'string' ? node.attrs.blockId : null, revision: source.revision,
        excerpt: text.slice(start, end), match: { from: from - start, to: from - start + query.length }
      })
    })
  }
  return { pages, duplicateNoteIds, references, search: { query: query ?? null, hits, total, truncated: total > hits.length }, invalid: knowledge.invalid }
}
