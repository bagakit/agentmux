import type { AppConfig } from '../../../shared/contracts.js'
import {
  BROWSER_AGENT_CONTROL_LIMITS, BROWSER_AGENT_GLOW_BLENDS, BROWSER_AGENT_GLOW_ANIMATIONS,
  DEFAULT_BROWSER_AGENT_CONTROL, resolveBrowserAgentControl, validBrowserAgentGlowColor,
  type BrowserAgentControlPreferences
} from '../../../shared/browser-agent-control.js'
import { booleanSetting, enumSetting, textSetting, invalid, type ScalarSetting } from '../scalar-setting.js'

function write<K extends keyof BrowserAgentControlPreferences>(config: AppConfig, key: K, value: BrowserAgentControlPreferences[K]): AppConfig {
  return { ...config, browser: { ...config.browser, agentControl: { ...config.browser.agentControl, [key]: value } } }
}

const booleanKeys = ['showCursor', 'showCursorLabel', 'showDiscussion', 'pointerTween', 'clickRipple', 'glowEnabled'] as const
const numberKeys = ['pointerDurationMs', 'clickDurationMs', 'clickRadius', 'glowWidth', 'glowSoftness', 'glowOpacity', 'glowDurationMs'] as const

export const browserAgentControlSettings: readonly ScalarSetting[] = [
  ...booleanKeys.map(key => booleanSetting(`browser.agentControl.${key}`, DEFAULT_BROWSER_AGENT_CONTROL[key],
    config => resolveBrowserAgentControl(config.browser.agentControl)[key], (config, value) => write(config, key, value))),
  ...numberKeys.map((key): ScalarSetting => ({
    key: `browser.agentControl.${key}`,
    entry(config) { return { key: this.key, kind: 'number', value: resolveBrowserAgentControl(config.browser.agentControl)[key], default: DEFAULT_BROWSER_AGENT_CONTROL[key] } },
    apply(config, text) {
      const value = Number(text), { min, max } = BROWSER_AGENT_CONTROL_LIMITS[key]
      if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(value) || value < min || value > max || (key !== 'glowOpacity' && !Number.isInteger(value))) {
        const error = invalid(this.key, text)
        error.message += ` Use ${key === 'glowOpacity' ? 'a number' : 'a whole number'} from ${min} to ${max}.`
        throw error
      }
      return this.entry(config).value === value ? config : write(config, key, value)
    }
  })),
  textSetting('browser.agentControl.glowColor', config => resolveBrowserAgentControl(config.browser.agentControl).glowColor,
    (config, value) => write(config, 'glowColor', value), validBrowserAgentGlowColor, DEFAULT_BROWSER_AGENT_CONTROL.glowColor),
  enumSetting('browser.agentControl.glowBlend', BROWSER_AGENT_GLOW_BLENDS, DEFAULT_BROWSER_AGENT_CONTROL.glowBlend,
    config => resolveBrowserAgentControl(config.browser.agentControl).glowBlend, (config, value) => write(config, 'glowBlend', value)),
  enumSetting('browser.agentControl.glowAnimation', BROWSER_AGENT_GLOW_ANIMATIONS, DEFAULT_BROWSER_AGENT_CONTROL.glowAnimation,
    config => resolveBrowserAgentControl(config.browser.agentControl).glowAnimation, (config, value) => write(config, 'glowAnimation', value))
]
