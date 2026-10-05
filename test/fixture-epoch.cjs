/** Controlled fixture coordinates; zero and relative ordering are intentional. */
function fixtureEpoch(days, seconds = 0, milliseconds = 0) {
  return days * 24 * 60 * 60 * 1000 + seconds * 1000 + milliseconds
}
module.exports = { fixtureEpoch }
