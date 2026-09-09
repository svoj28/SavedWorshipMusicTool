// lib/devotionRotation.ts
//
// Who leads the devotion, Saturday by Saturday.
//
// The rotation is not stored as a rule - it is stored as the Saturdays
// themselves, one ordinary calendar event each. That is deliberate. A rule
// ("Ana, then Ben, then Cara, forever") is tidy right up until somebody
// swaps, and from then on every date has to be worked out from a growing pile
// of exceptions. Writing the dates down means a swap is two rows changing
// places, the calendar shows them like any other event, and the whole thing
// syncs and works offline with no new table and nothing new on the server.
//
// The cost is that the rotation reaches only as far ahead as it has been
// filled in, so the admin extends it now and again. That is a fair trade for
// a schedule that cannot quietly disagree with itself.

/** Title given to the events this creates, so they read well in the calendar. */
export const DEVOTION_TITLE = 'Devotion'

/** The role written into the assignment - the real marker of a devotion. */
export const DEVOTION_ROLE = 'Devotion Leader'

/** Saturday, as JavaScript numbers the days of the week. */
const SATURDAY = 6

/** A date as the calendar stores it: YYYY-MM-DD in the phone's own timezone. */
export function toDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Read a date key back.
 *
 * Built field by field rather than parsed from the string: "2026-09-12" handed
 * to the Date constructor is read as UTC, which for half the world is the day
 * before. A rota that slips a day is worse than no rota at all.
 */
export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}

/** The first Saturday on or after a date. */
export function nextSaturdayOnOrAfter(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const shift = (SATURDAY - result.getDay() + 7) % 7
  result.setDate(result.getDate() + shift)
  return result
}

export function isSaturday(key: string): boolean {
  return parseDateKey(key).getDay() === SATURDAY
}

/** The next `weeks` Saturdays, starting from the one on or after `startKey`. */
export function saturdaysFrom(startKey: string, weeks: number): string[] {
  const first = nextSaturdayOnOrAfter(parseDateKey(startKey))
  const out: string[] = []

  for (let i = 0; i < Math.max(0, weeks); i += 1) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate())
    d.setDate(d.getDate() + i * 7)
    out.push(toDateKey(d))
  }

  return out
}

/**
 * Deal the leaders out across the dates, in order, wrapping round.
 *
 * Position in the list decides who leads, so the same range of dates always
 * produces the same rota - fill the next six months in twice and nothing
 * moves.
 */
export function assignRotation(
  leaders: string[],
  dates: string[],
): { date: string; person: string }[] {
  const named = leaders.map(l => l.trim()).filter(Boolean)
  if (named.length === 0) return []

  return dates.map((date, index) => ({ date, person: named[index % named.length] }))
}

/** Does this calendar event hold a devotion assignment? */
export function isDevotionEvent(event: {
  title?: string
  assignments?: { role?: string }[]
}): boolean {
  const assignments = event.assignments || []
  // The role settles it, not the title - somebody may well write their own
  // event called "Devotion", and it is not part of the rota.
  return assignments.some(a => (a.role || '').trim().toLowerCase() === DEVOTION_ROLE.toLowerCase())
}

/** Who is leading, according to this event. */
export function devotionLeaderOf(event: {
  assignments?: { role?: string; person?: string }[]
}): string {
  const match = (event.assignments || []).find(
    a => (a.role || '').trim().toLowerCase() === DEVOTION_ROLE.toLowerCase(),
  )
  return ((match && match.person) || '').trim()
}

export interface Assignment {
  role: string
  person: string
  note?: string
}

/**
 * The Saturdays in a plan that nobody is leading yet.
 *
 * Dates already carrying a devotion are left alone, which is what makes
 * "fill in the Saturdays" safe to press twice and safe to press next term:
 * extending the rota can never quietly undo a swap that was agreed weeks ago.
 */
export function planNewDevotions(
  leaders: string[],
  dates: string[],
  takenDates: string[],
): { date: string; person: string }[] {
  const taken: Record<string, boolean> = {}
  for (const d of takenDates) taken[d] = true
  return assignRotation(leaders, dates).filter(entry => !taken[entry.date])
}

/**
 * Trade the devotion leaders between two days.
 *
 * Only the devotion assignment moves. Anything else written on either day - a
 * note, somebody else's role - belongs to the date rather than to the person,
 * and stays exactly where it is.
 */
export function swapDevotionLeaders(
  first: Assignment[],
  second: Assignment[],
): { first: Assignment[]; second: Assignment[] } {
  const isDevotion = (a: Assignment) =>
    (a.role || '').trim().toLowerCase() === DEVOTION_ROLE.toLowerCase()

  const firstPerson = (first.find(isDevotion) || { person: '' }).person
  const secondPerson = (second.find(isDevotion) || { person: '' }).person

  return {
    first: first.map(a => (isDevotion(a) ? { ...a, person: secondPerson } : a)),
    second: second.map(a => (isDevotion(a) ? { ...a, person: firstPerson } : a)),
  }
}

/** A date written the way a person reads it: "Sat 12 Sep 2026". */
export function describeDate(key: string): string {
  const d = parseDateKey(key)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`
}
