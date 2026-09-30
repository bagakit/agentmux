import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Both runners mutate the actual product leaves in private scratch directories.
// Their Source result does not certify system credentials, signing or a user login.
const root = fileURLToPath(new URL('../../../', import.meta.url))
for (const file of ['verify-browser-webauthn-accounts-mutations.mjs', 'verify-browser-webauthn-access-mutations.mjs', 'verify-browser-webauthn-manager-mutations.mjs']) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
    cwd: root,
    stdio: 'inherit',
    timeout: 300_000
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
