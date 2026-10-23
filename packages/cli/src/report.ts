import type { CliContext } from './context.ts'
import { print } from './context.ts'
import { terminalFor, terminalText } from './terminal.ts'

/** Outcome of one check or setup step. `warn` and `skip` do not fail a command. */
export type StepStatus = 'pass' | 'warn' | 'fail' | 'skip'

/** One reported line plus the commands that fix it. */
export interface StepReport {
  status: StepStatus
  title: string
  detail?: string
  /** Commands or instructions the user can follow directly. */
  fixes?: string[]
}

const SYMBOLS: Record<StepStatus, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
  skip: '-',
}

/** Print a step as `✓ title：detail`, followed by indented fix lines. */
export function printStep(context: CliContext, step: StepReport): void {
  const style = terminalFor(context)
  const tone = { pass: 'success', warn: 'warning', fail: 'error', skip: 'muted' } as const
  print(context, style.paint(tone[step.status], `${SYMBOLS[step.status]} ${terminalText(step.title)}${step.detail === undefined ? '' : `：${terminalText(step.detail)}`}`))
  if (step.fixes !== undefined && step.fixes.length > 0) {
    print(context, step.status === 'fail' ? '    修复：' : '    建议：')
    for (const fix of step.fixes)
      print(context, `      ${fix}`)
  }
}
