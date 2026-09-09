// lib/tunerEngineHtml.ts
//
// The tuner that runs inside the WebView on the Tuner screen.
//
// Why a WebView, same as lib/pitchEngineHtml.ts: React Native has no way to
// read the microphone sample by sample. getUserMedia and Web Audio do, and
// they come with the platform - no native module, no rebuild. Everything
// below is plain browser JS and never runs in the React Native JS context.
//
// What it does:
//   * Reads the frequency actually being played, by autocorrelation of the
//     raw waveform (McLeod's normalised square difference). That is what
//     makes it accurate enough to tune by, rather than a guess taken from
//     whichever FFT bin happens to be loudest.
//   * Draws the scrolling chromatic spectrogram: every octave folded onto
//     one, so a note lights its own row whichever octave it is played in.
//
// The picture is drawn here rather than in React Native on purpose - a canvas
// scrolling one pixel a frame is cheap inside the WebView, while pushing a
// column of pixels across the bridge sixty times a second is not.
//
// The microphone is opened only on an explicit 'start' and every track is
// stopped on 'stop', so nothing is left listening once the screen is closed.

export const TUNER_ENGINE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin:0; padding:0; background:#000; overflow:hidden; height:100%; }
  /* The real colours arrive from React Native in a 'theme' message; these are
     only what shows for the frame or two before it lands. */
  canvas { display:block; }
</style>
</head>
<body>
<canvas id="view"></canvas>
<script>
(function () {
  var NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // C0 - the note every frequency is measured against when working out which
  // pitch class it belongs to.
  var C0 = 16.351597831287414;

  // The window the tuner listens over: a bass guitar's low B up past the top
  // of a soprano line. Anything outside it is noise as far as we care.
  //
  // That low B is 30.87 Hz, so the floor has to sit under it - at the 40 Hz
  // it used to be, the lowest string on a five-string bass was outside the
  // range the comment claimed to cover, and simply could not be tuned here.
  var MIN_HZ = 28;
  var MAX_HZ = 2000;

  var ctx = null;
  var stream = null;
  var analyser = null;
  var srcNode = null;
  var timeBuf = null;      // waveform, for working out the frequency
  var freqBuf = null;      // spectrum, for the picture
  var nsdf = null;         // kept between frames so a frame allocates nothing
  var running = false;
  var raf = 0;
  var frame = 0;
  var lastPost = 0;
  var recent = [];         // the last few readings, for a steady display
  var referenceCtx = null;
  var referenceOscillators = [];

  // The colours the picture is drawn in, sent over from React Native so the
  // note names and grid follow the app's theme instead of being white on
  // black whatever the rest of the app looks like.
  var theme = {
    bg: '#000000',
    text: 'rgba(255,255,255,0.92)',
    line: 'rgba(255,255,255,0.22)',
    // How bright a lit note is allowed to get. On a light theme the column
    // colours have to stay pale enough for the labels drawn over them to
    // still read; on a dark one they can sing.
    lightness: 0.62,
    dark: true
  };

  // Where in the octave the note being played sits, 0 (C) up to 12, and how
  // many frames it is since that was last confirmed. Drawing this into every
  // column is what leaves the bright line tracking across the picture - the
  // frequency itself, not just the energy around it.
  var traceP = -1;
  var traceAge = 0;

  // The pitch is worked out a few times a second but the picture is painted
  // every frame, so the line is allowed to carry on for a short while between
  // readings. Long enough to stay unbroken, short enough to stop when the
  // note does.
  var TRACE_HOLD_FRAMES = 30;

  var canvas, c2d, spec, s2d, colImg;
  var W = 0, H = 0, DPR = 1, gutter = 0, plotW = 0;

  // How finely the octave is divided for the picture. Twelve would give
  // twelve flat bands; this keeps the gradient smooth between the notes.
  var CHROMA_BINS = 240;
  var chroma = new Float32Array(CHROMA_BINS);

  function send(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }

  // ── The picture ────────────────────────────────────────────────────────────

  function setupCanvas() {
    canvas = document.getElementById('view');
    DPR = window.devicePixelRatio || 1;
    W = Math.max(1, Math.floor(window.innerWidth));
    H = Math.max(1, Math.floor(window.innerHeight));

    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    c2d = canvas.getContext('2d');
    c2d.setTransform(DPR, 0, 0, DPR, 0, 0);

    // Room down the left for the note names, as a share of the width so it
    // holds up on a small phone and on a tablet alike.
    gutter = Math.max(44, Math.min(104, Math.round(W * 0.17)));
    plotW = Math.max(1, W - gutter);

    // The spectrogram lives on a canvas of its own so it can be scrolled a
    // pixel at a time without smearing the note lines drawn over the top.
    spec = document.createElement('canvas');
    spec.width = Math.floor(plotW * DPR);
    spec.height = Math.floor(H * DPR);
    s2d = spec.getContext('2d');
    s2d.fillStyle = theme.bg;
    s2d.fillRect(0, 0, spec.width, spec.height);

    colImg = s2d.createImageData(1, spec.height);

    drawFrame();
  }

  /**
   * Paint this moment as a single column down the right-hand edge.
   *
   * The octave is laid out as most of a turn of hue, starting green at C, so
   * every note keeps its own recognisable colour from one run to the next.
   */
  function paintColumn() {
    var rows = spec.height;
    var data = colImg.data;

    for (var y = 0; y < rows; y += 1) {
      // The bottom of the screen is C, the top is the B above it
      var pos = yToPos(y, rows);
      var v = chromaAt(pos);

      // A little contrast, so quiet noise stays dark and a played note sings
      var level = v <= 0 ? 0 : Math.pow(v, 1.7);
      var hue = (90 + (pos / 12) * 330) % 360;
      // On a light theme an unlit cell has to start near white and darken as
      // the note comes in, or the whole panel reads as a black hole in the
      // middle of a pale screen.
      var lit = Math.min(theme.lightness, level * 0.72);
      var rgb = theme.dark
        ? hslToRgb(hue / 360, 0.95, lit)
        : hslToRgb(hue / 360, 0.85, 1 - lit * 0.85);

      var o = y * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }

    // The reading itself, laid over the top: a bright mark at exactly the
    // frequency being played. Column after column it draws the line that
    // wanders with the note - which is the tuning, read off the picture.
    if (traceP >= 0 && traceAge <= TRACE_HOLD_FRAMES) {
      var centre = posToY(traceP, rows);
      var half = Math.max(1, Math.round(rows / 500));
      var traceHue = ((90 + (traceP / 12) * 330) % 360) / 360;

      for (var d = -half; d <= half; d += 1) {
        var ty = Math.round(centre) + d;
        if (ty < 0 || ty >= rows) continue;

        // Brightest in the middle, fading at the edges, so the line reads as
        // a line rather than a band. "Brightest" runs the other way on a
        // light theme - a white line on a white panel is no line at all, so
        // there the strongest part of it is the darkest.
        var falloff = 1 - Math.abs(d) / (half + 1);
        var bright = theme.dark
          ? hslToRgb(traceHue, 1, 0.5 + 0.45 * falloff)
          : hslToRgb(traceHue, 1, 0.46 - 0.28 * falloff);

        var t = ty * 4;
        data[t] = bright[0];
        data[t + 1] = bright[1];
        data[t + 2] = bright[2];
        data[t + 3] = 255;
      }
    }

    // Everything shuffles one pixel left and the new moment goes in at the
    // right edge, so the picture reads as time flowing away to the left.
    s2d.drawImage(spec, -1, 0);
    s2d.putImageData(colImg, spec.width - 1, 0);
  }

  /** Where a frequency falls in the octave: 0 at C, 12 at the next C up. */
  function chromaPosition(hz) {
    var semitones = 12 * (Math.log(hz / C0) / Math.LN2);
    var pos = semitones % 12;
    return pos < 0 ? pos + 12 : pos;
  }

  // The note lines are drawn half a row up from the very bottom, so C is not
  // clipped against the edge of the screen. Every other part of the picture
  // has to use that same half-row shift or the colours - and the line showing
  // what is being played - would sit half a semitone off their own labels.
  var ROW_SHIFT = 11.5;

  /** Which point in the octave a screen row stands for. */
  function yToPos(y, rows) {
    var pos = (ROW_SHIFT - (12 * (y + 0.5)) / rows) % 12;
    return pos < 0 ? pos + 12 : pos;
  }

  /** And back the other way, for drawing at an exact frequency. */
  function posToY(pos, rows) {
    var y = (rows * (ROW_SHIFT - pos)) / 12 - 0.5;
    while (y < 0) y += rows;
    while (y >= rows) y -= rows;
    return y;
  }

  /** The strength at a point in the octave, smoothed between neighbours. */
  function chromaAt(pos) {
    var x = (pos / 12) * CHROMA_BINS;
    var i = Math.floor(x);
    var f = x - i;
    var a = chroma[((i % CHROMA_BINS) + CHROMA_BINS) % CHROMA_BINS];
    var b = chroma[(((i + 1) % CHROMA_BINS) + CHROMA_BINS) % CHROMA_BINS];
    return a + (b - a) * f;
  }

  function hslToRgb(h, s, l) {
    if (s === 0) { var g = Math.round(l * 255); return [g, g, g]; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [
      Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
      Math.round(hueToChannel(p, q, h) * 255),
      Math.round(hueToChannel(p, q, h - 1 / 3) * 255)
    ];
  }

  function hueToChannel(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function drawFrame() {
    if (!c2d) return;

    c2d.fillStyle = theme.bg;
    c2d.fillRect(0, 0, W, H);
    c2d.drawImage(spec, 0, 0, spec.width, spec.height, gutter, 0, plotW, H);

    // A line for each note, all the way across, with its name in the margin
    var fontSize = Math.max(13, Math.min(26, Math.round(H / 34)));
    c2d.font = '600 ' + fontSize + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
    c2d.textBaseline = 'middle';

    for (var n = 0; n < 12; n += 1) {
      var y = Math.round(H - (n / 12) * H - H / 24) + 0.5;

      c2d.strokeStyle = theme.line;
      c2d.lineWidth = 1;
      c2d.beginPath();
      c2d.moveTo(gutter * 0.42, y);
      c2d.lineTo(W, y);
      c2d.stroke();

      // The label is drawn over the scrolling colour, so it carries a faint
      // halo of the background behind it. Without that, a note lighting up
      // underneath its own name is exactly when the name stops being readable.
      c2d.lineWidth = 3;
      c2d.strokeStyle = theme.bg;
      c2d.strokeText(NOTES[n], 10, y);
      c2d.fillStyle = theme.text;
      c2d.fillText(NOTES[n], 10, y);
    }
  }

  // ── The frequency ──────────────────────────────────────────────────────────

  /**
   * The frequency being played, taken from the waveform rather than the
   * spectrum.
   *
   * An FFT bin is far too coarse to tune by - at this window each one spans
   * several Hz, which down at the bottom of the range is most of a semitone.
   * So the waveform is compared against a delayed copy of itself, and the
   * delay that matches best is the length of one cycle.
   *
   * Two details are what make it trustworthy. The normalisation is McLeod's,
   * which keeps the measure between -1 and 1 whatever the volume. And taking
   * the FIRST peak that comes close to the best one, rather than the best
   * outright, is what stops a tuner reading an octave high on a rich note.
   *
   * The peak is then fitted with a parabola through its two neighbours, so
   * the answer is not limited to whole samples - that last step is the
   * difference between a reading good to a few Hz and one good to a fraction.
   */
  // Working buffer for the coarse pass, kept between frames so a frame
  // allocates nothing.
  var COARSE_STEP = 4;
  var coarse = null;

  function detectPitch(buf, sr) {
    var N = buf.length;

    // Remove microphone/DC bias before correlation. Even a small offset makes
    // unrelated points look alike and can pull a tuner toward a false pitch.
    var mean = 0;
    for (var mi = 0; mi < N; mi += 1) mean += buf[mi];
    mean /= N;

    var sumSq = 0;
    for (var i = 0; i < N; i += 1) {
      var centred = buf[i] - mean;
      sumSq += centred * centred;
    }
    var rms = Math.sqrt(sumSq / N);
    // Only the very quietest input is turned away here. It is the periodicity
    // test further down that separates a note from noise, not the volume - so
    // this can stay low enough to follow a note as it rings away, or an
    // instrument played across the room.
    if (rms < 0.0022) return null;

    var minLag = Math.max(2, Math.floor(sr / MAX_HZ));
    var maxLag = Math.min(N - 2, Math.floor(sr / MIN_HZ));
    if (maxLag <= minLag) return null;

    if (!nsdf || nsdf.length < maxLag + 2) nsdf = new Float32Array(maxLag + 2);

    // The correlation is the expensive part - one pass over the whole window
    // for every lag in the range. Done at full resolution over a window long
    // enough to be accurate on a low string, it is too slow to run often
    // enough to feel live, and the old answer to that was a shorter window,
    // which costs accuracy exactly where it is hardest to get.
    //
    // So it is done twice instead. First over a copy decimated by four -
    // sixteen times less work, and plenty to find WHICH cycle length is the
    // right one. Then the neighbourhood of that answer is measured again at
    // full resolution, which is what the frequency is actually read from.
    // The window can be long AND the reading can be quick.
    var cN = Math.floor(N / COARSE_STEP);
    if (!coarse || coarse.length < cN) coarse = new Float32Array(cN);

    // Averaging the samples that are folded together, rather than picking one
    // of them, keeps the high partials from aliasing down into the range the
    // coarse pass is searching and inventing a cycle that is not there.
    for (var ci = 0; ci < cN; ci += 1) {
      var acc = 0;
      var base = ci * COARSE_STEP;
      for (var cj = 0; cj < COARSE_STEP; cj += 1) acc += buf[base + cj] - mean;
      coarse[ci] = acc / COARSE_STEP;
    }

    var cMinLag = Math.max(1, Math.floor(minLag / COARSE_STEP));
    var cMaxLag = Math.min(cN - 2, Math.ceil(maxLag / COARSE_STEP));
    if (cMaxLag <= cMinLag) return null;

    var coarseBest = 0;
    var coarseBestLag = -1;
    // The best few coarse lags are all followed up, not just the winner. The
    // true cycle and its double often score within a hair of each other at
    // this resolution, and choosing between them is precisely the octave
    // error a tuner must not make - so both get measured properly first.
    var cScores = [];
    for (var cl = cMinLag; cl <= cMaxLag; cl += 1) {
      var cac = 0, cen = 0;
      for (var cq = 0; cq < cN - cl; cq += 1) {
        var ca = coarse[cq], cb = coarse[cq + cl];
        cac += ca * cb;
        cen += ca * ca + cb * cb;
      }
      var cv = cen > 0 ? (2 * cac) / cen : 0;
      cScores.push(cv);
      if (cv > coarseBest) { coarseBest = cv; coarseBestLag = cl; }
    }

    if (coarseBestLag < 0 || coarseBest < 0.4) return null;

    // Peaks are only looked for AFTER the measure has first fallen through
    // zero. Close to zero delay anything correlates with itself, so a slow
    // rumble - mains hum, a lorry outside, a note below the range - leaves a
    // long downward slope with no peak on it, and the tuner would otherwise
    // seize on the shortest lag it could find and report a note two octaves
    // above anything actually being played. Waiting for the crossing means a
    // signal with no real cycle in range finds no peak at all, which is the
    // honest answer.
    var crossed = -1;
    for (var cz = 0; cz < cScores.length; cz += 1) {
      if (cScores[cz] <= 0) { crossed = cz; break; }
    }
    if (crossed < 0) return null;

    // Every coarse peak past that crossing that comes close to the best one
    // is a candidate.
    var candidates = [];
    var cThreshold = 0.86 * coarseBest;
    for (var ck = crossed + 1; ck < cScores.length - 1; ck += 1) {
      if (cScores[ck] >= cThreshold &&
          cScores[ck] >= cScores[ck - 1] && cScores[ck] >= cScores[ck + 1]) {
        candidates.push(cMinLag + ck);
      }
    }
    if (candidates.length === 0) return null;
    // Shortest cycle first: with equal scores the higher reading is the
    // fundamental, and the longer lags are its multiples.
    candidates.sort(function (a, b) { return a - b; });
    if (candidates.length > 4) candidates.length = 4;

    // Full-resolution pass, but only over the handful of lags around each
    // candidate rather than the whole range.
    var span = COARSE_STEP * 2;
    var touched = [];
    var best = 0;
    for (var cd = 0; cd < candidates.length; cd += 1) {
      var centreLag = candidates[cd] * COARSE_STEP;
      var from = Math.max(minLag + 1, centreLag - span);
      var to = Math.min(maxLag - 1, centreLag + span);

      for (var lag = from; lag <= to; lag += 1) {
        var ac = 0, energy = 0;
        for (var j = 0; j < N - lag; j += 1) {
          var a = buf[j] - mean, b = buf[j + lag] - mean;
          ac += a * b;
          energy += a * a + b * b;
        }
        var v = energy > 0 ? (2 * ac) / energy : 0;
        nsdf[lag] = v;
        touched.push(lag);
        if (v > best) best = v;
      }
    }

    if (best < 0.45) return null; // nothing periodic enough to call a note

    // The SHORTEST lag that scores close to the best is the answer, not the
    // best outright. A rich note correlates nearly as well against two or
    // three of its own cycles as against one, and taking the best outright
    // would read an octave - or two - low. This is the octave-error guard.
    touched.sort(function (a, b) { return a - b; });
    var threshold = 0.9 * best;
    var chosen = -1;
    for (var ti = 0; ti < touched.length; ti += 1) {
      var k = touched[ti];
      if (k <= minLag || k >= maxLag) continue;
      // Only a genuine local maximum counts, so the shoulder of a peak is
      // never mistaken for the peak itself.
      if (nsdf[k] >= threshold && nsdf[k] >= nsdf[k - 1] && nsdf[k] >= nsdf[k + 1]) {
        chosen = k;
        break;
      }
    }
    if (chosen < 1) return null;

    var y1 = nsdf[chosen - 1], y2 = nsdf[chosen], y3 = nsdf[chosen + 1];
    var denom = y1 + y3 - 2 * y2;
    var shift = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
    if (shift > 1 || shift < -1) shift = 0;

    var hz = sr / (chosen + shift);
    if (!isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) return null;

    // A note on what this does NOT correct for. A thick or wound string is
    // slightly inharmonic - its upper partials run sharp - and since those
    // partials are part of the same waveform, the cycle measured here sits a
    // little above the fundamental the player hears. Filtering the partials
    // away first was tried and made things worse, not better: the filter's
    // own settling at the ends of the window shifted the measurement further
    // than the inharmonicity ever did, and it spoiled ordinary notes that
    // were exact to begin with. So the honest reading is left as it is.

    return { hz: hz, clarity: y2, level: rms };
  }

  /**
   * The middle reading of the last few.
   *
   * One frame can be thrown by a string buzz or a chair scraping; the median
   * rides over that without the lag an average would add.
   */
  function steady(hz) {
    recent.push(hz);
    if (recent.length > 7) recent.shift();
    var sorted = recent.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  function computeChroma() {
    var sr = ctx.sampleRate;
    var bins = analyser.frequencyBinCount;

    for (var i = 0; i < CHROMA_BINS; i += 1) chroma[i] *= 0.55; // a brief trail

    for (var k = 1; k < bins; k += 1) {
      var f = (k * sr) / (2 * bins);
      if (f < MIN_HZ || f > 3200) continue;

      var semitones = 12 * (Math.log(f / C0) / Math.LN2);
      var pos = semitones % 12;
      if (pos < 0) pos += 12;

      var idx = Math.floor((pos / 12) * CHROMA_BINS);
      if (idx < 0) idx = 0;
      if (idx >= CHROMA_BINS) idx = CHROMA_BINS - 1;

      var mag = freqBuf[k] / 255;
      if (mag > chroma[idx]) chroma[idx] = mag;
    }
  }

  function tick() {
    if (!running) return;
    raf = window.requestAnimationFrame(tick);
    frame += 1;

    analyser.getByteFrequencyData(freqBuf);
    computeChroma();
    traceAge += 1;
    if (traceAge > TRACE_HOLD_FRAMES) traceP = -1;
    paintColumn();
    drawFrame();

    // Working out the frequency still costs more than painting a column, but
    // the coarse-to-fine search brought it down far enough to run about
    // twenty times a second - quick enough that the cents reading moves with
    // the peg rather than trailing behind it.
    if (frame % 3 === 0) {
      analyser.getFloatTimeDomainData(timeBuf);
      var found = detectPitch(timeBuf, ctx.sampleRate);
      var now = Date.now();

      if (found && found.clarity >= 0.7) {
        // The same steadied reading drives both the line and the number, so
        // the two can never disagree about what is being played.
        var shown = steady(found.hz);
        traceP = chromaPosition(shown);
        traceAge = 0;

        if (now - lastPost > 90) {
          lastPost = now;
          send({ type: 'pitch', hz: shown, clarity: found.clarity, level: found.level });
        }
      } else {
        recent.length = 0;
        if (now - lastPost > 250) {
          lastPost = now;
          send({ type: 'pitch', hz: 0, clarity: 0, level: found ? found.level : 0 });
        }
      }
    }
  }

  // ── Starting and stopping ──────────────────────────────────────────────────

  /**
   * Ask for the microphone, whichever way this WebView offers.
   *
   * navigator.mediaDevices only exists on a secure origin, which is why the
   * page is loaded with an https base URL. Older WebViews put the same thing
   * on navigator directly, taking callbacks rather than returning a promise -
   * worth trying before giving up, since it costs a few lines and rescues the
   * devices that still work that way.
   */
  function openMicrophone(constraints) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }

    var legacy = navigator.getUserMedia || navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia || navigator.msGetUserMedia;

    if (legacy) {
      return new Promise(function (resolve, reject) {
        legacy.call(navigator, constraints, resolve, reject);
      });
    }

    var why = window.isSecureContext === false
      ? 'the page is not running on a secure origin'
      : 'this WebView has no microphone support';
    return Promise.reject({ name: 'NotSupportedError', why: why });
  }

  function start() {
    if (running) return;

    // Every clean-up the browser would normally apply is turned off here:
    // echo cancellation and noise suppression both chew holes in a held note,
    // and automatic gain hides how hard the string was actually played.
    openMicrophone({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    }).then(function (s) {
      stream = s;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor();
      if (ctx.state === 'suspended') ctx.resume();

      srcNode = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -95;
      analyser.maxDecibels = -12;
      srcNode.connect(analyser);
      // Deliberately not connected to the destination: the microphone must
      // never come back out of the speaker.

      // A full fftSize window: at 48 kHz that is 170 ms, which holds seven
      // cycles even of a bass low B. Short windows are why tuners wobble on
      // the bottom string; the two-stage search above is what pays for it.
      timeBuf = new Float32Array(8192);
      freqBuf = new Uint8Array(analyser.frequencyBinCount);

      running = true;
      frame = 0;
      recent.length = 0;
      traceP = -1;
      traceAge = 0;
      send({ type: 'started', sampleRate: ctx.sampleRate });
      raf = window.requestAnimationFrame(tick);
    }).catch(function (err) {
      var name = (err && err.name) || '';
      var message;

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        message = 'Microphone access was refused. Allow it in your phone settings to use the tuner.';
      } else if (name === 'NotSupportedError') {
        message = 'The tuner could not reach the microphone on this device.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        message = 'No microphone was found on this device.';
      } else {
        message = 'The microphone could not be opened. Close anything else using it, then try again.';
      }

      // Carried along for the log: which of the two very different problems
      // this was - being told no, or never being able to ask in the first place
      send({
        type: 'error',
        message: message,
        detail: name + (err && err.why ? ' (' + err.why + ')' : ''),
        secure: window.isSecureContext === true,
        origin: String(window.location && window.location.origin)
      });
    });
  }

  function stop() {
    running = false;
    stopReference();
    if (raf) { window.cancelAnimationFrame(raf); raf = 0; }

    if (stream) {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i += 1) {
        try { tracks[i].stop(); } catch (e) {}
      }
      stream = null;
    }
    if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
    // Closing the context would take the reference notes with it, now that
    // they share it - so the shared handle is dropped first.
    if (ctx) {
      if (referenceCtx === ctx) referenceCtx = null;
      try { ctx.close(); } catch (e) {}
      ctx = null;
    }

    analyser = null;
    recent.length = 0;
    traceP = -1;
    for (var c = 0; c < CHROMA_BINS; c += 1) chroma[c] = 0;

    send({ type: 'stopped' });
  }

  function stopReference() {
    for (var i = 0; i < referenceOscillators.length; i += 1) {
      try { referenceOscillators[i].stop(); } catch (e) {}
    }
    referenceOscillators.length = 0;
  }

  function playReference(frequency) {
    if (!isFinite(frequency) || frequency < 20 || frequency > 5000) return;
    stopReference();

    // Prefer the context the microphone already opened. A second context
    // created later has never been unlocked by a gesture, and on iOS it can
    // sit suspended forever - which is a reference note that silently never
    // sounds. The live one is already running, so it always does.
    var Ctor = window.AudioContext || window.webkitAudioContext;
    var out = ctx;
    if (!out || out.state === 'closed') {
      if (!referenceCtx || referenceCtx.state === 'closed') referenceCtx = new Ctor();
      out = referenceCtx;
    }
    if (out.state === 'suspended') out.resume();
    referenceCtx = out;

    var now = referenceCtx.currentTime;
    var gain = referenceCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.025);
    gain.gain.setValueAtTime(0.2, now + 0.85);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
    gain.connect(referenceCtx.destination);

    var fundamental = referenceCtx.createOscillator();
    var harmonic = referenceCtx.createOscillator();
    var harmonicGain = referenceCtx.createGain();
    harmonicGain.gain.value = 0.14;
    fundamental.type = 'sine';
    harmonic.type = 'sine';
    fundamental.frequency.value = frequency;
    harmonic.frequency.value = frequency * 2;
    fundamental.connect(gain);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(gain);
    fundamental.start(now);
    harmonic.start(now);
    fundamental.stop(now + 1.18);
    harmonic.stop(now + 1.18);
    referenceOscillators = [fundamental, harmonic];
  }

  function applyTheme(next) {
    if (!next) return;
    if (next.bg) theme.bg = next.bg;
    if (next.text) theme.text = next.text;
    if (next.line) theme.line = next.line;
    if (typeof next.dark === 'boolean') theme.dark = next.dark;
    theme.lightness = theme.dark ? 0.62 : 0.55;

    // Repaint the history too, so changing theme does not leave a band of the
    // old background scrolling away across the picture.
    if (s2d && spec) {
      s2d.fillStyle = theme.bg;
      s2d.fillRect(0, 0, spec.width, spec.height);
    }
    drawFrame();
  }

  function handle(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'start') start();
    else if (msg.type === 'stop') stop();
    else if (msg.type === 'theme') applyTheme(msg.theme);
    else if (msg.type === 'play-reference') playReference(Number(msg.frequency));
  }

  function onMessage(event) {
    try { handle(JSON.parse(event.data)); } catch (e) {}
  }

  // Android delivers to document, iOS to window - listen on both
  document.addEventListener('message', onMessage);
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', setupCanvas);

  setupCanvas();
  send({ type: 'ready' });
})();
</script>
</body>
</html>`
