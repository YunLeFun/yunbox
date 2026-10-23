import type { CliContext } from './context.ts'

/** Semantic emphasis shared by human-readable CLI reports. */
export type Tone = 'title' | 'muted' | 'info' | 'success' | 'warning' | 'error'

const STYLES: Record<Tone, number> = { title: 1, muted: 2, info: 36, success: 32, warning: 33, error: 31 }

/** Escape terminal controls in repository-provided labels, paths and messages. */
export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Common title, value and semantic emphasis for human-readable reports. */
export interface TerminalStyle {
  paint: (tone: Tone, text: string) => string
  title: (name: string) => string
  field: (label: string, value: string, tone?: Tone) => string
}

/** A small report formatter. Color never replaces a status word or symbol. */
export function terminalStyle(color = false): TerminalStyle {
  const paint = (tone: Tone, text: string): string => color ? `\u001B[${STYLES[tone]}m${text}\u001B[0m` : text
  return {
    paint,
    title: (name: string): string => paint('title', `云匣 · ${name}`),
    field: (label: string, value: string, tone?: Tone): string => `${paint('muted', `${label}：`)}${tone ? paint(tone, value) : value}`,
  }
}

/** Only decorate an interactive output stream; pipes, CI and NO_COLOR stay plain. */
export function terminalFor(context: CliContext, stream: 'stdout' | 'stderr' = 'stdout'): ReturnType<typeof terminalStyle> {
  const output = context[stream] as NodeJS.WritableStream & { isTTY?: boolean }
  const { env } = context
  return terminalStyle(Boolean(output.isTTY && !env.NO_COLOR && env.TERM !== 'dumb' && env.FORCE_COLOR !== '0' && !env.CI))
}
