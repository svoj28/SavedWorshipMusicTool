// lib/padEngineHtml.ts
//
// The pad: a synth chord that holds under the song and never stops.
//
// Why a WebView, for the same reason as lib/pitchEngineHtml.ts and
// lib/tunerEngineHtml.ts: React Native has no oscillators. Web Audio does,
// and it comes with the platform. Everything below is plain browser JS.
//
// The sound is not a recording on a loop. Loops betray themselves - the ear
// finds the seam within a minute and cannot then unhear it. These are real
// oscillators held open indefinitely, so there is no seam to find, and slow
// movement is built in so it never sits perfectly still either.
//
// Changing key is the part worth being careful about. Stopping one chord and
// starting another leaves a hole in the middle of a service. So two complete
// voice banks exist, and a key change builds the new chord silently, fades
// the two past each other, and only then takes the old one down. The sound
// never stops; it becomes the other chord.

import { DEFAULT_PAD_PRESET, PAD_PRESETS } from './padPresets'

export const PAD_ENGINE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:transparent">
<script>
(function () {
  var ctx = null;
  var master = null;       // final volume
  var masterFade = null;
  var bus = null;          // everything the chords play into
  var current = null;      // the chord sounding now
  var retiring = [];       // chords still fading out behind it
  var running = false;
  var volume = 0.6;
  var presets = ${JSON.stringify(PAD_PRESETS)};
  var presetId = ${JSON.stringify(DEFAULT_PAD_PRESET)};
  var waves = {};

  // Each sound has its own gentle attack and transition. Release stays slow
  // so stopping the pad never cuts across the music.
  var FADE_OUT = 3.0;

  // Six voices played at once add up, and during a key change there are two
  // full chords sounding at the same time. This holds the whole bank low
  // enough that even mid-crossfade the sum stays well inside full scale,
  // which is what keeps the sound clean rather than clipped.
  var BANK_TRIM = 0.38;

  // What the volume slider at its very top actually means. Left at 1.0, two
  // chords overlapping mid-crossfade would reach past full scale and lean on
  // the limiter, which is audible as the sound tightening. Holding the
  // ceiling here means the limiter never has to act at all.
  var MAX_GAIN = 0.72;

  function masterTarget() {
    return volume * MAX_GAIN;
  }

  function send(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }

  // ── Keeping the sound up ───────────────────────────────────────────────────
  //
  // An AudioContext does not only stop when we tell it to. A notification
  // arriving, another app taking the audio session, the screen locking, the
  // WebView being backgrounded - any of these suspends it, and nothing here
  // ever brought it back. The pad went quiet and then returned the next time
  // the user touched a control, which is the stutter this is here to stop.
  //
  // So: while the pad is meant to be sounding, the context is watched and put
  // back the moment it is found down. Resuming a context that is already
  // running does nothing, so being over-eager about it costs nothing.

  var watchdog = 0;
  var lastClock = 0;
  var lastClockAt = 0;

  function resumeContext() {
    if (!ctx) return;
    try {
      var pending = ctx.resume();
      if (pending && pending.catch) pending.catch(function () {});
    } catch (e) {}
  }

  function noteClock() {
    lastClock = ctx ? ctx.currentTime : 0;
    lastClockAt = Date.now();
  }

  function startWatchdog() {
    if (watchdog) return;
    noteClock();
    watchdog = setInterval(function () {
      if (!running || !ctx) return;

      if (ctx.state !== 'running') {
        resumeContext();
        noteClock();
        return;
      }

      // A context can report 'running' while its clock has in fact stopped -
      // what an interruption looks like on some WebViews, and the case a
      // plain state check misses entirely. If the audio clock has not moved
      // while real time has, the graph is wedged and only a resume restarts
      // it.
      var clock = ctx.currentTime;
      if (clock > lastClock + 0.001) {
        noteClock();
      } else if (Date.now() - lastClockAt > 1500) {
        resumeContext();
        noteClock();
      }
    }, 1000);
  }

  function stopWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = 0;
    }
  }

  // The page being shown again is the earliest notice we get that the app is
  // back in front of the user - sooner than the watchdog's next tick, and
  // sooner than anything React Native can send us.
  function wake() {
    if (running) resumeContext();
  }
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('focus', wake);

  function freqOf(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function findPreset(id) {
    for (var p = 0; p < presets.length; p += 1) {
      if (presets[p].id === id) return presets[p];
    }
    return null;
  }

  function selectPreset(id) {
    if (findPreset(id)) presetId = id;
  }

  function customWave(preset) {
    if (!waves[preset.id]) {
      var harmonics = preset.synth.harmonics;
      var real = new Float32Array(harmonics.length + 1);
      var imag = new Float32Array(harmonics.length + 1);
      for (var h = 0; h < harmonics.length; h += 1) imag[h + 1] = harmonics[h];
      // Native periodic waves keep synthesis on the audio thread and limit
      // harmonics near Nyquist. Cache each shape instead of adding voices.
      waves[preset.id] = ctx.createPeriodicWave(real, imag);
    }
    return waves[preset.id];
  }

  function makeFade(param, now) {
    param.setValueAtTime(0, now);
    return { param: param, from: 0, to: 0, start: now, end: now };
  }

  // Cancelling a ramp before reading AudioParam.value can restore its old
  // value, making a step in the waveform. Hold the level before retargeting.
  // Keep the linear envelope too, for WebViews without cancelAndHoldAtTime.
  function fadeTo(fade, target, duration, now) {
    var progress = fade.end <= now ? 1 : Math.max(0, (now - fade.start) / (fade.end - fade.start));
    var value = fade.from + (fade.to - fade.from) * progress;
    var param = fade.param;
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now);
    } else {
      param.cancelScheduledValues(now);
      if (fade.start < now && now < fade.end) {
        // Preserve the part of the interrupted ramp leading up to now.
        param.linearRampToValueAtTime(value, now);
      }
    }
    // A finished ramp may have its last event far in the past. Anchor the
    // new ramp here so it cannot interpolate from that old event's time.
    param.setValueAtTime(value, now);
    param.linearRampToValueAtTime(target, now + duration);
    fade.from = value;
    fade.to = target;
    fade.start = now;
    fade.end = now + duration;
  }

  /**
   * How the chord is spread out.
   *
   * Low root, then the fifth, then the third placed high and quiet. Keeping
   * the third above the fifth and softer is what stops a pad turning muddy
   * down low, and it is why the same voicing works for major and minor alike
   * - only one note moves between them.
   */
  function voicing(minor, sound) {
    var intervals = [0, 7, 12, minor ? 15 : 16, 19, 24];
    return intervals.map(function (semitone, index) {
      return {
        semitone: semitone,
        gain: sound.gains[index],
        wave: index < 3 ? sound.lowWave : sound.highWave
      };
    });
  }

  /**
   * Build a complete chord, silent, ready to be faded up.
   *
   * Every note is two oscillators pulled a few cents apart. That slight
   * disagreement is the whole trick: two exactly tuned oscillators sound like
   * one thin electronic tone, while two slightly apart beat against each
   * other and sound wide and alive.
   */
  function buildBank(rootPitchClass, minor) {
    var preset = findPreset(presetId);
    var sound = preset.synth;
    var now = ctx.currentTime;
    var bankGain = ctx.createGain();
    var fade = makeFade(bankGain.gain, now);
    var nodes = [bankGain];

    // A gentle lowpass takes the edge off the harmonics and leaves something
    // that sits under a song without fighting the singers for room.
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(sound.cutoff, now);
    // Keep resonance low so the cutoff does not become an extra audible note.
    filter.Q.setValueAtTime(0.707, now);
    filter.connect(bankGain);
    bankGain.connect(bus);
    nodes.push(filter);

    // A very slow sweep on that filter, so the pad breathes rather than
    // sitting perfectly still - a completely static chord starts to sound
    // synthetic after a minute or two.
    var lfo = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(sound.movementRate, now);
    // Kept small. The pad should seem to breathe, not to sweep - an obvious
    // filter movement sounds like a synthesiser being played with.
    lfoGain.gain.setValueAtTime(sound.movement, now);
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start(now);
    nodes.push(lfo, lfoGain);

    var base = sound.register + rootPitchClass;
    var notes = voicing(minor, sound);
    var oscillators = [lfo];

    for (var i = 0; i < notes.length; i += 1) {
      var note = notes[i];
      var hz = freqOf(base + note.semitone);

      var voiceGain = ctx.createGain();
      // Divided between the two oscillators that feed it, so a voice is worth
      // what it says it is. Without this each note is played at double
      // strength, the six of them sum to well over full scale, and what comes
      // out of the speaker is a clipped chord - which sounds like static.
      voiceGain.gain.setValueAtTime((note.gain * BANK_TRIM * sound.level) / 2, now);
      voiceGain.connect(filter);
      nodes.push(voiceGain);

      // The two halves of each note are pulled slightly apart in tuning and
      // pushed to opposite sides. Detuning alone makes a note sound wide;
      // detuning and separating makes it sound like two players rather than
      // one oscillator, which is most of why this sounds like an ensemble.
      var detunes = [-sound.detune, sound.detune];
      for (var d = 0; d < detunes.length; d += 1) {
        var osc = ctx.createOscillator();
        if (note.wave === 'custom') osc.setPeriodicWave(customWave(preset));
        else osc.type = note.wave;
        osc.frequency.setValueAtTime(hz, now);
        osc.detune.setValueAtTime(detunes[d], now);

        var destination = voiceGain;
        if (ctx.createStereoPanner) {
          var panner = ctx.createStereoPanner();
          // Wider at the top of the chord, near-centred at the bottom, so the
          // low notes stay solid and only the upper voices spread
          panner.pan.setValueAtTime((d === 0 ? -1 : 1) * Math.min(0.9, (0.15 + i * 0.09) * sound.width), now);
          panner.connect(voiceGain);
          destination = panner;
          nodes.push(panner);
        }

        osc.connect(destination);
        osc.start(now);
        oscillators.push(osc);
        nodes.push(osc);
      }
    }

    var bank = {
      gain: bankGain, fade: fade, oscillators: oscillators,
      root: rootPitchClass, minor: !!minor, preset: presetId, stopAt: Infinity, disposed: false
    };
    // All sources stop together, after the bank reaches silence. Disconnect
    // every node so repeated key changes do not leave an ever-growing graph.
    lfo.onended = function () {
      bank.disposed = true;
      for (var n = 0; n < nodes.length; n += 1) nodes[n].disconnect();
      var index = retiring.indexOf(bank);
      if (index !== -1) retiring.splice(index, 1);
      lfo.onended = null;
    };
    return bank;
  }

  function retireBank(bank, duration, now) {
    if (!bank || bank.disposed || bank.stopAt <= now) return;
    // A later stop/change must never postpone an earlier scheduled stop.
    var end = Math.min(now + duration, bank.stopAt - 0.02);
    if (end <= now) return;
    fadeTo(bank.fade, 0, end - now, now);
    bank.stopAt = end + 0.02;
    for (var i = 0; i < bank.oscillators.length; i += 1) {
      try { bank.oscillators[i].stop(bank.stopAt); } catch (e) {}
    }
    if (retiring.indexOf(bank) === -1) retiring.push(bank);
  }

  function finishRetiring(now) {
    for (var r = 0; r < retiring.length; r += 1) {
      retireBank(retiring[r], 0.12, now);
    }
  }

  /**
   * A reverb tail, made rather than recorded.
   *
   * Noise that fades away is, acoustically, what a room does to a sound: a
   * dense scatter of reflections dying off. Shaping decaying noise gives a
   * perfectly usable hall without shipping an impulse recording, and the two
   * channels are generated separately so the tail spreads across the stereo
   * field instead of sitting in the middle of your head.
   */
  function makeHallImpulse(seconds, decay) {
    var rate = ctx.sampleRate;
    var length = Math.max(1, Math.floor(rate * seconds));
    var impulse = ctx.createBuffer(2, length, rate);

    for (var channel = 0; channel < 2; channel += 1) {
      var data = impulse.getChannelData(channel);

      // The noise has to be damped, and damped harder as the tail goes on.
      // Undamped noise is the mistake that makes a generated reverb hiss: a
      // real room swallows high frequencies far faster than low ones, and a
      // held chord run through bright noise sounds like static rather than
      // like a hall. This one-pole filter closes as the tail decays.
      var lp = 0;

      for (var i = 0; i < length; i += 1) {
        var t = i / length;
        var openness = 0.28 + (0.03 - 0.28) * t; // brighter early, dark later
        lp += openness * ((Math.random() * 2 - 1) - lp);

        // A short swell before the decay stands in for the early reflections
        // arriving fractionally after the note itself
        var build = Math.min(1, t * 90);
        data[i] = lp * build * Math.pow(1 - t, decay);
      }
    }

    return impulse;
  }

  function ensureContext() {
    if (ctx) return;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    // Sustained pads can tolerate buffering. Give the audio thread more
    // headroom than the default interactive mode to avoid dropped blocks.
    ctx = new Ctor({ latencyHint: 'playback' });

    // Suspension is reported here as well as caught by the watchdog, so an
    // interruption is undone in the same tick it happens rather than up to a
    // second later.
    ctx.onstatechange = function () {
      send({ type: 'context', state: ctx.state });
      if (running && ctx.state !== 'running') resumeContext();
    };

    var now = ctx.currentTime;

    master = ctx.createGain();
    masterFade = makeFade(master.gain, now);

    // A limiter on the way out, as a last line of defence. The levels below
    // are set to stay well clear of it, but a phone's own output stage
    // clipping can sound like static. This adds protection against peaks.
    if (ctx.createDynamicsCompressor) {
      var limiter = ctx.createDynamicsCompressor();
      limiter.threshold.setValueAtTime(-3, now);
      limiter.knee.setValueAtTime(6, now);
      limiter.ratio.setValueAtTime(12, now);
      limiter.attack.setValueAtTime(0.006, now);
      limiter.release.setValueAtTime(0.25, now);
      master.connect(limiter);
      limiter.connect(ctx.destination);
    } else {
      master.connect(ctx.destination);
    }

    // Everything plays into one bus, and the reverb sits on that bus rather
    // than inside each chord. That is deliberate: when the key changes, the
    // old chord's tail keeps ringing into the new one, so the two are joined
    // by the room itself instead of merely overlapping.
    bus = ctx.createGain();

    // Nothing musical lives below this, and a pad full of sub-bass rumble
    // turns to mud on a phone speaker or a small PA.
    var rumbleCut = ctx.createBiquadFilter();
    rumbleCut.type = 'highpass';
    rumbleCut.frequency.setValueAtTime(52, now);
    bus.connect(rumbleCut);

    var dry = ctx.createGain();
    dry.gain.setValueAtTime(0.75, now);
    rumbleCut.connect(dry);
    dry.connect(master);

    // Enough tail to sound like a room, no more. A convolution this long is
    // real work for a phone every single audio block, and a WebView that
    // cannot keep up drops blocks - which is heard as crackle, and is the
    // other thing that gets mistaken for static.
    var wet = ctx.createGain();
    wet.gain.setValueAtTime(0.30, now);

    if (ctx.createConvolver) {
      var hall = ctx.createConvolver();
      hall.buffer = makeHallImpulse(2.6, 2.4);
      rumbleCut.connect(hall);
      hall.connect(wet);
      wet.connect(master);
    }
  }

  function start(rootPitchClass, minor, vol, requestedPreset) {
    selectPreset(requestedPreset);
    ensureContext();
    if (ctx.state === 'suspended') ctx.resume();

    var previousVolume = volume;
    volume = typeof vol === 'number' && isFinite(vol) ? Math.max(0, Math.min(1, vol)) : volume;

    if (running) {
      if (volume !== previousVolume) fadeTo(masterFade, masterTarget(), 0.12, ctx.currentTime);
      setKey(rootPitchClass, minor);
      return;
    }

    current = buildBank(rootPitchClass, minor);

    var now = ctx.currentTime;
    var attack = findPreset(presetId).synth.attack;
    var restarting = retiring.some(function (bank) {
      return !bank.disposed && bank.fade.end > now;
    });
    finishRetiring(now);
    fadeTo(current.fade, 1, restarting ? 0.12 : attack, now);
    fadeTo(masterFade, masterTarget(), attack, now);

    running = true;
    startWatchdog();
    send({ type: 'started', root: rootPitchClass, minor: !!minor, preset: presetId });
  }

  /**
   * Move to another key without the sound ever stopping.
   *
   * The new chord is built silent, the two are faded past each other, and the
   * old one is only taken down once it is already inaudible.
   */
  function setKey(rootPitchClass, minor, requestedPreset) {
    selectPreset(requestedPreset);
    if (!running) {
      start(rootPitchClass, minor, volume);
      return;
    }
    if (current && current.root === rootPitchClass && current.minor === !!minor && current.preset === presetId) return;

    var outgoing = current;
    var incoming = buildBank(rootPitchClass, minor);
    var now = ctx.currentTime;

    // Rapid key taps need a short crossfade on BOTH sides. Fading the loudest
    // old chord in 120ms but bringing its replacement in over 3.6s leaves a
    // hole in the sound. Ordinary key changes keep the slow transition.
    var interrupted = retiring.some(function (bank) {
      return !bank.disposed && bank.fade.end > now;
    });
    var duration = interrupted ? 0.12 : findPreset(presetId).synth.transition;
    finishRetiring(now);

    fadeTo(incoming.fade, 1, duration, now);
    current = incoming;

    retireBank(outgoing, duration, now);

    send({ type: 'key', root: rootPitchClass, minor: !!minor, preset: presetId });
  }

  function setPreset(id) {
    if (!findPreset(id) || id === presetId) return;
    presetId = id;
    // Selecting a sound before playing must remain silent. During playback
    // use the same crossfade as a key change, keeping the chord and volume.
    if (running && current) setKey(current.root, current.minor);
    send({ type: 'preset', preset: presetId });
  }

  function setVolume(v) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    volume = Math.max(0, Math.min(1, v));
    if (!ctx || !master) return;
    var now = ctx.currentTime;
    // A short glide rather than a jump - a step in gain is heard as a click
    if (running) fadeTo(masterFade, masterTarget(), 0.12, now);
  }

  function stop() {
    stopWatchdog();
    if (!running || !ctx) {
      send({ type: 'stopped' });
      return;
    }

    var now = ctx.currentTime;
    fadeTo(masterFade, 0, FADE_OUT, now);

    // Fade banks as well as the master: restarting can raise the master
    // before old sources stop, so those sources must already be fading out.
    for (var i = 0; i < retiring.length; i += 1) retireBank(retiring[i], FADE_OUT, now);
    retireBank(current, FADE_OUT, now);
    current = null;
    running = false;

    send({ type: 'stopped' });
  }

  function handle(msg) {
    if (!msg || !msg.type) return;
    try {
      if (msg.type === 'start') start(msg.root | 0, !!msg.minor, msg.volume, msg.preset);
      else if (msg.type === 'setKey') setKey(msg.root | 0, !!msg.minor, msg.preset);
      else if (msg.type === 'setPreset') setPreset(msg.preset);
      else if (msg.type === 'setVolume') setVolume(msg.volume);
      else if (msg.type === 'stop') stop();
      // Sent when the app comes back to the foreground. The page may have
      // been frozen, in which case none of the listeners above ever fired.
      else if (msg.type === 'resume') { if (running) { resumeContext(); startWatchdog(); } }
    } catch (err) {
      send({ type: 'error', message: String((err && err.message) || err) });
    }
  }

  function onMessage(event) {
    try { handle(JSON.parse(event.data)); } catch (e) {}
  }

  // Android delivers to document, iOS to window - listen on both
  document.addEventListener('message', onMessage);
  window.addEventListener('message', onMessage);

  send({ type: 'ready' });
})();
</script>
</body>
</html>`
