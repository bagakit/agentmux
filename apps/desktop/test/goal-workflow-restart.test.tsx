// @vitest-environment happy-dom
import { root, directory, demands, container, session, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { retainGoalFiniteStartIntent, useAppStore } from '../src/renderer/src/store'
import { GoalFiniteStartControl } from '../src/renderer/src/components/GoalFiniteStartControl'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'

const phase = process.env.AGENTMUX_GOAL_WORKFLOW_RESTART_PHASE, evidence = process.env.AGENTMUX_GOAL_WORKFLOW_RESTART_ROOT
it.skipIf(!phase || !evidence)('retains finite intent and discussion close/unknown facts through two separate Renderer processes', async () => {
  await act(async () => root.render(null))
  const key = 'agentmux-workbench-v1', storagePath = join(evidence!, 'original-workbench.json'), manifestPath = join(evidence!, 'first-process.json')
  if (phase === 'save') {
    await mkdir(evidence!, { recursive: true })
    await demands.create({ id: 'unknown-goal', title: 'Retain original discussion', sessionIds: [session.agentSessionId] })
    const tab = { ...createWorkbenchTab('explicitly-closed-discussion', { kind: 'launcher', regionId: 'original-launcher', workspaceId: SCRATCH_WORKSPACE_ID }), topicId: PMO_TEAMS_TOPIC_ID }
    useAppStore.setState({ tabs: { [tab.id]: tab }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('original-group', [tab.id]) }, demandPmoTabIds: { goal: tab.id, 'unknown-goal': 'unobserved-original-tab' } })
    expect(await useAppStore.getState().closeTab(SCRATCH_WORKSPACE_ID, 'original-group', tab.id)).toBe(true)
    const goal = (await demands.get('goal'))!, intent = { goalId: goal.id, operationId: 'retained-original-start', sessionId: session.agentSessionId,
      expectedUpdatedAt: goal.updatedAt, phase: 'may-have-dispatched' as const }
    expect((await retainGoalFiniteStartIntent(intent)).localStorageWritten).toBe(true)
    const storage = window.localStorage.getItem(key)!
    expect(JSON.parse(storage).state.demandPmoTabIds).toEqual({ 'unknown-goal': 'unobserved-original-tab' })
    expect(JSON.parse(storage).state.goalFiniteStartIntents.goal).toEqual(intent)
    await writeFile(storagePath, storage)
    await cp(join(directory, 'goals'), join(evidence!, 'original-goals'), { recursive: true })
    await writeFile(manifestPath, JSON.stringify({ pid: process.pid, goal, intent, writes }, null, 2))
  } else {
    expect(phase).toBe('restore')
    const first = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(process.pid).not.toBe(first.pid)
    await cp(join(evidence!, 'original-goals'), join(directory, 'goals'), { recursive: true })
    window.localStorage.setItem(key, await readFile(storagePath, 'utf8'))
    await useAppStore.persist.rehydrate()
    expect(useAppStore.getState().goalFiniteStartIntents.goal).toEqual(first.intent)
    expect(useAppStore.getState().demandPmoTabIds).toEqual({ 'unknown-goal': 'unobserved-original-tab' })
    expect(await demands.get('goal')).toEqual(first.goal)
    const accepted = [...writes]
    await act(async () => { await useAppStore.getState().refreshDemand('goal'); await useAppStore.getState().refreshDemand('unknown-goal'); root.render(<GoalFiniteStartControl demand={useAppStore.getState().demands.goal!} />) })
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain('outcome remains unknown') })
    await expect(useAppStore.getState().openDemandPmo('unknown-goal')).rejects.toThrow('placement is unconfirmed')
    expect(writes).toEqual(accepted)
    expect(useAppStore.getState().goalFiniteStartIntents.goal).toEqual(first.intent)
    await writeFile(join(evidence!, 'second-process.json'), JSON.stringify({ pid: process.pid, firstPid: first.pid, intent: useAppStore.getState().goalFiniteStartIntents.goal,
      discussionBindings: useAppStore.getState().demandPmoTabIds, unchangedGoal: await demands.get('goal'), inputWrites: writes,
      boundary: 'Two independent source Renderer test processes, actual Store save/rehydrate and original Demand file; Electron transport and Native I/O remain fixture ports. This does not qualify Chromium durability or native Session recovery.' }, null, 2))
  }
})
