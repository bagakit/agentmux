import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
const packageRoot = resolve(import.meta.dirname, '../..'), entry = process.argv[1]
if (entry?.startsWith(packageRoot + '/') && entry.endsWith('.js') && !existsSync(entry) && existsSync(entry.slice(0, -3) + '.ts')) process.argv[1] = entry.slice(0, -3) + '.ts'
register(new URL('./startup-policy-loader.mjs', import.meta.url))
