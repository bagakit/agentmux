export function acceptedEarlierWindow(reads, accepted) {
  const window = accepted && reads.findLast(read => read.window?.complete === true &&
    read.window.id === accepted.id && read.window.revision === accepted.revision)?.window
  if (!window?.navigation?.older) throw new Error('No complete original earlier window for the accepted reading consumer frame')
  return window
}
