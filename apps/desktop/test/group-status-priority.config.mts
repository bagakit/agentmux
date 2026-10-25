import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './group-activity-actions.config.mts'

const mutant = process.env.GROUP_STATUS_PRIORITY_MUTANT
if (mutant && mutant !== 'success-first') throw Error('Unknown group status priority mutation')
export default defineConfig({ ...base, cacheDir: resolve(base.root!, '.cache/group-status-priority'),
  plugins: [...base.plugins!, { name: 'loaded-group-status-priority', enforce: 'pre', transform(source, id) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|host)|packages\/(?:core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path)) return
    let code = source
    if (mutant && path === 'apps/desktop/src/renderer/src/lib/connector-group-status.ts') {
      const anchor = "contentGap ? 'Some conversation content is not shared yet'"
      if (code.split(anchor).length !== 2) throw Error('Expected one original content priority expression')
      code = code.replace(anchor, 'counts.confirmed ? confirmedText : ' + anchor)
    }
    if (process.env.GROUP_STATUS_PRIORITY_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const record = { path, originalSHA256: sha(source), loadedSHA256: sha(code), mutation: source === code ? null : mutant }
      code = "import {appendFileSync as __markGroupStatusPriority} from 'node:fs'; __markGroupStatusPriority(" + JSON.stringify(process.env.GROUP_STATUS_PRIORITY_LOADED) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['apps/desktop/test/group-status-priority.test.tsx', 'apps/desktop/test/group-activity-actions.test.tsx', 'apps/desktop/test/connector-header-status.test.tsx'],
    testNamePattern: mutant ? 'prioritizes a real content gap' : 'prioritizes a real content gap|opens the original settings section directly|keeps a notice-only empty window|does not promote an earlier binding|exposes one-click member access|the actual header diagnoses a source gap|actual recorded refusal and waiting|recent confirmed deliveries stay neutral|the actual header explains an unsupported message|keeps an explicitly unsupported joining contribution', passWithNoTests: false } })
