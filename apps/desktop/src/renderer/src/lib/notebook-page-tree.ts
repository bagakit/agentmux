import { notebookPageArchiveRoot, type NotebookPage } from '@agentmux/core/notebook-catalog'

/** The durable parent links form this directory; open Tabs never participate. */
export function notebookPageRows(pages: NotebookPage[], notebookId: string, query = '', collapsed: ReadonlySet<string> = new Set(), archived?: boolean) {
  const catalog = Object.fromEntries(pages.map(page => [page.noteId, page]))
  const members = pages.filter(page => page.notebookId === notebookId && (archived === undefined || Boolean(notebookPageArchiveRoot(catalog, page.noteId)) === archived))
  const byId = new Map(members.map(page => [page.noteId, page]))
  const children = new Map<string | null, NotebookPage[]>()
  for (const page of members) { const parentId = page.parentNoteId && byId.has(page.parentNoteId) ? page.parentNoteId : null; const list = children.get(parentId) ?? []; list.push(page); children.set(parentId, list) }
  const term = query.trim().toLocaleLowerCase(), matches = new Set<string>()
  if (term) for (const page of members) {
    if (![page.title, ...page.sources.flatMap(source => [source.title ?? '', source.url])].some(value => value.toLocaleLowerCase().includes(term))) continue
    let current: NotebookPage | undefined = page
    while (current && !matches.has(current.noteId)) { matches.add(current.noteId); current = current.parentNoteId ? byId.get(current.parentNoteId) : undefined }
  }
  const rows: { page: NotebookPage; depth: number; hasChildren: boolean; expanded: boolean }[] = []
  const visit = (parent: string | null, depth: number) => {
    for (const page of children.get(parent) ?? []) {
      if (term && !matches.has(page.noteId)) continue
      const expanded = Boolean(term) || !collapsed.has(page.noteId), hasChildren = children.has(page.noteId)
      rows.push({ page, depth, hasChildren, expanded }); if (expanded) visit(page.noteId, depth + 1)
    }
  }
  visit(null, 0); return rows
}
export function notebookDescendants(pages: NotebookPage[], noteId: string): Set<string> {
  const members = new Set([noteId]); let added = true
  while (added) { added = false; for (const page of pages) if (page.parentNoteId && members.has(page.parentNoteId) && !members.has(page.noteId)) { members.add(page.noteId); added = true } }
  return members
}
