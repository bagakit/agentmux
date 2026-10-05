import { z } from 'zod'
import type { AgentMuxSpaceLocation } from '@agentmux/core/control'

const id = z.string().min(1)
const wallTime = z.number().finite().nonnegative()

/** The exact captured display occurrence; it is neither execution cwd nor Run health. */
export type MoteContextReference = Pick<AgentMuxSpaceLocation,
  'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'>
export const moteContextReferenceSchema: z.ZodType<MoteContextReference> = z.object({
  displayWorkspaceId: id, groupId: id, tabId: id, regionId: id
}).strict()

/** Original action scope. A missing Tab/reference remains null, never a guessed occurrence. */
export const moteContextTargetSchema = z.object({
  workspaceId: id, hostId: id, directoryPath: id, topicId: id,
  tabId: id.nullable(), reference: moteContextReferenceSchema.nullable()
}).strict()
export type MoteContextTarget = z.infer<typeof moteContextTargetSchema>

/** Original client action failure; cause is private original text, not a safe public summary. */
export const moteContextFailureSchema = z.object({
  step: z.enum(['ensure-mote', 'read-discussion', 'open-space']),
  cause: z.string(), observedAt: wallTime, target: moteContextTargetSchema
}).strict()
export type MoteContextFailure = z.infer<typeof moteContextFailureSchema>

/** Panel action facts only. State does not declare Agent availability or input admission. */
export const moteContextOperationSchema = z.object({
  target: moteContextTargetSchema,
  action: z.enum(['prepare', 'open-space']),
  state: z.enum(['pending', 'confirmed', 'unconfirmed']),
  startedAt: wallTime, settledAt: wallTime.nullable(),
  failure: moteContextFailureSchema.nullable()
}).strict()
export type MoteContextOperation = z.infer<typeof moteContextOperationSchema>
export type MoteContextAction = MoteContextOperation['action']

/** Scope/action key construction and settlement semantics remain with the original Panel owner. */
export const moteContextOperationsSchema = z.record(z.string(), moteContextOperationSchema)
export type MoteContextOperations = z.infer<typeof moteContextOperationsSchema>

/** One encoding shared by the action publisher, UI and exact-scope inspector. */
export function contextOperationKey(target: Pick<MoteContextTarget, 'hostId' | 'directoryPath' | 'topicId' | 'tabId' | 'reference'>,
  action: MoteContextAction): string {
  const r = action === 'open-space' ? target.reference : null
  return JSON.stringify([target.hostId, target.directoryPath, target.topicId, target.tabId, action,
    r ? [r.displayWorkspaceId, r.groupId, r.tabId, r.regionId] : null])
}
