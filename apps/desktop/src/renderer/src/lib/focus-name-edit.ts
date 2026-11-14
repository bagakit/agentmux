export type FocusNameVersion = { override: string | null; nameRevision: number }
export type FocusNameSave = {
  operationId: string
  applied: boolean
  nameRevision: number
  diskDurability: 'confirmed' | 'unconfirmed'
  issue: string | null
}

export type FocusNameEditor = {
  inspect(): Promise<FocusNameVersion>
  save(value: string | null, expectedNameRevision: number): Promise<FocusNameSave>
  confirm(operationId: string): Promise<FocusNameSave>
}
