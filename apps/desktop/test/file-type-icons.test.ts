import { win32 as _hygiene_win32 } from "node:path"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import {
  Database,
  File,
  FileArchive,
  FileBox,
  FileChartColumn,
  FileCode,
  FileCog,
  FileDiff,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileMusic,
  FileSliders,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo
} from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { getFileTypeIcon } from '../src/renderer/src/lib/file-type-icons.js'

describe('file type icons', () => {
  it('prefers known filenames over generic extensions', () => {
    expect(getFileTypeIcon('package.json')).toBe(FileBox)
    expect(getFileTypeIcon(_hygiene_fixturePath("repo/tsconfig.json"))).toBe(FileSliders)
    expect(getFileTypeIcon(_hygiene_win32.join("C:", _hygiene_win32.sep, "repo\\.env.local"))).toBe(FileLock)
    expect(getFileTypeIcon('README')).toBe(FileText)
    expect(getFileTypeIcon('Dockerfile.dev')).toBe(FileCog)
  })

  it('maps code, config, documents, media, data, and security files', () => {
    expect(getFileTypeIcon('src/App.tsx')).toBe(FileCode)
    expect(getFileTypeIcon('config/settings.jsonc')).toBe(FileJson)
    expect(getFileTypeIcon('styles/app.css')).toBe(FileType)
    expect(getFileTypeIcon('assets/logo.png')).toBe(FileImage)
    expect(getFileTypeIcon('notes.patch')).toBe(FileDiff)
    expect(getFileTypeIcon('db/schema.sql')).toBe(Database)
    expect(getFileTypeIcon('reports/summary.xlsx')).toBe(FileSpreadsheet)
    expect(getFileTypeIcon('certs/server.pem')).toBe(FileKey)
    expect(getFileTypeIcon('slides/status.pptx')).toBe(FileChartColumn)
    expect(getFileTypeIcon('sound/theme.mp3')).toBe(FileMusic)
    expect(getFileTypeIcon('demo.mov')).toBe(FileVideo)
  })

  it('handles compound archives and unknown files deterministically', () => {
    expect(getFileTypeIcon('release.tar.gz')).toBe(FileArchive)
    expect(getFileTypeIcon('unknown.customtype')).toBe(File)
  })
})
