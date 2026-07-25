import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserProfileSummary } from '../src/shared/contracts.js'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import {
  BrowserProfileCatalog,
  browserProfileIsInUse,
  type BrowserProfileSurface
} from '../src/renderer/src/components/BrowserProfilesPanel.js'

const profiles: BrowserProfileSummary[] = [
  {
    id: 'default',
    label: 'Default',
    createdAt: 1,
    isDefault: true,
    source: null
  },
  {
    id: 'work',
    label: 'Work',
    createdAt: 2,
    isDefault: false,
    source: {
      browserLabel: 'Google Chrome',
      profileLabel: 'Profile 1',
      importedAt: 3,
      importedCookies: 12,
      skippedCookies: 2
    }
  },
  {
    id: 'unused',
    label: 'Unused',
    createdAt: 4,
    isDefault: false,
    source: null
  }
]

const browsers: BrowserProfileSurface[] = [{
  browserId: 'browser-1',
  profileId: 'work',
  title: 'AgentMux',
  url: 'https://example.com/'
}]

describe('Browser Profile projection', () => {
  it('derives in-use state only from Main-owned Browser snapshots', () => {
    expect(browserProfileIsInUse('work', browsers)).toBe(true)
    expect(browserProfileIsInUse('unused', browsers)).toBe(false)
  })

  it('keeps deletion fenced when a Profile is used by a Browser in another workspace', () => {
    const otherWorkspaceBrowser: BrowserProfileSurface = {
      browserId: 'browser-other-workspace',
      profileId: 'unused',
      title: 'Other workspace',
      url: 'https://other.example/'
    }
    const markup = renderToStaticMarkup(
      <BrowserProfileCatalog
        profiles={profiles}
        browsers={[...browsers, otherWorkspaceBrowser]}
        busy={null}
        confirmDeleteId={null}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
        onDelete={() => {}}
      />
    )

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete Unused"/)
  })

  it('shows source results without private paths and fences default or in-use deletion', () => {
    const markup = renderToStaticMarkup(
      <BrowserProfileCatalog
        profiles={profiles}
        browsers={browsers}
        busy={null}
        confirmDeleteId={null}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
        onDelete={() => {}}
      />
    )

    expect(markup).toContain('Google Chrome · Profile 1 · 12 imported, 2 skipped')
    expect(markup).not.toContain('partition')
    expect(markup).not.toContain('Cookies')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete Default"/)
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete Work"/)
    expect(markup).toMatch(/aria-label="Delete Unused"/)
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="Delete Unused"/)
  })

  it('requires an explicit second delete action for an unused Profile', () => {
    const markup = renderToStaticMarkup(
      <BrowserProfileCatalog
        profiles={profiles}
        browsers={browsers}
        busy={null}
        confirmDeleteId="unused"
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
        onDelete={() => {}}
      />
    )

    expect(markup).toContain('>Cancel</button>')
    expect(markup).toContain('>Delete</button>')
  })
})
