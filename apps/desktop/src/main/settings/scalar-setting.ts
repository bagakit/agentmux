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

/** A whole number within a closed range; the legal values are listed so callers can discover them. */
export function integerSetting(key: string, range: { min: number; max: number }, defaultValue: number, read: (config: AppConfig) => number,
  write: (config: AppConfig, value: number) => AppConfig): ScalarSetting {
  return {
    key,
    entry(config) { return { key, kind: 'number', value: read(config), default: defaultValue, enum: Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index) } },
    apply(config, value) {
      const next = parseIntegerSettingValue(key, value, range.min, range.max)
      return read(config) === next ? config : write(config, next)
    }
  }
}

/** Shared lexical validation for integer fields with domain-specific entries or cross-field rules. */
export function parseIntegerSettingValue(key: string, text: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) throw invalid(key, text)
  return value
}

export function invalid(key: string, value: string): Error {
  return Object.assign(new Error(`Invalid value for ${key}: ${value}. Run amux settings inspect ${key} for valid values.`), { code: 'INVALID_SETTING_VALUE' })
}

/** Freeform text still has a declared, bounded setting owner; no arbitrary config paths. */
export function textSetting(key: string, read: (config: AppConfig) => string,
  write: (config: AppConfig, value: string) => AppConfig, valid: (value: string) => boolean, defaultValue = ''): ScalarSetting {
  return {
    key,
    entry(config) { return { key, kind: 'string', value: read(config), default: defaultValue } },
    apply(config, value) {
      if (!valid(value)) throw Object.assign(new Error(`Invalid value for ${key}. Run amux settings inspect ${key} for valid values.`), { code: 'INVALID_SETTING_VALUE' })
      return read(config) === value ? config : write(config, value)
    }
  }
}
