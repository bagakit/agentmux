import { diffChars } from 'diff'
import { fileUploadRevision, parseFileUploadIdentity, type FileUploadIdentity } from '@agentmux/core/files'
import type { AgentInputImageReference } from '@agentmux/core'
export type SemanticReferenceKind = 'skill' | 'component' | 'subcommand' | 'file' | 'agent' | 'image'
export type ComposerSemanticReference = {
  token: string
  label: string
  kind: SemanticReferenceKind
  reference: string
}

// The existing durable draft string owns the complete reference. Markdown links keep copied drafts
// readable, and an explicit scheme distinguishes selected tools from ordinary Markdown the user types.
export function encodeSemanticReference(item: ComposerSemanticReference): string {
  return `[${(item.label.replace(/[\[\]\\\n]/g, '') || 'Reference')}](agentmux-${item.kind}:${encodeURIComponent(item.reference).replace(/\(/g, '%28').replace(/\)/g, '%29')})`
}

export type ComposerDraftPart = { text: string } | { reference: ComposerSemanticReference; raw: string }
export function parseComposerDraft(draft: string): ComposerDraftPart[] {
  const parts: ComposerDraftPart[] = []
  const pattern = /\[([^\]\n]+)\]\(agentmux-(skill|component|subcommand|file|agent|image):([^\s)]*)\)/g
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
  return parseComposerDraft(draft).map((part) => 'text' in part ? part.text : part.reference.kind === 'image' ? selectedImageReference(part.reference)?.text ?? part.raw : part.reference.reference).join('')
}

export function semanticReferenceKind(reference: string): SemanticReferenceKind {
  if (/(^|[\\/])components?([\\/]|$)/i.test(reference)) return 'component'
  if (/^\/[A-Za-z0-9._-]+$/.test(reference)) return 'subcommand'
  return 'skill'
}

export function semanticReferenceLabel(reference: string): string {
  return reference.replace(/[\\/]$/, '').split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.[^.]+$/, '') ?? reference
}

/** Draft metadata preserves an original immutable upload; it never grants filesystem reads. */
export function encodeSelectedImageReference(text: string, upload: FileUploadIdentity): string {
  return encodeSemanticReference({ token: '', label: 'Image', kind: 'image', reference: JSON.stringify({ text, upload }) })
}
export function selectedImageReference(reference: ComposerSemanticReference): { text: string; upload: FileUploadIdentity } | null {
  if (reference.kind !== 'image') return null
  try {
    const value = JSON.parse(reference.reference)
    if (typeof value.text !== 'string' || !value.text) return null
    return { text: value.text, upload: parseFileUploadIdentity(value.upload) }
  } catch { return null }
}
export function expandComposerInput(draft: string): { text: string; inputImages: AgentInputImageReference[] } {
  let text = ''
  const selected: Omit<AgentInputImageReference, 'bodyRevision'>[] = []
  for (const part of parseComposerDraft(draft)) {
    const image = 'reference' in part ? selectedImageReference(part.reference) : null
    const body = 'text' in part ? part.text : part.reference.kind === 'image' ? image?.text ?? part.raw : part.reference.reference
    if (image) selected.push({ start: text.length, end: text.length + body.length, upload: image.upload })
    text += body
  }
  if (!selected.length) return { text, inputImages: [] }
  const bodyRevision = fileUploadRevision(new TextEncoder().encode(text))
  return { text, inputImages: selected.map(image => ({ ...image, bodyRevision })) }
}

/** Keep only original selected spans that survived a text edit intact. New prose grants nothing. */
export function editComposerInputImages(previous: string, next: string, images: readonly AgentInputImageReference[] | undefined): AgentInputImageReference[] | undefined {
  if (!images?.length) return images ? [] : undefined
  const beforeRevision = fileUploadRevision(new TextEncoder().encode(previous))
  const retained: AgentInputImageReference[] = []
  let before = 0, after = 0
  for (const change of diffChars(previous, next)) {
    if (!change.added && !change.removed) {
      for (const image of images) if (image.bodyRevision === beforeRevision && image.start >= before && image.end <= before + change.value.length) {
        retained.push({ ...image, start: after + image.start - before, end: after + image.end - before })
      }
    }
    if (!change.added) before += change.value.length
    if (!change.removed) after += change.value.length
  }
  if (!retained.length) return []
  const bodyRevision = fileUploadRevision(new TextEncoder().encode(next))
  return retained.map(image => ({ ...image, bodyRevision }))
}
/** Returning an existing selected Input to the draft retains its original image nodes. */
export function restoreComposerInput(text: string, images: readonly AgentInputImageReference[] | undefined): string {
  if (!images?.length) return text
  const bodyRevision = fileUploadRevision(new TextEncoder().encode(text))
  let draft = '', offset = 0
  for (const image of images) if (image.bodyRevision === bodyRevision && image.start >= offset && image.end <= text.length) {
    draft += text.slice(offset, image.start) + encodeSelectedImageReference(text.slice(image.start, image.end), image.upload)
    offset = image.end
  }
  return draft + text.slice(offset)
}
