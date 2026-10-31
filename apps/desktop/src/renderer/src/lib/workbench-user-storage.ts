/** Original Desktop user projection. Native storage owns the only durable copy. */
export const WORKBENCH_USER_STATE_KEY = 'agentmux-workbench-v1'

type UserStatePort = {
  readWorkbenchState(): Promise<string | null>
  importWorkbenchState(value: string): Promise<string>
  writeWorkbenchState(value: string): Promise<unknown>
}

export function createWorkbenchUserStorage(port: UserStatePort, original: () => Pick<Storage, 'getItem' | 'removeItem'>) {
  const target = (name: string) => {
    if (name !== WORKBENCH_USER_STATE_KEY) throw new Error('This storage owner accepts only the original Desktop user-state document.')
  }
  return {
    async getItem(name: string): Promise<string | null> {
      target(name)
      const saved = await port.readWorkbenchState()
      if (saved !== null) return saved
      // Import existing user bytes only on confirmed native absence. Read failure
      // never enters this path; failed import retains the original exact bytes.
      const held = original().getItem(name)
      if (held === null) return null
      const parsed = JSON.parse(held)
      if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) {
        throw new Error('The original Desktop user state is invalid. Its bytes were retained; restore the original storage before saving.')
      }
      const imported = await port.importWorkbenchState(held)
      if (imported === held && original().getItem(name) === held) original().removeItem(name)
      return imported
    },
    async setItem(name: string, value: string): Promise<void> {
      target(name)
      await port.writeWorkbenchState(value)
    },
    async removeItem(name: string): Promise<void> {
      target(name)
      // Retain an explicit empty document so old imported bytes cannot revive.
      await port.writeWorkbenchState(JSON.stringify({ state: {}, version: 1 }))
    }
  }
}
