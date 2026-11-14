/** Expand assignments for pair-based carriers without reinterpreting their data.
 * Domain parsers still own legal flags, arity, duplicates and business values.
 * Generic flags() already supports assignments and does not use this adapter. */
export function expandCliOptionAssignments(args: readonly string[], positionalData = 0,
  booleanOptions: readonly string[] = []): string[] {
  const result = args.slice(0, positionalData)
  for (let index = positionalData; index < args.length; index++) {
    const argument = args[index]!
    if (!argument.startsWith('--')) { result.push(argument); continue }
    const separator = argument.indexOf('=')
    const option = separator < 0 ? argument : argument.slice(0, separator)
    if (booleanOptions.includes(option)) {
      // Leave --switch=value intact so its original parser refuses the value.
      result.push(argument)
    } else if (separator >= 0) {
      result.push(option, argument.slice(separator + 1))
    } else {
      result.push(argument)
      // A consumed literal can itself look like --another=option.
      if (index + 1 < args.length) result.push(args[++index]!)
    }
  }
  return result
}
