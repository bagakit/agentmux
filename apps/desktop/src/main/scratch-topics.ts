import { resolve } from 'node:path'
import { nativeImage, type NativeImage } from 'electron'
import { ScratchTopics as ScratchTopicResources, type ScratchWorkspace as WorkspaceRecord } from '@agentmux/host/mote-resources'
export type { PreparedScratchAgentTopic } from '@agentmux/host/mote-resources'
import { MOTE_AVATAR_OUTPUT_MAX_BYTES, type MoteAvatarInput, type MoteAvatarRef, type MoteAvatarImage } from '../shared/mote-avatars.js'
import { decodeObjectAvatar, previewObjectAvatar, objectAvatarPng } from './object-avatar-image.js'
import { readObjectAvatarFile, saveObjectAvatarFile } from '@agentmux/host/object-avatar-files'
import { migrateTopicDirectories } from './scratch-directory-maintenance.mjs'
import { normalizeDirectoryIdentity, retainDirectoryIdentity, inspectDirectoryIdentity, type DirectoryIdentityWriteOptions } from './scratch-directory-identity.mjs'
import { resolveScratchTopicDirectory, scratchStorageTopicIds, scratchIdentityContext, scratchDirectoryIdentity, scratchDirectoryAddress } from './scratch-topic-directories.js'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code }
function requireScratchWorkspace(workspace: WorkspaceRecord): void {
  if (workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local') throw new Error('Scratch Topics are available only in the local Scratch workspace')
}
/** Desktop retains image decoding and explicit maintenance; all resource preparation uses the Host owner. */
export class ScratchTopics extends ScratchTopicResources {
  private directoryMaintenanceIssue: { directory: string; message: string; shortenMotes: boolean } | undefined
  constructor(private readonly createAvatarImage: (bytes: Buffer) => NativeImage = bytes => nativeImage.createFromBuffer(bytes)) { super({ directoryIdentityHelper: resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move') }) }
  protected override directoryMaintenanceObservation() { return this.directoryMaintenanceIssue }
  private decodeAvatar(input: MoteAvatarInput): NativeImage { return decodeObjectAvatar(input, this.createAvatarImage) }
  /** Advisory maintenance is a write operation; read/list and public discovery remain read-only. */
  async normalizeDirectoryIdentities(workspace: WorkspaceRecord, options: DirectoryIdentityWriteOptions & { shortenMotes?: boolean } = {}): Promise<void> {
    requireScratchWorkspace(workspace)
    const issues: string[] = []
    try {
      if (options.shortenMotes) {
        const maintenance = await migrateTopicDirectories({ scratchRoot: workspace.path, execute: true, motesOnly: true,
          ...(options.helperPath ? { helperPath: options.helperPath } : {}) })
        issues.push(...maintenance.issues.map(item => `${item.code}: ${item.message}`),
          ...maintenance.objects.filter(item => item.issue).map(item => `${item.id}: ${item.issue!.code}: ${item.issue!.message}`))
      }
      const ids = await scratchStorageTopicIds(workspace.path)
      issues.push(...ids.issues ?? [])
      for (const topicId of ids) {
        try {
          const resolved = await resolveScratchTopicDirectory(workspace.path, topicId)
          if (resolved) {
            const context = await scratchIdentityContext(workspace.path, topicId)
            const existing = await inspectDirectoryIdentity(resolved, context)
            if (existing) await normalizeDirectoryIdentity(resolved, context, options)
            // Match read()'s verified logical address; canonical IO must not rename published content.
            else await retainDirectoryIdentity(resolved, { ...context, original: await scratchDirectoryIdentity(workspace.path, topicId, await scratchDirectoryAddress(workspace.path, topicId, resolved)) }, options)
          }
        } catch (error) { issues.push(`${topicId}: ${errorCode(error) ?? 'DIRECTORY_IDENTITY_UNCONFIRMED'}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (issues.length) throw new Error('Directory identity maintenance is unconfirmed. Existing files, workfaces and healthy Agent input remain available. Restore storage access and retry directory identity repair. ' + issues.join(' · '))
      if (!this.directoryMaintenanceIssue?.shortenMotes || options.shortenMotes) this.directoryMaintenanceIssue = undefined
    } catch (error) {
      // Service observation only: never an identity, filesystem catalog or per-object capability flag.
      // A narrower metadata retry cannot replace an unconfirmed shortening operation.
      if (!(this.directoryMaintenanceIssue?.directory === workspace.path && this.directoryMaintenanceIssue.shortenMotes && !options.shortenMotes))
        this.directoryMaintenanceIssue = { directory: workspace.path, message: error instanceof Error ? error.message : String(error), shortenMotes: options.shortenMotes === true }
      throw error
    }
  }

  async previewAvatar(workspace: WorkspaceRecord, topicId: string, input: MoteAvatarInput, objectKey: string): Promise<MoteAvatarImage> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    await this.avatarMoteDirectory(workspace, topicId)
    return previewObjectAvatar(this.decodeAvatar(input))
  }

  async saveAvatar(workspace: WorkspaceRecord, topicId: string, input: MoteAvatarInput, objectKey: string): Promise<MoteAvatarRef> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    if (input?.mimeType !== 'image/png' || input.dataUrl.length > Math.ceil(MOTE_AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 22) throw new Error('Save a bounded PNG avatar crop.')
    const png = objectAvatarPng(await this.decodeAvatar(input))
    return await saveObjectAvatarFile(await this.avatarMoteDirectory(workspace, topicId), png)
  }

  async readAvatar(workspace: WorkspaceRecord, topicId: string, ref: MoteAvatarRef, objectKey: string): Promise<MoteAvatarImage> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    const png = await readObjectAvatarFile(await this.avatarMoteDirectory(workspace, topicId), ref)
    const input: MoteAvatarInput = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
    const image = this.decodeAvatar(input)
    objectAvatarPng(image)
    return { dataUrl: input.dataUrl, ...image.getSize() }
  }
}
