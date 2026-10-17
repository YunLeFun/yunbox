/** Where a command runs and how it talks to the user. Injected so tests can run commands in-process. */
export interface CliContext {
  /** Working directory the command acts on. */
  cwd: string
  /** Environment passed to every `git` child process. */
  env: NodeJS.ProcessEnv
  /** Source of `--token-stdin` and interactive token input. */
  stdin: NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?: (mode: boolean) => unknown }
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

/** Write one line to the context's stdout. */
export function print(context: CliContext, line = ''): void {
  context.stdout.write(`${line}\n`)
}

/** Write one line to the context's stderr. */
export function printError(context: CliContext, line: string): void {
  context.stderr.write(`${line}\n`)
}

/** An error whose message is shown to the user as-is, with an optional exit code (default 1). */
export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/** Exit code for invalid command-line usage. */
export const USAGE_EXIT_CODE = 2
