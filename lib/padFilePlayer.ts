// lib/padFilePlayer.ts
//
// Playing an imported pad on a loop, and crossing from one key to the next.
//
// The synth pad in lib/padEngineHtml.ts holds its chord with oscillators, so
// it never has to loop. A file does, and its crossfade has to be done by hand
// here rather than in Web Audio - two sounds playing at once, one climbing
// while the other falls.
//
// The two are kept deliberately alike: the same slow crossover, the same
// promise that the sound never drops out in the middle. Whichever source the
// user picks, changing key should feel the same.

import { Audio } from './audioCompat'

/** Matches the synth's crossfade, so both sources behave the same way. */
const CROSSFADE_MS = 3200
const STEP_MS = 50

/** How often the file is checked to still actually be playing. */
const KEEPALIVE_MS = 1000

let currentSound: Audio.Sound | null = null
let currentUri = ''
let fadeTimer: ReturnType<typeof setInterval> | null = null
let keepAliveTimer: ReturnType<typeof setInterval> | null = null
let masterVolume = 0.6

function clearFade() {
  if (fadeTimer) {
    clearInterval(fadeTimer)
    fadeTimer = null
  }
}

/**
 * Keep the file sounding.
 *
 * An interruption - a notification, another app taking the audio session, a
 * moment of lost audio focus - pauses the player, and nothing ever started it
 * again. The pad went quiet and came back only when the user next touched
 * something, which is the dropout this is here to stop. The synth engine
 * watches its AudioContext the same way, for the same reason.
 */
function startKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(async () => {
    const sound = currentSound
    if (!sound) return
    try {
      const status = await sound.getStatusAsync()
      if (status.isLoaded && !status.isPlaying) await sound.playAsync()
    } catch {
      /* the sound went away underneath us; stopFile clears the timer */
    }
  }, KEEPALIVE_MS)
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

async function quietlyUnload(sound: Audio.Sound | null) {
  if (!sound) return
  try {
    await sound.stopAsync()
  } catch {
    /* already stopped */
  }
  try {
    await sound.unloadAsync()
  } catch {
    /* already gone */
  }
}

/** Load a file, looping, silent, ready to be faded up. */
async function loadLooping(uri: string): Promise<Audio.Sound> {
  const { sound } = await Audio.Sound.createAsync(
    { uri },
    { isLooping: true, volume: 0, shouldPlay: true },
  )
  return sound
}

export function currentFileUri(): string {
  return currentUri
}

/** Start a pad file from silence. */
export async function playFile(uri: string, volume: number): Promise<void> {
  masterVolume = volume
  clearFade()
  // Stopped before the unload, so the keep-alive cannot try to restart the
  // very sound being taken away.
  stopKeepAlive()
  await quietlyUnload(currentSound)

  try {
    // Worth asking for, so a phone on silent still plays the pad - somebody
    // will always have flicked the switch without thinking about it - and so
    // the pad keeps holding once the screen locks rather than being cut off.
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    })
  } catch {
    /* not fatal - it only means the ringer switch still applies */
  }

  const sound = await loadLooping(uri)
  currentSound = sound
  currentUri = uri
  startKeepAlive()

  let step = 0
  const steps = Math.ceil(CROSSFADE_MS / STEP_MS)
  fadeTimer = setInterval(async () => {
    step += 1
    const progress = Math.min(1, step / steps)
    try {
      await sound.setVolumeAsync(masterVolume * progress)
    } catch {
      /* the sound went away underneath us */
    }
    if (progress >= 1) clearFade()
  }, STEP_MS)
}

/**
 * Move to another file without a gap.
 *
 * Both play together for the length of the crossfade, one rising and one
 * falling, and the old one is only unloaded once it is silent.
 */
export async function crossfadeToFile(uri: string, volume: number): Promise<void> {
  masterVolume = volume

  if (!currentSound) {
    await playFile(uri, volume)
    return
  }
  if (uri === currentUri) return

  clearFade()

  const outgoing = currentSound
  const incoming = await loadLooping(uri)
  currentSound = incoming
  currentUri = uri
  startKeepAlive()

  let step = 0
  const steps = Math.ceil(CROSSFADE_MS / STEP_MS)

  fadeTimer = setInterval(async () => {
    step += 1
    const progress = Math.min(1, step / steps)

    try {
      await incoming.setVolumeAsync(masterVolume * progress)
    } catch {
      /* gone */
    }
    try {
      await outgoing.setVolumeAsync(masterVolume * (1 - progress))
    } catch {
      /* gone */
    }

    if (progress >= 1) {
      clearFade()
      await quietlyUnload(outgoing)
    }
  }, STEP_MS)
}

export async function setFileVolume(volume: number): Promise<void> {
  masterVolume = Math.max(0, Math.min(1, volume))
  // A fade in progress owns the volume until it finishes; overriding it from
  // here would make the crossfade jump.
  if (fadeTimer || !currentSound) return
  try {
    await currentSound.setVolumeAsync(masterVolume)
  } catch {
    /* gone */
  }
}

/** Fade out and let the file go. */
export async function stopFile(): Promise<void> {
  clearFade()
  stopKeepAlive()

  const going = currentSound
  currentSound = null
  currentUri = ''
  if (!going) return

  let step = 0
  const steps = Math.ceil(CROSSFADE_MS / STEP_MS)

  await new Promise<void>(resolve => {
    const timer = setInterval(async () => {
      step += 1
      const progress = Math.min(1, step / steps)
      try {
        await going.setVolumeAsync(masterVolume * (1 - progress))
      } catch {
        /* gone */
      }
      if (progress >= 1) {
        clearInterval(timer)
        resolve()
      }
    }, STEP_MS)
  })

  await quietlyUnload(going)
}
