import { z } from 'zod'
import { parseConversationCheckpoint, parseConversationLandmarkRef, parseConversationSource,
  type ConversationCheckpoint, type ConversationItemRef, type ConversationSourceRef } from '@agentmux/core/conversation'
import { parseConversationConsumerQuery, type ConversationConsumerQuery } from '@agentmux/core/control'
import { desktopLoadedRendererSchema, desktopPackageIdentitySchema } from './client-observation'

const id = z.string().min(1)
function original<T>(parse: (value: unknown) => T): z.ZodType<T> {
  return z.custom<T>(value => { try { parse(value); return true } catch { return false } })
}
const source = original<ConversationSourceRef>(parseConversationSource)
const record = original<ConversationItemRef>(parseConversationLandmarkRef)
const issue = z.object({ name: z.string(), code: z.string().nullable(), message: z.string() }).strict().nullable()
const frame = z.object({
  id, revision: z.number().int().nonnegative(), sourceHostId: id.nullable(),
  scope: z.object({ sources: z.array(source) }).strict(),
  checkpoint: original<ConversationCheckpoint>(parseConversationCheckpoint),
  unitCount: z.number().int().nonnegative(), recordCount: z.number().int().nonnegative(),
  coverage: z.array(z.object({ source, current: z.enum(['complete-through-cut', 'partial', 'unavailable', 'unsupported']),
    readExtent: z.object({ from: z.string().optional(), through: z.string() }).strict(),
    gaps: z.array(z.object({ code: id, record: record.optional() }).strict()) }).strict()),
  membership: z.array(z.object({ record, present: z.boolean().nullable(), roles: z.array(id) }).strict())
}).strict()
const query = original<ConversationConsumerQuery>(parseConversationConsumerQuery)
export const conversationConsumerObservationSchema = z.object({
  schema: z.literal('agentmux.conversation-consumer-observation.v1'), query,
  consumers: z.array(z.object({
    consumerId: id, reference: z.object({ hostId: id, agentSessionId: id }).strict(),
    runId: id.nullable(), matchesExpectedRun: z.boolean().nullable(), readingIdentity: z.string(),
    location: z.object({ regionId: id.nullable(), presentationId: id.nullable(),
      document: z.object({ windowId: id, documentGeneration: id }).strict().nullable() }).strict(),
    gates: z.object({ enabled: z.boolean(), visible: z.boolean().nullable(), parked: z.boolean().nullable(),
      activityShown: z.boolean().nullable(), viewMode: z.string().nullable() }).strict(),
    viewport: z.object({ connected: z.boolean(), hidden: z.boolean(), width: z.number().nonnegative(), height: z.number().nonnegative() }).strict(),
    loading: z.boolean(), held: z.boolean(), historical: z.boolean(), newerAvailable: z.boolean(),
    dirty: z.boolean().nullable(), inFlight: z.boolean(),
    error: issue, sourceError: issue, observationError: issue,
    watch: z.object({ binding: z.boolean(), bound: z.boolean(), closed: z.boolean().nullable(),
      windowId: id.nullable(), invalidations: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative() }).strict(),
    accepted: frame.nullable(), pending: frame.nullable(),
    rendered: z.array(z.object({ record, message: z.boolean(), messageExposed: z.boolean(), process: z.boolean(), disclosure: z.boolean(), open: z.boolean().nullable() }).strict())
  }).strict())
}).strict()
export type ConversationConsumerObservation = z.infer<typeof conversationConsumerObservationSchema>
export type ConversationConsumerSample = ConversationConsumerObservation['consumers'][number]
export const desktopConversationConsumerObservationSchema = conversationConsumerObservationSchema.extend({
  main: z.object({ pid: z.number().int().positive(), package: desktopPackageIdentitySchema.nullable(),
    renderer: desktopLoadedRendererSchema, documentGeneration: z.number().int().nonnegative() }).strict()
}).strict()
