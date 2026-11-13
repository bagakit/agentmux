import { NOTE_CONTENT_WIDTHS, NOTE_FONT_SIZE_DEFAULT, NOTE_FONT_SIZE_MIN, NOTE_FONT_SIZE_MAX, resolveNotesPreferences } from '../../../shared/notes-preferences.js'
import { enumSetting, integerSetting, type ScalarSetting } from '../scalar-setting.js'
import { defaultNotesDirectory } from '@agentmux/core/notebook-store'
import type { NotesStorageOwner } from '../../notes-storage-owner.js'
import type { OwnedSetting } from '../owned-setting.js'

export function notesDirectorySetting(notes: Pick<NotesStorageOwner, 'inspect' | 'change'>): OwnedSetting {
  const key = 'notes.directory'
  const entry = (directory: string) => ({ key, kind: 'string' as const, value: directory, default: defaultNotesDirectory() })
  return {
    key,
    unavailableCode: 'NOTES_DIRECTORY_UNAVAILABLE',
    async inspect() { return entry((await notes.inspect()).directory) },
    async apply(directory, operationId) {
      const current = await notes.inspect(operationId)
      const saved = await notes.change({ operationId, expectedDirectory: current.operation?.expectedDirectory ?? current.directory, directory })
      return entry(saved.directory)
    }
  }
}

export const notesSettings = [
  integerSetting('notes.fontSize', { min: NOTE_FONT_SIZE_MIN, max: NOTE_FONT_SIZE_MAX }, NOTE_FONT_SIZE_DEFAULT,
    config => resolveNotesPreferences(config.notes).fontSize,
    (config, fontSize) => ({ ...config, notes: { ...config.notes, fontSize } })),
  enumSetting('notes.contentWidth', NOTE_CONTENT_WIDTHS, resolveNotesPreferences(undefined).contentWidth,
    config => resolveNotesPreferences(config.notes).contentWidth,
    (config, contentWidth) => ({ ...config, notes: { ...config.notes, contentWidth } }))
] satisfies readonly ScalarSetting[]
