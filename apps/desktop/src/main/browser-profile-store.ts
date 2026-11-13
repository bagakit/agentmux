import { parseBrowserProfileQuery, parseBrowserProfileView, type BrowserProfileView, type BrowserProfileQuery, parseBrowserProfileEnvironment, normalizeBrowserProfileTags, type BrowserProfileEnvironment } from '@agentmux/core/control'
import { mintObjectId, isObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import { clearsSemanticHues } from '../renderer/src/lib/conversation-avatar-color.js'
import { BROWSER_PROFILE_COOKIE_SKIP_REASONS } from '../shared/browser-profile-import-skip.js'
import { normalizeBrowserProfileNetwork, type BrowserProfileStoredNetwork } from '../shared/browser-profile-network.js'
import type {
  BrowserProfileEdit,
  BrowserProfileImportedSource,
  BrowserProfileSummary,
  BrowserProfileFolder
} from '../shared/contracts.js'

export type { BrowserProfileEdit, BrowserProfileImportedSource, BrowserProfileSummary } from '../shared/contracts.js'

const BROWSER_PROFILE_METADATA_VERSION = 1
const BROWSER_PROFILE_FILE_NAME = 'browser-profiles.json'
const BROWSER_PROFILE_PARTITION_PREFIX = 'persist:agentmux-browser-profile:'
const BROWSER_PROFILE_LABEL_MAX_LENGTH = 128
const BROWSER_PROFILE_NOTES_MAX_LENGTH = 2000
const PROFILE_UUID_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

const profileIdSchema = z.string().refine(value => isObjectId(value) || PROFILE_UUID_RE.test(value), 'Browser Profile id must be a stored object identity')
const profileLabelSchema = z
  .string()
  .min(1)
  .max(BROWSER_PROFILE_LABEL_MAX_LENGTH)
  .refine((label) => label === label.trim(), 'Browser Profile label must not have surrounding whitespace')
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
// An identity hue, never a status color: hues near red, amber, green or blue would read as a state.
const profileHueSchema = z.number().int().min(0).max(359).refine(clearsSemanticHues, 'Browser Profile hue must stay clear of status colors')
const profileNotesSchema = z.string().max(BROWSER_PROFILE_NOTES_MAX_LENGTH)
// A stored route must be one the parser would produce, so a hand-edited file cannot hide a malformed proxy.
const profileNetworkSchema = z.custom<BrowserProfileStoredNetwork>((value) => {
  try { const route = normalizeBrowserProfileNetwork(value); return route.mode !== 'system' && JSON.stringify(route) === JSON.stringify(value) } catch { return false }
}, 'Browser Profile network route is not a valid route')

const folderIdSchema = z.string().refine(isObjectId, 'Folder ID must identify a stored folder')
const folderSchema = z.object({ id: folderIdSchema, label: profileLabelSchema }).strict()
const tagsSchema = z.custom<string[]>(value => {
  try { return JSON.stringify(normalizeBrowserProfileTags(value)) === JSON.stringify(value) } catch { return false }
}, 'Stored Profile tags must be canonical names')

const importedSourceSchema = z
  .object({
    browserLabel: profileLabelSchema,
    profileLabel: profileLabelSchema,
    importedAt: nonNegativeSafeIntegerSchema,
    importedCookies: nonNegativeSafeIntegerSchema,
    skippedCookies: nonNegativeSafeIntegerSchema,
    skippedByReason: z.partialRecord(z.enum(BROWSER_PROFILE_COOKIE_SKIP_REASONS), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).optional()
  })
  .strict()
  .refine((source) => source.skippedByReason === undefined ||
    Object.values(source.skippedByReason).reduce((sum, count) => sum + (count ?? 0), 0) === source.skippedCookies,
  'Skipped cookies per reason must add up to the skipped total')

const activityGapSchema = z.object({ id: z.string().min(1), after: nonNegativeSafeIntegerSchema,
  until: nonNegativeSafeIntegerSchema.optional(), reason: z.enum(['observation-interrupted', 'renderer-gone']) }).strict()
const activityCheckpointSchema = z.object({ observerId: z.string().min(1), previousObserverId: z.string().min(1).nullable(),
  sequence: nonNegativeSafeIntegerSchema, unionMs: nonNegativeSafeIntegerSchema, observedAt: nonNegativeSafeIntegerSchema,
  lastUsedAt: nonNegativeSafeIntegerSchema, active: z.boolean(), gaps: z.array(activityGapSchema) }).strict()
export type BrowserProfileActivityCheckpoint = z.infer<typeof activityCheckpointSchema>
export type BrowserProfileActivityGap = z.infer<typeof activityGapSchema>
const profileActivitySchema = z.object({ observedRunMs: nonNegativeSafeIntegerSchema, lastUsedAt: nonNegativeSafeIntegerSchema,
  checkpoint: activityCheckpointSchema, gaps: z.array(activityGapSchema) }).strict()

const profileRecordSchema = z
  .object({
    id: profileIdSchema,
    revision: z.string().min(1).optional(),
    activity: profileActivitySchema.optional(),
    label: profileLabelSchema,
    createdAt: nonNegativeSafeIntegerSchema,
    source: importedSourceSchema.nullable(),
    hue: profileHueSchema.optional(),
    notes: profileNotesSchema.optional(),
    tags: tagsSchema.optional(),
    folderId: folderIdSchema.optional(),
    pinned: z.literal(true).optional(),
    network: profileNetworkSchema.optional(),
    environment: z.custom<BrowserProfileEnvironment>(value => {
      try { parseBrowserProfileEnvironment(value); return true } catch { return false }
    }, 'Browser Profile environment is invalid').optional(),
    // Stored only when Agents are turned off, so an untouched Profile keeps the global switch's answer.
    agentAccess: z.literal(false).optional()
  })
  .strict()

const pendingImportSchema = z
  .object({
    profileId: profileIdSchema,
    label: profileLabelSchema,
    startedAt: nonNegativeSafeIntegerSchema
  })
  .strict()

// JSON object key order is not a persistence contract. Parse the same view semantics as public input.
const viewSchema = z.unknown().transform((value, context): BrowserProfileView => {
  try { return parseBrowserProfileView(value) }
  catch { context.addIssue({ code: 'custom', message: 'Saved Profile view is invalid' }); return z.NEVER }
})

const metadataSchema = z
  .object({
    version: z.literal(BROWSER_PROFILE_METADATA_VERSION),
    /** Configuration collection CAS; activity checkpoints leave it unchanged. */
    revision: nonNegativeSafeIntegerSchema.optional(),
    /** Complete metadata snapshot order, including confirmed native activity. */
    sequence: nonNegativeSafeIntegerSchema.optional(),
    defaultProfileId: profileIdSchema,
    profiles: z.array(profileRecordSchema).min(1),
    folders: z.array(folderSchema).optional(),
    views: z.array(viewSchema).optional(),
    pendingImports: z.array(pendingImportSchema),
    /** Profiles already removed from the list whose site data is not confirmed cleared yet. */
    pendingDeletes: z.array(profileIdSchema).optional()
  })
  .strict()
  .superRefine((metadata, context) => {
    const folderIds = new Set<string>()
    for (const [index, folder] of (metadata.folders ?? []).entries()) {
      if (folderIds.has(folder.id)) context.addIssue({ code: 'custom', path: ['folders', index, 'id'], message: 'Duplicate Profile folder identity' })
      folderIds.add(folder.id)
    }
    const profileIds = new Set<string>()
    for (const [index, profile] of metadata.profiles.entries()) {
      if (profileIds.has(profile.id)) {
        context.addIssue({
          code: 'custom',
          path: ['profiles', index, 'id'],
          message: `Duplicate Browser Profile id: ${profile.id}`
        })
      }
      profileIds.add(profile.id)
      if (profile.folderId !== undefined && !folderIds.has(profile.folderId)) context.addIssue({ code: 'custom', path: ['profiles', index, 'folderId'], message: 'Profile folder reference is missing from the saved directory' })
    }
    if (!profileIds.has(metadata.defaultProfileId)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: 'Default Browser Profile must identify a persisted Profile'
      })
    }

    const viewIds = new Set<string>()
    for (const [index, view] of (metadata.views ?? []).entries()) {
      if (viewIds.has(view.id)) context.addIssue({ code: 'custom', path: ['views', index, 'id'], message: 'Duplicate saved Profile view identity' })
      viewIds.add(view.id)
    }
    const pendingIds = new Set<string>()
    for (const [index, pending] of metadata.pendingImports.entries()) {
      if (profileIds.has(pending.profileId)) {
        context.addIssue({
          code: 'custom',
          path: ['pendingImports', index, 'profileId'],
          message: `Pending Browser Profile is already committed: ${pending.profileId}`
        })
      }
      if (pendingIds.has(pending.profileId)) {
        context.addIssue({
          code: 'custom',
          path: ['pendingImports', index, 'profileId'],
          message: `Duplicate pending Browser Profile id: ${pending.profileId}`
        })
      }
      pendingIds.add(pending.profileId)
    }
    for (const [index, id] of (metadata.pendingDeletes ?? []).entries()) {
      if (profileIds.has(id) || pendingIds.has(id)) {
        context.addIssue({ code: 'custom', path: ['pendingDeletes', index], message: `Deleted Browser Profile is still listed: ${id}` })
      }
      pendingIds.add(id)
    }
  })

type BrowserProfileMetadata = z.infer<typeof metadataSchema>
type BrowserProfileRecord = z.infer<typeof profileRecordSchema>

export type PendingBrowserProfileImport = z.infer<typeof pendingImportSchema>

/** The whole committed list after one write; the manager replaces its cache with it. */
export type BrowserProfileSnapshot = { revision: number; sequence: number; profiles: BrowserProfileSummary[]; defaultProfileId: string; folders: BrowserProfileFolder[]; views: BrowserProfileView[]; activitySources: Record<string, string> }

function cloneImportedSource(source: z.infer<typeof importedSourceSchema> | null): BrowserProfileImportedSource | null {
  if (source === null) return null
  const { skippedByReason, ...rest } = source
  return skippedByReason === undefined ? { ...rest } : { ...rest, skippedByReason: { ...skippedByReason } }
}

function snapshotOf(metadata: BrowserProfileMetadata): BrowserProfileSnapshot {
  return { activitySources: Object.fromEntries(metadata.profiles.filter(profile => profile.activity).map(profile => [profile.id, profile.activity!.checkpoint.observerId])),
    views: structuredClone(metadata.views ?? []), revision: metadata.revision ?? 0, sequence: metadata.sequence ?? metadata.revision ?? 0, defaultProfileId: metadata.defaultProfileId, folders: (metadata.folders ?? []).map(folder => ({ ...folder })),
    profiles: metadata.profiles.map((profile) => profileSummary(profile, metadata.defaultProfileId)) }
}

function profileSummary(profile: BrowserProfileRecord, defaultProfileId: string): BrowserProfileSummary {
  return {
    id: profile.id,
    revision: profileConfigurationRevision(profile),
    ...(profile.activity ? { activity: { observedRunMs: profile.activity.observedRunMs, lastUsedAt: profile.activity.lastUsedAt,
      observedAt: profile.activity.checkpoint.observedAt, state: profile.activity.gaps.some(gap => gap.until === undefined) ? 'unknown' as const : profile.activity.checkpoint.active ? 'running' as const : 'idle' as const,
      history: 'partial' as const, interruptions: profile.activity.gaps.length } } : {}),
    label: profile.label,
    createdAt: profile.createdAt,
    isDefault: profile.id === defaultProfileId,
    source: cloneImportedSource(profile.source),
    ...(profile.hue === undefined ? {} : { hue: profile.hue }),
    ...(profile.tags === undefined ? {} : { tags: [...profile.tags] }),
    ...(profile.folderId === undefined ? {} : { folderId: profile.folderId }),
    ...(profile.pinned === true ? { pinned: true as const } : {}),
    ...(profile.notes === undefined || profile.notes === '' ? {} : { notes: profile.notes }),
    ...(profile.network === undefined ? {} : { network: structuredClone(profile.network) }),
    ...(profile.environment === undefined ? {} : { environment: structuredClone(profile.environment) }),
    ...(profile.agentAccess === false ? { agentAccess: false as const } : {})
  }
}


/** An opaque current configuration baseline, never an edit count or a root-list version. */
function configurationBytes(profile: BrowserProfileRecord): string {
  const { revision: _revision, activity: _activity, ...configuration } = profile
  return JSON.stringify(configuration)
}
function profileConfigurationRevision(profile: BrowserProfileRecord): string {
  return profile.revision ?? 'baseline:' + createHash('sha256').update(configurationBytes(profile)).digest('hex')
}

export class BrowserProfileConfigurationConflict extends Error {
  readonly code = 'BROWSER_PROFILE_REVISION_CONFLICT'
  constructor(readonly currentRevision: string) {
    super('This Profile configuration changed. Read the same Profile again and retry with its revision; your inputs are kept.')
  }
}

export class BrowserProfileRevisionConflict extends Error {
  readonly code = 'BROWSER_PROFILE_REVISION_CONFLICT'
  constructor(readonly currentRevision: number) {
    super(`Browser Profiles changed since revision was read; current revision is ${currentRevision}. Read them again and retry.`)
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function validateBrowserProfileLabel(label: string): string {
  return profileLabelSchema.parse(label)
}

export function browserProfilePartition(profileId: string): string {
  return `${BROWSER_PROFILE_PARTITION_PREFIX}${profileIdSchema.parse(profileId)}`
}

export class BrowserProfileStore {
  private operationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path = join(app.getPath('userData'), BROWSER_PROFILE_FILE_NAME)
  ) {}

  listProfiles(): Promise<BrowserProfileSummary[]> {
    return this.list().then(snapshot => snapshot.profiles)
  }

  list(): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => snapshotOf(await this.readOrInitialize()))
  }

  inspectProfile(profileId: string): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), profile = metadata.profiles.find(value => value.id === profileId)
      if (!profile) throw new Error(`Unknown Browser Profile: ${profileId}`)
      return { snapshot: snapshotOf(metadata), profile: profileSummary(profile, metadata.defaultProfileId) }
    })
  }

  /** Absolute observer high-water marks make an unknown ACK retry idempotent. */
  recordActivity(profileId: string, value: BrowserProfileActivityCheckpoint): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const checkpoint = activityCheckpointSchema.parse(value), metadata = await this.readMetadata()
      const current = metadata.profiles.find(profile => profile.id === profileId)
      if (!current) throw new Error(`Unknown Browser Profile: ${profileId}`)
      const previous = current.activity, same = previous?.checkpoint.observerId === checkpoint.observerId
      if (!same && (previous?.checkpoint.observerId ?? null) !== checkpoint.previousObserverId) {
        throw new Error('The original Profile activity observation changed. Its confirmed history is kept.')
      }
      if (same && checkpoint.sequence <= previous!.checkpoint.sequence) return snapshotOf(metadata)
      if (same && checkpoint.unionMs < previous!.checkpoint.unionMs) throw new Error('Profile activity cannot move its confirmed high-water mark backwards.')
      const gaps = new Map((previous?.gaps ?? []).map(gap => [gap.id, gap]))
      if (previous && !same && previous.checkpoint.active) {
        const id = previous.checkpoint.observerId + ':unclosed'
        gaps.set(id, { id, after: previous.checkpoint.observedAt, until: checkpoint.observedAt, reason: 'observation-interrupted' })
      }
      for (const gap of checkpoint.gaps) gaps.set(gap.id, { ...gap })
      const observedRunMs = (previous?.observedRunMs ?? 0) + checkpoint.unionMs - (same ? previous!.checkpoint.unionMs : 0)
      const activity = profileActivitySchema.parse({ observedRunMs, lastUsedAt: Math.max(previous?.lastUsedAt ?? 0, checkpoint.lastUsedAt), checkpoint, gaps: [...gaps.values()] })
      return this.commit({ ...metadata, profiles: metadata.profiles.map(profile => profile.id === profileId ? { ...profile, activity } : profile) }, false)
    })
  }

  updateProfile(profileId: string, edit: BrowserProfileEdit, expectedRevision: string): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readMetadata()
      const current = metadata.profiles.find((profile) => profile.id === validatedProfileId)
      if (!current) throw new Error(`Unknown Browser Profile: ${validatedProfileId}`)
      this.assertProfileRevision(current, expectedRevision)
      const updated: BrowserProfileRecord = { ...current }
      if (edit.label !== undefined) updated.label = validateBrowserProfileLabel(edit.label)
      if (edit.hue === null) delete updated.hue
      else if (edit.hue !== undefined) updated.hue = profileHueSchema.parse(edit.hue)
      if (edit.notes !== undefined) {
        const notes = profileNotesSchema.parse(edit.notes)
        if (notes === '') delete updated.notes
        else updated.notes = notes
      }
      if (edit.tags !== undefined) {
        const tags = normalizeBrowserProfileTags(edit.tags)
        if (tags.length) updated.tags = tags
        else delete updated.tags
      }
      if (edit.folderId === null) delete updated.folderId
      else if (edit.folderId !== undefined) {
        const id = folderIdSchema.parse(edit.folderId)
        if (!(metadata.folders ?? []).some(folder => folder.id === id)) throw new Error(`Unknown Profile folder: ${id}`)
        updated.folderId = id
      }
      if (edit.pinned === true) updated.pinned = true
      else if (edit.pinned === false) delete updated.pinned
      else if (edit.pinned !== undefined) throw new Error('Profile pinned must be on or off')
      if (edit.agentAccess === true) delete updated.agentAccess
      else if (edit.agentAccess === false) updated.agentAccess = false
      else if (edit.agentAccess !== undefined) throw new Error('Browser Profile Agent access must be on or off')
      if (edit.network === null) delete updated.network
      else if (edit.network !== undefined) {
        const network = normalizeBrowserProfileNetwork(edit.network)
        if (network.mode === 'system') delete updated.network
        else updated.network = network
      }
      if (edit.environment === null) delete updated.environment
      else if (edit.environment !== undefined) updated.environment = parseBrowserProfileEnvironment(edit.environment)
      if (configurationBytes(updated) !== configurationBytes(current)) updated.revision = mintObjectId()
      const snapshot = await this.commit({
        ...metadata,
        profiles: metadata.profiles.map((profile) => profile.id === validatedProfileId ? updated : profile)
      })
      return { snapshot, profile: profileSummary(updated, snapshot.defaultProfileId) }
    })
  }

  /** Moving the default edits no Profile field, so it names only an existing target, not a revision. */
  setDefaultProfile(profileId: string): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readOrInitialize()
      if (!metadata.profiles.some((profile) => profile.id === validatedProfileId)) {
        throw new Error(`Unknown Browser Profile: ${validatedProfileId}`)
      }
      return await this.commit({ ...metadata, defaultProfileId: validatedProfileId })
    })
  }

  listPendingImports(): Promise<PendingBrowserProfileImport[]> {
    return this.enqueue(async () => {
      const metadata = await this.readOrInitialize()
      return metadata.pendingImports.map((pending) => ({ ...pending }))
    })
  }

  createProfile(label: string): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const validatedLabel = validateBrowserProfileLabel(label)
      const metadata = await this.readOrInitialize()
      const profile: BrowserProfileRecord = {
        id: this.createUnusedProfileId(metadata),
        label: validatedLabel,
        createdAt: Date.now(),
        source: null
      }
      const next = metadataSchema.parse({
        ...metadata,
        profiles: [...metadata.profiles, profile]
      })
      const snapshot = await this.commit(next)
      return { snapshot, profile: profileSummary(profile, snapshot.defaultProfileId) }
    })
  }

  /** Copy saved configuration into a new identity in the same atomic metadata write. */
  copyProfile(profileId: string, label: string, expectedRevision: string): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId), validatedLabel = validateBrowserProfileLabel(label)
      // An exact-source copy must not initialize a substitute identity if its original file is missing.
      const metadata = await this.readMetadata()
      const original = metadata.profiles.find(profile => profile.id === validatedProfileId)
      if (!original) throw new Error(`Unknown Browser Profile: ${validatedProfileId}`)
      // Deliberately list configuration fields; import history, approvals and native application
      // observations do not become authority for the new Profile.
      this.assertProfileRevision(original, expectedRevision)
      const profile: BrowserProfileRecord = {
        revision: mintObjectId(), id: this.createUnusedProfileId(metadata), label: validatedLabel, createdAt: Date.now(), source: null,
        ...(original.hue === undefined ? {} : { hue: original.hue }),
        ...(original.notes === undefined ? {} : { notes: original.notes }),
        ...(original.tags === undefined ? {} : { tags: [...original.tags] }),
        ...(original.folderId === undefined ? {} : { folderId: original.folderId }),
        ...(original.network === undefined ? {} : { network: structuredClone(original.network) }),
        ...(original.environment === undefined ? {} : { environment: structuredClone(original.environment) }),
        ...(original.agentAccess === false ? { agentAccess: false as const } : {}) }
      const snapshot = await this.commit({ ...metadata, profiles: [...metadata.profiles, profile] })
      return { snapshot, profile: profileSummary(profile, snapshot.defaultProfileId) }
    })
  }

  saveView(label: string, query: BrowserProfileQuery, expectedRevision: number, viewId?: string): Promise<{ snapshot: BrowserProfileSnapshot; view: BrowserProfileView }> {
    return this.enqueue(async () => {
      const name = validateBrowserProfileLabel(label), definition = parseBrowserProfileQuery(query), metadata = await this.readMetadata()
      this.assertRevision(metadata, expectedRevision)
      if (viewId !== undefined && !(metadata.views ?? []).some(view => view.id === viewId)) throw new Error(`Unknown saved Profile view: ${viewId}`)
      const view = { id: viewId === undefined ? this.createUnusedProfileId(metadata) : folderIdSchema.parse(viewId), label: name, query: definition }
      const views = viewId === undefined ? [...(metadata.views ?? []), view] : metadata.views!.map(value => value.id === viewId ? view : value)
      return { snapshot: await this.commit({ ...metadata, views }), view: structuredClone(view) }
    })
  }

  deleteView(viewId: string, expectedRevision: number): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const id = folderIdSchema.parse(viewId), metadata = await this.readMetadata()
      this.assertRevision(metadata, expectedRevision)
      if (!(metadata.views ?? []).some(view => view.id === id)) throw new Error(`Unknown saved Profile view: ${id}`)
      return this.commit({ ...metadata, views: metadata.views!.filter(view => view.id !== id) })
    })
  }

  createFolder(label: string, expectedRevision: number): Promise<{ snapshot: BrowserProfileSnapshot; folder: BrowserProfileFolder }> {
    return this.enqueue(async () => {
      const name = validateBrowserProfileLabel(label), metadata = await this.readMetadata()
      this.assertRevision(metadata, expectedRevision)
      const folder = { id: this.createUnusedProfileId(metadata), label: name }
      const snapshot = await this.commit({ ...metadata, folders: [...(metadata.folders ?? []), folder] })
      return { snapshot, folder: { ...folder } }
    })
  }

  renameFolder(folderId: string, label: string, expectedRevision: number): Promise<{ snapshot: BrowserProfileSnapshot; folder: BrowserProfileFolder }> {
    return this.enqueue(async () => {
      const id = folderIdSchema.parse(folderId), name = validateBrowserProfileLabel(label), metadata = await this.readMetadata()
      this.assertRevision(metadata, expectedRevision)
      if (!(metadata.folders ?? []).some(folder => folder.id === id)) throw new Error(`Unknown Profile folder: ${id}`)
      const folder = { id, label: name }
      const snapshot = await this.commit({ ...metadata, folders: metadata.folders!.map(value => value.id === id ? folder : value) })
      return { snapshot, folder: { ...folder } }
    })
  }

  deleteFolder(folderId: string, expectedRevision: number): Promise<{ snapshot: BrowserProfileSnapshot; folderId: string; unassignedProfileIds: string[] }> {
    return this.enqueue(async () => {
      const id = folderIdSchema.parse(folderId), metadata = await this.readMetadata()
      this.assertRevision(metadata, expectedRevision)
      if (!(metadata.folders ?? []).some(folder => folder.id === id)) throw new Error(`Unknown Profile folder: ${id}`)
      const unassignedProfileIds = metadata.profiles.filter(profile => profile.folderId === id).map(profile => profile.id)
      const profiles = metadata.profiles.map(profile => {
        if (profile.folderId !== id) return profile
        const { folderId: _folderId, ...retained } = profile
        return { ...retained, revision: mintObjectId() }
      })
      const snapshot = await this.commit({ ...metadata, profiles, folders: metadata.folders!.filter(folder => folder.id !== id) })
      return { snapshot, folderId: id, unassignedProfileIds }
    })
  }

  /**
   * Removes a Profile from the list and records it as deleted in the same write, before any of its
   * site data is touched. A failed write leaves the Profile and its data as they were; a failed clear
   * leaves only this record, which the next start clears again.
   */
  deleteProfile(profileId: string): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readOrInitialize()
      if (metadata.defaultProfileId === validatedProfileId) {
        throw new Error('The default Browser Profile cannot be deleted')
      }
      if (!metadata.profiles.some((profile) => profile.id === validatedProfileId)) {
        throw new Error(`Unknown Browser Profile: ${validatedProfileId}`)
      }
      const next = metadataSchema.parse({
        ...metadata,
        profiles: metadata.profiles.filter((profile) => profile.id !== validatedProfileId),
        pendingDeletes: [...(metadata.pendingDeletes ?? []), validatedProfileId]
      })
      return await this.commit(next)
    })
  }

  listPendingDeletes(): Promise<string[]> {
    return this.enqueue(async () => [...((await this.readOrInitialize()).pendingDeletes ?? [])])
  }

  /**
   * The deleted Profile's site data is confirmed cleared; forget the record. The list is unchanged,
   * so the revision stays: an edit made against the list after the delete is not refused for this.
   */
  finishDelete(profileId: string): Promise<void> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readOrInitialize()
      const pending = metadata.pendingDeletes ?? []
      if (!pending.includes(validatedProfileId)) throw new Error(`Unknown deleted Browser Profile: ${validatedProfileId}`)
      const rest = pending.filter((id) => id !== validatedProfileId)
      const { pendingDeletes: _done, ...kept } = metadata
      await this.writeMetadata(metadataSchema.parse(rest.length ? { ...kept, pendingDeletes: rest } : kept))
    })
  }

  beginPendingImport(label: string): Promise<{ snapshot: BrowserProfileSnapshot; pending: PendingBrowserProfileImport }> {
    return this.enqueue(async () => {
      const validatedLabel = validateBrowserProfileLabel(label)
      const metadata = await this.readOrInitialize()
      const pending: PendingBrowserProfileImport = {
        profileId: this.createUnusedProfileId(metadata),
        label: validatedLabel,
        startedAt: Date.now()
      }
      const next = metadataSchema.parse({
        ...metadata,
        pendingImports: [...metadata.pendingImports, pending]
      })
      return { snapshot: await this.commit(next), pending: { ...pending } }
    })
  }

  commitImportedProfile(
    profileId: string,
    source: BrowserProfileImportedSource
  ): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const validatedSource = importedSourceSchema.parse(source)
      const metadata = await this.readOrInitialize()
      const pending = metadata.pendingImports.find((item) => item.profileId === validatedProfileId)
      if (!pending) throw new Error(`Unknown pending Browser Profile import: ${validatedProfileId}`)
      const profile: BrowserProfileRecord = {
        id: pending.profileId,
        label: pending.label,
        createdAt: pending.startedAt,
        source: validatedSource
      }
      const next = metadataSchema.parse({
        ...metadata,
        profiles: [...metadata.profiles, profile],
        pendingImports: metadata.pendingImports.filter((item) => item.profileId !== validatedProfileId)
      })
      const snapshot = await this.commit(next)
      return { snapshot, profile: profileSummary(profile, snapshot.defaultProfileId) }
    })
  }

  abortPendingImport(profileId: string): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readOrInitialize()
      if (!metadata.pendingImports.some((item) => item.profileId === validatedProfileId)) {
        throw new Error(`Unknown pending Browser Profile import: ${validatedProfileId}`)
      }
      const next = metadataSchema.parse({
        ...metadata,
        pendingImports: metadata.pendingImports.filter((item) => item.profileId !== validatedProfileId)
      })
      return await this.commit(next)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.catch(() => {}).then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }

  private async readMetadata(): Promise<BrowserProfileMetadata> { return metadataSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))) }

  private async readOrInitialize(): Promise<BrowserProfileMetadata> {
    try {
      return await this.readMetadata()
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }

    const id = mintObjectId()
    const metadata = metadataSchema.parse({
      version: BROWSER_PROFILE_METADATA_VERSION,
      defaultProfileId: id,
      profiles: [{ id, label: 'Default', createdAt: Date.now(), source: null }],
      pendingImports: []
    })
    await this.writeMetadata(metadata)
    return metadata
  }

  private assertProfileRevision(profile: BrowserProfileRecord, expectedRevision: string): void {
    const current = profileConfigurationRevision(profile)
    if (typeof expectedRevision !== 'string' || expectedRevision !== current) throw new BrowserProfileConfigurationConflict(current)
  }

  private assertRevision(metadata: BrowserProfileMetadata, expectedRevision: number): void {
    if (expectedRevision !== (metadata.revision ?? 0)) throw new BrowserProfileRevisionConflict(metadata.revision ?? 0)
  }

  /** Every commit advances sequence; configuration writes also advance collection CAS. */
  private async commit(metadata: BrowserProfileMetadata, configuration = true): Promise<BrowserProfileSnapshot> {
    const next = metadataSchema.parse({ ...metadata, revision: (metadata.revision ?? 0) + (configuration ? 1 : 0), sequence: (metadata.sequence ?? metadata.revision ?? 0) + 1 })
    await this.writeMetadata(next)
    return snapshotOf(next)
  }

  private createUnusedProfileId(metadata: BrowserProfileMetadata): string {
    let id: string
    do { id = mintObjectId() } while (
      metadata.profiles.some((profile) => profile.id === id) ||
      metadata.pendingImports.some((pending) => pending.profileId === id) ||
      (metadata.pendingDeletes ?? []).includes(id) || (metadata.views ?? []).some(view => view.id === id) || (metadata.folders ?? []).some(folder => folder.id === id)
    )
    return id
  }

  private async writeMetadata(metadata: BrowserProfileMetadata): Promise<void> {
    const validated = metadataSchema.parse(metadata)
    await mkdir(dirname(this.path), { recursive: true })
    await durableWriteFile(this.path, `${JSON.stringify(validated, null, 2)}\n`)
  }
}
