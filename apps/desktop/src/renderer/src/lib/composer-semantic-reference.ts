export type SemanticReferenceKind = 'skill' | 'component' | 'subcommand'

export type ComposerSemanticReference = {
  token: string
  label: string
  kind: SemanticReferenceKind
  reference: string
}

export function appendSemanticReference(draft: string, token: string): string {
  const separator = draft && !draft.endsWith(' ') ? ' ' : ''
  return `${draft}${separator}${token} `
}

export function expandSemanticReferences(
  draft: string,
  references: readonly ComposerSemanticReference[]
): string {
  return references.reduce((value, item) => value.split(item.token).join(item.reference), draft)
}

export function semanticReferenceKind(reference: string): SemanticReferenceKind {
  if (/(^|[\\/])components?([\\/]|$)/i.test(reference)) return 'component'
  if (/^\/[A-Za-z0-9._-]+$/.test(reference)) return 'subcommand'
  return 'skill'
}

export function semanticReferenceLabel(reference: string): string {
  const clean = reference.replace(/[\\/]$/, '')
  return clean.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.[^.]+$/, '') ?? reference
}
