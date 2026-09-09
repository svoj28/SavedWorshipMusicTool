// lib/audioFormat.ts
//
// Working out what a picked file actually is, rather than trusting its name.
//
// Both importers - the pad library and the metronome's click slots - used to
// take the extension off the file name and copy the file under it. That works
// right up until somebody's audio arrives named something the phone has never
// heard of: an .ss2, say. Two things then go wrong, and they go wrong at
// different ends.
//
//   * The picker never offers the file. Filtered to 'audio/*', a file the
//     system cannot map to an audio type is simply not selectable, so the
//     import cannot even begin.
//   * If it did get through, the copy keeps the unknown extension, and the
//     native players - which infer the format from the name as much as from
//     the bytes - refuse to open it.
//
// The bytes, though, are perfectly ordinary audio. Every container announces
// itself in its first few bytes, so that is what is read here: the file is
// identified from its own header and copied under the extension matching what
// it really is. An .ss2 holding a WAV is stored as a .wav, and plays.

import * as FileSystem from 'expo-file-system/legacy'
import { IS_WEB } from './platform'

/**
 * What the file pickers ask for.
 *
 * 'audio/*' alone is what hid these files in the first place. The wildcard is
 * deliberate and is the only way to be sure nothing is unselectable - a phone
 * that cannot name the type of an .ss2 will not offer it under any narrower
 * filter. The cost is that other files can be picked too, which is why
 * everything imported is checked against its header rather than taken on
 * trust.
 */
export const AUDIO_PICKER_TYPES = ['audio/*', 'application/octet-stream', '*/*']

/** Extensions the platform decoders are known to open. */
const KNOWN_EXTENSIONS = [
  '.mp3', '.wav', '.wave', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus',
  '.flac', '.aif', '.aiff', '.aifc', '.caf', '.amr', '.3gp', '.wma',
]

/** How many bytes of the header are enough to name every format below. */
const HEADER_BYTES = 16

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Turn the base64 the file system hands back into bytes.
 *
 * Written out rather than reached for, because atob is not something every
 * React Native runtime has, and a sixteen-byte header does not justify a
 * dependency.
 */
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))

  let out = 0
  let buffer = 0
  let bits = 0

  for (let i = 0; i < clean.length; i += 1) {
    const value = BASE64_ALPHABET.indexOf(clean[i])
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[out] = (buffer >> bits) & 0xff
      out += 1
    }
  }

  return bytes.subarray(0, out)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let i = offset; i < offset + length && i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i])
  }
  return text
}

/**
 * Name the format from a header, or null if it is not audio we recognise.
 *
 * Exported so it can be checked against bytes directly, without a file.
 */
export function extensionForHeader(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null

  // Container formats, each of which says its own name near the front.
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return '.wav'
  if (ascii(bytes, 0, 4) === 'OggS') return '.ogg'
  if (ascii(bytes, 0, 4) === 'fLaC') return '.flac'
  if (ascii(bytes, 0, 4) === 'caff') return '.caf'
  if (ascii(bytes, 0, 5) === '#!AMR') return '.amr'
  if (ascii(bytes, 0, 4) === 'FORM') {
    const kind = ascii(bytes, 8, 4)
    if (kind === 'AIFF' || kind === 'AIFC') return '.aiff'
  }
  // MPEG-4 and its relatives put the brand at offset 4, not 0.
  if (ascii(bytes, 4, 4) === 'ftyp') return '.m4a'
  // ASF, which is what a .wma is.
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75) return '.wma'

  // A tagged MP3 announces itself; a bare one has only its first frame.
  if (ascii(bytes, 0, 3) === 'ID3') return '.mp3'
  if (bytes[0] === 0xff) {
    // Both MP3 and raw AAC begin with a run of set bits, so they have to be
    // told apart by what follows. AAC in an ADTS stream leaves the layer bits
    // clear, which in an MPEG audio frame would be a reserved layer - so that
    // pattern is never a valid MP3, and is the thing to test on.
    if ((bytes[1] & 0xf6) === 0xf0) return '.aac'
    if ((bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0x00) return '.mp3'
  }

  return null
}

/**
 * The first few bytes of a picked file.
 *
 * The two platforms hand back different kinds of URI and are read differently,
 * but the point is the same on both: identify the file from its own header
 * rather than its name. Doing this on web matters as much as on the phone -
 * without it a WAV named .ss2 would fall through to the name check and be
 * turned away, so the same file would import on the app and not in a browser.
 */
async function readHeader(uri: string): Promise<Uint8Array> {
  if (IS_WEB) {
    // A picked file on web is a blob: or data: URL that fetch can read
    // directly. Only the header is wanted, but a Blob is already in memory,
    // so slicing after the fact costs nothing.
    const response = await fetch(uri)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer.slice(0, HEADER_BYTES))
  }

  const head = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length: HEADER_BYTES,
  })
  return base64ToBytes(head)
}

/** The extension on a file name, lowercased, or an empty string. */
export function extensionOf(name: string | null | undefined): string {
  const match = (name || '').match(/\.[A-Za-z0-9]{1,5}$/)
  return match ? match[0].toLowerCase() : ''
}

/**
 * The extension a picked file should be stored under.
 *
 * The header is believed over the file name, since the name is exactly what
 * cannot be trusted here. A file whose header means nothing to us is still
 * accepted if its name carries an extension the decoders know - some formats
 * begin with nothing distinctive, and refusing a plainly-named .wma to be
 * tidy would help nobody.
 *
 * Returns null when the file is not audio we can play, which is the case the
 * callers turn into a message rather than importing something silent.
 */
export async function resolveAudioExtension(
  uri: string,
  name?: string | null,
): Promise<string | null> {
  try {
    const sniffed = extensionForHeader(await readHeader(uri))
    if (sniffed) return sniffed
  } catch {
    // Unreadable header - fall back to the name, which may still be right.
  }

  const named = extensionOf(name)
  return KNOWN_EXTENSIONS.indexOf(named) === -1 ? null : named
}
