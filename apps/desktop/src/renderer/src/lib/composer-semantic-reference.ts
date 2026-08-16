export type SemanticReferenceKind = 'skill' | 'component' | 'subcommand'
export type ComposerSemanticReference = {
  token: string
  label: string
  kind: SemanticReferenceKind
  reference: string
}

// The existing durable draft string owns the complete reference. Markdown links keep copied drafts
// readable, and an explicit scheme distinguishes selected tools from ordinary Markdown the user types.
export function encodeSemanticReference(item: ComposerSemanticReference): string {
  return `[${item.label.replace(/[\[\]\\\n]/g, '')}](agentmux-${item.kind}:${encodeURIComponent(item.reference).replace(/\(/g, '%28').replace(/\)/g, '%29')})`
}

export type ComposerDraftPart = { text: string } | { reference: ComposerSemanticReference; raw: string }
export function parseComposerDraft(draft: string): ComposerDraftPart[] {
  const parts: ComposerDraftPart[] = []
  const pattern = /\[([^\]\n]+)\]\(agentmux-(skill|component|subcommand):([^\s)]*)\)/g
  let offset = 0
  for (const match of draft.matchAll(pattern)) {
    let reference: string
    try { reference = decodeURIComponent(match[3]!) } catch { continue }
    if (match.index! > offset) parts.push({ text: draft.slice(offset, match.index) })
    parts.push({ raw: match[0], reference: { token: match[0], label: match[1]!, kind: match[2] as SemanticReferenceKind, reference } })
    offset = match.index! + match[0].length
  }
  if (offset < draft.length) parts.push({ text: draft.slice(offset) })
  return parts
}

export function appendSemanticReference(draft: string, reference: ComposerSemanticReference): string {
  return `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${encodeSemanticReference(reference)} `
}

export function expandSemanticReferences(draft: string): string {
  return parseComposerDraft(draft).map((part) => 'text' in part ? part.text : part.reference.reference).join('')
}

export function semanticReferenceKind(reference: string): SemanticReferenceKind {
  if (/(^|[\\/])components?([\\/]|$)/i.test(reference)) return 'component'
  if (/^\/[A-Za-z0-9._-]+$/.test(reference)) return 'subcommand'
  return 'skill'
}

export function semanticReferenceLabel(reference: string): string {
  return reference.replace(/[\\/]$/, '').split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.[^.]+$/, '') ?? reference
}

// Local editable prompts, not Provider commands. They never dispatch anything on selection.
export const COMPOSER_PROMPT_PRESETS = [
  { text: '/review-changes', label: 'Review changes', description: 'Expand an editable review prompt', prompt: 'Review the current changes. Identify concrete bugs and missing tests, cite the relevant files, and explain any remaining risks.' },
  { text: '/summarize-progress', label: 'Summarize progress', description: 'Expand an editable progress prompt', prompt: 'Summarize the goal, completed work, verification results, remaining work, and the next useful action. Distinguish confirmed facts from uncertainty.' }
] as const
