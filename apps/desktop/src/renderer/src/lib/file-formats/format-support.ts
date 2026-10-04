import { workspaceFileFormat } from '../../../../shared/workspace-file-format'

export function fileFormatExtension(path: string): string { return path.split('.').pop()?.toLowerCase() ?? '' }
export function canFormatFile(path: string): boolean { return workspaceFileFormat(path).formatter !== null }
