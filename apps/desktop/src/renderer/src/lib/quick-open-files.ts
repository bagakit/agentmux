import { fuzzyScore } from './quick-switch'
import { referenceRevealLocation } from '@agentmux/client-ui/markdown-file-reference'

/** An exact filename wins over location syntax, including names that end in :12. */
export function quickFileQuery(input: string, files: readonly string[]) {
  const query = input.trim()
  if (files.includes(query)) return { query, location: undefined }
  const suffix = /:(\d+)(?::(\d+))?$/u.exec(query)
  if (!suffix) return { query, location: undefined }
  const line = Number(suffix[1]), column = suffix[2] === undefined ? undefined : Number(suffix[2])
  if (!Number.isSafeInteger(line) || line < 1 || column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return { query, location: undefined }
  return { query: query.slice(0, suffix.index), location: referenceRevealLocation({ path: '', index: 0, length: 0, line, ...(column !== undefined ? { column } : {}) }) }
}

export function rankQuickFiles(files: readonly string[], recent: readonly string[], query: string, limit = 100): string[] {
  const recency = new Map<string, number>()
  recent.forEach((path, index) => { if (!recency.has(path)) recency.set(path, index) })
  return [...new Set([...recent, ...files])].flatMap(path => {
    const score = fuzzyScore(query, path)
    return score === null ? [] : [{ path, score, recent: recency.get(path) ?? Infinity }]
  }).sort((a, b) => b.score - a.score || a.recent - b.recent || a.path.localeCompare(b.path))
    .slice(0, limit).map(item => item.path)
}
