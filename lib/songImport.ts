// lib/songImport.ts
//
// Bringing a song in from the web and turning it into the format this app
// edits: section headers on their own line, chords inline as [G]like this.
//
// Chord sheets online are almost always written with the chords on a line of
// their own, sitting above the words:
//
//     G          D        Em      C
//     Amazing grace, how sweet the sound
//
// That has to become "[G]Amazing [D]grace, how [Em]sweet the [C]sound", with
// each chord landing on the word it was sitting over.
//
// The site-by-site knowledge - which sites to search, how each one lays its
// chord sheet out - lives in lib/chordSources.ts. This file stays the plain
// text side of the job so the two can be read on their own.

import { isChordToken } from './transpose'

export interface ImportedSong {
  title: string
  artist: string
  key: string
  content: string
  /** Where it came from, kept for the user's reference */
  source: string
}

/**
 * Is this a line of chords rather than a line of words?
 * Every token has to be a real chord - one stray word and it is lyrics.
 */
export function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every(isChordToken)
}

/** Column positions of each chord in a chord line. */
function chordPositions(line: string): { at: number; chord: string }[] {
  const out: { at: number; chord: string }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push({ at: m.index, chord: m[0] })
  return out
}

/**
 * Nudge a chord that landed just inside a word back to the front of it.
 *
 * Sites are a column or two out all the time - proportional fonts, a stray
 * space, a chord typed over the second letter - which reads as "how
 * sw[C]eet" when it was meant to be "how [C]sweet". Only a near miss is
 * moved: a chord sitting well inside a word ("hallelu[G]jah") was put there
 * on purpose and is left alone.
 */
function snapToWordStart(line: string, at: number): number {
  if (at <= 0 || at >= line.length) return at
  if (/\s/.test(line[at])) return at // already in the gap between words

  let start = at
  while (start > 0 && !/\s/.test(line[start - 1])) start -= 1
  return at - start <= 2 ? start : at
}

/**
 * Lay chords out along a line at the columns they belong to.
 *
 * Brackets take two characters the bare chord did not, so a chord can no
 * longer always start exactly where it did. Each one is put where it belongs
 * unless the chord before it is still in the way, in which case it goes one
 * space after - the order and the spread are kept, and nothing is ever lost by
 * being written over.
 */
function placeChords(marks: { at: number; chord: string }[]): string {
  let line = ''
  for (const mark of marks) {
    const col = line.length === 0 ? Math.max(mark.at, 0) : Math.max(mark.at, line.length + 1)
    line = line.padEnd(col) + `[${mark.chord}]`
  }
  return line
}

/**
 * Put the chords in brackets while leaving them on their own line above the
 * words, which is how this app's songs are written:
 *
 *     Verse 1
 *                   [G]
 *     I love you, Lord
 *
 * The chord keeps the column it was written at, so it still sits over the word
 * it is played on - only now the app can read it, transpose it, and show it in
 * another key.
 */
export function bracketChordLines(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    if (!isChordLine(line)) {
      out.push(line.trimEnd())
      continue
    }

    // The words this chord line sits over, when there are any. They stay
    // where they are - they are only read here, to line the chords up on.
    const next = lines[i + 1]
    const lyric = next !== undefined && next.trim() !== '' && !isChordLine(next) ? next : ''

    const marks = chordPositions(line).map(c => ({
      chord: c.chord,
      at: lyric ? snapToWordStart(lyric, c.at) : c.at,
    }))

    out.push(placeChords(marks))
  }

  return out.join('\n')
}

/**
 * Lift inline chords up onto a line of their own.
 *
 * A sheet written as "[G]Amazing [D]grace" becomes the two-line form the rest
 * of the app uses, with each chord standing over the syllable it was attached
 * to. A line that is nothing but chords is left as the one line it already is.
 */
export function inlineToChordLines(text: string): string {
  const out: string[] = []

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!/\[[^\]]+\]/.test(raw)) {
      out.push(raw.trimEnd())
      continue
    }

    const marks: { at: number; chord: string }[] = []
    let lyric = ''

    const piece = /\[([^\]]*)\]|([^[]+)/g
    let m: RegExpExecArray | null
    while ((m = piece.exec(raw)) !== null) {
      if (m[1] !== undefined) marks.push({ at: lyric.length, chord: m[1] })
      else lyric += m[2]
    }

    if (!lyric.trim()) {
      // Chords and nothing else - an intro, a turnaround, or a heading
      out.push(raw.trimEnd())
      continue
    }

    out.push(placeChords(marks).trimEnd())
    out.push(lyric.trimEnd())
  }

  return out.join('\n')
}

/** A line that is nothing but bracketed chords, e.g. "[G]   [C]  [D]". */
function isBracketChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  return tokens.every(t => /^\[[^\]]+\]$/.test(t) && isChordToken(t.slice(1, -1)))
}

/**
 * Close up the gap between a chord line and the words underneath it.
 *
 * Sites space their sheets out with a blank line between every pair, which
 * leaves the chords floating away from the words they belong to once they are
 * bracketed. A single blank line directly before a chord line is dropped, so a
 * verse reads as one block - but a blank before a heading is kept, because
 * that is what keeps one section from running into the next.
 */
export function tightenChordLines(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '') {
      out.push(line)
      continue
    }

    const before = out[out.length - 1]
    const after = lines[i + 1]
    const insideAVerse =
      before !== undefined &&
      before.trim() !== '' && // not a paragraph break already
      !isBracketChordLine(before) && // the words, or a heading
      after !== undefined &&
      isBracketChordLine(after)

    if (!insideAVerse) out.push(line)
  }

  return out.join('\n')
}

/** Turn HTML entities back into the characters they stand for. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last, so "&amp;lt;" does not come out as "<"
    .replace(/&amp;/gi, '&')
}

/** Strip every tag out of a fragment of HTML and decode what is left. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim()
}

/** Pull readable text out of a web page. */
export function extractTextFromHtml(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  // Chord sheets are nearly always inside <pre> - that is what preserves the
  // column alignment the chords depend on. Prefer it over the whole page.
  const pre = [...stripped.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map(m => m[1])
  const body = pre.length > 0 ? pre.join('\n\n') : stripped

  return decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read a ChordPro directive such as {title: Amazing Grace}. */
function directive(text: string, names: string[]): string {
  for (const name of names) {
    const m = text.match(new RegExp(`\\{\\s*(?:${name})\\s*:\\s*([^}]+)\\}`, 'i'))
    if (m) return m[1].trim()
  }
  return ''
}

/** Strip ChordPro directives once their contents have been read. */
function removeDirectives(text: string): string {
  return text.replace(/^\s*\{[^}]*\}\s*$/gim, '').replace(/\n{3,}/g, '\n\n')
}

/**
 * Turn a page or a pasted chord sheet into something this app can edit.
 * Text that already uses [G] inline chords is left as it is.
 */
export function parseSongText(raw: string, source = ''): ImportedSong {
  const looksLikeHtml = /<\/?(html|body|div|pre|p|br)\b/i.test(raw)
  const text = looksLikeHtml ? extractTextFromHtml(raw) : raw.replace(/\r\n?/g, '\n')

  const title = directive(text, ['title', 't'])
  const artist = directive(text, ['artist', 'subtitle', 'st', 'composer'])
  const key = directive(text, ['key'])

  const body = removeDirectives(text)
  // Either way round, the song comes out in one shape: chords in brackets, on
  // their own line, above the words they are played on.
  const content = tightenChordLines(
    hasInlineChords(body) ? inlineToChordLines(body) : bracketChordLines(body),
  ).trim()

  let htmlTitle = ''
  if (looksLikeHtml && !title) {
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (m) htmlTitle = extractTextFromHtml(m[1]).split(/[|\-–—]/)[0].trim()
  }

  return {
    title: title || htmlTitle,
    artist,
    key,
    content,
    source,
  }
}

/**
 * Is this sheet already written with its chords inline, as [G]like this?
 *
 * The brackets alone do not settle it: a section header like [Bridge] or
 * [First Part] starts with a note letter, and taking those for chords means a
 * perfectly ordinary chords-above-the-words sheet is left unconverted. So the
 * brackets have to actually hold chords, and more than one of them - a lone
 * match is far more likely to be a heading than a chord sheet.
 */
export function hasInlineChords(text: string): boolean {
  const inside = [...text.matchAll(/\[([^\]\n]{1,12})\]/g)].map(m => m[1].trim())
  return inside.filter(token => isChordToken(token)).length >= 2
}

/** Enough on the page to be a song, rather than a "not found" notice. */
export function looksLikeSong(content: string): boolean {
  return !!content && content.replace(/\s/g, '').length >= 40
}

export interface FetchPageOptions {
  timeoutMs?: number
  /** Lets a caller cancel - the user closing the search, say */
  signal?: AbortSignal
  headers?: Record<string, string>
}

/**
 * Fetch a page as text, with a timeout and plain-language failures.
 *
 * Every site the app reads goes through here, so one place decides how long to
 * wait and what to say when a site turns us away.
 */
export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<string> {
  const { timeoutMs = 15000, signal, headers } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const relayAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', relayAbort)
  }

  try {
    const response = await fetch(url, {
      headers: {
        // Some sites serve a stripped page to unknown clients
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`The site returned ${response.status}. It may block apps from reading it.`)
    }
    return await response.text()
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error(signal?.aborted ? 'Cancelled' : 'The site took too long to respond')
    }
    if (err instanceof Error && /^The site returned/.test(err.message)) throw err
    throw new Error('Could not reach that page. Check the address and your connection.')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', relayAbort)
  }
}

// Fetching a song from a URL lives in lib/chordSources.ts as
// importSongFromUrl(), which knows how each site lays its chord sheet out and
// falls back to parseSongText() above for a site it has never seen.
