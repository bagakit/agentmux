import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolkitToolDefinition, ToolkitToolFields } from '@agentmux/core/control'
import { presentError } from '../../lib/error-presentation'
import { configValuesEqual } from '../../../../shared/config-edit'

const fields = ['name', 'icon', 'enabled', 'statusBar', 'workspacePath', 'script', 'args', 'actions'] as const
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
export type ToolkitDraft = { value: ToolkitToolFields; expected: ToolkitToolDefinition | null; saving: boolean; state: SaveState; error: string; missing: boolean }
export type ToolkitDraftWriter = {
  add(id: string, value: ToolkitToolFields): Promise<ToolkitToolDefinition>
  update(id: string, changes: Partial<ToolkitToolFields>, expected: Partial<ToolkitToolFields>): Promise<ToolkitToolDefinition>
}
export function toolkitFields(tool: ToolkitToolFields): ToolkitToolFields {
  return { name: tool.name, icon: tool.icon, enabled: tool.enabled, statusBar: tool.statusBar, workspacePath: tool.workspacePath, script: tool.script, args: [...tool.args], ...(tool.actions ? { actions: tool.actions.map(action => ({ ...action, args: [...action.args] })) } : {}) }
}
export function toolkitDraftDirty(entry: ToolkitDraft): boolean {
  return entry.expected === null || fields.some(key => !configValuesEqual(entry.value[key], entry.expected![key]))
}
function clean(tool: ToolkitToolDefinition): ToolkitDraft {
  return { value: toolkitFields(tool), expected: tool, saving: false, state: 'idle', error: '', missing: false }
}
function reconcile(entry: ToolkitDraft, saved: ToolkitToolDefinition | undefined): ToolkitDraft | undefined {
  if (entry.saving) return entry
  if (!saved) return entry.expected === null ? entry : toolkitDraftDirty(entry) ? { ...entry, missing: true } : undefined
  if (!entry.expected) return entry // A colliding externally-created ID must still fail add.
  const value = { ...entry.value }, expected = { ...entry.expected, revision: saved.revision }
  for (const key of fields) if (configValuesEqual(entry.value[key], entry.expected[key])) {
    if (key === 'actions' && saved.actions === undefined) { delete value.actions; delete expected.actions }
    else { Object.assign(value, { [key]: saved[key] }); Object.assign(expected, { [key]: saved[key] }) }
  }
  return { ...entry, value, expected, missing: false }
}

/** A captured save acknowledges one entity. Other authored tools and later keystrokes stay dirty. */
export function useToolkitDrafts(saved: readonly ToolkitToolDefinition[]) {
  const committed = useMemo(() => new Map(saved.map(tool => [tool.id, tool])), [saved])
  const latest = useRef(committed)
  latest.current = committed
  const pending = useRef(new Set<string>())
  const [entries, setEntries] = useState<Record<string, ToolkitDraft>>(() => Object.fromEntries(saved.map(tool => [tool.id, clean(tool)])))
  useEffect(() => {
    setEntries(current => {
      const next: Array<[string, ToolkitDraft]> = []
      for (const id of new Set([...Object.keys(current), ...committed.keys()])) {
        const entry = Object.hasOwn(current, id) ? reconcile(current[id]!, committed.get(id)) : clean(committed.get(id)!)
        if (entry) next.push([id, entry])
      }
      return Object.fromEntries(next)
    })
  }, [committed])
  function edit(id: string, patch: Partial<ToolkitToolFields>) {
    setEntries(current => {
      const entry = current[id]
      if (!Object.hasOwn(current, id) || !entry) return current
      const changed = { ...entry, value: { ...entry.value, ...patch }, state: entry.saving ? 'saving' as const : 'idle' as const }
      const source = committed.get(id)
      // A durable reply can precede its React publication. Do not undo it with older props.
      return { ...current, [id]: source && source.revision === entry.expected?.revision ? reconcile(changed, source) ?? changed : changed }
    })
  }
  function saveFor(id: string) {
    const entry = entries[id]!
    async function run(operation: () => Promise<void>): Promise<boolean> {
      if (pending.current.has(id)) return false
      pending.current.add(id)
      setEntries(current => ({ ...current, [id]: { ...current[id]!, saving: true, state: 'saving', error: '' } }))
      try {
        await operation()
        setEntries(current => {
          const finished: ToolkitDraft = { ...current[id]!, saving: false, state: 'saved', error: '' }
          return { ...current, [id]: finished }
        })
        return true
      } catch (cause) {
        setEntries(current => {
          const finished: ToolkitDraft = { ...current[id]!, saving: false, state: 'error', error: presentError(cause) }
          return { ...current, [id]: reconcile(finished, latest.current.get(id)) ?? finished }
        })
        return false
      } finally {
        pending.current.delete(id)
      }
    }
    return { state: entry.state, error: entry.error, saving: entry.saving, run }
  }
  async function save(id: string, writer: ToolkitDraftWriter): Promise<boolean> {
    const captured = entries[id]!
    if (!captured || captured.saving || !toolkitDraftDirty(captured)) return false
    const submitted = toolkitFields(captured.value)
    return saveFor(id).run(async () => {
      const changes: Partial<ToolkitToolFields> = {}, expected: Partial<ToolkitToolFields> = {}
      if (captured.expected) for (const key of fields) if (!configValuesEqual(submitted[key], captured.expected[key])) {
        Object.assign(changes, { [key]: submitted[key] }); Object.assign(expected, { [key]: key === 'actions' ? captured.expected.actions ?? [] : captured.expected[key] })
      }
      const accepted = captured.expected ? await writer.update(id, changes, expected) : await writer.add(id, submitted)
      setEntries(current => {
        const value = { ...current[id]!.value }, baseline = { ...accepted }
        for (const key of fields) {
          if (configValuesEqual(value[key], submitted[key])) {
            if (key === 'actions' && accepted.actions === undefined) delete value.actions
            else Object.assign(value, { [key]: accepted[key] })
          } else if (captured.expected && !Object.hasOwn(changes, key)) {
            // A sibling save cannot acknowledge input first authored while it was pending.
            if (key === 'actions' && captured.expected.actions === undefined) delete baseline.actions
            else Object.assign(baseline, { [key]: captured.expected[key] })
          }
        }
        return { ...current, [id]: { ...current[id]!, value, expected: baseline, missing: false } }
      })
    })
  }
  function add(id: string, value: ToolkitToolFields) {
    setEntries(current => ({ ...current, [id]: { value, expected: null, saving: false, state: 'idle', error: '', missing: false } }))
  }
  function forget(id: string) {
    setEntries(current => { const next = { ...current }; delete next[id]; return next })
  }
  return { entries, edit, add, forget, save, saveFor }
}
