import { workspaceFileFormat } from '../catalog'

export function fileFormatExtension(path: string): string { return path.split('.').pop()?.toLowerCase() ?? '' }
export function canFormatFile(path: string): boolean { return workspaceFileFormat(path).formatter !== null }
