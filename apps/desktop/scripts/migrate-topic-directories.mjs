import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrateTopicDirectories } from '../src/main/scratch-directory-maintenance.mjs'
export { migrateTopicDirectories } from '../src/main/scratch-directory-maintenance.mjs'
const issue = error => ({ code: error?.code ?? 'DIRECTORY_MIGRATION_FAILED', message: error instanceof Error ? error.message : String(error) })

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let execute = false, modeSeen = false, home = homedir(), scratchRoot, helperPath
  try {
    for (let index = 2; index < process.argv.length; index += 1) {
      const arg = process.argv[index]
      if (arg === '--execute' || arg === '--repair' || arg === '--dry-run') { if (modeSeen) throw new Error('Choose one maintenance mode.'); modeSeen = true; execute = arg !== '--dry-run' }
      else if (arg === '--home' || arg === '--scratch-root' || arg === '--helper-path') {
        const value = process.argv[++index]; if (!value || value.startsWith('--')) throw new Error(`Provide a value for ${arg}.`)
        if (arg === '--home') home = value; else if (arg === '--scratch-root') scratchRoot = value; else helperPath = resolve(value)
      } else if (arg === '--help') { process.stdout.write('Usage: migrate-topic-directories.mjs [--dry-run | --execute | --repair] [--home HOME | --scratch-root ROOT] [--helper-path HELPER]\n'); process.exit(0) }
      else throw new Error(`Unknown option: ${arg}`)
    }
    const report = await migrateTopicDirectories({ home, ...(scratchRoot ? { scratchRoot } : {}), execute, ...(helperPath ? { helperPath } : {}) })
    process.stdout.write(JSON.stringify(report, null, 2) + '\n'); if (!report.success) process.exitCode = 1
  } catch (error) { process.stderr.write(JSON.stringify({ issue: issue(error) }) + '\n'); process.exitCode = 1 }
}
