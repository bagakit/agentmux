import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** One runtime recipe for published artifacts and isolated source consumers. */
export async function bundleIdentityRuntime() {
  const options = {
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/runtime-entry.ts'],
    bundle: true,
    platform: 'neutral',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
  }
  const [module, script] = await Promise.all([
    build({ ...options, format: 'esm' }),
    build({ ...options, format: 'iife', globalName: 'AgentMuxIdentity' }),
  ])
  return {
    module: module.outputFiles[0].text,
    source: `(()=>{${script.outputFiles[0].text};return AgentMuxIdentity;})()`,
  }
}
