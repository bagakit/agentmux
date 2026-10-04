// First configuration creation only. These are ordinary editable local package references.
export const INITIAL_TOOLKIT_PACKAGES = [
  { id: 'auth', directory: 'auth', args: ['codexL', '@active'] }
] satisfies { id: string; directory: string; args: string[] }[]
