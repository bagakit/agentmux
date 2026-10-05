import { win32 as _hygiene_win32 } from "node:path"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { describe, expect, it } from 'vitest'
import { getFileTypeIcon } from '../src/renderer/src/lib/file-type-icons.js'

describe('file type icons', () => {
  it('prefers known filenames over generic extensions', () => {
    expect(getFileTypeIcon('package.json')).toBe(semanticIconComponent('file.package'))
    expect(getFileTypeIcon(_hygiene_fixturePath("repo/tsconfig.json"))).toBe(semanticIconComponent('file.config'))
    expect(getFileTypeIcon(_hygiene_win32.join("C:", _hygiene_win32.sep, "repo\\.env.local"))).toBe(semanticIconComponent('file.locked'))
    expect(getFileTypeIcon('README')).toBe(semanticIconComponent('file.text'))
    expect(getFileTypeIcon('Dockerfile.dev')).toBe(semanticIconComponent('file.build-config'))
  })

  it('maps code, config, documents, media, data, and security files', () => {
    expect(getFileTypeIcon('src/App.tsx')).toBe(semanticIconComponent('file.code'))
    expect(getFileTypeIcon('config/settings.jsonc')).toBe(semanticIconComponent('file.json'))
    expect(getFileTypeIcon('styles/app.css')).toBe(semanticIconComponent('file.stylesheet'))
    expect(getFileTypeIcon('assets/logo.png')).toBe(semanticIconComponent('file.image'))
    expect(getFileTypeIcon('notes.patch')).toBe(semanticIconComponent('file.diff'))
    expect(getFileTypeIcon('db/schema.sql')).toBe(semanticIconComponent('file.database'))
    expect(getFileTypeIcon('reports/summary.xlsx')).toBe(semanticIconComponent('file.spreadsheet'))
    expect(getFileTypeIcon('certs/server.pem')).toBe(semanticIconComponent('file.key'))
    expect(getFileTypeIcon('slides/status.pptx')).toBe(semanticIconComponent('file.chart'))
    expect(getFileTypeIcon('sound/theme.mp3')).toBe(semanticIconComponent('file.audio'))
    expect(getFileTypeIcon('demo.mov')).toBe(semanticIconComponent('file.video'))
  })

  it('handles compound archives and unknown files deterministically', () => {
    expect(getFileTypeIcon('release.tar.gz')).toBe(semanticIconComponent('file.archive'))
    expect(getFileTypeIcon('unknown.customtype')).toBe(semanticIconComponent('file.generic'))
  })
})
