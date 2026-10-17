/**
 * Invalid or incomplete configuration. The message lists every problem and
 * names options and environment variables, never their values, so it is safe
 * to print even when a value is a secret.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}
