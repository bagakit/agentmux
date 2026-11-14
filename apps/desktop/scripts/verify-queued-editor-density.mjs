import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const capture = fileURLToPath(new URL('./capture-message-delivery-diagnostics.mjs', import.meta.url))
for (const extra of [[], ['--force-queued-editor-blank-line'], []]) {
  execFileSync(process.execPath, [capture, '--only=queued-editor', ...extra], { stdio: 'inherit' })
}
