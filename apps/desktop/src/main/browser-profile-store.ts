import { parseBrowserProfileControlPayload, browserProfileCreationActor, browserProfileCreationCanonical, browserProfileCreationOperationId, parseBrowserProfileCreationReceipt, type BrowserProfileCreationReceipt, type BrowserProfileCreationInspection, type BrowserProfileControlPayload, type AgentMuxNameActor } from '@agentmux/core/control'
import { browserProfileCookieFileRecordSchema, type BrowserProfileCookieFileRecord } from './browser-profile-cookie-file-record.js'
import { browserProfileBookmarksSchema, emptyBookmarks, type BrowserProfileBookmarksState } from './browser-profile-bookmark-record.js'
import { browserProfileExtensionRecordSchema, browserProfileExtensionReceiptSchema, browserProfileExtensionPendingSchema, type BrowserProfileExtensionPending, type BrowserProfileExtensionRecord, type BrowserProfileExtensionReceipt } from './browser-profile-extension-record.js'
import { parseBrowserProxyEdit, parseBrowserProxyAsset, type BrowserProxyAsset, type BrowserProxyEdit, type BrowserProxyBinding, parseBrowserProfileQuery, parseBrowserProfileView, type BrowserProfileView, type BrowserProfileQuery, parseBrowserProfileEnvironment, normalizeBrowserProfileTags, type BrowserProfileEnvironment } from '@agentmux/core/control'
import { parseBrowserProxyProbe, type BrowserProxyProbe, type BrowserProxyProbeHistory } from '@agentmux/core/control'
import { mintObjectId, isObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, readFile, open, lstat, stat } from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { app } from 'electron'
import { durableWriteFile, DurableWriteError } from '@agentmux/core'
import { z } from 'zod'
import { clearsSemanticHues } from '../renderer/src/lib/conversation-avatar-color.js'
import { BROWSER_PROFILE_COOKIE_SKIP_REASONS } from '../shared/browser-profile-import-skip.js'
import { formatBrowserProfileProxyServer, normalizeBrowserProfileNetwork, type BrowserProfileStoredNetwork } from '../shared/browser-profile-network.js'
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
    proxyBinding: z.object({ proxyId: z.string().refine(isObjectId), revision: z.string().refine(isObjectId) }).strict().optional(),
    environment: z.custom<BrowserProfileEnvironment>(value => {
      try { parseBrowserProfileEnvironment(value); return true } catch { return false }
    }, 'Browser Profile environment is invalid').optional(),
    // Stored only when Agents are turned off, so an untouched Profile keeps the global switch's answer.
    cookieFileRecords: z.array(browserProfileCookieFileRecordSchema).optional(),
    bookmarks: browserProfileBookmarksSchema.optional(),
    extensions: z.array(browserProfileExtensionRecordSchema).optional(),
    extensionReceipts: z.array(browserProfileExtensionReceiptSchema).optional(),
    extensionPending: z.array(browserProfileExtensionPendingSchema).optional(),
    agentAccess: z.literal(false).optional()
  })
  .strict()

const proxyAssetSchema = z.unknown().transform((value, context): BrowserProxyAsset => {
  try {
    const asset = parseBrowserProxyAsset(value)
    if (!isObjectId(asset.id) || !isObjectId(asset.revision)) throw new Error('Invalid proxy identity')
    const route = normalizeBrowserProfileNetwork({ mode: 'proxy', server: asset.server, bypass: asset.bypass })
    if (route.mode !== 'proxy' || formatBrowserProfileProxyServer(route.server) !== asset.server) throw new Error('Invalid proxy server')
    return asset
  } catch { context.addIssue({ code: 'custom', message: 'Stored proxy asset is invalid' }); return z.NEVER }
})
const proxyBindingSchema = z.object({ proxyId: z.string().refine(isObjectId), revision: z.string().refine(isObjectId) }).strict()

const pendingImportSchema = z
  .object({
    profileId: profileIdSchema,
    label: profileLabelSchema,
    startedAt: nonNegativeSafeIntegerSchema
  })
  .strict()

const retainedPartitionSchema = z.object({
  partition: z.string().min(1),
  relativePath: z.string().min(1).refine(value => !isAbsolute(value) && !value.split(/[\\/]/u).some(part => !part || part === '..' || part === '.'), 'Retained data must stay inside its original session root')
}).strict()
export type BrowserProfileRetainedPartition = z.infer<typeof retainedPartitionSchema>
const purgeReceiptSchema = z.object({ purgeId: folderIdSchema, archiveId: folderIdSchema, profileId: profileIdSchema,
  status: z.enum(['waiting-for-restart', 'preparing', 'deleting-data', 'erasing-backup', 'failed', 'unknown', 'deleted', 'restored']),
  requestedAt: nonNegativeSafeIntegerSchema, updatedAt: nonNegativeSafeIntegerSchema, warning: z.string().optional(),
  credentialCleanup: z.enum(['pending', 'confirmed', 'unknown']).optional(), permissionCleanup: z.enum(['pending', 'confirmed', 'unknown']).optional() }).strict()
const retentionSchema = z.object({ purgeId: folderIdSchema, deleteAfter: nonNegativeSafeIntegerSchema, approvedAt: nonNegativeSafeIntegerSchema }).strict()
const safetyCopySchema = z.object({ relativePath: retainedPartitionSchema.shape.relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
const trashRecordSchema = z.object({ id: folderIdSchema, revision: z.string().min(1), archivedAt: nonNegativeSafeIntegerSchema,
  profile: profileRecordSchema, data: retainedPartitionSchema, retention: retentionSchema.optional(), purge: purgeReceiptSchema.optional(), safetyCopy: safetyCopySchema.optional() }).strict()
export type BrowserProfileTrashRecord = z.infer<typeof trashRecordSchema>

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
    proxyAssets: z.array(proxyAssetSchema).optional(),
    networkDiagnostics: z.array(z.unknown().transform((value, context): BrowserProxyProbe => {
      try { return parseBrowserProxyProbe(value) }
      catch { context.addIssue({ code: 'custom', message: 'Stored network diagnostic is invalid' }); return z.NEVER }
    })).optional(),
    trash: z.array(trashRecordSchema).optional(),
    /** Completed original purge receipts; they retain no Profile settings or filesystem paths. */
    purgeReceipts: z.array(purgeReceiptSchema.extend({ safetyCopy: safetyCopySchema.optional() }).strict()).optional(),
    creationReceipts: z.array(z.unknown().transform((value, context): BrowserProfileCreationReceipt => {
      try { return parseBrowserProfileCreationReceipt(value) }
      catch { context.addIssue({ code: 'custom', message: 'Original Profile creation receipt is invalid' }); return z.NEVER }
    })).optional(),
    pendingImports: z.array(pendingImportSchema),
    /** Profiles already removed from the list whose site data is not confirmed cleared yet. */
    pendingDeletes: z.array(profileIdSchema).optional()
  })
  .strict()
  .superRefine((metadata, context) => {
    const creationIds = new Set<string>()
    for (const [index, receipt] of (metadata.creationReceipts ?? []).entries()) {
      if (creationIds.has(receipt.operationId)) context.addIssue({ code: 'custom', path: ['creationReceipts', index], message: 'Duplicate original Profile creation operation' })
      creationIds.add(receipt.operationId)
    }
    const proxyIds = new Set<string>()
    for (const [index, proxy] of (metadata.proxyAssets ?? []).entries()) {
      if (proxyIds.has(proxy.id)) context.addIssue({ code: 'custom', path: ['proxyAssets', index, 'id'], message: 'Duplicate proxy identity' })
      proxyIds.add(proxy.id)
    }
    for (const { profile, path } of [...metadata.profiles.map((profile, index) => ({ profile, path: ['profiles', index] })), ...(metadata.trash ?? []).map((entry, index) => ({ profile: entry.profile, path: ['trash', index, 'profile'] }))]) {
      if (profile.proxyBinding && (!proxyIds.has(profile.proxyBinding.proxyId) || profile.network?.mode !== 'proxy')) context.addIssue({ code: 'custom', path: [...path, 'proxyBinding'], message: 'Profile proxy binding is missing its asset or route' })
    }
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
    const archiveIds = new Set<string>()
    for (const [index, archive] of (metadata.trash ?? []).entries()) {
      if (archive.id === archive.profile.id || archiveIds.has(archive.id) || profileIds.has(archive.id) || profileIds.has(archive.profile.id) || archiveIds.has(archive.profile.id) || archive.profile.id === metadata.defaultProfileId || archive.data.partition !== browserProfilePartition(archive.profile.id)) {
        context.addIssue({ code: 'custom', path: ['trash', index], message: 'Archived Profile identity or original data ownership conflicts' })
      }
      archiveIds.add(archive.id); archiveIds.add(archive.profile.id)
      if (archive.purge && (archive.purge.archiveId !== archive.id || archive.purge.profileId !== archive.profile.id || archive.purge.status === 'deleted')) context.addIssue({ code: 'custom', path: ['trash', index, 'purge'], message: 'Purge belongs to another archive' })
      if (archive.safetyCopy && !archive.purge) context.addIssue({ code: 'custom', path: ['trash', index, 'safetyCopy'], message: 'Safety copy needs its original purge intent' })
    }
    const purges = [...(metadata.trash ?? []).flatMap(entry => entry.purge ? [entry.purge] : []), ...(metadata.purgeReceipts ?? [])]
    if (new Set(purges.map(value => value.purgeId)).size !== purges.length || (metadata.purgeReceipts ?? []).some(value => value.status !== 'deleted' && value.status !== 'restored')) context.addIssue({ code: 'custom', path: ['purgeReceipts'], message: 'Purge identities conflict' })
    const pendingIds = new Set<string>()
    for (const [index, pending] of metadata.pendingImports.entries()) {
      if (profileIds.has(pending.profileId) || archiveIds.has(pending.profileId)) {
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
      if (profileIds.has(id) || pendingIds.has(id) || archiveIds.has(id)) {
        context.addIssue({ code: 'custom', path: ['pendingDeletes', index], message: `Deleted Browser Profile is still listed: ${id}` })
      }
      pendingIds.add(id)
    }
  })

type BrowserProfileMetadata = z.infer<typeof metadataSchema>
export type BrowserProfileRecord = z.infer<typeof profileRecordSchema>

export type PendingBrowserProfileImport = z.infer<typeof pendingImportSchema>

/** The whole committed list after one write; the manager replaces its cache with it. */
export type BrowserProfileSnapshot = { cookieFileRecords?: Record<string,BrowserProfileCookieFileRecord[]>; bookmarks?: Record<string, BrowserProfileBookmarksState>; extensionPending?: Record<string, BrowserProfileExtensionPending[]>; extensions?: Record<string, BrowserProfileExtensionRecord[]>; extensionReceipts?: Record<string, BrowserProfileExtensionReceipt[]>; proxyAssets?: BrowserProxyAsset[]; revision: number; sequence: number; profiles: BrowserProfileSummary[]; defaultProfileId: string; folders: BrowserProfileFolder[]; views: BrowserProfileView[]; trash: BrowserProfileTrashRecord[]; purgeReceipts?: import('@agentmux/core/control').BrowserProfilePurgeReceipt[]; legacyPendingDeletes: string[]; activitySources: Record<string, string> }

function cloneImportedSource(source: z.infer<typeof importedSourceSchema> | null): BrowserProfileImportedSource | null {
  if (source === null) return null
  const { skippedByReason, ...rest } = source
  return skippedByReason === undefined ? { ...rest } : { ...rest, skippedByReason: { ...skippedByReason } }
}

function snapshotOf(metadata: BrowserProfileMetadata): BrowserProfileSnapshot {
  const retained = [...metadata.profiles, ...(metadata.trash ?? []).map(entry => entry.profile)]
  const cookieFileRecords=Object.fromEntries(retained.filter(profile=>profile.cookieFileRecords?.length).map(profile=>[profile.id,structuredClone(profile.cookieFileRecords!)]))
  const bookmarks = Object.fromEntries(retained.filter(profile => profile.bookmarks).map(profile => [profile.id, structuredClone(profile.bookmarks!)]))
  const extensions = Object.fromEntries(retained.filter(profile => profile.extensions?.length).map(profile => [profile.id, structuredClone(profile.extensions!)]))
  const extensionPending = Object.fromEntries(retained.filter(profile => profile.extensionPending?.length).map(profile => [profile.id, structuredClone(profile.extensionPending!)]))
  const extensionReceipts = Object.fromEntries(retained.filter(profile => profile.extensionReceipts?.length).map(profile => [profile.id, structuredClone(profile.extensionReceipts!)]))
  return { ...(Object.keys(cookieFileRecords).length?{cookieFileRecords}:{}), ...(Object.keys(bookmarks).length ? { bookmarks } : {}), ...(Object.keys(extensionPending).length ? { extensionPending } : {}), purgeReceipts: structuredClone(metadata.purgeReceipts ?? []), ...(Object.keys(extensions).length ? { extensions } : {}), ...(Object.keys(extensionReceipts).length ? { extensionReceipts } : {}), proxyAssets: structuredClone(metadata.proxyAssets ?? []), legacyPendingDeletes: [...(metadata.pendingDeletes ?? [])], trash: structuredClone(metadata.trash ?? []), activitySources: Object.fromEntries([...metadata.profiles, ...(metadata.trash ?? []).map(entry => entry.profile)].filter(profile => profile.activity).map(profile => [profile.id, profile.activity!.checkpoint.observerId])),
    views: structuredClone(metadata.views ?? []), revision: metadata.revision ?? 0, sequence: metadata.sequence ?? metadata.revision ?? 0, defaultProfileId: metadata.defaultProfileId, folders: (metadata.folders ?? []).map(folder => ({ ...folder })),
    profiles: metadata.profiles.map((profile) => profileSummary(profile, metadata.defaultProfileId)) }
}

export function profileSummary(profile: BrowserProfileRecord, defaultProfileId: string): BrowserProfileSummary {
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
    ...(profile.proxyBinding === undefined ? {} : { proxyBinding: { ...profile.proxyBinding } }),
    ...(profile.environment === undefined ? {} : { environment: structuredClone(profile.environment) }),
    ...(profile.agentAccess === false ? { agentAccess: false as const } : {})
  }
}


/** An opaque current configuration baseline, never an edit count or a root-list version. */
function configurationBytes(profile: BrowserProfileRecord): string {
  const { revision: _revision, activity: _activity, extensionPending: _extensionPending, ...configuration } = profile
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

/** A replacement/readback is not a directory-durability ACK. Snapshot stays inside Main. */
export class BrowserProfileWriteUnconfirmed extends Error {
  readonly code = 'BROWSER_PROFILE_WRITE_UNCONFIRMED'
  constructor(operation: 'recycle' | 'restore' | 'purge' | 'retention', profileId: string, readonly currentSnapshot: BrowserProfileSnapshot | null, cause: unknown) {
    super(`The ${operation} of Profile ${profileId} could not be confirmed. ${cause instanceof DurableWriteError ? cause.phase === 'after-replace' ? 'The metadata replacement applied, but its durable confirmation is missing.' : 'This attempt did not replace the metadata.' : 'The write may already have applied.'} Original data is kept. Read Profiles and Recycled Profiles to confirm the exact identity before explicitly retrying.`, { cause })
  }
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

  /** Read the original file after initialization; missing is unknown, never a new empty catalog. */
  read(): Promise<BrowserProfileSnapshot> { return this.enqueue(async () => snapshotOf(await this.readMetadata())) }

  /** Bounded views over original records. An absent id never certifies that a request did not run. */
  networkHistory(profileId: string, operationId?: string, before?: string): Promise<BrowserProxyProbeHistory> {
    return this.enqueue(async () => {
      const records = (await this.readMetadata()).networkDiagnostics ?? []
      if (operationId) {
        const original = records.find(item => item.id === operationId)
        if (original && original.profileId !== profileId) throw new Error('This diagnostic belongs to another Profile.')
        return { diagnostics: original ? [structuredClone(original)] : [], nextCursor: null }
      }
      const matching = records.filter(item => item.profileId === profileId)
      const end = before === undefined ? matching.length : matching.findIndex(item => item.id === before)
      if (end < 0) throw new Error('The original diagnostic cursor is unavailable; read the current history before continuing.')
      const start = Math.max(0, end - 20), page = matching.slice(start, end).reverse()
      return { diagnostics: structuredClone(page), nextCursor: start > 0 ? page.at(-1)!.id : null }
    })
  }

  recordNetworkDiagnostic(input: BrowserProxyProbe): Promise<BrowserProfileSnapshot> {
    const diagnostic = parseBrowserProxyProbe(input)
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), records = metadata.networkDiagnostics ?? []
      const original = records.find(item => item.id === diagnostic.id)
      if (original) {
        const binding = (value: BrowserProxyProbe) => ({ id: value.id, profileId: value.profileId, configurationRevision: value.configurationRevision, route: value.route, exitOrigin: value.exitOrigin, startedAt: value.startedAt })
        if (!isDeepStrictEqual(binding(original), binding(diagnostic)) || original.phase === 'observed') throw new Error('The original diagnostic binding is immutable; inspect its original operation id.')
      } else {
        const profile = metadata.profiles.find(item => item.id === diagnostic.profileId)
        if (!profile || profileConfigurationRevision(profile) !== diagnostic.configurationRevision || diagnostic.phase !== 'pending') throw new Error('The original Profile configuration changed before this diagnostic was registered.')
      }
      return await this.commit({ ...metadata, networkDiagnostics: original ? records.map(item => item.id === original.id ? diagnostic : item) : [...records, diagnostic] }, false)
    })
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
      const current = metadata.profiles.find(profile => profile.id === profileId) ?? metadata.trash?.find(entry => entry.profile.id === profileId)?.profile
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
      return this.commit({ ...metadata, profiles: metadata.profiles.map(profile => profile.id === profileId ? { ...profile, activity } : profile),
        ...(metadata.trash ? { trash: metadata.trash.map(entry => entry.profile.id === profileId ? { ...entry, profile: { ...entry.profile, activity } } : entry) } : {}) }, false)
    })
  }

  updateProfile(profileId: string, edit: BrowserProfileEdit, expectedRevision: string, binding?: BrowserProxyBinding): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
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
      if (edit.network !== undefined) delete updated.proxyBinding
      if (binding !== undefined) {
        const target = proxyBindingSchema.parse(binding)
        const proxy = this.exactProxy(metadata, target.proxyId, target.revision)
        const route = normalizeBrowserProfileNetwork(edit.network)
        const assetRoute = normalizeBrowserProfileNetwork({ mode: 'proxy', server: proxy.server, bypass: proxy.bypass })
        if (JSON.stringify(route) !== JSON.stringify(assetRoute)) throw new Error('Proxy assignment must apply the exact asset route')
        updated.proxyBinding = target
      }
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

  /** Durable dispatch intent belongs to the original Profile metadata, before any native effect. */
  beginExtensionChange(profileId: string, expectedRevision: string, pending: BrowserProfileExtensionPending): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), current = metadata.profiles.find(profile => profile.id === profileId)
      if (!current) throw new Error('The original Browser Profile is unavailable.')
      this.assertProfileRevision(current, expectedRevision)
      const intent = browserProfileExtensionPendingSchema.parse(pending)
      if (intent.profileId !== profileId || intent.expectedRevision !== expectedRevision) throw new Error('The extension intent names a different original Profile.')
      if (current.extensionPending?.some(value => value.operationId === intent.operationId) || current.extensionReceipts?.some(value => value.operationId === intent.operationId)) throw new Error('This original extension operation already has a durable intent or receipt.')
      const updated = { ...current, extensionPending: [...(current.extensionPending ?? []), intent] }
      return this.commit({ ...metadata, profiles: metadata.profiles.map(profile => profile.id === profileId ? updated : profile) }, false, undefined, true)
    })
  }

  /** Original Profile transaction owns safe Cookie operation records; no Cookie values are stored. */
  changeCookieFiles(profileId:string,action:(records:BrowserProfileCookieFileRecord[])=>BrowserProfileCookieFileRecord[]):Promise<BrowserProfileSnapshot>{
    return this.enqueue(async()=>{
      const metadata=await this.readMetadata(),current=metadata.profiles.find(profile=>profile.id===profileId)
      if(!current)throw new Error('The original Browser Profile is unavailable.')
      const records=z.array(browserProfileCookieFileRecordSchema).parse(action(structuredClone(current.cookieFileRecords??[])))
      if(records.some(r=>r.receipt.profileId!==profileId)||new Set(records.map(r=>r.receipt.operationId)).size!==records.length)throw new Error('Cookie file operation identities do not match the original Profile.')
      const updated={...current,revision:profileConfigurationRevision(current),cookieFileRecords:records}
      return this.commit({...metadata,profiles:metadata.profiles.map(profile=>profile.id===profileId?updated:profile)},false,undefined,true)
    })
  }

  /** Bookmarks share the original metadata writer; native dispatch intents require directory ACK. */
  changeBookmarks(profileId: string, action: (state: BrowserProfileBookmarksState) => BrowserProfileBookmarksState, durable = false): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), current = metadata.profiles.find(profile => profile.id === profileId)
      if (!current) throw new Error('The original Browser Profile is unavailable.')
      const bookmarks = browserProfileBookmarksSchema.parse(action(structuredClone(current.bookmarks ?? emptyBookmarks())))
      const changed = bookmarks.revision !== (current.bookmarks?.revision ?? 'empty')
      const updated = { ...current, revision: changed ? mintObjectId() : profileConfigurationRevision(current), bookmarks }
      return this.commit({ ...metadata, profiles: metadata.profiles.map(profile => profile.id === profileId ? updated : profile) }, changed, undefined, durable)
    })
  }

  /** Extension changes use the original Profile transaction and configuration token. */
  setExtensions(profileId: string, expectedRevision: string, extensions: BrowserProfileExtensionRecord[], receipt: BrowserProfileExtensionReceipt): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), current = metadata.profiles.find(profile => profile.id === profileId)
      if (!current) throw new Error('The original Browser Profile is unavailable.')
      this.assertProfileRevision(current, expectedRevision)
      const records = z.array(browserProfileExtensionRecordSchema).parse(extensions), saved = browserProfileExtensionReceiptSchema.parse(receipt)
      if (saved.profileId !== profileId || new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.nativeId)).size !== records.length) throw new Error('Extension identities do not match this Profile.')
      const previous = current.extensionReceipts?.find(value => value.operationId === saved.operationId)
      if (previous) {
        if (!isDeepStrictEqual(previous, saved)) throw new Error('This original extension operation belongs to a different request.')
        return snapshotOf(metadata)
      }
      const intent = current.extensionPending?.find(value => value.operationId === saved.operationId)
      if (!intent || intent.extensionId !== saved.extensionId || intent.kind !== saved.kind || intent.sha256 !== saved.sha256 || intent.profileId !== saved.profileId) throw new Error('The original durable extension dispatch intent is unavailable or different.')
      const updated = { ...current, revision: mintObjectId(), extensionPending: current.extensionPending!.filter(value => value.operationId !== saved.operationId), extensions: records, extensionReceipts: [...(current.extensionReceipts ?? []), saved] }
      return this.commit({ ...metadata, profiles: metadata.profiles.map(profile => profile.id === profileId ? updated : profile) }, true, undefined, true)
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

  private creationRequest(input: Extract<BrowserProfileControlPayload, { operation: import('@agentmux/core/control').BrowserProfileCreationOperation }>, given: AgentMuxNameActor | undefined) {
    const actor = browserProfileCreationActor(given), operationId = browserProfileCreationOperationId(input.operationId)
    const normalized = parseBrowserProfileControlPayload(input as unknown as Record<string, unknown>, ['operation', 'schemaVersion', 'requestId']) as typeof input
    if ('label' in normalized) normalized.label = validateBrowserProfileLabel(normalized.label)
    if (normalized.operation === 'browser.profile.view.create') normalized.query = parseBrowserProfileQuery(normalized.query)
    if (normalized.operation === 'browser.profile.proxy.create') normalized.edit = parseBrowserProxyEdit(normalized.edit)
    const requestDigest = 'sha256:' + createHash('sha256').update(browserProfileCreationCanonical({ actor, input: normalized })).digest('hex')
    return { actor, operationId, normalized, requestDigest }
  }

  /** All five new-identity actions commit their fixed producer receipt beside the identity. */
  createIdentity(input: Extract<BrowserProfileControlPayload, { operation: import('@agentmux/core/control').BrowserProfileCreationOperation }>, given: AgentMuxNameActor | undefined): Promise<{ snapshot: BrowserProfileSnapshot; creation: BrowserProfileCreationInspection }> {
    const { actor, operationId, normalized, requestDigest } = this.creationRequest(input, given)
    return this.enqueue(async () => {
      const metadata = normalized.operation === 'browser.profile.create' ? await this.readOrInitialize() : await this.readMetadata()
      const previous = (metadata.creationReceipts ?? []).find(value => value.operationId === operationId)
      if (previous) {
        if (previous.requestDigest !== requestDigest || !isDeepStrictEqual(previous.actor, actor) || previous.action !== normalized.operation)
          throw Object.assign(new Error('This Profile creation operation belongs to a different original actor or request. Keep the original identity and inspect its receipt.'), { code: 'BROWSER_PROFILE_CREATION_CONFLICT' })
        return this.confirmCreationMetadata(metadata, previous, actor)
      }
      const id = this.createUnusedProfileId(metadata), committedAt = Date.now()
      let next = metadata, kind: BrowserProfileCreationReceipt['createdKind']
      switch (normalized.operation) {
        case 'browser.profile.create': {
          kind = 'profile'
          const profile: BrowserProfileRecord = { id, label: normalized.label, createdAt: committedAt, source: null }
          next = { ...metadata, profiles: [...metadata.profiles, profile] }; break
        }
        case 'browser.profile.copy': {
          kind = 'profile'
          const original = metadata.profiles.find(value => value.id === normalized.profileId)
          if (!original) throw Object.assign(new Error('The exact source Profile is unavailable. Its original creation receipt remains queryable.'), { code: 'BROWSER_PROFILE_NOT_FOUND' })
          this.assertProfileRevision(original, normalized.expectedRevision)
          const profile: BrowserProfileRecord = { revision: mintObjectId(), id, label: normalized.label, createdAt: committedAt, source: null,
            ...(original.hue === undefined ? {} : { hue: original.hue }), ...(original.notes === undefined ? {} : { notes: original.notes }),
            ...(original.tags === undefined ? {} : { tags: [...original.tags] }), ...(original.folderId === undefined ? {} : { folderId: original.folderId }),
            ...(original.network === undefined ? {} : { network: structuredClone(original.network) }),
            ...(original.proxyBinding === undefined ? {} : { proxyBinding: { ...original.proxyBinding } }),
            ...(original.environment === undefined ? {} : { environment: structuredClone(original.environment) }),
            ...(original.agentAccess === false ? { agentAccess: false as const } : {}) }
          next = { ...metadata, profiles: [...metadata.profiles, profile] }; break
        }
        case 'browser.profile.folder.create':
          kind = 'folder'; this.assertRevision(metadata, normalized.expectedRevision)
          next = { ...metadata, folders: [...(metadata.folders ?? []), { id, label: normalized.label }] }; break
        case 'browser.profile.view.create':
          kind = 'view'; this.assertRevision(metadata, normalized.expectedRevision)
          next = { ...metadata, views: [...(metadata.views ?? []), { id, label: normalized.label, query: normalized.query }] }; break
        case 'browser.profile.proxy.create': {
          kind = 'proxy'
          const edit = normalized.edit, route = normalizeBrowserProfileNetwork({ mode: 'proxy', server: edit.server, bypass: edit.bypass })
          if (route.mode !== 'proxy') throw new Error('A proxy asset needs a proxy route')
          const proxy = { id, revision: mintObjectId(), label: edit.label, server: formatBrowserProfileProxyServer(route.server), ...(route.bypass?.length ? { bypass: route.bypass } : {}), ...(edit.notes ? { notes: edit.notes } : {}) }
          next = { ...metadata, proxyAssets: [...(metadata.proxyAssets ?? []), proxy] }; break
        }
      }
      const receipt: BrowserProfileCreationReceipt = { operationId, actor, action: normalized.operation, requestDigest, createdId: id, createdKind: kind!, committedAt,
        ...(normalized.operation === 'browser.profile.copy' ? { source: { profileId: normalized.profileId, expectedRevision: normalized.expectedRevision } } : {}),
        ...(normalized.operation === 'browser.profile.folder.create' || normalized.operation === 'browser.profile.view.create' ? { expectedCollectionRevision: normalized.expectedRevision } : {}) }
      next = { ...next, creationReceipts: [...(metadata.creationReceipts ?? []), receipt] }
      const snapshot = await this.commit(next, true, undefined, true)
      return { snapshot, creation: { ...this.creationObservation(next, operationId, actor), durability: 'confirmed' as const, confirmation: 'original-write' as const } }
    })
  }

  /** Explicit existing-request confirmation can never enter a new-identity branch. */
  confirmIdentity(input: Extract<BrowserProfileControlPayload, { operation: import('@agentmux/core/control').BrowserProfileCreationOperation }>, given: AgentMuxNameActor | undefined): Promise<{ snapshot: BrowserProfileSnapshot; creation: BrowserProfileCreationInspection }> {
    const { actor, operationId, normalized, requestDigest } = this.creationRequest(input, given)
    return this.enqueue(async () => {
      const metadata = await this.readMetadata()
      const receipt = (metadata.creationReceipts ?? []).find(value => value.operationId === operationId)
      if (!receipt) throw Object.assign(new Error('No original creation receipt is observed. Confirmation did not create an identity; retain the original request.'), { code: 'BROWSER_PROFILE_CREATION_NOT_OBSERVED' })
      if (receipt.requestDigest !== requestDigest || !isDeepStrictEqual(receipt.actor, actor) || receipt.action !== normalized.operation)
        throw Object.assign(new Error('The original creation belongs to another actor or request.'), { code: 'BROWSER_PROFILE_CREATION_CONFLICT' })
      return this.confirmCreationMetadata(metadata, receipt, actor)
    })
  }

  private fileWitness(info: BigIntStats): string {
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  }

  /** Confirm the currently retained original record; this never claims that a historical reply arrived. */
  private async confirmCreationMetadata(expected: BrowserProfileMetadata, receipt: BrowserProfileCreationReceipt, actor: AgentMuxNameActor): Promise<{ snapshot: BrowserProfileSnapshot; creation: BrowserProfileCreationInspection }> {
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true }), raw = await file.readFile('utf8')
      const current = metadataSchema.parse(JSON.parse(raw))
      if (!before.isFile() || !isDeepStrictEqual(current, expected)) throw new Error('The original metadata changed before confirmation.')
      await file.sync()
      const directory = await open(dirname(this.path), 'r')
      try {
        const parent = await directory.stat({ bigint: true })
        await directory.sync()
        const named = await lstat(this.path, { bigint: true }), after = await file.stat({ bigint: true })
        const finalRaw = await readFile(this.path, 'utf8'), finalNamed = await lstat(this.path, { bigint: true })
        const finalParent = await stat(dirname(this.path), { bigint: true })
        if (this.fileWitness(before) !== this.fileWitness(named) || this.fileWitness(before) !== this.fileWitness(after) ||
          this.fileWitness(before) !== this.fileWitness(finalNamed) || finalRaw !== raw || parent.dev !== finalParent.dev || parent.ino !== finalParent.ino)
          throw new Error('The original metadata file or parent witness changed during confirmation.')
        const final = metadataSchema.parse(JSON.parse(finalRaw))
        const original = (final.creationReceipts ?? []).find(value => value.operationId === receipt.operationId)
        if (!isDeepStrictEqual(original, receipt)) throw new Error('The original creation receipt changed during confirmation.')
        return { snapshot: snapshotOf(final), creation: { ...this.creationObservation(final, receipt.operationId, actor), durability: 'confirmed', confirmation: 'current-metadata-sync' } }
      } finally { await directory.close() }
    } catch (cause) {
      throw Object.assign(new Error('The original creation storage confirmation is unconfirmed. No identity was created or replayed. ' + (cause instanceof Error ? cause.message : String(cause)), { cause }), { code: 'BROWSER_PROFILE_CREATION_UNCONFIRMED' })
    } finally { await file.close() }
  }

  inspectCreation(operationId: string, given: AgentMuxNameActor | undefined): Promise<BrowserProfileCreationInspection> {
    return this.readCreation(operationId, given).then(result => result.creation)
  }

  readCreation(operationId: string, given: AgentMuxNameActor | undefined): Promise<{ snapshot: BrowserProfileSnapshot; creation: BrowserProfileCreationInspection }> {
    const actor = browserProfileCreationActor(given)
    browserProfileCreationOperationId(operationId)
    return this.enqueue(async () => {
      const metadata = await this.readMetadata()
      return { snapshot: snapshotOf(metadata), creation: this.creationObservation(metadata, operationId, actor) }
    })
  }

  private creationObservation(metadata: BrowserProfileMetadata, operationId: string, actor: AgentMuxNameActor): BrowserProfileCreationInspection {
    const receipt = (metadata.creationReceipts ?? []).find(value => value.operationId === operationId)
    if (receipt && actor.kind === 'agent' && !isDeepStrictEqual(receipt.actor, actor))
      throw Object.assign(new Error('A managed Agent may inspect only its own original Profile creation.'), { code: 'CONTROL_PERMISSION_DENIED' })
    if (!receipt) return { operationId, receipt: null, current: { state: 'unknown' }, durability: 'unconfirmed', confirmation: 'observation' }
    const id = receipt.createdId
    const present = receipt.createdKind === 'profile' ? metadata.profiles.some(value => value.id === id)
      : receipt.createdKind === 'folder' ? (metadata.folders ?? []).some(value => value.id === id)
      : receipt.createdKind === 'view' ? (metadata.views ?? []).some(value => value.id === id)
      : (metadata.proxyAssets ?? []).some(value => value.id === id)
    const archived = receipt.createdKind === 'profile' && (metadata.trash ?? []).some(value => value.profile.id === id)
    return { operationId, receipt: structuredClone(receipt), current: { createdId: id, state: present ? 'present' : archived ? 'archived' : 'removed' }, durability: 'unconfirmed', confirmation: 'observation' }
  }

  async createProfile(label: string, operationId: string, actor: AgentMuxNameActor): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    const result = await this.createIdentity({ operation: 'browser.profile.create', label, operationId }, actor)
    const profile = result.snapshot.profiles.find(value => value.id === result.creation.receipt!.createdId)
    if (!profile) throw new Error('The created Profile is now removed. Inspect the original creation operation.')
    return { snapshot: result.snapshot, profile }
  }

  async copyProfile(profileId: string, label: string, expectedRevision: string, operationId: string, actor: AgentMuxNameActor): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    const result = await this.createIdentity({ operation: 'browser.profile.copy', profileId, label, expectedRevision, operationId }, actor)
    const profile = result.snapshot.profiles.find(value => value.id === result.creation.receipt!.createdId)
    if (!profile) throw new Error('The copied Profile is now removed. Inspect the original creation operation.')
    return { snapshot: result.snapshot, profile }
  }

  inspectProxy(proxyId: string, expectedRevision: string): Promise<BrowserProxyAsset> {
    return this.enqueue(async () => structuredClone(this.exactProxy(await this.readMetadata(), proxyId, expectedRevision)))
  }

  saveProxy(editInput: BrowserProxyEdit, proxyId?: string, expectedRevision?: string, creation?: { operationId: string; actor: AgentMuxNameActor }): Promise<{ snapshot: BrowserProfileSnapshot; proxy: BrowserProxyAsset }> {
    if (proxyId === undefined && creation) return this.createIdentity({ operation: 'browser.profile.proxy.create', operationId: creation.operationId, edit: editInput }, creation.actor).then(result => {
      const proxy = result.snapshot.proxyAssets!.find(value => value.id === result.creation.receipt!.createdId)
      if (!proxy) throw new Error('The original created proxy is removed. Inspect its creation receipt.')
      return { snapshot: result.snapshot, proxy }
    })
    return this.enqueue(async () => {
      if (proxyId === undefined) throw new Error('New proxy identities require createIdentity with the original operation and actor.')
      if ((proxyId === undefined) !== (expectedRevision === undefined)) throw Object.assign(new Error('Proxy updates need both the original asset identity and its configuration token. Create supplies neither.'), { code: 'BROWSER_PROXY_ARGUMENT_INVALID' })
      const edit = parseBrowserProxyEdit(editInput), metadata = await this.readMetadata()
      if (proxyId !== undefined) this.exactProxy(metadata, proxyId, expectedRevision!)
      const route = normalizeBrowserProfileNetwork({ mode: 'proxy', server: edit.server, bypass: edit.bypass })
      if (route.mode !== 'proxy') throw new Error('A proxy asset needs a proxy route')
      const proxy: BrowserProxyAsset = { id: proxyId ?? this.createUnusedProfileId(metadata), revision: mintObjectId(), label: edit.label, server: formatBrowserProfileProxyServer(route.server), ...(route.bypass?.length ? { bypass: route.bypass } : {}), ...(edit.notes ? { notes: edit.notes } : {}) }
      const assets = metadata.proxyAssets ?? []
      const snapshot = await this.commit({ ...metadata, proxyAssets: proxyId === undefined ? [...assets, proxy] : assets.map(item => item.id === proxyId ? proxy : item) })
      return { snapshot, proxy: structuredClone(proxy) }
    })
  }

  deleteProxy(proxyId: string, expectedRevision: string): Promise<BrowserProfileSnapshot> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata()
      this.exactProxy(metadata, proxyId, expectedRevision)
      if ([...metadata.profiles, ...(metadata.trash ?? []).map(entry => entry.profile)].some(profile => profile.proxyBinding?.proxyId === proxyId)) throw Object.assign(new Error('This proxy is still bound to an active or recycled Profile. Keep it or explicitly change those routes first.'), { code: 'BROWSER_PROXY_IN_USE' })
      return this.commit({ ...metadata, proxyAssets: (metadata.proxyAssets ?? []).filter(proxy => proxy.id !== proxyId) })
    })
  }

  private exactProxy(metadata: BrowserProfileMetadata, proxyId: string, expectedRevision: string): BrowserProxyAsset {
    const proxy = (metadata.proxyAssets ?? []).find(item => item.id === proxyId)
    if (!proxy) throw Object.assign(new Error('The exact proxy asset is unavailable. Read the library before changing it.'), { code: 'BROWSER_PROXY_NOT_FOUND' })
    if (proxy.revision !== expectedRevision) throw Object.assign(new Error('The proxy asset changed. Inspect its current configuration before assigning or editing it.'), { code: 'BROWSER_PROXY_REVISION_CONFLICT' })
    return proxy
  }

  saveView(label: string, query: BrowserProfileQuery, expectedRevision: number, viewId?: string, creation?: { operationId: string; actor: AgentMuxNameActor }): Promise<{ snapshot: BrowserProfileSnapshot; view: BrowserProfileView }> {
    if (viewId === undefined && creation) return this.createIdentity({ operation: 'browser.profile.view.create', operationId: creation.operationId, label, query, expectedRevision }, creation.actor).then(result => {
      const view = result.snapshot.views.find(value => value.id === result.creation.receipt!.createdId)
      if (!view) throw new Error('The original created view is removed. Inspect its creation receipt.')
      return { snapshot: result.snapshot, view }
    })
    return this.enqueue(async () => {
      const name = validateBrowserProfileLabel(label), definition = parseBrowserProfileQuery(query), metadata = await this.readMetadata()
      if (viewId === undefined) throw new Error('New view identities require createIdentity with the original operation and actor.')
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

  async createFolder(label: string, expectedRevision: number, operationId: string, actor: AgentMuxNameActor): Promise<{ snapshot: BrowserProfileSnapshot; folder: BrowserProfileFolder }> {
    const result = await this.createIdentity({ operation: 'browser.profile.folder.create', label, expectedRevision, operationId }, actor)
    const folder = result.snapshot.folders.find(value => value.id === result.creation.receipt!.createdId)
    if (!folder) throw new Error('The created folder is now removed. Inspect the original creation operation.')
    return { snapshot: result.snapshot, folder }
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

  archiveProfile(profileId: string, expectedRevision: string, data: BrowserProfileRetainedPartition): Promise<{ snapshot: BrowserProfileSnapshot; archive: BrowserProfileTrashRecord }> {
    return this.enqueue(async () => {
      const id = profileIdSchema.parse(profileId), held = retainedPartitionSchema.parse(data), metadata = await this.readMetadata()
      if (metadata.defaultProfileId === id) throw new Error('The default Browser Profile cannot be recycled')
      const profile = metadata.profiles.find(value => value.id === id)
      if (!profile) throw new Error(`Unknown active Browser Profile: ${id}`)
      this.assertProfileRevision(profile, expectedRevision)
      if (held.partition !== browserProfilePartition(id)) throw new Error('Retained data belongs to another Profile')
      const archive: BrowserProfileTrashRecord = { id: this.createUnusedProfileId(metadata), revision: mintObjectId(), archivedAt: Date.now(), profile: structuredClone(profile), data: held }
      const snapshot = await this.commit({ ...metadata, profiles: metadata.profiles.filter(value => value.id !== id), trash: [...(metadata.trash ?? []), archive] }, true, { operation: 'recycle', profileId: id })
      return { snapshot, archive: structuredClone(archive) }
    })
  }

  inspectArchive(archiveId: string): Promise<{ snapshot: BrowserProfileSnapshot; archive: BrowserProfileTrashRecord }> {
    return this.enqueue(async () => {
      const id = folderIdSchema.parse(archiveId), metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === id)
      if (!archive) throw new Error(`Unknown archived Profile: ${id}`)
      return { snapshot: snapshotOf(metadata), archive: structuredClone(archive) }
    })
  }

  setArchiveRetention(archiveId: string, expectedRevision: string, retention: BrowserProfileTrashRecord['retention']): Promise<{ snapshot: BrowserProfileSnapshot; archive: BrowserProfileTrashRecord }> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === archiveId)
      if (!archive) throw new Error('The exact recycled Profile is unavailable.')
      if (archive.revision !== expectedRevision) throw new BrowserProfileConfigurationConflict(archive.revision)
      if (archive.purge) throw new Error('This entry already has an original deletion intent. Inspect it or restore this Profile before choosing a new retention period.')
      if (retention && (metadata.trash?.some(value => value.id !== archiveId && (value.purge?.purgeId === retention.purgeId || value.retention?.purgeId === retention.purgeId)) || metadata.purgeReceipts?.some(value => value.purgeId === retention.purgeId))) throw new Error('This deletion ID already belongs to another original action.')
      if (retention) archive.retention = retentionSchema.parse(retention)
      else delete archive.retention
      archive.revision = mintObjectId()
      const snapshot = await this.commit(metadata, true, { operation: 'retention', profileId: archive.profile.id })
      return { snapshot, archive: structuredClone(archive) }
    })
  }

  beginArchivePurge(archiveId: string, expectedRevision: string, purgeId: string, now: number): Promise<{ snapshot: BrowserProfileSnapshot; archive: BrowserProfileTrashRecord }> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === archiveId)
      if (!archive) throw new Error('The exact recycled Profile is unavailable. Inspect the original purge ID; no deletion was replayed.')
      if (archive.purge) {
        if (archive.purge.purgeId !== purgeId) throw new Error('This entry already has a deletion intent. Keep and inspect its original purge ID.')
        return { snapshot: snapshotOf(metadata), archive: structuredClone(archive) }
      }
      if (archive.revision !== expectedRevision) throw new BrowserProfileConfigurationConflict(archive.revision)
      if (metadata.trash?.some(value => value.id !== archiveId && (value.purge?.purgeId === purgeId || value.retention?.purgeId === purgeId)) || metadata.purgeReceipts?.some(value => value.purgeId === purgeId)) throw new Error('This purge ID already belongs to another original action.')
      archive.purge = purgeReceiptSchema.parse({ purgeId, archiveId, profileId: archive.profile.id, status: 'waiting-for-restart', requestedAt: now, updatedAt: now })
      archive.revision = mintObjectId()
      const snapshot = await this.commit(metadata, true, { operation: 'purge', profileId: archive.profile.id })
      return { snapshot, archive: structuredClone(archive) }
    })
  }

  updateArchivePurge(archiveId: string, purgeId: string, status: import('@agentmux/core/control').BrowserProfilePurgeStatus, now: number,
    extra: { warning?: string; safetyCopy?: BrowserProfileTrashRecord['safetyCopy'] } = {}): Promise<{ snapshot: BrowserProfileSnapshot; archive: BrowserProfileTrashRecord }> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === archiveId)
      if (!archive?.purge || archive.purge.purgeId !== purgeId) throw new Error('The original deletion intent changed. No further cleanup was sent.')
      archive.purge = purgeReceiptSchema.parse({ ...archive.purge, status, updatedAt: now, ...(extra.warning ? { warning: extra.warning } : {}) })
      if (extra.safetyCopy) archive.safetyCopy = safetyCopySchema.parse(extra.safetyCopy)
      archive.revision = mintObjectId()
      const snapshot = await this.commit(metadata, true, { operation: 'purge', profileId: archive.profile.id })
      return { snapshot, archive: structuredClone(archive) }
    })
  }

  completeArchivePurge(archiveId: string, purgeId: string, now: number): Promise<{ snapshot: BrowserProfileSnapshot; purge: import('@agentmux/core/control').BrowserProfilePurgeReceipt }> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === archiveId)
      if (!archive?.purge || archive.purge.purgeId !== purgeId || archive.purge.status !== 'erasing-backup') throw new Error('The original purge has no confirmed final cleanup stage.')
      const purge = purgeReceiptSchema.parse({ ...archive.purge, status: 'deleted', updatedAt: now, credentialCleanup: 'pending', permissionCleanup: 'pending' })
      delete purge.warning
      const prior = (metadata.purgeReceipts ?? []).map(receipt => { if (receipt.profileId !== archive.profile.id) return receipt; const { safetyCopy: _held, ...history } = receipt; return history })
      const snapshot = await this.commit({ ...metadata, trash: metadata.trash!.filter(value => value.id !== archiveId), purgeReceipts: [...prior, purge] }, true, { operation: 'purge', profileId: archive.profile.id })
      return { snapshot, purge }
    })
  }

  inspectPurge(purgeId: string): Promise<import('@agentmux/core/control').BrowserProfilePurgeReceipt | null> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata()
      const result = metadata.trash?.find(value => value.purge?.purgeId === purgeId)?.purge ?? metadata.purgeReceipts?.find(value => value.purgeId === purgeId) ?? null
      if (!result) return null
      const { safetyCopy: _held, ...receipt } = result as typeof result & { safetyCopy?: unknown }
      return purgeReceiptSchema.parse(receipt)
    })
  }

  updatePurgeOwners(purgeId: string, owners: { credentialCleanup: 'confirmed' | 'unknown'; permissionCleanup: 'confirmed' | 'unknown' }): Promise<import('@agentmux/core/control').BrowserProfilePurgeReceipt> {
    return this.enqueue(async () => {
      const metadata = await this.readMetadata(), receipt = metadata.purgeReceipts?.find(value => value.purgeId === purgeId && value.status === 'deleted')
      if (!receipt) throw new Error('The original completed purge receipt is unavailable. Other cleanup was not repeated.')
      Object.assign(receipt, owners)
      await this.commit(metadata, false, { operation: 'purge', profileId: receipt.profileId })
      return purgeReceiptSchema.parse(receipt)
    })
  }

  priorPurgeCopies(profileId: string): Promise<{ archiveId: string; purgeId: string }[]> {
    return this.enqueue(async () => (await this.readMetadata()).purgeReceipts?.filter(value => value.profileId === profileId && value.status === 'restored').map(value => ({ archiveId: value.archiveId, purgeId: value.purgeId })) ?? [])
  }

  restoreProfile(archiveId: string, expectedRevision: string, folderOverride?: string | null): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const id = folderIdSchema.parse(archiveId), metadata = await this.readMetadata(), archive = metadata.trash?.find(value => value.id === id)
      if (!archive) throw new Error(`Unknown archived Profile: ${id}`)
      if (archive.revision !== expectedRevision) throw new BrowserProfileConfigurationConflict(archive.revision)
      if (metadata.profiles.some(profile => profile.id === archive.profile.id) || metadata.pendingImports.some(pending => pending.profileId === archive.profile.id) || metadata.pendingDeletes?.includes(archive.profile.id)) throw new Error('The original Profile identity is already owned. Nothing was overwritten.')
      const profile: BrowserProfileRecord = { ...structuredClone(archive.profile), revision: mintObjectId() }
      if (folderOverride === null) delete profile.folderId
      else if (folderOverride !== undefined) profile.folderId = folderIdSchema.parse(folderOverride)
      if (profile.folderId !== undefined && !(metadata.folders ?? []).some(folder => folder.id === profile.folderId)) throw Object.assign(new Error('The original folder is unavailable. Explicitly choose a current folder or restore unfiled; the archive is kept.'), { code: 'BROWSER_PROFILE_RESTORE_FOLDER_CONFLICT' })
      const retainedCopy = archive.purge ? { ...archive.purge, status: 'restored' as const, updatedAt: Date.now(), ...(archive.safetyCopy ? { safetyCopy: archive.safetyCopy } : {}) } : undefined
      const snapshot = await this.commit({ ...metadata, profiles: [...metadata.profiles, profile], trash: metadata.trash!.filter(value => value.id !== id),
        ...(retainedCopy ? { purgeReceipts: [...(metadata.purgeReceipts ?? []), retainedCopy] } : {}) }, true, { operation: 'restore', profileId: archive.profile.id })
      return { snapshot, profile: profileSummary(profile, metadata.defaultProfileId) }
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
  private async commit(metadata: BrowserProfileMetadata, configuration = true, retirement?: { operation: 'recycle' | 'restore' | 'purge' | 'retention'; profileId: string }, requireDirectorySync = false): Promise<BrowserProfileSnapshot> {
    const next = metadataSchema.parse({ ...metadata, revision: (metadata.revision ?? 0) + (configuration ? 1 : 0), sequence: (metadata.sequence ?? metadata.revision ?? 0) + 1 })
    try { await this.writeMetadata(next, retirement !== undefined || requireDirectorySync) }
    catch (cause) {
      if (!retirement) throw cause
      // The original producer's replacement fact survives a missing directory ACK. Prefer an
      // authoritative current read when available, within the same Store queue. Neither is a
      // power-loss durability confirmation, and an unreadable original file is never initialized.
      let current = cause instanceof DurableWriteError && cause.phase === 'after-replace' ? snapshotOf(next) : null
      try { current = snapshotOf(await this.readMetadata()) } catch { /* Keep the exact last producer fact, or unknown. */ }
      throw new BrowserProfileWriteUnconfirmed(retirement.operation, retirement.profileId, current, cause)
    }
    return snapshotOf(next)
  }

  private createUnusedProfileId(metadata: BrowserProfileMetadata): string {
    let id: string
    do { id = mintObjectId() } while (
      metadata.profiles.some((profile) => profile.id === id) ||
      metadata.pendingImports.some((pending) => pending.profileId === id) ||
      (metadata.creationReceipts ?? []).some(receipt => receipt.createdId === id) || (metadata.proxyAssets ?? []).some(proxy => proxy.id === id) || (metadata.pendingDeletes ?? []).includes(id) || (metadata.trash ?? []).some(entry => entry.id === id || entry.profile.id === id) || (metadata.purgeReceipts ?? []).some(value => value.profileId === id || value.archiveId === id || value.purgeId === id) || (metadata.views ?? []).some(view => view.id === id) || (metadata.folders ?? []).some(folder => folder.id === id)
    )
    return id
  }

  private async writeMetadata(metadata: BrowserProfileMetadata, requireDirectorySync = false): Promise<void> {
    const validated = metadataSchema.parse(metadata)
    await mkdir(dirname(this.path), { recursive: true })
    await durableWriteFile(this.path, `${JSON.stringify(validated, null, 2)}\n`, { requireDirectorySync })
  }
}
