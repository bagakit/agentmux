import { resolve } from 'node:path'
import original from './vitest.goal-links.config.mts'

const collection = resolve(import.meta.dirname, '../src/renderer/src/components/GoalActiveTickets.tsx')
export default { ...original,
  plugins: [...original.plugins ?? [], { name: 'actual-active-ticket-navigation', enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (!process.env.GOAL_ACTIVE_TICKETS_DROP_OPEN || id.split('?')[0] !== collection) return
      const call = "await api.ui.openObjectLink(formatAmuxObjectLink({ kind: 'goal', goalId, nodeId, ...read.result.owner }))"
      if (source.split(call).length !== 2) throw Error('Expected one active Ticket navigation call')
      process.stderr.write('Active Ticket navigation mutation loaded\n')
      return source.replace(call, 'await Promise.resolve()')
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/desktop-focus-navigation.test.tsx'],
    testNamePattern: /active Ticket links and the real CLI/, passWithNoTests: false }
}
