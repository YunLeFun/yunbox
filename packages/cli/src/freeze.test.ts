import type { FreezeConfig, FreezeScope } from './freeze.ts'
import { describe, expect, it } from 'vitest'
import { activePauses, checkFreeze, formatFreezeBlock, formatPauseEnd, freezeTimeline, parseDays, parseFreezeWindow, parseMoment, pauseEnd, withDays } from './freeze.ts'

function config(...windows: string[]): FreezeConfig {
  return { windows: windows.map(text => ({ ...parseFreezeWindow(text), scope: 'local' as FreezeScope })), messages: {}, timeZones: {} }
}

/** Local time on a fixed week: 2026-10-19 is a Monday. */
function at(day: 'mon' | 'tue' | 'fri' | 'sat' | 'sun', time: string): Date {
  const date = { mon: 19, tue: 20, fri: 23, sat: 24, sun: 25 }[day]
  const [hours, minutes] = time.split(':').map(Number)
  return new Date(2026, 9, date, hours, minutes)
}

describe('parseFreezeWindow', () => {
  it('normalizes opening_hours rules and accepts ~ or an en dash', () => {
    expect(parseFreezeWindow('9:05-12:00').window).toBe('09:05-12:00')
    expect(parseFreezeWindow(' 14:00 ~ 18:00 ').window).toBe('14:00-18:00')
    expect(parseFreezeWindow('22:00–02:00').rules).toEqual([{ spans: [{ start: 1320, end: 120 }] }])
    expect(parseFreezeWindow('00:00-24:00').window).toBe('24/7')
    expect(parseFreezeWindow('24/7').week.every(day => day.length === 1)).toBe(true)
    expect(parseFreezeWindow('mo-fr 09:00 - 12:00, 14:00-18:00').window).toBe('Mo-Fr 09:00-12:00,14:00-18:00')
    expect(parseFreezeWindow('Fr 18:00-24:00; Sa,Su;').window).toBe('Fr 18:00-24:00; Sa,Su 00:00-24:00')
    expect(parseFreezeWindow('Mo-Fr 09:00-18:00; We off').window).toBe('Mo-Fr 09:00-18:00; We off')
  })

  it('normalizes weekday lists, ranges and aliases', () => {
    expect(parseFreezeWindow('mon-fri 10:00-12:00').rules).toEqual([{ days: [1, 2, 3, 4, 5], spans: [{ start: 600, end: 720 }] }])
    expect(parseFreezeWindow('Weekends 00:00-24:00').window).toBe('Sa,Su 00:00-24:00')
    expect(parseFreezeWindow('工作日 09:00-18:00').window).toBe('Mo-Fr 09:00-18:00')
    expect(parseFreezeWindow('周六,周日').window).toBe('Sa,Su 00:00-24:00')
    expect(parseFreezeWindow('Fr-Mo 09:00-10:00').window).toBe('Mo,Fr-Su 09:00-10:00')
    expect(parseFreezeWindow('Mo,Tu,We 09:00-10:00').window).toBe('Mo-We 09:00-10:00')
    expect(parseFreezeWindow('weekdays,weekends 09:00-10:00').window).toBe('09:00-10:00')
    expect(parseDays('Su')).toEqual([0])
    expect(withDays(parseFreezeWindow('09:00-12:00,14:00-18:00; Sa 10:00-11:00'), [1, 2, 3, 4, 5]).window).toBe('Mo-Fr 09:00-12:00,14:00-18:00; Sa 10:00-11:00')
  })

  it('rejects malformed, out-of-range and empty windows', () => {
    for (const text of ['10-12', '10:00', '10:60-11:00', '24:00-01:00', '10:00-24:30', '25:00-26:00', '10:00-10:00', '', ';', 'Mo-Fr 09:00-12:00;; Sa', 'monday 10:00-11:00', 'Mo- 10:00-11:00', 'Mo-Tu-We 10:00-11:00', 'Mo-Fr 09:00-12:00 14:00-18:00'])
      expect(() => parseFreezeWindow(text), text).toThrow(TypeError)
    expect(() => parseFreezeWindow('PH off')).toThrow('节假日')
    expect(() => parseMoment('24:00')).toThrow(TypeError)
    expect(() => parseMoment('someday 10:00')).toThrow(TypeError)
  })

  it('resolves --at to today or the next matching weekday', () => {
    const now = at('tue', '08:00')
    expect(parseMoment('11:30', now)).toEqual(at('tue', '11:30'))
    expect(parseMoment('Fr 17:00', now)).toEqual(at('fri', '17:00'))
    expect(parseMoment('fri 17:00', now)).toEqual(at('fri', '17:00'))
    expect(parseMoment('mon 09:00', now).getDate()).toBe(26)
  })
})

describe('checkFreeze', () => {
  it('treats windows as [start, end) and reports when pushing opens again', () => {
    const windows = config('10:00-12:00', '14:00-18:00')
    expect(checkFreeze(windows, at('mon', '09:59')).status).toBe('allowed')
    expect(checkFreeze(windows, at('mon', '10:00'))).toEqual({
      status: 'frozen',
      weekday: 'mon',
      time: '10:00',
      window: '10:00-12:00',
      scope: 'local',
      until: { weekday: 'mon', time: '12:00', daysAhead: 0 },
    })
    expect(checkFreeze(windows, at('mon', '12:00')).status).toBe('allowed')
    expect(checkFreeze(windows, at('mon', '17:59')).until?.time).toBe('18:00')
  })

  it('wraps past midnight and merges adjacent windows', () => {
    expect(checkFreeze(config('22:00-02:00'), at('mon', '23:00')).until).toEqual({ weekday: 'tue', time: '02:00', daysAhead: 1 })
    expect(checkFreeze(config('22:00-02:00'), at('mon', '02:00')).status).toBe('allowed')
    expect(checkFreeze(config('10:00-12:00', '12:00-13:30'), at('mon', '11:00')).until?.time).toBe('13:30')
    expect(checkFreeze(config('00:00-24:00'), at('mon', '08:00')).until).toBeNull()
  })

  it('only applies on the configured weekdays, with overnight windows belonging to their start day', () => {
    const workdays = config('Mo-Fr 10:00-12:00')
    expect(checkFreeze(workdays, at('fri', '11:00')).status).toBe('frozen')
    expect(checkFreeze(workdays, at('sat', '11:00')).status).toBe('allowed')
    const friday = config('Fr 22:00-02:00')
    expect(checkFreeze(friday, at('sat', '01:00')).status).toBe('frozen')
    expect(checkFreeze(friday, at('sat', '23:00')).status).toBe('allowed')
    expect(checkFreeze(friday, at('mon', '01:00')).status).toBe('allowed')
    const weekend = config('Fr 18:00-24:00; Sa,Su')
    expect(checkFreeze(weekend, at('fri', '19:00')).until).toEqual({ weekday: 'mon', time: '00:00', daysAhead: 3 })
  })

  it('lets later rules replace earlier ones on the days they name', () => {
    const hours = config('Mo-Fr 09:00-18:00; We off; Fr 09:00-12:00')
    expect(checkFreeze(hours, at('tue', '15:00')).status).toBe('frozen')
    expect(checkFreeze(hours, at('fri', '15:00')).status).toBe('allowed')
    // Separate values add up instead.
    expect(checkFreeze(config('Mo-Fr 09:00-18:00', 'Fr off'), at('fri', '15:00')).status).toBe('frozen')
    // An overnight span still reaches into a day a later rule turned off.
    expect(checkFreeze(config('Fr 22:00-02:00; Sa off'), at('sat', '01:00')).status).toBe('frozen')
  })

  it('evaluates each scope in its own time zone', () => {
    const shanghai: FreezeConfig = { ...config('10:00-12:00'), timeZones: { local: 'Asia/Shanghai' } }
    // 03:30 UTC is 11:30 in Shanghai (no DST).
    const check = checkFreeze(shanghai, new Date(Date.UTC(2026, 9, 19, 3, 30)))
    expect(check).toMatchObject({ status: 'frozen', weekday: 'mon', time: '11:30', timeZone: 'Asia/Shanghai', until: { time: '12:00', daysAhead: 0 } })
    expect(checkFreeze(shanghai, new Date(Date.UTC(2026, 9, 19, 4, 0))).status).toBe('allowed')
    // 23:00 UTC Sunday is 07:00 Monday in Shanghai.
    const weekdays: FreezeConfig = { ...config('Mo-Fr'), timeZones: { local: 'Asia/Shanghai' } }
    expect(checkFreeze(weekdays, new Date(Date.UTC(2026, 9, 18, 23, 0))).weekday).toBe('mon')
  })

  it('explains the block with the scope message and opening day', () => {
    const windows = config('22:00-02:00')
    windows.messages.local = '夜间维护'
    const text = formatFreezeBlock(checkFreeze(windows, at('mon', '23:15')))
    expect(text).toContain('现在是周一 23:15，处于禁推时段 22:00-02:00')
    expect(text).toContain('明天 02:00 后可以推送')
    expect(text).toContain('夜间维护')
    expect(formatFreezeBlock(checkFreeze(config('Fr 18:00-24:00; Sa,Su'), at('sat', '10:00')))).toContain('周一 00:00 后可以推送')
    expect(formatFreezeBlock(checkFreeze(config('00:00-24:00'), at('mon', '00:00')))).toContain('接下来 7 天都不能推送')
  })
})

describe('freezeTimeline', () => {
  it('lists merged frozen stretches for the next seven local days', () => {
    const week = freezeTimeline(config('Mo-Fr 09:00-12:00,12:00-18:00', 'Fr 22:00-02:00'), at('fri', '08:00'))
    expect(week.map(day => day.weekday)).toEqual(['fri', 'sat', 'sun', 'mon', 'tue', 'wed', 'thu'])
    expect(week[0]).toEqual({ weekday: 'fri', date: '2026-10-23', spans: [{ start: '09:00', end: '18:00' }, { start: '22:00', end: '24:00' }] })
    expect(week[1]!.spans).toEqual([{ start: '00:00', end: '02:00' }])
    expect(week[2]!.spans).toEqual([])
    expect(freezeTimeline(config('24/7'), at('mon', '08:00'), 1)[0]!.spans).toEqual([{ start: '00:00', end: '24:00' }])
  })
})

describe('pauses', () => {
  it('lets a pause switch windows off until it ends, the repository first', () => {
    const now = at('mon', '10:00')
    const paused: FreezeConfig = { ...config('Mo-Fr 09:00-18:00'), pauses: { global: 'forever', local: at('mon', '11:00').toISOString() } }
    expect(checkFreeze(paused, now)).toMatchObject({ status: 'paused', window: 'Mo-Fr 09:00-18:00', pause: { scope: 'local', until: at('mon', '11:00').toISOString() } })
    expect(activePauses(paused, at('mon', '12:00'))).toEqual([{ scope: 'global', until: null }])
    const expired: FreezeConfig = { ...config('Mo-Fr 09:00-18:00'), pauses: { local: at('mon', '09:30').toISOString() } }
    expect(checkFreeze(expired, now).status).toBe('frozen')
    expect(checkFreeze({ ...config('Sa,Su'), pauses: { global: 'forever' } }, now)).toMatchObject({ status: 'allowed', pause: { scope: 'global', until: null } })
  })

  it('works out when a timed pause ends', () => {
    const now = at('tue', '15:20')
    expect(pauseEnd({ for: '1h30m' }, now)).toEqual(at('tue', '16:50'))
    expect(pauseEnd({ for: '2d' }, now).getDate()).toBe(22)
    expect(pauseEnd({ until: '18:00' }, now)).toEqual(at('tue', '18:00'))
    expect(pauseEnd({ until: '09:00' }, now)).toEqual(new Date(2026, 9, 21, 9, 0))
    expect(pauseEnd({ until: '24:00' }, now)).toEqual(new Date(2026, 9, 21, 0, 0))
    expect(pauseEnd({ until: 'Mo 09:00' }, now)).toEqual(new Date(2026, 9, 26, 9, 0))
    for (const text of ['', '0m', '1x', '31d', '1h 30m'])
      expect(() => pauseEnd({ for: text }, now), text).toThrow(TypeError)
    expect(formatPauseEnd(at('tue', '18:00').toISOString(), now)).toBe('至 今天 18:00')
    expect(formatPauseEnd(new Date(2026, 9, 21, 0, 0).toISOString(), now)).toBe('至 明天 00:00')
    expect(formatPauseEnd(null, now)).toBe('直到重新开启')
  })
})
