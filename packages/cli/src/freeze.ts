import type { CliContext } from './context.ts'
import { join } from 'node:path'
import { LOCATION_FILE } from './cos/location.ts'
import { runGit } from './git.ts'

/**
 * Multi-valued Git config key: each value is one freeze rule set in the
 * OpenStreetMap `opening_hours` syntax subset, e.g. `Mo-Fr 09:00-18:00`.
 */
export const FREEZE_KEY = 'yunbox.pushFreeze'
/** Explanation shown when a window of the same scope blocks a push. */
export const FREEZE_MESSAGE_KEY = 'yunbox.pushFreezeMessage'
/** IANA time zone the windows of the same scope are written in; this machine's zone when unset. */
export const FREEZE_TIME_ZONE_KEY = 'yunbox.pushFreezeTimeZone'
/**
 * Turns every window off without deleting it: an ISO 8601 moment after which they apply again, or `forever`.
 * Only personal scopes may hold it; a committed pause would switch the team's rules off for everyone.
 */
export const FREEZE_PAUSE_KEY = 'yunbox.pushFreezePausedUntil'

const MINUTES_PER_DAY = 24 * 60
/** How far ahead `until` is searched before a freeze counts as permanent. */
const SEARCH_MINUTES = 7 * MINUTES_PER_DAY
const SPAN_PATTERN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/
const CLOCK_PATTERN = /^(?:(\S+)\s+)?(\d{1,2}):(\d{2})$/

/** Weekday names in JSON output, indexed like `Date#getDay()` (Sunday is 0). */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** `opening_hours` weekday names, the normalized form. */
const OSM_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const CHINESE_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** Display order, Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
/** Shorthands beyond `opening_hours`, normalized away when saved. */
const DAY_ALIASES: Record<string, number[]> = { weekdays: [1, 2, 3, 4, 5], weekends: [6, 0], 工作日: [1, 2, 3, 4, 5], 周末: [6, 0] }
const FORMAT_HINT = '应为 opening_hours 写法：[星期] HH:MM-HH:MM[,HH:MM-HH:MM]，多条规则用「;」分隔，例如 Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-12:00'

/**
 * Where a window is configured: `shared` is the committed `.yunbox/config`;
 * the others are the scopes `git config --show-scope` reports.
 */
export type FreezeScope = 'shared' | 'local' | 'worktree' | 'global' | 'system' | 'command'

/** `[start, end)` in minutes after midnight; `end` up to 1440, smaller than `start` when it runs past midnight. */
export interface FreezeSpan {
  start: number
  end: number
}

/** One `;`-separated rule: its weekdays (absent means every day) and spans; no spans means `off`. */
export interface FreezeRule {
  days?: number[]
  spans: FreezeSpan[]
}

/** A parsed rule set: later rules replace earlier ones on the days they name, as in `opening_hours`. */
export interface ParsedFreezeWindow {
  /** Normalized, e.g. `Mo-Fr 09:00-18:00; We off`. */
  window: string
  rules: FreezeRule[]
  /** Effective spans for each weekday (0 = Sunday); a span past midnight belongs to the day it starts. */
  week: FreezeSpan[][]
}

/** One configured window and the scope it came from. */
export interface FreezeWindow extends ParsedFreezeWindow {
  scope: FreezeScope
}

/** Every configured window plus each scope's message, time zone and pause. */
export interface FreezeConfig {
  windows: FreezeWindow[]
  messages: Partial<Record<FreezeScope, string>>
  timeZones: Partial<Record<FreezeScope, string>>
  /** Raw `pushFreezePausedUntil` per scope: an ISO moment or `forever`. */
  pauses?: Partial<Record<FreezeScope, string>>
}

/** Windows switched off by `yunbox freeze off`. */
export interface FreezePause {
  scope: FreezeScope
  /** ISO 8601 moment the windows apply again; `null` until `yunbox freeze on`. */
  until: string | null
}

/** A wall-clock moment in some time zone. */
export interface FreezeClock {
  /** `mon` … `sun`. */
  weekday: typeof WEEKDAYS[number]
  /** `HH:MM`. */
  time: string
}

/** Whether a push is allowed at a moment; when frozen, the blocking window and when pushing opens again. */
export interface FreezeCheck extends FreezeClock {
  /** `paused`: a window would block now, but `yunbox freeze off` switched the windows off. */
  status: 'allowed' | 'frozen' | 'paused'
  /** The zone `weekday` / `time` / `until` are in; absent for this machine's zone. */
  timeZone?: string
  window?: string
  scope?: FreezeScope
  message?: string
  /** When pushing opens again (`daysAhead` 0 is today); `null` when no gap appears within 7 days. */
  until?: (FreezeClock & { daysAhead: number }) | null
  /** The pause in effect, whether or not a window would block now. */
  pause?: FreezePause
}

/** Human-readable name of each scope for messages. */
export const SCOPE_LABELS: Record<FreezeScope, string> = {
  shared: `团队 ${LOCATION_FILE}`,
  local: '本仓库 .git/config',
  worktree: '本 worktree 配置',
  global: '全局 ~/.gitconfig',
  system: '系统 Git 配置',
  command: '命令行 -c',
}

/**
 * Parse a rule set in the OpenStreetMap `opening_hours` subset: rules
 * separated by `;`, each `[weekdays] spans`, `[weekdays] off` or `24/7`.
 * Weekdays are `Mo`…`Su` (also `mon`…`sun` or `周一`…`周日`), ranges such as
 * `Mo-Fr` (which may wrap, `Fr-Mo`) and comma lists; `weekdays` / `weekends` /
 * `工作日` / `周末` are shorthands. Weekdays alone mean the whole day. Spans
 * are `HH:MM-HH:MM` separated by commas, `[start, end)`; a span past midnight
 * (`22:00-02:00`) belongs to the day it starts. As in `opening_hours`, a later
 * rule replaces earlier ones on the days it names: `Mo-Fr 09:00-18:00; We off`.
 *
 * @throws {TypeError} explaining the expected format.
 */
export function parseFreezeWindow(text: string): ParsedFreezeWindow {
  const parts = text.split(';').map(part => part.trim())
  // A trailing `;` is harmless; an empty rule elsewhere is a typo.
  if (parts.at(-1) === '' && parts.length > 1)
    parts.pop()
  if (parts.includes(''))
    throw new TypeError(`时段「${text}」为空，${FORMAT_HINT}`)
  const rules = parts.map(part => parseRule(part, text))
  return { window: formatRules(rules), rules, week: effectiveWeek(rules) }
}

/** Give every rule that names no weekdays the weekdays `days`. */
export function withDays(window: ParsedFreezeWindow, days: number[] | undefined): ParsedFreezeWindow {
  const rules = window.rules.map(rule => rule.days === undefined && days !== undefined ? { ...rule, days } : rule)
  return { window: formatRules(rules), rules, week: effectiveWeek(rules) }
}

/**
 * Parse a weekday selector such as `Mo-Fr`, `Sa,Su` or `weekdays`; every day
 * yields `undefined`.
 *
 * @throws {TypeError} naming the accepted names.
 */
export function parseDays(text: string): number[] | undefined {
  const days = new Set<number>()
  for (const part of text.split(',')) {
    const alias = DAY_ALIASES[part.toLowerCase()]
    if (alias) {
      alias.forEach(day => days.add(day))
      continue
    }
    if (/^(?:PH|SH)$/i.test(part))
      throw new TypeError(`暂不支持节假日（${part}），请用星期表示`)
    const [from, to = from, extra] = part.split('-').map(dayIndex)
    if (from === undefined || from < 0 || to! < 0 || extra !== undefined)
      throw new TypeError(`星期「${text}」格式不对，可用 Mo Tu We Th Fr Sa Su、范围 Mo-Fr、列表 Sa,Su，或 weekdays / weekends`)
    // A range may wrap around the week, e.g. Fr-Mo.
    for (let day = from; ; day = (day + 1) % 7) {
      days.add(day)
      if (day === to)
        break
    }
  }
  return days.size === 7 ? undefined : WEEK_ORDER.filter(day => days.has(day))
}

/** Compact `opening_hours` weekday selector, Monday first: runs of three or more become ranges. */
export function formatDays(days: number[]): string {
  const ordered = WEEK_ORDER.filter(day => days.includes(day))
  const parts: string[] = []
  for (let i = 0; i < ordered.length;) {
    let j = i
    while (j + 1 < ordered.length && WEEK_ORDER.indexOf(ordered[j + 1]!) === WEEK_ORDER.indexOf(ordered[j]!) + 1)
      j++
    if (j - i >= 2)
      parts.push(`${OSM_DAYS[ordered[i]!]}-${OSM_DAYS[ordered[j]!]}`)
    else
      parts.push(...ordered.slice(i, j + 1).map(day => OSM_DAYS[day]!))
    i = j + 1
  }
  return parts.join(',')
}

/** `HH:MM` for minutes after midnight; 1440 is `24:00`. */
export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * Turn `[weekday ]HH:MM` into a moment in this machine's zone: today, or the
 * first such weekday from today on.
 *
 * @throws {TypeError} explaining the expected format.
 */
export function parseMoment(text: string, now: Date = new Date()): Date {
  const match = CLOCK_PATTERN.exec(text.trim())
  const minutes = match ? toMinutes(match[2]!, match[3]!) : Number.NaN
  const day = match?.[1] === undefined ? undefined : dayIndex(match[1])
  if (!(minutes >= 0 && minutes < MINUTES_PER_DAY) || day === -1)
    throw new TypeError(`时间「${text}」格式不对，应为 [星期] HH:MM，例如 11:30 或 Fr 17:00`)
  const ahead = day === undefined ? 0 : (day - now.getDay() + 7) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead, Math.floor(minutes / 60), minutes % 60)
}

/** Whether `timeZone` is an IANA zone this Node.js knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    zonedFormatter(timeZone)
    return true
  }
  catch {
    return false
  }
}

/** Whether a weekday and minute fall inside `window`, including spans carried over from the day before. */
export function inWindow(window: Pick<ParsedFreezeWindow, 'week'>, weekday: number, minute: number): boolean {
  return window.week[weekday]!.some(span => minute >= span.start && (span.start > span.end || minute < span.end))
    || window.week[(weekday + 6) % 7]!.some(span => span.start > span.end && minute < span.end)
}

/**
 * Check `now` against every window, each in its scope's time zone.
 * Overlapping or adjacent windows, also across scopes, extend `until`.
 */
export function checkFreeze(config: FreezeConfig, now: Date): FreezeCheck {
  const blocking = blockingWindow(config, now)
  const pause = activePauses(config, now)[0]
  if (blocking === undefined)
    return { status: 'allowed', ...toClock(wallClock(now)), ...(pause ? { pause } : {}) }
  if (pause) {
    const timeZone = config.timeZones[blocking.scope]
    return { status: 'paused', ...toClock(wallClock(now, timeZone)), ...(timeZone ? { timeZone } : {}), window: blocking.window, scope: blocking.scope, pause }
  }
  const timeZone = config.timeZones[blocking.scope]
  const current = wallClock(now, timeZone)
  let until: FreezeCheck['until'] = null
  const minute = Math.floor(now.getTime() / 60_000) * 60_000
  for (let step = 1; step <= SEARCH_MINUTES; step++) {
    const next = new Date(minute + step * 60_000)
    if (blockingWindow(config, next) === undefined) {
      const opens = wallClock(next, timeZone)
      until = { ...toClock(opens), daysAhead: Math.round((opens.day - current.day) / 86_400_000) }
      break
    }
  }
  const message = config.messages[blocking.scope]
  return {
    status: 'frozen',
    ...toClock(current),
    ...(timeZone ? { timeZone } : {}),
    window: blocking.window,
    scope: blocking.scope,
    ...(message ? { message } : {}),
    until,
  }
}

/** Scopes a pause may be written to, in the order a pause takes effect. */
const PAUSE_SCOPES: FreezeScope[] = ['local', 'worktree', 'command', 'global', 'system']

/** Pauses still in effect at `now`, the repository's own first. */
export function activePauses(config: FreezeConfig, now: Date): FreezePause[] {
  const pauses: FreezePause[] = []
  for (const scope of PAUSE_SCOPES) {
    const value = config.pauses?.[scope]
    if (value === undefined)
      continue
    if (value === 'forever')
      pauses.push({ scope, until: null })
    else if (Date.parse(value) > now.getTime())
      pauses.push({ scope, until: new Date(value).toISOString() })
  }
  return pauses
}

/**
 * When `yunbox freeze off --for` / `--until` ends. Durations are `30m`, `1h`,
 * `1h30m` or `2d` (at most 30 days); a clock time is the next such moment in
 * this machine's zone, `24:00` meaning the end of today.
 *
 * @throws {TypeError} explaining the expected format.
 */
export function pauseEnd(options: { for?: string, until?: string }, now: Date): Date {
  if (options.for !== undefined) {
    const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?:in)?)?$/i.exec(options.for.trim())
    const minutes = match ? Number(match[1] ?? 0) * MINUTES_PER_DAY + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0
    if (!(minutes > 0 && minutes <= 30 * MINUTES_PER_DAY))
      throw new TypeError(`时长「${options.for}」格式不对，例如 30m、1h、1h30m、2d（最长 30 天）`)
    return new Date(now.getTime() + minutes * 60_000)
  }
  const text = options.until!.trim()
  if (text === '24:00')
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const moment = parseMoment(text, now)
  if (moment.getTime() <= now.getTime())
    moment.setDate(moment.getDate() + (CLOCK_PATTERN.exec(text)?.[1] === undefined ? 1 : 7))
  return moment
}

/** `今天 17:30`, `明天 09:00` or `10月25日 09:00` in this machine's zone; `null` means until switched back on. */
export function formatPauseEnd(until: string | null, now: Date): string {
  if (until === null)
    return '直到重新开启'
  const date = new Date(until)
  const days = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000)
  const day = days === 0 ? '今天' : days === 1 ? '明天' : `${date.getMonth() + 1}月${date.getDate()}日`
  return `至 ${day} ${formatMinutes(date.getHours() * 60 + date.getMinutes())}`
}

/** One local calendar day and the frozen stretches in it, for timelines. */
export interface FreezeDay {
  /** `mon` … `sun`. */
  weekday: typeof WEEKDAYS[number]
  /** `YYYY-MM-DD` in this machine's zone. */
  date: string
  /** Merged frozen stretches, `HH:MM` to `HH:MM` (`24:00` for the end of the day). */
  spans: { start: string, end: string }[]
}

/**
 * The frozen stretches of `days` local calendar days starting with the day of
 * `now`, in this machine's zone, with every window evaluated in its own zone.
 */
export function freezeTimeline(config: FreezeConfig, now: Date, days = 7): FreezeDay[] {
  const timeline: FreezeDay[] = []
  for (let offset = 0; offset < days; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const spans: FreezeDay['spans'] = []
    let start: number | undefined
    for (let minute = 0; minute <= MINUTES_PER_DAY; minute++) {
      const frozen = minute < MINUTES_PER_DAY && config.windows.length > 0
        && blockingWindow(config, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minute)) !== undefined
      if (frozen && start === undefined) {
        start = minute
      }
      else if (!frozen && start !== undefined) {
        spans.push({ start: formatMinutes(start), end: formatMinutes(minute) })
        start = undefined
      }
    }
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    timeline.push({ weekday: WEEKDAYS[day.getDay()]!, date, spans })
  }
  return timeline
}

/** The text shown when a push is blocked. */
export function formatFreezeBlock(check: FreezeCheck): string {
  const zone = check.timeZone ? `（${check.timeZone}）` : ''
  const until = check.until
  const opens = until === null || until === undefined
    ? '接下来 7 天都不能推送'
    : `${until.daysAhead === 0 ? '' : until.daysAhead === 1 ? '明天 ' : `${weekdayLabel(until.weekday)} `}${until.time} 后可以推送`
  const lines = [`禁止推送：现在是${weekdayLabel(check.weekday)} ${check.time}${zone}，处于禁推时段 ${check.window}（${SCOPE_LABELS[check.scope!]}），${opens}。`]
  if (check.message)
    lines.push(check.message)
  lines.push('查看或修改禁推时段：yunbox freeze list')
  return `${lines.join('\n')}\n`
}

/**
 * Read windows, messages and time zones from Git config (every scope) and,
 * inside a repository, from the committed `.yunbox/config`. All windows apply together.
 *
 * @throws {TypeError} naming the scope of an invalid value.
 */
export async function readFreezeConfig(context: CliContext, root: string | undefined): Promise<FreezeConfig> {
  const config: FreezeConfig = { windows: [], messages: {}, timeZones: {}, pauses: {} }
  const keys = [FREEZE_KEY, FREEZE_MESSAGE_KEY, FREEZE_TIME_ZONE_KEY, FREEZE_PAUSE_KEY]
  const entries: { scope: FreezeScope, key: string, value: string }[] = []
  // Independent lookups run together; flattening preserves shared/key/scope order.
  const groups = await Promise.all([
    ...(root === undefined
      ? []
      : keys.map(async key => (await readAll(context, ['--file', join(root, LOCATION_FILE), '--get-all', key]))
          .map(value => ({ scope: 'shared' as const, key, value })))),
    ...keys.map(async key => (await readAll(context, ['--show-scope', '--get-all', key])).map((line) => {
      const tab = line.indexOf('\t')
      return { scope: line.slice(0, tab) as FreezeScope, key, value: line.slice(tab + 1) }
    })),
  ])
  entries.push(...groups.flat())
  for (const { scope, key, value } of entries) {
    const label = `${SCOPE_LABELS[scope] ?? scope} 的 ${key}`
    // Like `git config --get`, the last message or zone of a scope wins.
    if (key === FREEZE_MESSAGE_KEY) {
      config.messages[scope] = value
    }
    else if (key === FREEZE_PAUSE_KEY) {
      if (scope === 'shared')
        throw new TypeError(`${label}：不能提交到仓库，暂停只能写在本仓库或全局配置里`)
      if (value !== 'forever' && Number.isNaN(Date.parse(value)))
        throw new TypeError(`${label}：「${value}」应为 ISO 8601 时间或 forever，用 yunbox freeze on 恢复`)
      config.pauses![scope] = value
    }
    else if (key === FREEZE_TIME_ZONE_KEY) {
      if (!isValidTimeZone(value))
        throw new TypeError(`${label}：「${value}」不是有效的 IANA 时区，例如 Asia/Shanghai`)
      config.timeZones[scope] = value
    }
    else {
      try {
        config.windows.push({ ...parseFreezeWindow(value), scope })
      }
      catch (error) {
        throw new TypeError(`${label}：${(error as Error).message}`)
      }
    }
  }
  return config
}

function blockingWindow(config: FreezeConfig, date: Date): FreezeWindow | undefined {
  const clocks = new Map<string | undefined, WallClock>()
  return config.windows.find((window) => {
    const zone = config.timeZones[window.scope]
    let clock = clocks.get(zone)
    if (clock === undefined) {
      clock = wallClock(date, zone)
      clocks.set(zone, clock)
    }
    return inWindow(window, clock.weekday, clock.minute)
  })
}

interface WallClock {
  weekday: number
  minute: number
  /** UTC midnight of the calendar date, for counting days. */
  day: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function wallClock(date: Date, timeZone?: string): WallClock {
  if (timeZone === undefined)
    return { weekday: date.getDay(), minute: date.getHours() * 60 + date.getMinutes(), day: Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) }
  const parts = Object.fromEntries(zonedFormatter(timeZone).formatToParts(date).map(part => [part.type, part.value]))
  return {
    weekday: WEEKDAYS.indexOf(parts.weekday!.toLowerCase() as typeof WEEKDAYS[number]),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  }
}

function toClock(clock: WallClock): FreezeClock {
  return { weekday: WEEKDAYS[clock.weekday]!, time: formatMinutes(clock.minute) }
}

/** `周一` … `周日` for a JSON weekday name. */
export function weekdayLabel(weekday: string): string {
  return CHINESE_DAYS[WEEKDAYS.indexOf(weekday as typeof WEEKDAYS[number])]!
}

async function readAll(context: CliContext, args: string[]): Promise<string[]> {
  const result = await runGit(context, ['config', ...args])
  // Exit 1 means the key (or the file) is absent.
  if (result.code !== 0)
    return []
  return result.stdout.split(/\r?\n/).filter(line => line !== '')
}

function parseRule(rule: string, text: string): FreezeRule {
  // Tolerate spaces around separators: "Mo - Fr 09:00 - 12:00, 14:00 - 18:00".
  const compact = rule.replace(/\s*([,~–-])\s*/g, '$1').replace(/[~–]/g, '-')
  if (compact === '24/7')
    return { spans: [{ start: 0, end: MINUTES_PER_DAY }] }
  const [first = '', ...others] = compact.split(/\s+/)
  const selector = /^\d/.test(first) ? undefined : first
  const rest = (selector === undefined ? [first, ...others] : others).join(' ')
  const days = selector === undefined ? undefined : parseDays(selector)
  if (rest === '')
    return { days, spans: [{ start: 0, end: MINUTES_PER_DAY }] }
  if (/^(?:off|closed)$/i.test(rest))
    return { days, spans: [] }
  return { days, spans: rest.split(',').map(span => parseSpan(span, text)) }
}

function parseSpan(span: string, text: string): FreezeSpan {
  const match = SPAN_PATTERN.exec(span)
  const start = match ? toMinutes(match[1]!, match[2]!) : Number.NaN
  const end = match ? toMinutes(match[3]!, match[4]!) : Number.NaN
  if (!(start >= 0 && start < MINUTES_PER_DAY && end >= 0 && end <= MINUTES_PER_DAY) || start === end)
    throw new TypeError(`时段「${text}」里的「${span}」格式不对，${FORMAT_HINT}；开始和结束不能相同，24:00 只能作为结束`)
  return { start, end }
}

function formatRules(rules: FreezeRule[]): string {
  return rules.map((rule) => {
    const allDay = rule.spans.length === 1 && rule.spans[0]!.start === 0 && rule.spans[0]!.end === MINUTES_PER_DAY
    if (rule.days === undefined && allDay)
      return '24/7'
    const spans = rule.spans.length ? rule.spans.map(span => `${formatMinutes(span.start)}-${formatMinutes(span.end)}`).join(',') : 'off'
    return rule.days === undefined ? spans : `${formatDays(rule.days)} ${spans}`
  }).join('; ')
}

function effectiveWeek(rules: FreezeRule[]): FreezeSpan[][] {
  const week: FreezeSpan[][] = ALL_DAYS.map(() => [])
  for (const rule of rules) {
    for (const day of rule.days ?? ALL_DAYS)
      week[day] = rule.spans
  }
  return week
}

/** Weekday index (0 = Sunday) from `Mo`, `mon` or `周一`, case-insensitive; -1 when unknown. */
function dayIndex(name: string): number {
  const lower = name.toLowerCase()
  const index = OSM_DAYS.findIndex(day => day.toLowerCase() === lower)
  if (index >= 0)
    return index
  return WEEKDAYS.includes(lower as typeof WEEKDAYS[number]) ? WEEKDAYS.indexOf(lower as typeof WEEKDAYS[number]) : CHINESE_DAYS.indexOf(name)
}

function toMinutes(hours: string, minutes: string): number {
  const h = Number(hours)
  const m = Number(minutes)
  if (m > 59 || (h === 24 && m !== 0))
    return Number.NaN
  return h * 60 + m
}
