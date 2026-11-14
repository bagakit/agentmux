export type NativeProviderError = new (message: string, code: string, detail?: string) => Error & { code: string }
