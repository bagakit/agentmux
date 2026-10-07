/** A failed lookup observes the configured file, not the software's installation state. */
export function missingExecutableCause(command: string): { code: string; message: string } {
  return {
    code: 'EXECUTABLE_NOT_FOUND',
    message: `Configured executable ${JSON.stringify(command)} was not found on this host. Check its path or PATH. Keep launch arguments in args, separate from the executable name or path.`
  }
}
