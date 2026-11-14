import { defineConfig } from 'vitest/config'
const mutation = process.env.AMX_NATIVE_ENV_MUTATION
if (mutation && !['skip-argv', 'accept-reused-pid'].includes(mutation)) throw new Error('Unknown native environment mutation')
export default defineConfig({ plugins: [{ name: 'native-environment-identity-counterexample', enforce: 'pre', transform(source, file) {
  if (mutation !== 'accept-reused-pid' || !file.endsWith('/src/agent-native-process.ts')) return
  const anchor = "await nativeProcessBirth(processId, signal) !== birth) throw unavailable('The original process environment receipt is incomplete.')"
  if (source.split(anchor).length !== 2) throw new Error('Environment mutation must change one actual final identity fence')
  return { code: source.replace(anchor, "false) throw unavailable('The original process environment receipt is incomplete.')"), map: null }
} }], test: { environment: 'node', include: ['packages/core/test/native-process-environment.test.ts', 'packages/core/test/native-process-environment-linux.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 20000 } })
