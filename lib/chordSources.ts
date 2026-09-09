// lib/chordSources.ts
//
// Searching several chord sites at once and turning any one of their pages
// into an editable song.
//
// The user types a song title, every site the app knows is asked at the same
// time, and what comes back is a list of choices - not one guess. Nothing is
// saved until they pick one, look at it, and change whatever the site got
// wrong.
//
// Two ways of asking a site for songs:
//
//   - A site with a search page we can read directly (Ultimate Guitar keeps
//     its search results in a JSON blob inside the HTML) gets its own search().
//   - Everything else is found through a plain web search restricted to that
//     one domain. Less exact, but it costs nothing to add a new site.
//
// Nothing here needs an API key, so nothing here can be counted on forever -
// sites change their markup. A site that fails is skipped and reported, never
// allowed to sink the whole search.

import {
  ImportedSong,
  bracketChordLines,
  decodeEntities,
  extractTextFromHtml,
  fetchPage,
  looksLikeSong,
  parseSongText,
  stripTags,
  tightenChordLines,
} from './songImport'
import { isChordToken } from './transpose'

/** One song found on one site - a choice offered to the user. */
export interface SongSearchResult {
  /** Stable enough for a list key */
  id: string
  sourceId: string
  sourceName: string
  title: string
  artist: string
  url: string
  /** Only some sites tell us the key up front */
  key?: string
  /** Out of 5, when the site publishes one */
  rating?: number
  votes?: number
  snippet?: string
}

export interface SearchContext {
  signal?: AbortSignal
  timeoutMs: number
  limit: number
}

export interface ChordSource {
  id: string
  name: string
  domain: string
  /** Where the site is served from, when it is not just https://domain */
  home?: string
  /** A word on what this site carries, shown in the picker */
  blurb: string
  /** Sites searched unless the user turns them off */
  defaultOn: boolean
  /** A site with a readable search page of its own */
  search?: (query: string, ctx: SearchContext) => Promise<SongSearchResult[]>
  /** A site whose chord sheet is not simply plain text in a <pre> */
  extract?: (html: string, url: string) => ImportedSong | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A section header written as [Verse 1] is a section, not a chord.
 * This app writes sections as a bare line, so unwrap the ones that are not
 * chords and leave the ones that are - [G] alone on a line stays a chord.
 */
export function tidySectionHeaders(content: string): string {
  return content
    .split('\n')
    .map(line => {
      const m = line.trim().match(/^\[([^\]]+)\]\s*(.*)$/)
      if (!m) return line

      const header = m[1].trim()
      const rest = m[2].trim()
      if (isChordToken(header)) return line // a chord, not a heading

      // "[Intro]" on its own
      if (!rest) return header

      // "[Intro] G  C  G  C" - the heading, then chords the app can transpose
      const tokens = rest.split(/\s+/)
      if (tokens.every(isChordToken)) {
        return `${header}\n${tokens.map(t => `[${t}]`).join(' ')}`
      }

      return line
    })
    .join('\n')
}

/**
 * Does this piece of a headline just name the site?
 *
 * Sites write their own name loosely - "Worship Chords", "WorshipChords",
 * "worshipchords.com" - so spaces and punctuation are ignored when comparing.
 */
function isSiteName(part: string, site?: { name: string; domain: string }): boolean {
  if (!site) return false
  const flat = part.toLowerCase().replace(/[^a-z]/g, '')
  if (!flat) return true
  const name = site.name.toLowerCase().replace(/[^a-z]/g, '')
  const domain = site.domain.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z]/g, '')
  return flat === name || flat === domain || flat === `${domain}com`
}

/** Strip the word "chords" and any trailing site name off a page title. */
function cleanTitleText(text: string): string {
  return text
    .replace(/\s*[@|·]\s*ultimate[- ]guitar(\.com)?.*$/i, '')
    .replace(/\s*[|\-–—]\s*(chords?|tabs?|lyrics)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * The searched-for words, as whole words only.
 *
 * Whole words matter: "song" turning up inside "Hillsong" is not a match, and
 * treating it as one fills the results with whatever the site had lying about.
 * Hyphens and slashes count as gaps, so a word is still found inside an
 * address like /amazing-grace-chords/.
 */
function wordsIn(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9']+/i).filter(w => w.length > 2)
}

function containsWord(haystack: string, word: string): boolean {
  return haystack.toLowerCase().split(/[^a-z0-9']+/i).includes(word)
}

/** How many of the searched-for words appear in a piece of text. */
function queryHits(text: string, query: string): number {
  const words = wordsIn(query)
  if (words.length === 0) return 0
  return words.reduce((n, w) => (containsWord(text, w) ? n + 1 : n), 0)
}

/** Trim the trailing "Chords"/"Tab"/"Lyrics" noise off a name. */
function tidySongWord(text: string): string {
  return text
    .replace(/\s*\b(chords?|tabs?|lyrics|guitar|ukulele|piano)\b\s*$/i, '')
    .replace(/\s*[:\-–—]\s*$/, '')
    .trim()
}

/**
 * Pull a song title and an artist out of a search result's headline.
 *
 * Chord sites write these every way round:
 *   "AMAZING GRACE CHORDS by Chris Tomlin"
 *   "Amazing Grace - Paul Oakley - WorshipChords"
 *   "Chris Tomlin - Amazing Grace Chords"
 * so the order cannot be assumed. What can be relied on is that the user
 * searched for the song, not the artist: of the two halves, the one carrying
 * the searched-for words is the title. With nothing to go on, the first half
 * is taken as the title, which is how most of these sites write them.
 *
 * Anything that fits none of this becomes the title on its own - no loss, as
 * the user sees both fields and can correct them.
 */
export function splitTitleArtist(
  headline: string,
  site?: { name: string; domain: string },
  query = '',
): { title: string; artist: string } {
  const text = cleanTitleText(headline)

  const by = text.match(/^(.*?)\s+(?:chords?|tabs?)?\s*\bby\b\s+(.+?)$/i)
  if (by) return { title: tidySongWord(by[1]), artist: tidySongWord(by[2]) }

  const parts = text
    .split(/\s+[-–—|]\s+/)
    .map(tidySongWord)
    .filter(part => part && !isSiteName(part, site))

  if (parts.length >= 2) {
    let best = 0
    for (let i = 1; i < parts.length; i += 1) {
      if (queryHits(parts[i], query) > queryHits(parts[best], query)) best = i
    }
    const rest = parts.filter((_, i) => i !== best)
    return { title: parts[best], artist: rest.join(' - ') }
  }

  return { title: parts[0] || tidySongWord(text), artist: '' }
}

/**
 * "Amazing Grace Globus", searched for as "amazing grace", is the song
 * followed by whoever recorded it. Some sites run the two together with no
 * punctuation at all, and the only thing separating them is knowing what was
 * asked for.
 */
function splitTrailingArtist(headline: string, query: string): { title: string; artist: string } {
  const asked = new Set(query.toLowerCase().split(/\s+/).filter(Boolean))
  const words = headline.split(/\s+/).filter(Boolean)

  let taken = 0
  while (taken < words.length && asked.has(words[taken].toLowerCase().replace(/[^a-z0-9']/gi, ''))) {
    taken += 1
  }

  if (taken === 0 || taken === words.length) return { title: headline, artist: '' }
  return { title: words.slice(0, taken).join(' '), artist: words.slice(taken).join(' ') }
}

/**
 * Is this link plausibly one song's page?
 *
 * A search restricted to a site still turns up its front page, its own search
 * results, category listings and PDF downloads. None of those hold a chord
 * sheet we can read, and offering them as choices only wastes the user's taps.
 */
function looksLikeSongPage(url: string, headline: string): boolean {
  const lower = url.toLowerCase()
  if (/\.(pdf|zip|docx?|jpe?g|png|gif|mp3|mp4)(\?|#|$)/.test(lower)) return false
  if (/\/(category|categories|tag|tags|author|page|feed)\//.test(lower)) return false
  if (/\b(search|results?)\b|result\.php|search\.php/.test(lower)) return false
  // The site's own front page
  if (/^https?:\/\/[^/]+\/?$/.test(lower)) return false
  if (/search results/i.test(headline)) return false
  return true
}

/** The share of the searched-for words a result actually contains, 0 to 1. */
function matchFraction(result: SongSearchResult, query: string): number {
  const words = wordsIn(query)
  if (words.length === 0) return 1
  const hay = `${result.title} ${result.artist}`
  return words.filter(w => containsWord(hay, w)).length / words.length
}

/** How well a result matches what the user asked for, for ordering. */
function relevance(result: SongSearchResult, query: string): number {
  const words = wordsIn(query)
  const hay = `${result.title} ${result.artist}`.toLowerCase()
  let score = matchFraction(result, query)
  if (words.length > 0 && hay.startsWith(words[0])) score += 0.25
  if (result.rating) score += Math.min(result.rating, 5) / 20
  return score
}

/**
 * How much of the search has to appear in a result for it to be worth showing.
 *
 * A short title has to match in full: someone searching "Way Maker" is not
 * after "Hey Mr. Dream Maker", and a half-match on a two-word title is nearly
 * always a different song. Longer titles are given some room, since sites
 * abbreviate them and drop the words in brackets.
 */
function requiredMatch(query: string): number {
  return wordsIn(query).length <= 3 ? 1 : 0.6
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic web search, used by every site without a search page of its own
// ─────────────────────────────────────────────────────────────────────────────

/** DuckDuckGo wraps outbound links; unwrap them back to the real address. */
function unwrapRedirect(href: string): string {
  const uddg = href.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      /* fall through to the raw href */
    }
  }
  if (href.startsWith('//')) return 'https:' + href
  return href
}

/** Result headlines from either DuckDuckGo front end, or from Bing's HTML. */
function parseSearchLinks(html: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = []
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = anchor.exec(html)) !== null) {
    // Only the headline links, not the site's own navigation
    if (!/result__a|result-link/.test(m[0])) continue
    const url = unwrapRedirect(decodeEntities(m[1]))
    const text = stripTags(m[2])
    if (/^https?:\/\//i.test(url) && text) out.push({ url, text })
  }

  return out
}

/** Bing's headlines sit inside <h2>, so they need their own pass. */
function parseBingLinks(html: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = []
  const re = /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = unwrapRedirect(decodeEntities(m[1]))
    const text = stripTags(m[2])
    if (/^https?:\/\//i.test(url) && text) out.push({ url, text })
  }
  return out
}

/** Bing will hand back RSS, which is far steadier to read than its HTML. */
function parseRssLinks(xml: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = []
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || []
  for (const item of items) {
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)
    const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)
    if (!link || !title) continue
    const url = decodeEntities(link[1].trim())
    const text = stripTags(title[1])
    if (/^https?:\/\//i.test(url) && text) out.push({ url, text })
  }
  return out
}

/**
 * Find pages on one site through a public web search.
 *
 * Several front ends are tried in turn: search engines rate-limit apps hard,
 * and one of them refusing is not a reason to tell the user the site has
 * nothing.
 */
async function webSearch(
  query: string,
  domain: string,
  ctx: SearchContext,
): Promise<{ url: string; text: string }[]> {
  const q = encodeURIComponent(`${query} chords site:${domain}`)
  const engines = [
    { url: `https://html.duckduckgo.com/html/?q=${q}`, parse: parseSearchLinks },
    { url: `https://lite.duckduckgo.com/lite/?q=${q}`, parse: parseSearchLinks },
    { url: `https://www.bing.com/search?q=${q}&format=rss`, parse: parseRssLinks },
    { url: `https://www.bing.com/search?q=${q}`, parse: parseBingLinks },
  ]

  for (const engine of engines) {
    if (ctx.signal?.aborted) return []
    try {
      const html = await fetchPage(engine.url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal })
      const links = engine.parse(html).filter(l => l.url.toLowerCase().includes(domain.toLowerCase()))
      if (links.length > 0) return links
    } catch {
      // Try the next front end
    }
  }

  return []
}

/** The default search for a site: a web search, tidied into results. */
async function searchViaWeb(source: ChordSource, query: string, ctx: SearchContext): Promise<SongSearchResult[]> {
  const links = await webSearch(query, source.domain, ctx)
  const seen = new Set<string>()
  const out: SongSearchResult[] = []

  for (const link of links) {
    if (seen.has(link.url)) continue
    seen.add(link.url)
    if (!looksLikeSongPage(link.url, link.text)) continue
    let { title, artist } = splitTitleArtist(link.text, source, query)
    // Some sites run the song and the artist together with nothing between
    if (!artist) ({ title, artist } = splitTrailingArtist(title, query))
    if (!title) continue
    out.push({
      id: `${source.id}:${link.url}`,
      sourceId: source.id,
      sourceName: source.name,
      title,
      artist,
      url: link.url,
    })
    if (out.length >= ctx.limit) break
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Ultimate Guitar - its own search, and its own chord sheet format
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ultimate Guitar draws its pages in the browser, but it ships the whole
 * page's data as JSON in a data-content attribute first. That JSON is what we
 * read, so the search results and the chord sheet both come back intact.
 */
function readUgStore(html: string): any | null {
  const m = html.match(/data-content="([^"]+)"/)
  if (!m) return null
  try {
    return JSON.parse(decodeEntities(m[1]))
  } catch {
    return null
  }
}

/** UG marks chords as [ch]G[/ch] inside a column-aligned [tab] block. */
function ugContentToChordLines(raw: string): string {
  const plain = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\[\/?tab\]/g, '')
    .replace(/\[\/?ch\]/g, '')
  return tightenChordLines(tidySectionHeaders(bracketChordLines(plain))).trim()
}

/**
 * Ultimate Guitar has no search here on purpose.
 *
 * Its search page used to ship the results in that same JSON blob; as of this
 * writing it no longer does - the page arrives empty and is filled in by the
 * browser, so there is nothing for the app to read. Rather than offer a site
 * that always comes back empty, it is left switched off and kept for what it
 * still does well: a link the user pastes is read properly, chords, key and
 * all. The web-search fallback will still turn up its pages when it can.
 */
const ultimateGuitar: ChordSource = {
  id: 'ultimate-guitar',
  name: 'Ultimate Guitar',
  domain: 'ultimate-guitar.com',
  blurb: 'Best used by pasting a link - it hides its search',
  defaultOn: false,

  extract(html, url) {
    const store = readUgStore(html)
    const tab = store?.store?.page?.data?.tab
    const raw = store?.store?.page?.data?.tab_view?.wiki_tab?.content
    if (typeof raw !== 'string' || !raw.trim()) return null

    return {
      title: String(tab?.song_name || ''),
      artist: String(tab?.artist_name || ''),
      key: String(tab?.tonality_name || ''),
      content: ugContentToChordLines(raw),
      source: url,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Sites read as plain text - their chord sheets are already in the HTML
// ─────────────────────────────────────────────────────────────────────────────

/** Turn a page's address into a readable name: amazing-grace-chords -> Amazing Grace */
function slugToTitle(url: string): string {
  const slug = url
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '')
    .split('/')
    .pop() || ''
  return slug
    .replace(/\.(html?|php)$/i, '')
    .replace(/[-_]+(chords?|tabs?|lyrics)$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim()
}

/** The address a site is served from, when it differs from its bare domain. */
function homeOf(source: ChordSource): string {
  return source.home || `https://${source.domain}`
}

/**
 * Search a WordPress site through its own search page.
 *
 * Several of these sites run on WordPress, so ?s= gets a proper result page
 * from the site itself - steadier than a search engine, which throttles apps
 * and ignores a site: filter whenever it feels like it.
 *
 * The results page has no markup worth relying on, so every link back into the
 * site is gathered instead, and the ones that have nothing to do with what was
 * asked for are dropped. The best label an anchor carries wins; where the link
 * is only wrapped round a picture, the address itself names the song.
 */
async function searchWordPress(source: ChordSource, query: string, ctx: SearchContext): Promise<SongSearchResult[]> {
  const url = `${homeOf(source)}/?s=${encodeURIComponent(query)}`
  const html = await fetchPage(url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal })

  const labels = new Map<string, string>()
  const order: string[] = []
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null

  while ((m = anchor.exec(html)) !== null) {
    const href = decodeEntities(m[1]).replace(/[#?].*$/, '')
    if (!href.toLowerCase().includes(source.domain)) continue
    if (!looksLikeSongPage(href, '')) continue

    const label = stripTags(m[2]).replace(/\s+/g, ' ').trim()
    if (!labels.has(href)) order.push(href)
    if ((labels.get(href) || '').length < label.length) labels.set(href, label)
  }

  const out: SongSearchResult[] = []
  for (const href of order) {
    const label = labels.get(href) || ''
    const fromSlug = slugToTitle(href)
    // A link to the site's own pages that has nothing to do with the search
    if (queryHits(`${label} ${fromSlug}`, query) === 0) continue

    const headline = label.length > 2 ? label : fromSlug
    const { title, artist } = splitTitleArtist(headline, source, query)
    if (!title) continue

    out.push({
      id: `${source.id}:${href}`,
      sourceId: source.id,
      sourceName: source.name,
      title,
      artist,
      url: href,
    })
    if (out.length >= ctx.limit) break
  }

  return out
}

const worshipChords: ChordSource = {
  id: 'worship-chords',
  name: 'Worship Chords',
  domain: 'worshipchords.com',
  home: 'https://worshipchords.com',
  blurb: 'Worship songs, chords over the words',
  defaultOn: true,
  search: (query, ctx) => searchWordPress(worshipChords, query, ctx),
}

/**
 * CifraClub publishes the search its own apps use, as plain JSON: one entry
 * per song with the artist and the song each in their own field, which is far
 * better than anything that can be scraped out of a results page. The song's
 * address is built from the two slugs it hands back.
 *
 * It is a Brazilian site with an enormous catalogue, worship songs included,
 * so a search will turn up Portuguese versions alongside the English ones -
 * they are labelled by artist, and the user picks.
 */
const cifraClub: ChordSource = {
  id: 'cifraclub',
  name: 'CifraClub',
  domain: 'cifraclub.com',
  home: 'https://www.cifraclub.com',
  blurb: 'Huge catalogue, artist and key on every song',
  defaultOn: true,

  async search(query, ctx) {
    const url = `https://solr.sscdn.co/cifraclub/br/mobile/?q=${encodeURIComponent(query)}`
    const raw = await fetchPage(url, { timeoutMs: ctx.timeoutMs, signal: ctx.signal })

    let docs: any[] = []
    try {
      docs = JSON.parse(raw)?.response?.docs || []
    } catch {
      return []
    }

    return docs
      .filter(d => d && d.url && d.dns && d.txt)
      .slice(0, ctx.limit)
      .map(d => ({
        id: `cifraclub:${d.dns}/${d.url}`,
        sourceId: 'cifraclub',
        sourceName: 'CifraClub',
        title: String(d.txt),
        artist: String(d.art || ''),
        url: `https://www.cifraclub.com/${d.dns}/${d.url}/`,
      }))
  },
}

/**
 * GuitarTabs.cc keeps its search in the browser, so there is nothing to read
 * on its results page - but its song pages are plain and read perfectly. It is
 * left off by default and found through the web-search fallback, which is the
 * honest position: worth having when it can be reached, not worth a tap that
 * usually comes back empty.
 */
const guitarTabs: ChordSource = {
  id: 'guitartabs',
  name: 'GuitarTabs.cc',
  domain: 'guitartabs.cc',
  home: 'https://www.guitartabs.cc',
  blurb: 'Plain sheets - found through a web search',
  defaultOn: false,
}

/**
 * Every site the app knows how to look in.
 *
 * Each one was checked by hand for two things: that it answers a plain HTTP
 * request at all (several big chord sites turn away anything that is not a
 * browser), and that its chord sheet is in the page rather than drawn later by
 * JavaScript. A site failing either test is worse than no site - it is a
 * choice the user keeps tapping that never works.
 */
export const CHORD_SOURCES: ChordSource[] = [
  worshipChords,
  cifraClub,
  guitarTabs,
  ultimateGuitar,
]

export const DEFAULT_SOURCE_IDS = CHORD_SOURCES.filter(s => s.defaultOn).map(s => s.id)

export function sourceById(id: string): ChordSource | undefined {
  return CHORD_SOURCES.find(s => s.id === id)
}

/** The site a link belongs to, when the app knows it. */
export function sourceForUrl(url: string): ChordSource | undefined {
  const lower = url.toLowerCase()
  return CHORD_SOURCES.find(s => lower.includes(s.domain))
}

// ─────────────────────────────────────────────────────────────────────────────
// Searching every chosen site at once
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Which sites to ask; defaults to the ones that are on out of the box */
  sourceIds?: string[]
  signal?: AbortSignal
  timeoutMs?: number
  /** Most results to take from any one site */
  perSource?: number
}

/** What one site did, in enough detail to explain an empty search. */
export interface SourceOutcome {
  sourceId: string
  sourceName: string
  /** Songs the site handed back, before any filtering of ours */
  found: number
  /** How many of those survived as close enough to the search */
  kept: number
  /** Empty when the site answered; otherwise why it did not */
  reason: string
}

export interface SearchOutcome {
  results: SongSearchResult[]
  /** Sites that could not be read, and why */
  failed: { sourceId: string; sourceName: string; reason: string }[]
  /** Sites that answered, whether or not they had the song */
  searched: string[]
  /** Site by site, for telling the user why a search came back empty */
  perSource: SourceOutcome[]
  /**
   * True when nothing matched closely and the near misses are being shown
   * instead - an empty screen helps nobody.
   */
  loosened: boolean
}

/**
 * Ask every chosen site for a song, all at the same time.
 *
 * Results are interleaved rather than stacked, so the first thing the user
 * sees is one choice from each site instead of ten from whichever site
 * happened to answer quickest.
 */
export async function searchChordSites(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const trimmed = query.trim()
  if (!trimmed) throw new Error('Type the name of a song to search for')

  const { sourceIds = DEFAULT_SOURCE_IDS, signal, timeoutMs = 12000, perSource = 6 } = options

  const sources = sourceIds.map(sourceById).filter((s): s is ChordSource => Boolean(s))
  if (sources.length === 0) throw new Error('Pick at least one site to search')

  const ctx: SearchContext = { signal, timeoutMs, limit: perSource }

  const settled = await Promise.all(
    sources.map(async source => {
      let found: SongSearchResult[] = []
      let error = ''

      if (source.search) {
        try {
          found = await source.search(trimmed, ctx)
        } catch (err: any) {
          error = err?.message || 'Did not answer'
        }
      }

      // A site's own search is the better answer, but when it is down or has
      // been rebuilt, a web search of that one domain still finds the song.
      if (found.length === 0 && !ctx.signal?.aborted) {
        try {
          found = await searchViaWeb(source, trimmed, ctx)
          if (found.length > 0) error = ''
        } catch (err: any) {
          if (!error) error = err?.message || 'Did not answer'
        }
      }

      return { source, found, error }
    }),
  )

  const failed = settled
    .filter(s => s.error)
    .map(s => ({ sourceId: s.source.id, sourceName: s.source.name, reason: s.error }))

  // Results that are not really the song asked for are dropped - a site with
  // no match will happily offer its nearest miss, and a wrong song presented
  // as a choice costs more than one fewer choice does.
  // Best first inside each site, then one from each site in turn.
  const needed = requiredMatch(trimmed)
  const byRelevance = (a: SongSearchResult, b: SongSearchResult) =>
    relevance(b, trimmed) - relevance(a, trimmed)

  const strict = settled.map(s =>
    s.found.filter(r => matchFraction(r, trimmed) >= needed).sort(byRelevance),
  )

  // Being strict is right when there is something to be strict about. When it
  // leaves nothing at all, showing the near misses beats an empty screen -
  // the user can see what the sites do have and judge for themselves.
  const anyKept = strict.some(list => list.length > 0)
  const anyFound = settled.some(s => s.found.length > 0)
  const loosened = !anyKept && anyFound
  const ranked = loosened ? settled.map(s => [...s.found].sort(byRelevance)) : strict

  const perSourceOutcome: SourceOutcome[] = settled.map((s, i) => ({
    sourceId: s.source.id,
    sourceName: s.source.name,
    found: s.found.length,
    kept: strict[i].length,
    reason: s.error,
  }))

  const results: SongSearchResult[] = []
  const seen = new Set<string>()
  const deepest = ranked.reduce((n, list) => Math.max(n, list.length), 0)
  for (let i = 0; i < deepest; i += 1) {
    for (const list of ranked) {
      const item = list[i]
      if (!item) continue
      const dedupeKey = item.url.replace(/[#?].*$/, '').toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      results.push(item)
    }
  }

  // Worth a line in the log: when a search comes back thin, the answer is
  // nearly always which site said what, and that is invisible otherwise.
  console.log(
    '[chordSources] "' + trimmed + '" ->',
    perSourceOutcome
      .map(s => `${s.sourceName}: ${s.reason || `${s.found} found / ${s.kept} kept`}`)
      .join(' | '),
  )

  return {
    results,
    failed,
    searched: settled.filter(s => !s.error).map(s => s.source.id),
    perSource: perSourceOutcome,
    loosened,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Turning one chosen result into an editable song
// ─────────────────────────────────────────────────────────────────────────────

const NO_SHEET =
  'That page did not give up a chord sheet. Some sites build theirs in the browser — ' +
  'open it in a browser, copy the chords, and use Paste instead.'

/** Read one page as a song, using whatever the site it came from needs. */
export async function importSongFromUrl(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ImportedSong> {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Enter a full web address starting with http:// or https://')
  }

  const { signal, timeoutMs = 15000 } = options
  const html = await fetchPage(trimmed, { timeoutMs, signal })
  const source = sourceForUrl(trimmed)

  const specific = source?.extract ? source.extract(html, trimmed) : null
  let song: ImportedSong

  if (specific && looksLikeSong(specific.content)) {
    song = specific
  } else {
    // Fall back to reading the page as plain text, keeping anything the
    // site-specific pass did manage to work out about the song
    const generic = parseSongText(html, trimmed)
    song = {
      title: specific?.title || generic.title,
      artist: specific?.artist || generic.artist,
      key: specific?.key || generic.key,
      content: looksLikeSong(generic.content) ? generic.content : specific?.content || '',
      source: trimmed,
    }
  }

  song.content = tightenChordLines(tidySectionHeaders(song.content)).trim()
  if (!looksLikeSong(song.content)) throw new Error(NO_SHEET)

  if (!song.title) {
    const heading = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (heading) {
      const parts = splitTitleArtist(extractTextFromHtml(heading[1]), source)
      song.title = parts.title
      if (!song.artist) song.artist = parts.artist
    }
  }

  return song
}

/**
 * Fetch the song behind a chosen search result.
 *
 * What the search listing already told us wins over what the page says: the
 * listing is usually the tidier of the two, and the user can edit either way.
 */
export async function fetchResultSong(
  result: SongSearchResult,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ImportedSong> {
  const song = await importSongFromUrl(result.url, options)
  return {
    ...song,
    title: result.title || song.title,
    artist: result.artist || song.artist,
    key: result.key || song.key,
    source: result.url,
  }
}
