import { mintObjectId, isObjectId } from '@agentmux/core/object-id'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { durableWriteFile } from '@agentmux/core'
import { z } from 'zod'
import { clearsSemanticHues } from '../renderer/src/lib/conversation-avatar-color.js'
import type {
  BrowserProfileEdit,
  BrowserProfileImportedSource,
  BrowserProfileSummary
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

const importedSourceSchema = z
  .object({
    browserLabel: profileLabelSchema,
    profileLabel: profileLabelSchema,
    importedAt: nonNegativeSafeIntegerSchema,
    importedCookies: nonNegativeSafeIntegerSchema,
    skippedCookies: nonNegativeSafeIntegerSchema
  })
  .strict()

const profileRecordSchema = z
  .object({
    id: profileIdSchema,
    label: profileLabelSchema,
    createdAt: nonNegativeSafeIntegerSchema,
    source: importedSourceSchema.nullable(),
    hue: profileHueSchema.optional(),
    notes: profileNotesSchema.optional()
  })
  .strict()

const pendingImportSchema = z
  .object({
    profileId: profileIdSchema,
    label: profileLabelSchema,
    startedAt: nonNegativeSafeIntegerSchema
  })
  .strict()

const metadataSchema = z
  .object({
    version: z.literal(BROWSER_PROFILE_METADATA_VERSION),
    /** Advances on every committed change; readers order snapshots and writers state what they edited. */
    revision: nonNegativeSafeIntegerSchema.optional(),
    defaultProfileId: profileIdSchema,
    profiles: z.array(profileRecordSchema).min(1),
    pendingImports: z.array(pendingImportSchema)
  })
  .strict()
  .superRefine((metadata, context) => {
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
    }
    if (!profileIds.has(metadata.defaultProfileId)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultProfileId'],
        message: 'Default Browser Profile must identify a persisted Profile'
      })
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
  })

type BrowserProfileMetadata = z.infer<typeof metadataSchema>
type BrowserProfileRecord = z.infer<typeof profileRecordSchema>

export type PendingBrowserProfileImport = z.infer<typeof pendingImportSchema>

/** The whole committed list after one write; the manager replaces its cache with it. */
export type BrowserProfileSnapshot = { revision: number; profiles: BrowserProfileSummary[]; defaultProfileId: string }

function cloneImportedSource(source: BrowserProfileImportedSource | null): BrowserProfileImportedSource | null {
  return source === null ? null : { ...source }
}

function snapshotOf(metadata: BrowserProfileMetadata): BrowserProfileSnapshot {
  return { revision: metadata.revision ?? 0, defaultProfileId: metadata.defaultProfileId,
    profiles: metadata.profiles.map((profile) => profileSummary(profile, metadata.defaultProfileId)) }
}

function profileSummary(profile: BrowserProfileRecord, defaultProfileId: string): BrowserProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    createdAt: profile.createdAt,
    isDefault: profile.id === defaultProfileId,
    source: cloneImportedSource(profile.source),
    ...(profile.hue === undefined ? {} : { hue: profile.hue }),
    ...(profile.notes === undefined || profile.notes === '' ? {} : { notes: profile.notes })
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

  updateProfile(profileId: string, edit: BrowserProfileEdit, expectedRevision: number): Promise<{ snapshot: BrowserProfileSnapshot; profile: BrowserProfileSummary }> {
    return this.enqueue(async () => {
      const validatedProfileId = profileIdSchema.parse(profileId)
      const metadata = await this.readOrInitialize()
      this.assertRevision(metadata, expectedRevision)
      const current = metadata.profiles.find((profile) => profile.id === validatedProfileId)
      if (!current) throw new Error(`Unknown Browser Profile: ${validatedProfileId}`)
      const updated: BrowserProfileRecord = { ...current }
      if (edit.label !== undefined) updated.label = validateBrowserProfileLabel(edit.label)
      if (edit.hue === null) delete updated.hue
      else if (edit.hue !== undefined) updated.hue = profileHueSchema.parse(edit.hue)
      if (edit.notes !== undefined) {
        const notes = profileNotesSchema.parse(edit.notes)
        if (notes === '') delete updated.notes
        else updated.notes = notes
      }
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
        profiles: metadata.profiles.filter((profile) => profile.id !== validatedProfileId)
      })
      return await this.commit(next)
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

  private async readOrInitialize(): Promise<BrowserProfileMetadata> {
    try {
      return metadataSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
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

  private assertRevision(metadata: BrowserProfileMetadata, expectedRevision: number): void {
    if (expectedRevision !== (metadata.revision ?? 0)) throw new BrowserProfileRevisionConflict(metadata.revision ?? 0)
  }

  /** Every write advances the revision and returns the whole list it committed. */
  private async commit(metadata: BrowserProfileMetadata): Promise<BrowserProfileSnapshot> {
    const next = metadataSchema.parse({ ...metadata, revision: (metadata.revision ?? 0) + 1 })
    await this.writeMetadata(next)
    return snapshotOf(next)
  }

  private createUnusedProfileId(metadata: BrowserProfileMetadata): string {
    let id: string
    do { id = mintObjectId() } while (
      metadata.profiles.some((profile) => profile.id === id) ||
      metadata.pendingImports.some((pending) => pending.profileId === id)
    )
    return id
  }

  private async writeMetadata(metadata: BrowserProfileMetadata): Promise<void> {
    const validated = metadataSchema.parse(metadata)
    await mkdir(dirname(this.path), { recursive: true })
    await durableWriteFile(this.path, `${JSON.stringify(validated, null, 2)}\n`)
  }
}
