import { z } from 'zod'
import type { AgentMuxDesktopObservation } from '@agentmux/core/control'

const id = z.string().min(1)
const nullableId = id.nullable()
const provenance = z.enum(['observed', 'unavailable', 'unknown'])
const desktopSpaceSelectionSchema = z.object({ spaceId: id, zoneId: id, workspaceId: id,
  tabId: nullableId, groupId: nullableId, regionId: nullableId, topicId: nullableId }).strict()
const desktopInputObservationSchema = z.object({ provenance,
  scope: z.enum(['main', 'floating', 'overlay', 'none', 'unknown']), ownerKind: z.enum(['terminal', 'composer', 'editor', 'dialog', 'other']).nullable(),
  tabId: nullableId, regionId: nullableId, sessionId: nullableId,
  connected: z.boolean().nullable(), visible: z.boolean().nullable(), inert: z.boolean().nullable() }).strict()
export const desktopObservationSchema: z.ZodType<AgentMuxDesktopObservation> = z.object({
  selection: z.object({ surface: z.enum(['space', 'focus', 'goals', 'survey']), mainSurface: z.enum(['workbench', 'agents', 'board', 'survey']),
    space: desktopSpaceSelectionSchema.nullable(), goalId: nullableId }).strict(),
  presentation: z.object({ provenance, state: z.enum(['main-visible', 'floating', 'covered', 'pending', 'unknown']),
    tabId: nullableId, regionId: nullableId, blockers: z.array(z.enum(['settings', 'quick-switcher', 'shortcuts-help'])) }).strict(),
  input: desktopInputObservationSchema,
  floating: z.object({ provenance, state: z.enum(['closed', 'preview', 'pinned', 'unknown']), topicId: nullableId,
    tabId: nullableId, regionId: nullableId, sessionId: nullableId, presentation: z.enum(['visible', 'hidden', 'pending', 'unknown']) }).strict(),
  overlays: z.object({ provenance, settings: z.boolean().nullable(), quickSwitcher: z.boolean().nullable(), shortcutsHelp: z.boolean().nullable() }).strict(),
  focus: z.object({ executionSessionId: nullableId, pmoSessionId: nullableId }).strict()
}).strict()
