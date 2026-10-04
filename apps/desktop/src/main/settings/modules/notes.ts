import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { NOTE_CONTENT_WIDTHS, NOTE_FONT_SIZE_DEFAULT, NOTE_FONT_SIZE_MIN, NOTE_FONT_SIZE_MAX, resolveNotesPreferences, validNoteFontSize } from '../../../shared/notes-preferences.js'
import { enumSetting, invalid, type ScalarSetting } from '../scalar-setting.js'

export const notesSettings = [
  {
    key: 'notes.fontSize',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'number', value: resolveNotesPreferences(config.notes).fontSize, default: NOTE_FONT_SIZE_DEFAULT,
      enum: Array.from({ length: NOTE_FONT_SIZE_MAX - NOTE_FONT_SIZE_MIN + 1 }, (_, index) => NOTE_FONT_SIZE_MIN + index)
    } },
    apply(config: AppConfig, value: string): AppConfig {
      const fontSize = Number(value)
      if (!/^\d+$/.test(value) || !validNoteFontSize(fontSize)) throw invalid(this.key, value)
      return this.entry(config).value === fontSize ? config : { ...config, notes: { ...config.notes, fontSize } }
    }
  },
  enumSetting('notes.contentWidth', NOTE_CONTENT_WIDTHS, resolveNotesPreferences(undefined).contentWidth,
    config => resolveNotesPreferences(config.notes).contentWidth,
    (config, contentWidth) => ({ ...config, notes: { ...config.notes, contentWidth } }))
] satisfies readonly ScalarSetting[]
