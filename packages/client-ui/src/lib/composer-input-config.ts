/** Client-side completion preferences; these never govern Agent input authority. */
export type ComposerInputConfig = {
  command: string | null
  skill: string | null
  reference: string | null
  keywords: boolean
}

export const DEFAULT_COMPOSER_INPUT_CONFIG: ComposerInputConfig = Object.freeze({
  command: '/', skill: '$', reference: '@', keywords: true
})

/** Preserve object identity for Store selectors and the authored null choices. */
export function resolveComposerInputConfig(config?: ComposerInputConfig | null): ComposerInputConfig {
  return config ?? DEFAULT_COMPOSER_INPUT_CONFIG
}

/** A null result is valid. Prefixes are literal symbols, never regular expressions. */
export function validateComposerInputConfig(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Shortcut input preferences must be an object.'
  const config = value as Record<string, unknown>
  const keys = ['command', 'skill', 'reference', 'keywords']
  if (Object.keys(config).some(key => !keys.includes(key)) || keys.some(key => !(key in config))) return 'Shortcut input preferences require command, skill, reference and keywords.'
  if (typeof config.keywords !== 'boolean') return 'Keyword suggestions must be enabled or disabled.'
  const prefixes: string[] = []
  for (const key of ['command', 'skill', 'reference']) {
    const prefix = config[key]
    if (prefix === null) continue
    if (typeof prefix !== 'string' || !/^[\p{P}\p{S}]+$/u.test(prefix)) return 'Each enabled shortcut must contain symbols only, without spaces or control characters.'
    if (prefixes.some(other => other.startsWith(prefix) || prefix.startsWith(other))) return 'Shortcut prefixes must be different and cannot begin with one another.'
    prefixes.push(prefix)
  }
  return null
}
