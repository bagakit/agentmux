import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

// 这些是当前设计合同里最容易被并发改动扫掉、且用户能直接感知的纵切。每一项都要求
// 来源实现、定义文件之外的生产调用者和真实测试同时存在；这里不把测试本身当作接线证明。
const FEATURE_ANCHORS = [
  {
    id: 'terminal-open-destination',
    source: 'apps/desktop/src/renderer/src/components/OpenDestinationBar.tsx',
    symbol: 'OpenDestinationPopover',
    callers: ['apps/desktop/src/renderer/src/components/TerminalView.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx'],
    tests: ['apps/desktop/test/terminal-open-destination.test.ts', 'apps/desktop/test/open-destination-bar.test.tsx']
  },
  {
    id: 'scratch-topic-inheritance',
    source: 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts',
    symbol: 'inheritedTopicIdForNewTab',
    callers: ['apps/desktop/src/renderer/src/store.ts'],
    tests: ['apps/desktop/test/topic-tab-inheritance.test.ts']
  },
  {
    id: 'window-agent-status-and-resources',
    source: 'apps/desktop/src/renderer/src/components/AgentStatusBar.tsx',
    symbol: 'AgentStatusBar',
    callers: ['apps/desktop/src/renderer/src/App.tsx'],
    tests: ['apps/desktop/test/agent-status-bar.test.tsx', 'apps/desktop/test/agent-roster-surface.test.tsx']
  },
  {
    id: 'workspace-path-rebind',
    source: 'apps/desktop/src/renderer/src/lib/workspace-path-recovery.ts',
    symbol: 'applyWorkspacePathRebind',
    callers: ['apps/desktop/src/renderer/src/components/FileExplorer.tsx'],
    tests: ['apps/desktop/test/workspace-navigation-recovery.test.tsx', 'apps/desktop/test/workspace-rebind.test.ts']
  },
  {
    id: 'package-source-identity',
    source: 'apps/desktop/scripts/package-identity.mjs',
    symbol: 'createPackageIdentity',
    callers: ['apps/desktop/scripts/package-macos.mjs', 'apps/desktop/scripts/report-desktop-package.mjs'],
    tests: ['apps/desktop/test/package-identity.test.ts']
  }
]

function gitGrep(symbol, roots) {
  try {
    return execFileSync('git', ['grep', '-n', '-F', symbol, '--', ...roots], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    }).trim().split('\n').filter(Boolean)
  } catch (error) {
    if (error?.status === 1) return []
    throw error
  }
}

function productionUseHits(symbol, roots) {
  const exact = new RegExp(`(?<![A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`)
  return gitGrep(symbol, roots).filter((hit) => {
    const source = hit.slice(hit.indexOf(':') + 1)
    return !/\bimport\b/.test(source) && exact.test(source)
  })
}

function deletedHistory() {
  const output = execFileSync(
    'git',
    ['log', '--all', '--reflog', '--diff-filter=D', '--format=commit:%H%x09%s', '--name-status', '--', 'apps/desktop/src', 'apps/desktop/scripts', 'packages/core/src'],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  const records = []
  let commit = null
  let subject = null
  for (const line of output.split('\n')) {
    if (line.startsWith('commit:')) {
      const [hash, ...rest] = line.slice('commit:'.length).split('\t')
      commit = hash
      subject = rest.join('\t')
      continue
    }
    const match = /^D\t(.+)$/.exec(line)
    if (match && commit) records.push({ commit, subject, path: match[1], reviewRequired: true })
  }
  return records
}

const results = []
for (const anchor of FEATURE_ANCHORS) {
  const sourceText = await readFile(resolve(repositoryRoot, anchor.source), 'utf8').catch(() => null)
  const sourcePresent = sourceText?.includes(anchor.symbol) === true
  const callerHits = productionUseHits(anchor.symbol, anchor.callers)
  const testHits = gitGrep(anchor.symbol, anchor.tests)
  results.push({
    ...anchor,
    sourcePresent,
    productionCallerCount: callerHits.length,
    productionCallerHits: callerHits,
    testHitCount: testHits.length,
    testHits,
    ok: sourcePresent && callerHits.length > 0 && testHits.length > 0
  })
}

const history = deletedHistory().map((record) => {
  const anchor = FEATURE_ANCHORS.find((candidate) => candidate.source === record.path)
  return {
    ...record,
    anchorId: anchor?.id ?? null,
    // A critical source that was deleted and never reintroduced is a release blocker. A historical
    // deletion of an obsolete implementation remains visible, but does not masquerade as a lost
    // capability when the current design anchor still has callers and tests.
    replacementPresent: anchor ? results.find((result) => result.id === anchor.id)?.ok === true : null,
    reviewRequired: Boolean(anchor)
  }
})
const blockingDeletions = history.filter((record) => record.reviewRequired && !record.replacementPresent)
const report = {
  schema: 'agentmux.feature-history-audit.v1',
  source: 'design-contract-anchors',
  repositoryRoot,
  anchors: results,
  deletedHistory: history,
  blockingDeletions,
  ok: results.every((result) => result.ok) && blockingDeletions.length === 0
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.ok) process.exitCode = 1
