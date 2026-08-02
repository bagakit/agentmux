import { stat } from 'node:fs/promises'

export const PACKAGE_REPORT_NEXT_COMMAND = 'pnpm --filter @agentmux/desktop package:mac'

async function exists(path) {
  return await stat(path).then(() => true, () => false)
}

/**
 * Check the release bundle before report-desktop-package starts traversing it.
 *
 * The report is intentionally bound to the release candidate produced by
 * package:mac.  A missing nested path is a packaging precondition failure, not
 * an uncaught filesystem exception, so callers can show one actionable reason.
 */
export async function inspectPackageReportPaths(paths) {
  const required = [
    { label: 'release candidate', path: paths.appPath },
    { label: 'renderer assets', path: paths.rendererAssets },
    { label: 'main executable', path: paths.mainExecutablePath },
    { label: 'DMG', path: paths.dmgPath }
  ]
  const missing = []
  for (const entry of required) {
    if (!(await exists(entry.path))) missing.push(entry)
  }
  return { ok: missing.length === 0, missing }
}

export function formatPackageReportPreflightError(missing) {
  const details = missing.map(({ label, path }) => `missing ${label} at ${path}`).join('; ')
  return `package report unavailable: ${details}\nRun \`${PACKAGE_REPORT_NEXT_COMMAND}\` first to create a fresh release candidate.`
}
