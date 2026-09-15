import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BrowserProfileSummary } from '../src/shared/contracts.js'
import { BrowserProfileCatalog } from '../src/renderer/src/components/BrowserProfilesPanel.js'

const panelSource = readFileSync(new URL('../src/renderer/src/components/BrowserProfilesPanel.tsx', import.meta.url), 'utf8')
const profile: BrowserProfileSummary = {
  id: 'profile-work',
  label: 'Work',
  createdAt: 1,
  isDefault: false,
  source: null
}

describe('Browser Profile destructive approval wiring', () => {
  it('renders a named second confirmation and sends the structured approval fact', () => {
    const markup = renderToStaticMarkup(
      <BrowserProfileCatalog
        profiles={[profile]}
        browsers={[]}
        busy={null}
        confirmDeleteId={profile.id}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
        onDelete={() => {}}
      />
    )

    expect(markup).toContain('<strong>Work</strong>')
    expect(markup).toContain('Cancel')
    expect(markup).toContain('>Delete</button>')

    const callerFacts = panelSource.match(/api\.browser\.deleteProfile\(profileId, \{[\s\S]*?profileId\n\s*\}\)/g) ?? []
    expect(callerFacts.length).toBeGreaterThan(0)
    expect(callerFacts[0]).toContain("kind: 'user-confirmed'")
    expect(callerFacts[0]).toContain("operation: 'delete-profile'")
    expect(callerFacts[0]).toContain("scope: 'profile'")
  })
})
