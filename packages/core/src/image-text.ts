/** Pattern suggestions about image text, never a completeness or authorization claim. */
export function isSensitiveImageText(text: string): boolean {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|\b(?:sk[-_]|gh[pousr]_|AKIA)[A-Za-z0-9_-]{12,}|\b(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/i.test(text)
}
