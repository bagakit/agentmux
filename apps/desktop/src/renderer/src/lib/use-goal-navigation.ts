import { mintObjectId } from '@agentmux/core/object-id'
import { useCallback } from 'react'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { useAppStore } from '../store'

/** The existing Goal-only control and service window remain the navigation and feedback owners. */
export function useGoalNavigation() {
  const execute = useAppStore(state => state.executeControl)
  return useCallback(async (goalId: string) => {
    try {
      const result = await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
        operation: 'focus', target: { kind: 'goal', goalId }, inputPolicy: 'preserve' })
      if (result.operation !== 'focus' || result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed') {
        const issue = result.operation === 'focus' ? result.issues.find(issue => issue.step === 'target' || issue.step === 'navigation') : undefined
        useAppStore.getState().reportError(new Error(issue?.message ?? 'The original Goal navigation is unconfirmed.'), {
          kind: 'indeterminate', summary: issue?.recovery ?? 'The current work surface and healthy Agents are kept. Inspect the client before explicitly retrying the original Goal.'
        })
      }
      // Partial observation does not reject a Goal that the original owner has applied.
      // Its presentation/input/save notice remains with desktopNavigationNotice.
    } catch (error) {
      useAppStore.getState().reportError(error, { kind: 'indeterminate',
        summary: 'Goal navigation did not complete. The current work surface and healthy Agents are kept; review the original Goal before retrying.' })
    }
  }, [execute])
}
