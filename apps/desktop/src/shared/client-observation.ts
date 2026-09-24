import { z } from 'zod'
import type { WorkspaceLayout, WorkbenchViewLayout } from '@agentmux/layout'

const id = z.string().min(1)
const nullableId = id.nullable()
const run = z.object({ runId: id }).strict()
const control = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), hostId: id, agentSessionId: id, run }).strict(),
  z.object({ kind: z.literal('terminal'), hostId: id, runId: id, run }).strict()
])
// The public layout trees share their algebra; only leaf identity differs.
function layoutTree(key: 'groupId' | 'regionId'): z.ZodType {
  const leaf = z.object({ type: z.literal('leaf'), [key]: id }).strict()
  const node: z.ZodType = z.lazy(() => z.union([leaf, z.object({
    type: z.literal('split'), direction: z.enum(['horizontal', 'vertical']),
    ratio: z.number().finite().gt(0).lt(1), first: node, second: node
  }).strict()]))
  return node
}
const regionTree = layoutTree('regionId') as z.ZodType<WorkbenchViewLayout['root']>
const groupTree = layoutTree('groupId') as z.ZodType<WorkspaceLayout['root']>
const regionBase = { regionId: id, workspaceId: id }
const sessionRegion = { ...regionBase, sessionId: id, phase: z.enum(['launching', 'attached']), control: control.nullable(), processState: z.enum(['running', 'exited', 'interrupted']).nullable() }
const comparison = z.object({
  snapshot: z.object({ hostId: id, repoPath: id, mode: z.enum(['two-point', 'merge-base']), baseBranch: id,
    targetBranch: id, baseOid: id, targetOid: id, comparisonBaseOid: id }).strict(),
  file: z.object({ path: id, origPath: nullableId }).strict()
}).strict()
const region = z.discriminatedUnion('kind', [
  z.object({ ...sessionRegion, kind: z.literal('agent') }).strict(),
  z.object({ ...sessionRegion, kind: z.literal('terminal') }).strict(),
  z.object({ ...regionBase, kind: z.literal('launcher') }).strict(),
  z.object({ ...regionBase, kind: z.literal('file'), path: id }).strict(),
  z.object({ ...regionBase, kind: z.literal('git-diff'), comparison }).strict(),
  z.object({ ...regionBase, kind: z.literal('browser'), browserId: id, url: z.string(), title: z.string(),
    profileId: z.string(), navigationId: z.string(), error: z.string().nullable(), loading: z.boolean() }).strict()
])
export const desktopWorkbenchObservationSchema = z.object({
  loading: z.boolean(),
  startupProgress: z.union([
    z.object({ step: z.enum(['saved-workspace', 'runtime', 'layout']) }).strict(),
    z.object({ step: z.enum(['sessions', 'browsers']), current: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict()
  ]),
  activeWorkspaceId: nullableId, mainSurface: z.enum(['search', 'agents', 'workbench', 'board']),
  focus: z.object({ executionSessionId: nullableId, pmoSessionId: nullableId }).strict(),
  tabs: z.array(z.object({ id, workspaceId: id, topicId: id.optional(), titleRegionId: id, name: z.string().optional(),
    layout: z.object({ root: regionTree, activeRegionId: id }).strict(), regions: z.array(region) }).strict()),
  layouts: z.record(z.string(), z.object({ root: groupTree, activeGroupId: id, groups: z.array(z.object({
    id, activeTabId: nullableId, tabOrder: z.array(id), recentTabIds: z.array(id)
  }).strict()) }).strict())
}).strict()
export const desktopPackageIdentitySchema = z.object({
  schema: z.literal('agentmux.package-identity.v1'), sourceCommit: id, sourceTree: id,
  appVersion: id, platform: id, arch: id
}).strict()
export const desktopLoadedRendererSchema = z.object({
  kind: z.enum(['bundled', 'staged']), id: z.string().regex(/^[a-f0-9]{64}$/),
  identity: z.object({ shell: id, ctxmux: id }).strict()
}).strict()
export const desktopWorkbenchStorageObservationSchema = z.object({
  userData: id, sessionData: id, directory: nullableId,
  localStorage: z.enum(['present', 'missing', 'unconfirmed']), detail: z.string().nullable()
}).strict()
export const desktopClientObservationSchema = z.object({
  schema: z.literal('agentmux.desktop-client-observation.v1'),
  main: z.object({ pid: z.number().int().positive(), package: desktopPackageIdentitySchema.nullable(),
    renderer: desktopLoadedRendererSchema,
    // An absent observation is unknown. It never selects a guessed or configured fallback root.
    storage: desktopWorkbenchStorageObservationSchema.optional(),
    runtimes: z.array(z.object({ hostId: id, identity: z.object({ hostId: id, buildIdentity: id,
      protocolVersion: z.number().int().positive(), processId: z.number().int().positive().nullable(), instanceId: id,
      ownership: z.enum(['owned', 'unverified']).optional() }).strict() }).strict()) }).strict(),
  workbench: desktopWorkbenchObservationSchema
}).strict()
export type DesktopPackageIdentity = z.infer<typeof desktopPackageIdentitySchema>
export type DesktopLoadedRenderer = z.infer<typeof desktopLoadedRendererSchema>
export type DesktopWorkbenchObservation = z.infer<typeof desktopWorkbenchObservationSchema>
export type DesktopWorkbenchStorageObservation = z.infer<typeof desktopWorkbenchStorageObservationSchema>
export type DesktopClientObservation = z.infer<typeof desktopClientObservationSchema>

/** Shared by the production Control owner and the installer; never fills missing facts. */
export function parseDesktopClientObservation(value: unknown): DesktopClientObservation {
  return desktopClientObservationSchema.parse(value)
}
