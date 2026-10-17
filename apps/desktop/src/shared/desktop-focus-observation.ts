import { z } from 'zod'
import type { AgentMuxDesktopObservation } from '@agentmux/core/control'

const id = z.string().min(1)
const nullableId = id.nullable()
const windowIdentity = { windowId: id.optional(), documentGeneration: id.optional() }
function exactWindowPair(value: { windowId?: string | undefined; documentGeneration?: string | undefined; scope?: string; state?: string }, context: z.RefinementCtx): void {
  if (Object.hasOwn(value, 'windowId') && value.windowId === undefined || Object.hasOwn(value, 'documentGeneration') && value.documentGeneration === undefined) { context.addIssue({ code: 'custom', message: 'An unknown native identity must omit both keys.' }) }
  if ((value.windowId === undefined) !== (value.documentGeneration === undefined) || (value.scope === 'window' || value.state === 'window') && value.windowId === undefined) {
    context.addIssue({ code: 'custom', message: 'An exact native window document pair is required.' })
  }
}
function omitMissingWindow<T extends { windowId?: string | undefined; documentGeneration?: string | undefined }>(value: T): Omit<T, 'windowId' | 'documentGeneration'> & { windowId?: string; documentGeneration?: string } {
  const { windowId, documentGeneration, ...rest } = value
  return windowId === undefined ? rest : { ...rest, windowId, documentGeneration: documentGeneration! }
}
const provenance = z.enum(['observed', 'unavailable', 'unknown'])
const desktopSpaceSelectionSchema = z.object({ spaceId: nullableId, zoneId: nullableId, workspaceId: id,
  tabId: nullableId, groupId: nullableId, regionId: nullableId, topicId: nullableId }).strict()
const desktopInputObservationSchema = z.object({ provenance,
  ...windowIdentity, scope: z.enum(['main', 'floating', 'window', 'overlay', 'none', 'unknown']), ownerKind: z.enum(['terminal', 'composer', 'editor', 'dialog', 'other']).nullable(),
  tabId: nullableId, regionId: nullableId, sessionId: nullableId,
  connected: z.boolean().nullable(), visible: z.boolean().nullable(), inert: z.boolean().nullable() }).strict().superRefine(exactWindowPair).transform(omitMissingWindow)
const desktopSelectionSchema = z.object({ surface: z.enum(['space', 'focus', 'goals', 'survey', 'recall']), mainSurface: z.enum(['workbench', 'agents', 'board', 'survey', 'recall']),
  spaceView: z.enum(['workbench', 'map']).nullable(), space: desktopSpaceSelectionSchema.nullable(), goalId: nullableId }).strict().superRefine((value, context) => {
  if ((value.surface === 'space') !== (value.spaceView !== null)) context.addIssue({ code: 'custom', message: 'Space view belongs only to the Space Surface.' })
})
export const desktopObservationSchema: z.ZodType<AgentMuxDesktopObservation> = z.object({
  selection: desktopSelectionSchema,
  presentation: z.object({ provenance, ...windowIdentity, state: z.enum(['main-visible', 'floating', 'window', 'covered', 'pending', 'unknown']),
    tabId: nullableId, regionId: nullableId, blockers: z.array(z.enum(['settings', 'quick-switcher'])) }).strict().superRefine(exactWindowPair).transform(omitMissingWindow),
  input: desktopInputObservationSchema,
  floating: z.object({ provenance, state: z.enum(['closed', 'preview', 'pinned', 'unknown']), topicId: nullableId,
    tabId: nullableId, regionId: nullableId, sessionId: nullableId, presentation: z.enum(['visible', 'hidden', 'pending', 'unknown']) }).strict(),
  overlays: z.object({ provenance, settings: z.boolean().nullable(), quickSwitcher: z.boolean().nullable() }).strict(),
  focus: z.object({ executionSessionId: nullableId, pmoSessionId: nullableId }).strict()
}).strict().superRefine((value, context) => {
  if (value.selection.spaceView === 'map' && (value.presentation.tabId !== null || value.presentation.regionId !== null ||
    value.presentation.windowId !== undefined || value.presentation.documentGeneration !== undefined || value.presentation.state === 'floating' || value.presentation.state === 'window')) {
    context.addIssue({ code: 'custom', message: 'A map presentation cannot identify a retained, borrowed or native Region.' })
  }
})
