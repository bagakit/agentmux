import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../src/renderer/src/components/settings/AppearanceSettingsPane.tsx', import.meta.url), 'utf8')

describe('appearance choices SSOT', () => {
  it('derives settings choices from APP_APPEARANCE_IDS and covers every member', () => {
    const tuple = /APP_APPEARANCE_IDS\s*=\s*\[([^\]]+)\]\s+as const/.exec(contracts)?.[1]
    expect(tuple, 'shared appearance tuple anchor is missing').toBeTruthy()
    const ids = [...tuple!.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    expect(ids.length).toBeGreaterThan(1)
    expect(settings).toContain('APP_APPEARANCE_IDS.map')
    expect(settings).not.toMatch(/\(\['dark',\s*'light',\s*'system'\]\s+as const\)/)
    for (const id of ids) expect(settings).toContain(`${id}: {`)
  })

  it('keeps the copy map exhaustive through the AppAppearanceId type', () => {
    expect(settings).toContain('satisfies Record<AppAppearanceId, { title: string; description: string }>')
  })
})
