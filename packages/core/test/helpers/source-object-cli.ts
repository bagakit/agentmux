import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { CliResult } from './object-cli-rpc.js'

/** Execute the real CLI parser and transport from source, without a dist artifact.
 * This deliberately does not qualify the compiled or installed launcher. */
export async function runSourceObjectCli(args: readonly string[], env: NodeJS.ProcessEnv, stdin = '', timeoutMs = 15_000): Promise<CliResult> {
  const loader = new URL('../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs', import.meta.url)
  const entry = fileURLToPath(new URL('../../src/agentmux.ts', import.meta.url))
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), entry, ...args],
      { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private source CLI exceeded its bounded test deadline.')) }, timeoutMs)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(stdin)
  })
}
