import type {
  BrowserAnnotationMarker,
  BrowserElementSelection
} from '../../../shared/contracts'
import { formatAmuxSharing } from '@agentmux/core/sharing'

export const BROWSER_ANNOTATION_NOTE_MAX_LENGTH = 1_000
export const BROWSER_CONTEXT_MAX_LENGTH = 12_000

export type BrowserAnnotation = {
  id: string
  workspaceId: string
  browserId: string
  navigationId: string
  selection: BrowserElementSelection
  note: string
}

function line(label: string, value: string): string[] {
  return value ? [`${label}: ${value}`] : []
}

export function normalizeBrowserAnnotationNote(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BROWSER_ANNOTATION_NOTE_MAX_LENGTH)
}

function browserElementContextContent(
  selection: BrowserElementSelection,
  note = ''
): string {
  const attributes = Object.entries(selection.attributes)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(' ')
  const nearby = selection.nearbyText.join(' | ')
  const content = [
    ...line('Page', selection.pageTitle),
    ...line('URL', selection.pageUrl),
    ...line('Element', `<${selection.tagName}>${selection.role ? ` role=${selection.role}` : ''}`),
    ...line('Accessible name', selection.accessibleName),
    ...line('Selector', selection.selector),
    ...line('Text', selection.text),
    ...line('Nearby text', nearby),
    ...line('Attributes', attributes),
    ...line('HTML', selection.html),
    ...line('Annotation', normalizeBrowserAnnotationNote(note))
  ].join('\n')
  return content
}

function shareBrowserContext(content: string): string {
  const bodyBudget = BROWSER_CONTEXT_MAX_LENGTH - formatAmuxSharing('Browser', '').length
  return formatAmuxSharing('Browser', content.slice(0, bodyBudget))
}

export function formatBrowserElementContext(selection: BrowserElementSelection, note = ''): string {
  return shareBrowserContext(browserElementContextContent(selection, note))
}

export function formatBrowserAnnotationsContext(annotations: readonly BrowserAnnotation[]): string {
  return shareBrowserContext(annotations
    .map((annotation, index) => (
      `## Element ${browserAnnotationDisplayNumber(annotations, index)}\n${browserElementContextContent(annotation.selection, annotation.note)}`
    ))
    .join('\n\n')
  )
}

export function browserAnnotationMarkers(
  annotations: readonly BrowserAnnotation[]
): BrowserAnnotationMarker[] {
  return annotations.slice(0, 50).map((annotation, index) => ({
    id: annotation.id,
    index,
    rectViewport: annotation.selection.rectViewport,
    rectPage: annotation.selection.rectPage,
    isFixed: annotation.selection.isFixed
  }))
}

export function browserAnnotationDisplayNumber(
  annotations: readonly BrowserAnnotation[],
  annotationIndex: number
): number {
  const annotation = annotations[annotationIndex]
  if (!annotation) throw new Error('Browser annotation index is out of range')
  return annotations.slice(0, annotationIndex + 1).filter((candidate) => (
    candidate.browserId === annotation.browserId &&
    candidate.navigationId === annotation.navigationId
  )).length
}
