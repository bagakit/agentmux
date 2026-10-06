import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const loadFile = process.env.NATIVE_DIAGNOSTIC_LOAD_PINS
const loadPins: Record<string, string> = {}
const resultFile = process.env.NATIVE_DIAGNOSTIC_TEST_RESULT

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: loadFile ? [{ name: 'native-diagnostic-actual-load', async transform(_source, file) {
    if (file.includes('/packages/core/') && /\.[cm]?[jt]s$/u.test(file)) {
      loadPins[file] = createHash('sha256').update(await readFile(file)).digest('hex')
      await writeFile(loadFile, JSON.stringify(loadPins, null, 2))
    }
  } }] : [],
  test: {
    include: ['packages/core/test/native-diagnostic-truth.test.ts'],
    environment: 'node',
    reporters: resultFile ? ['default', { async onFinished(files, errors) {
      const tests: unknown[] = []
      const visit = (task: NonNullable<typeof files>[number]['tasks'][number]): void => {
        if (task.type === 'test') tests.push({ id: task.id, state: task.result?.state,
          errors: task.result?.errors?.map(error => ({ name: error.name, message: error.message })) ?? [] })
        else task.tasks.forEach(visit)
      }
      files?.forEach(file => file.tasks.forEach(visit))
      await writeFile(resultFile, JSON.stringify({ files: files?.length ?? 0, tests,
        unhandled: errors.map(error => ({ name: error.name, message: error.message })) }, null, 2))
    } }] : ['default'],
    globalSetup: [fileURLToPath(new URL('../../vitest.dist-freshness.ts', import.meta.url))]
  }
})
