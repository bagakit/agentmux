import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { updateRoute } from '../src/shared/update-policy.ts'

export const runtimeReviewMessage = 'The ctxmux fingerprints differ or are missing. Report that Native installation needs a Run compatibility and Provider resume review. With installation and GUI relaunch authorized, pass the review record to pnpm package:mac:install --app-only --runtime-reviewed=<path>.'

export async function installedUpdateRoute(installedApp, candidate) {
  const path = join(installedApp, 'Contents/Resources/app/out/renderer/release.json')
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return 'application'
    throw error
  }
  return updateRoute(JSON.parse(raw)?.identity, candidate?.identity)
}
