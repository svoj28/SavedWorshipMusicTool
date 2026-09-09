// lib/dayLabels.ts
//
// Naming the day a message was sent.
//
// A chat only needs a date when the day changes - repeating it on every
// message is noise, and a bare time is confusing the moment a conversation
// spans more than one day. So the date is written once, between the last
// message of one day and the first of the next.
//
// Days are compared by their calendar parts, never by subtracting
// milliseconds. Clocks go forward and back, which makes some days 23 hours
// long and others 25; dividing by "a day" gets those wrong, and gets them
// wrong exactly twice a year - the hardest kind of bug to ever be told about.

/** Midnight at the start of the local day containing this moment. */
function dayStart(timestamp: number): Date {
  const d = new Date(timestamp)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Whole calendar days from `from` to `to`; negative when `to` is earlier.
 *
 * The local year, month and day are re-read as if they were UTC before
 * subtracting, which takes daylight saving out of the arithmetic entirely.
 */
export function daysApart(from: number, to: number): number {
  const a = dayStart(from)
  const b = dayStart(to)
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((ub - ua) / 86400000)
}

/** Were these two moments on the same calendar day, locally? */
export function isSameDay(a: number, b: number): boolean {
  return daysApart(a, b) === 0
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * How a person would say which day this was.
 *
 * Recent days get the words actually used for them - "Today", "Yesterday",
 * then the weekday for the rest of the week back. Older messages get a date,
 * and the year appears only when it is not this one, because "12 Sep" reads
 * better than "12 Sep 2026" for something from last month.
 */
export function dayLabel(timestamp: number, now: number = Date.now()): string {
  const diff = daysApart(timestamp, now)
  const d = new Date(timestamp)

  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'

  // Inside the last week, the weekday alone is the clearest thing to say
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()]

  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return sameYear ? base : `${base} ${d.getFullYear()}`
}

/** The time of day, as the phone's own locale writes it. */
export function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
