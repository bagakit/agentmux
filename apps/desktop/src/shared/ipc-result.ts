/** Electron's invoke keeps only an error's message; this envelope keeps the code and detail as data. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; detail?: string } }

/** Main side: run one handler and return its value or its typed refusal. */
export async function ipcResult<T>(run: () => T | Promise<T>): Promise<IpcResult<T>> {
  try { return { ok: true, value: await run() } }
  catch (error) {
    const source = error instanceof Error ? error as Error & { code?: unknown; detail?: unknown } : null
    return { ok: false, error: {
      code: typeof source?.code === 'string' ? source.code : 'CONTROL_FAILED',
      message: source?.message ?? String(error),
      ...(typeof source?.detail === 'string' ? { detail: source.detail } : {})
    } }
  }
}

/** Renderer side, after contextBridge copied the plain result: a refusal becomes an Error with its code again. */
export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
  return result.value
}

/** The Profile GUI methods whose Main handlers return an IpcResult; reads and writes alike. */
export const BROWSER_PROFILE_RESULT_METHODS = ['switchProfile', 'saveProxy', 'deleteProxy', 'assignProxy', 'listProfiles', 'readProfiles', 'readProfileTrash', 'restoreProfile', 'setProfileTrashRetention', 'purgeProfile', 'inspectProfilePurge', 'updateProfile', 'setDefaultProfile', 'createProfileIdentity', 'confirmProfileCreation', 'inspectProfileCreation', 'saveProfileView', 'deleteProfileView', 'bulkUpdateProfiles', 'renameProfileFolder', 'deleteProfileFolder',
  'prepareProfileCookieImport', 'importProfileCookies', 'exportProfileCookies', 'inspectProfileCookieFiles', 'discardProfileCookieImport', 'revealProfileCookieFile',
  'listProfileBookmarks', 'editProfileBookmark', 'importProfileBookmarks', 'exportProfileBookmarks', 'openProfileBookmark',
  'listProfileExtensions', 'prepareProfileExtension', 'applyProfileExtension', 'removeProfileExtension', 'loadProfileExtension', 'deleteProfile', 'listProfileSites', 'clearProfileSite', 'checkProfileExit', 'probeProfileNetwork', 'profileNetworkHistory', 'readProfileProxySignIn', 'setProfileProxySignIn', 'detectProfileImportSources', 'importProfile'] as const
export type BrowserProfileResultMethod = typeof BROWSER_PROFILE_RESULT_METHODS[number]

/** Every method of an api object whose results arrive wrapped. */
export type IpcResultApi<A> = { [K in keyof A]: A[K] extends (...args: infer P) => Promise<infer R> ? (...args: P) => Promise<IpcResult<R>> : A[K] }

/** Unwrap the named methods of a wrapped api object; other members pass through unchanged. */
export function unwrapIpcResultMethods<A extends object, K extends keyof A>(api: IpcResultApi<Pick<A, K>> & Omit<A, K>, names: readonly K[]): A {
  const out: Record<PropertyKey, unknown> = { ...api }
  for (const name of names) {
    const call = (api as Record<PropertyKey, unknown>)[name] as (...args: unknown[]) => Promise<IpcResult<unknown>>
    out[name] = async (...args: unknown[]) => unwrapIpcResult(await call(...args))
  }
  return out as A
}
