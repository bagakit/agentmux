/** Deterministic instants relative to Unix zero for Node-only process fixtures. */
export function fixtureEpoch(days, seconds = 0, milliseconds = 0) {
  const secondsPerDay = 24 * 60 * 60
  const millisecondsPerSecond = 1_000
  return (days * secondsPerDay + seconds) * millisecondsPerSecond + milliseconds
}
