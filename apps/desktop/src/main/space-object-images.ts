import { nativeImage, type NativeImage } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { AVATAR_OUTPUT_MAX_BYTES, requireSpaceObjectImageTarget, type ObjectAvatarInput,
  type ObjectAvatarImage, type ObjectAvatarRef, type SpaceObjectAppearance, type SpaceObjectImageTarget } from '../shared/object-avatars.js'
import { decodeObjectAvatar, objectAvatarPng, previewObjectAvatar } from './object-avatar-image.js'
import { readObjectAvatarFile, saveObjectAvatarFile } from './object-avatar-files.js'
import { projectAppearance } from './project-appearance.js'

/** A small client presentation port: identity and resource permission stay with the original owner. */
export class SpaceObjectImages {
  constructor(private readonly resolve: (target: SpaceObjectImageTarget) => Promise<{ hostId: string; directoryPath: string }>,
    private readonly createImage: (bytes: Buffer) => NativeImage = bytes => nativeImage.createFromBuffer(bytes)) {}

  private async localDirectory(target: SpaceObjectImageTarget): Promise<string | null> {
    requireSpaceObjectImageTarget(target)
    const original = await this.resolve(target)
    if (original.hostId !== 'local') return null
    const info = await lstat(original.directoryPath)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The original image directory is unavailable. Your saved choice and workface are retained.')
    return await realpath(original.directoryPath)
  }
  private async requireLocalDirectory(target: SpaceObjectImageTarget): Promise<string> {
    const directory = await this.localDirectory(target)
    if (!directory) throw new Error('Image uploads and reads require this object’s local directory. Its original choice and workface are retained.')
    return directory
  }
  async appearance(target: SpaceObjectImageTarget): Promise<SpaceObjectAppearance> {
    const directory = await this.localDirectory(target)
    return { local: directory !== null, icon: directory ? (await projectAppearance(directory)).icon : null }
  }
  async preview(target: SpaceObjectImageTarget, input: ObjectAvatarInput): Promise<ObjectAvatarImage> {
    await this.requireLocalDirectory(target)
    return previewObjectAvatar(decodeObjectAvatar(input, this.createImage))
  }
  async save(target: SpaceObjectImageTarget, input: ObjectAvatarInput): Promise<ObjectAvatarRef> {
    const directory = await this.requireLocalDirectory(target)
    if (input?.mimeType !== 'image/png' || typeof input.dataUrl !== 'string' || input.dataUrl.length > Math.ceil(AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 22)
      throw new Error('Save a bounded PNG avatar crop.')
    const png = objectAvatarPng(decodeObjectAvatar(input, this.createImage))
    // The immutable asset is separate from publication by the original preference writer.
    return await saveObjectAvatarFile(directory, png)
  }
  async read(target: SpaceObjectImageTarget, ref: ObjectAvatarRef): Promise<ObjectAvatarImage> {
    const png = await readObjectAvatarFile(await this.requireLocalDirectory(target), ref)
    const input: ObjectAvatarInput = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
    const image = decodeObjectAvatar(input, this.createImage); objectAvatarPng(image)
    return { dataUrl: input.dataUrl, ...image.getSize() }
  }
}
