import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'

const BROWSER_PROFILE_METADATA_VERSION = 1
const BROWSER_PROFILE_FILE_NAME = 'browser-profiles.json'
const BROWSER_PROFILE_PARTITION_PREFIX = 'persist:agentmux-browser-profile:'
const BROWSER_PROFILE_LABEL_MAX_LENGTH = 128
const PROFILE_UUID_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

const profileIdSchema = z.string().regex(PROFILE_UUID_RE, 'Browser Profile id must be a canonical UUID v4')
const profileLabelSchema = z
  .string()
  .min(1)
  .max(BROWSER_PROFILE_LABEL_MAX_LENGTH)
  .refine((label) => label === label.trim(), 'Browser Profile label must not have surrounding whitespace')
const nonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

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
    source: importedSourceSchema.nullable()
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

export type BrowserProfileImportedSource = z.infer<typeof importedSourceSchema>

export type BrowserProfileSummary = {
  id: string
  label: string
  createdAt: number
  isDefault: boolean
  source: BrowserProfileImportedSource | null
}

export type PendingBrowserProfileImport = z.infer<typeof pendingImportSchema>

function cloneImportedSource(source: BrowserProfileImportedSource | null): BrowserProfileImportedSource | null {
  return source === null ? null : { ...source }
}

function profileSummary(profile: BrowserProfileRecord, defaultProfileId: string): BrowserProfileSummary {
  return {
    id: profile.id,
    label: profile.label,
    createdAt: profile.createdAt,
    isDefault: profile.id === defaultProfileId,
    source: cloneImportedSource(profile.source)
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
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
    return this.enqueue(async () => {
      const metadata = await this.readOrInitialize()
      return metadata.profiles.map((profile) => profileSummary(profile, metadata.defaultProfileId))
    })
  }

  listPendingImports(): Promise<PendingBrowserProfileImport[]> {
    return this.enqueue(async () => {
      const metadata = await this.readOrInitialize()
      return metadata.pendingImports.map((pending) => ({ ...pending }))
    })
  }

  createProfile(label: string): Promise<BrowserProfileSummary> {
    return this.enqueue(async () => {
      const validatedLabel = profileLabelSchema.parse(label)
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
      await this.writeMetadata(next)
      return profileSummary(profile, next.defaultProfileId)
    })
  }

  deleteProfile(profileId: string): Promise<void> {
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
      await this.writeMetadata(next)
    })
  }

  beginPendingImport(label: string): Promise<PendingBrowserProfileImport> {
    return this.enqueue(async () => {
      const validatedLabel = profileLabelSchema.parse(label)
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
      await this.writeMetadata(next)
      return { ...pending }
    })
  }

  commitImportedProfile(
    profileId: string,
    source: BrowserProfileImportedSource
  ): Promise<BrowserProfileSummary> {
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
      await this.writeMetadata(next)
      return profileSummary(profile, next.defaultProfileId)
    })
  }

  abortPendingImport(profileId: string): Promise<void> {
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
      await this.writeMetadata(next)
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

    const id = randomUUID()
    const metadata = metadataSchema.parse({
      version: BROWSER_PROFILE_METADATA_VERSION,
      defaultProfileId: id,
      profiles: [{ id, label: 'Default', createdAt: Date.now(), source: null }],
      pendingImports: []
    })
    await this.writeMetadata(metadata)
    return metadata
  }

  private createUnusedProfileId(metadata: BrowserProfileMetadata): string {
    const id = randomUUID()
    if (
      metadata.profiles.some((profile) => profile.id === id) ||
      metadata.pendingImports.some((pending) => pending.profileId === id)
    ) {
      throw new Error('Generated duplicate Browser Profile id')
    }
    return id
  }

  private async writeMetadata(metadata: BrowserProfileMetadata): Promise<void> {
    const validated = metadataSchema.parse(metadata)
    await mkdir(dirname(this.path), { recursive: true })
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
      await rename(tempPath, this.path)
    } catch (error) {
      try {
        await unlink(tempPath)
      } catch (cleanupError) {
        if (!isMissingFileError(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            'Failed to persist Browser Profile metadata and clean up its temporary file'
          )
        }
      }
      throw error
    }
  }
}
