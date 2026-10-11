import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityPolicy, type AgentMuxContinuityPolicy } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting, invalid, textSetting, type ScalarSetting } from '../scalar-setting.js'

const defaults = DEFAULT_AGENT_CONTINUITY_POLICY
function numberSetting(key: 'activeRecoveryDelayMs' | 'confirmedIdleWindowMs' | 'recheckIntervalMs' | 'recheckMaxAttempts' | 'retryInitialDelayMs' | 'retryMaxDelayMs' | 'retryMaxAttempts'): ScalarSetting {
  return {
    key: `continuity.${key}`,
    entry(config) { return { key: this.key, kind: 'number', value: normalizeAgentContinuityPolicy(config.continuity)[key], default: defaults[key] } },
    apply(config, text) {
      const value = Number(text)
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 0) {
        const error = invalid(this.key, text)
        error.message += ` Use a whole number from 0 to ${Number.MAX_SAFE_INTEGER}${key.endsWith('Ms') ? ' milliseconds' : ''}.`
        throw error
      }
      if (this.entry(config).value === value) return config
      const next = { ...config, continuity: { ...config.continuity, [key]: value } }
      try { normalizeAgentContinuityPolicy(next.continuity) }
      catch {
        const error = invalid(this.key, text)
        error.message += ' The maximum retry base delay must be at least the initial retry base delay.'
        throw error
      }
      return next
    }
  }
}
function write<K extends keyof AgentMuxContinuityPolicy>(key: K) {
  return (config: AppConfig, value: AgentMuxContinuityPolicy[K]): AppConfig => ({ ...config, continuity: { ...config.continuity, [key]: value } })
}

/** Declared scalar keys only. All persistence and publication stay with ConfigOwner. */
export const continuitySettings = [
  enumSetting('continuity.activeRecovery', ['automatic', 'manual'], defaults.activeRecovery,
    config => normalizeAgentContinuityPolicy(config.continuity).activeRecovery, write('activeRecovery')),
  numberSetting('activeRecoveryDelayMs'),
  numberSetting('confirmedIdleWindowMs'),
  booleanSetting('continuity.resumeAfterExit', defaults.resumeAfterExit,
    config => normalizeAgentContinuityPolicy(config.continuity).resumeAfterExit, write('resumeAfterExit')),
  numberSetting('recheckIntervalMs'),
  numberSetting('recheckMaxAttempts'),
  numberSetting('retryInitialDelayMs'),
  numberSetting('retryMaxDelayMs'),
  numberSetting('retryMaxAttempts'),
  enumSetting('continuity.reminderMode', ['off', 'default', 'default-plus-custom'], defaults.reminderMode,
    config => normalizeAgentContinuityPolicy(config.continuity).reminderMode, write('reminderMode')),
  textSetting('continuity.reminderAppend', config => normalizeAgentContinuityPolicy(config.continuity).reminderAppend,
    write('reminderAppend'), () => true, defaults.reminderAppend),
  booleanSetting('continuity.continuationEnabled', defaults.continuationEnabled,
    config => normalizeAgentContinuityPolicy(config.continuity).continuationEnabled, write('continuationEnabled')),
  textSetting('continuity.continuationPrompt', config => normalizeAgentContinuityPolicy(config.continuity).continuationPrompt,
    write('continuationPrompt'), () => true, defaults.continuationPrompt)
] satisfies readonly ScalarSetting[]
