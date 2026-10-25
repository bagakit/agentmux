import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string]> = {
  'unpin-process': ['directory = `/proc/self/fd/${handle.fd}`', 'directory = `/proc/${pid}`'],
  'ignore-group-change': ['after.group !== identity.group || ', ''],
  'ignore-object-change': ['after.ino !== object.ino || ', ''],
  'ignore-fdinfo-object': ['info.inode !== object.ino || ', ''],
  'ignore-membership-change': ['!sameList(pids.map(String), (await members()).map(String))', 'false']
}
const mutation = process.env.AGENTMUX_LINUX_NATIVE_MUTANT
if (mutation && !mutations[mutation]) throw new Error('Unknown native process mutant')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/native-process-linux/cache'),
  plugins: [{ name: 'linux-native-process-counterexample', enforce: 'pre', transform(source, file) {
    if (!mutation || !file.endsWith('/packages/core/src/agent-native-process-linux.ts')) return
    const [before, after] = mutations[mutation]!
    if (source.split(before).length !== 2) throw new Error('Mutant must touch one actual process observer: ' + mutation)
    process.stderr.write('LINUX_NATIVE_MUTANT_HIT ' + mutation + '\n')
    return { code: source.replace(before, after), map: null }
  } }],
  test: { include: ['packages/core/test/agent-native-process-linux.test.ts'],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 } })
