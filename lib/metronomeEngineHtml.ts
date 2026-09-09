// lib/metronomeEngineHtml.ts
//
// The metronome's clock and click, running inside a WebView.
//
// Why this exists at all. React Native has no audio clock. The metronome used
// to keep time with setTimeout and sound each beat by calling replayAsync() on
// a preloaded player - which means every single click travels the bridge, is
// queued by the OS, and starts whenever the player gets round to it. The gap
// between beats was right on average and wrong every time: tens of
// milliseconds of jitter, which at 120 BPM is audibly not a metronome. No
// amount of correcting the TIMER fixes that, because the timer was never the
// part that was late.
//
// Web Audio has the clock the platform does not. A click scheduled for
// ctx.currentTime + 0.1 sounds at that moment to the sample, decided in the
// audio thread and unaffected by anything JavaScript is doing. So the
// scheduling moves in here, next to the clock, and React Native only ever says
// "start", "stop", or "here is the new tempo" - none of which has to be on
// time. This is the same trick the pad and the tuner already use.
//
// The lookahead loop is the standard one: wake often, and schedule every beat
// that falls due before the next wake. A late wake costs nothing as long as it
// is less than SCHEDULE_AHEAD late, because those beats were already handed to
// the audio thread.
//
// Imported sounds are decoded once, here, and played with an AudioBufferSource
// started at the same exact time a synthesised click would have been - so a
// custom sample is exactly as steady as the built-in one.

export const METRONOME_ENGINE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;}</style>
</head>
<body>
<script>
(function () {
  // ── The click, as three tones ───────────────────────────────────────────────
  //
  // Deliberately the same numbers as lib/clickSynth.ts. They are repeated
  // rather than imported because this file is a string of browser JS that
  // never shares a module system with the app - so if the tones are ever
  // retuned, both places have to move together.
  //
  //   2 = STRONG  measure downbeat
  //   1 = MEDIUM  group downbeat
  //   0 = WEAK    inner subdivision
  var TONES = {
    2: { startHz: 480, endHz: 300, decaySec: 0.030, level: 1.0 },
    1: { startHz: 380, endHz: 250, decaySec: 0.026, level: 0.74 },
    0: { startHz: 300, endHz: 210, decaySec: 0.022, level: 0.52 }
  };

  // Decay time constants kept before the click is faded out. Five puts the
  // tail under one percent of peak, which is inaudible.
  var DECAY_TAIL = 5;
  var ATTACK_SEC = 0.003;

  // How loud an imported sample is per accent. A single imported sound used
  // for every beat would flatten the measure out, so the accents are kept by
  // level even when the sample itself is the same.
  var SAMPLE_LEVEL = { 2: 1.0, 1: 0.76, 0: 0.55 };

  // The lookahead scheduler. 25 ms between wakes against 120 ms of lookahead
  // leaves nearly five wakes of slack - so the click survives the device
  // deciding to do something else for a moment.
  var LOOKAHEAD_MS = 25;
  var SCHEDULE_AHEAD_SEC = 0.12;

  var ctx = null;
  var running = false;
  var timer = null;

  // The grid the clicks sit on. unitSec is the length of one grid unit, and
  // each pattern step says how many units it spans - a compound meter played
  // without subdivisions holds one click across a whole three-unit group.
  var unitSec = 0.5;
  var pattern = [{ accent: 2, units: 1 }];
  var pitchRatio = 1;
  var stepIndex = 0;
  var nextBeatTime = 0;
  var beatCount = 0;

  // Decoded imported sounds, by accent. Empty means "use the synth".
  var samples = { 2: null, 1: null, 0: null };

  function send(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }

  function ensureContext() {
    if (ctx && ctx.state !== 'closed') {
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /**
   * Which sound plays for this accent.
   *
   * An accent with no sample of its own falls back to the downbeat's, played
   * quieter. That is what lets someone import one click and have the whole
   * measure work, while still leaving room to import three.
   */
  function sampleFor(accent) {
    if (samples[accent]) return { buffer: samples[accent], gain: 1 };
    if (samples[2]) return { buffer: samples[2], gain: SAMPLE_LEVEL[accent] };
    return null;
  }

  /**
   * Put one click on the clock at an exact time.
   *
   * Everything here is scheduled, never played "now": start times, ramps and
   * stops are all absolute values on the audio clock. That is the whole point
   * of the exercise - nothing about when this function happens to run can
   * change when the click is heard.
   */
  function scheduleClick(time, accent) {
    if (!ctx) return;

    var chosen = sampleFor(accent);
    if (chosen) {
      var src = ctx.createBufferSource();
      src.buffer = chosen.buffer;
      // An imported sound is pitched by playback rate, which stretches it -
      // acceptable for a sample, and it is what the pitch control means for
      // one. The synth path below shifts frequency without stretching.
      src.playbackRate.value = pitchRatio;

      var sGain = ctx.createGain();
      sGain.gain.value = chosen.gain;
      src.connect(sGain);
      sGain.connect(ctx.destination);
      src.start(time);
      return;
    }

    var tone = TONES[accent] || TONES[0];
    var startHz = tone.startHz * pitchRatio;
    var endHz = tone.endHz * pitchRatio;
    var total = ATTACK_SEC + tone.decaySec * DECAY_TAIL + 0.008;

    var gain = ctx.createGain();
    gain.connect(ctx.destination);
    // A short ramp rather than an instant start; an instant one pops.
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(tone.level, time + ATTACK_SEC);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + tone.decaySec * DECAY_TAIL);
    // Land on true zero, so the stop below has nothing left to cut off.
    gain.gain.linearRampToValueAtTime(0, time + total);

    var harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.3;
    harmonicGain.connect(gain);

    var fundamental = ctx.createOscillator();
    var harmonic = ctx.createOscillator();
    fundamental.type = 'sine';
    harmonic.type = 'sine';

    // The pitch falls away from the attack, which is what reads as struck
    // wood rather than a beep.
    var glideEnd = time + tone.decaySec * 0.4;
    fundamental.frequency.setValueAtTime(startHz, time);
    fundamental.frequency.exponentialRampToValueAtTime(endHz, glideEnd);
    harmonic.frequency.setValueAtTime(startHz * 2, time);
    harmonic.frequency.exponentialRampToValueAtTime(endHz * 2, glideEnd);

    fundamental.connect(gain);
    harmonic.connect(harmonicGain);

    fundamental.start(time);
    harmonic.start(time);
    fundamental.stop(time + total);
    harmonic.stop(time + total);
  }

  /**
   * Tell React Native a beat has landed, at the moment it lands.
   *
   * The flash cannot be scheduled on the audio clock, so it is timed from it
   * instead: one timeout per beat, set when the beat is scheduled. Being a
   * frame late here is invisible, which is exactly why the visuals can afford
   * the approach the audio could not.
   */
  function announce(time, accent, index) {
    var delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    window.setTimeout(function () {
      if (running) send({ type: 'beat', accent: accent, index: index });
    }, delayMs);
  }

  function tick() {
    if (!running || !ctx) return;

    // If the clock has fallen a long way behind - the app was backgrounded,
    // or the device throttled the timer hard - resync rather than firing a
    // burst of catch-up clicks, and start a fresh measure so the downbeat
    // stays on the downbeat.
    if (nextBeatTime < ctx.currentTime - unitSec) {
      nextBeatTime = ctx.currentTime + SCHEDULE_AHEAD_SEC;
      stepIndex = 0;
    }

    while (nextBeatTime < ctx.currentTime + SCHEDULE_AHEAD_SEC) {
      var step = pattern[stepIndex % pattern.length] || { accent: 2, units: 1 };
      scheduleClick(nextBeatTime, step.accent);
      announce(nextBeatTime, step.accent, beatCount);

      nextBeatTime += unitSec * (step.units || 1);
      stepIndex = (stepIndex + 1) % pattern.length;
      beatCount += 1;
    }

    timer = window.setTimeout(tick, LOOKAHEAD_MS);
  }

  function applyGrid(msg) {
    if (typeof msg.unitSec === 'number' && msg.unitSec > 0) unitSec = msg.unitSec;
    if (msg.pattern && msg.pattern.length) {
      // A different number of steps means the meter itself changed, not just
      // the tempo - and half a bar of 4/4 followed by the back half of 6/8 is
      // not a measure of anything. So the measure starts again from its
      // downbeat. A tempo change alone keeps its place.
      if (msg.pattern.length !== pattern.length) stepIndex = 0;
      pattern = msg.pattern;
    }
    if (typeof msg.pitchRatio === 'number' && msg.pitchRatio > 0) pitchRatio = msg.pitchRatio;
  }

  function start(msg) {
    if (!ensureContext()) {
      send({ type: 'error', message: 'This device has no Web Audio, so the metronome cannot keep time here.' });
      return;
    }
    applyGrid(msg);

    if (running) return;
    running = true;
    stepIndex = 0;
    beatCount = 0;
    // A hair ahead of now, so the very first click is scheduled rather than
    // already in the past and therefore clipped.
    nextBeatTime = ctx.currentTime + 0.06;
    send({ type: 'started' });
    tick();
  }

  function stop() {
    running = false;
    if (timer) { window.clearTimeout(timer); timer = null; }
    send({ type: 'stopped' });
  }

  /**
   * A tempo or meter change while playing.
   *
   * The phase is deliberately left alone. Beats already handed to the audio
   * thread are going to sound whatever happens, and restarting the measure
   * would put a downbeat wherever the finger happened to lift - so the new
   * spacing simply takes effect from the next beat that has not been
   * scheduled yet.
   */
  function update(msg) {
    applyGrid(msg);
    if (running && pattern.length && stepIndex >= pattern.length) stepIndex = 0;
  }

  /** One click right now, for previewing pitch or an imported sound. */
  function preview(accent) {
    if (!ensureContext()) return;
    scheduleClick(ctx.currentTime + 0.02, accent);
  }

  function base64ToArrayBuffer(b64) {
    var binary = window.atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  /**
   * Decode an imported sound and keep it ready.
   *
   * Decoding happens once, on import, and never on a beat. A click that had
   * to be decoded when it was due would be exactly the kind of work on the
   * critical path that this whole engine exists to avoid.
   */
  function loadSample(accent, b64) {
    if (!ensureContext()) return;
    var buffer;
    try {
      buffer = base64ToArrayBuffer(b64);
    } catch (e) {
      send({ type: 'sample-error', accent: accent, message: 'That file could not be read.' });
      return;
    }

    // decodeAudioData is callback-style on older WebViews and promise-style on
    // newer ones; the callback form is accepted by both.
    try {
      ctx.decodeAudioData(buffer, function (decoded) {
        samples[accent] = decoded;
        send({ type: 'sample-loaded', accent: accent, seconds: decoded.duration });
      }, function () {
        send({ type: 'sample-error', accent: accent, message: 'That audio format could not be decoded on this device.' });
      });
    } catch (e) {
      send({ type: 'sample-error', accent: accent, message: 'That audio format could not be decoded on this device.' });
    }
  }

  function clearSamples(accent) {
    if (accent === null || accent === undefined) samples = { 2: null, 1: null, 0: null };
    else samples[accent] = null;
  }

  function handle(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'start') start(msg);
    else if (msg.type === 'stop') stop();
    else if (msg.type === 'update') update(msg);
    else if (msg.type === 'preview') preview(Number(msg.accent) || 0);
    else if (msg.type === 'sample') loadSample(Number(msg.accent), String(msg.data || ''));
    else if (msg.type === 'clear-samples') clearSamples(msg.accent === undefined ? null : Number(msg.accent));
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
