import { DATA_PREVIEW_MAX_BYTES } from '../file-data-preview'

export const EXCALIDRAW_PREVIEW_MAX_ELEMENTS = 256
export const EXCALIDRAW_PREVIEW_MAX_POINTS = 10_000

/** Validate the scene envelope and embedded files; official restore owns element semantics. */
export function validateExcalidrawScene(content: string): void {
  if (content.length > DATA_PREVIEW_MAX_BYTES || new TextEncoder().encode(content).byteLength > DATA_PREVIEW_MAX_BYTES) throw new Error('Excalidraw preview supports scenes up to 1 MiB. Use Source to read the full file.')
  const scene: unknown = JSON.parse(content)
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('Expected an Excalidraw scene.')
  const value = scene as Record<string, unknown>
  if (value.type !== 'excalidraw' || ![1, 2].includes(value.version as number) || !Array.isArray(value.elements)) {
    throw new Error('Expected a supported Excalidraw scene with type, version and elements.')
  }
  if (value.elements.length > EXCALIDRAW_PREVIEW_MAX_ELEMENTS || value.elements.reduce((count, element) => count + (Array.isArray(element?.points) ? element.points.length : 0), 0) > EXCALIDRAW_PREVIEW_MAX_POINTS) {
    throw new Error('This scene exceeds the interactive preview budget (256 elements / 10,000 points). Use Source to read the full file.')
  }
  const files = value.files ?? {}
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Invalid Excalidraw image files.')
  for (const file of Object.values(files)) {
    if (!file || typeof file !== 'object' || typeof file.dataURL !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]*={0,2}$/.test(file.dataURL)) {
      throw new Error('Excalidraw images must be embedded image data URLs.')
    }
    try { atob(file.dataURL.slice(file.dataURL.indexOf(',') + 1)) } catch { throw new Error('Invalid embedded Excalidraw image.') }
  }
  for (const element of value.elements) {
    if (element?.type === 'image' && !element.isDeleted && (!element.fileId || !(element.fileId in files))) {
      throw new Error('An Excalidraw image is missing its embedded file.')
    }
  }
}
