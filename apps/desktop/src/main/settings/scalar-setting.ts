import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../shared/contracts.js'

export type ScalarSetting = {
  key: string
  entry(config: AppConfig): AgentMuxControlSettingEntry
  apply(config: AppConfig, value: string): AppConfig
}

export function enumSetting<T extends string>(
  key: string, choices: readonly T[], defaultValue: T, read: (config: AppConfig) => T,
  write: (config: AppConfig, value: T) => AppConfig
): ScalarSetting {
  return {
    key,
    entry(config) { return { key, kind: 'string', value: read(config), default: defaultValue, enum: [...choices] } },
    apply(config, value) {
      if (!(choices as readonly string[]).includes(value)) throw invalid(key, value)
      return this.entry(config).value === value ? config : write(config, value as T)
    }
  }
}

export function booleanSetting(
  key: string, defaultValue: boolean, read: (config: AppConfig) => boolean,
  write: (config: AppConfig, value: boolean) => AppConfig
): ScalarSetting {
  return {
    key,
    entry(config) { return { key, kind: 'boolean', value: read(config), default: defaultValue } },
    apply(config, value) {
      if (value !== 'true' && value !== 'false') throw invalid(key, value)
      const next = value === 'true'
      return this.entry(config).value === next ? config : write(config, next)
    }
  }
}

export function invalid(key: string, value: string): Error {
  return Object.assign(new Error(`Invalid value for ${key}: ${value}. Run agentmux settings get ${key} for valid values.`), { code: 'INVALID_SETTING_VALUE' })
}
