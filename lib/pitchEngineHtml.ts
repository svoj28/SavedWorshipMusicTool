// lib/pitchEngineHtml.ts
//
// The audio engine that runs inside the hidden WebView in PitchAudioEngine.
//
// Why a WebView: real pitch shifting needs raw PCM. The WebView gives us the
// platform audio decoders (decodeAudioData handles mp3/m4a/wav) plus Web Audio
// for playback, with no native module to install. Everything below is plain
// browser JS - it never runs in the React Native JS context.
//
// What it does:
//   * Granular (overlap-add) pitch shifting - pitch moves, tempo does NOT.
//   * Independent tempo stretch, so speed can be changed separately if wanted.
//   * Key detection from a chroma profile scored against Krumhansl-Schmuckler
//     key profiles, returning sharps or flats per the key's own signature.
//
// The shift is rendered up front into a new AudioBuffer, then played by an
// ordinary AudioBufferSourceNode. Doing it per-block in a ScriptProcessor
// callback instead puts the work on the main thread, where one hitch drops a
// block and the audio jumps forward - heard as a speed-up cut. Rendering
// ahead of time costs a short wait when the pitch changes and nothing after.

export const PITCH_ENGINE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:transparent">
<script>
(function () {
  var ctx = null;
  var buffer = null;          // decoded source AudioBuffer
  var rendered = null;        // pitch/tempo shifted AudioBuffer being played
  var renderedTempo = 1;      // the tempo 'rendered' was built with
  var source = null;          // AudioBufferSourceNode
  var chunks = [];            // incoming base64 pieces

  var playing = false;
  var startedAt = 0;          // ctx.currentTime when the current source started
  var startOffset = 0;        // seconds into 'rendered' where it started
  var stopping = false;       // guards onended during a deliberate stop

  var semitones = 0;
  var tempo = 1;              // 1 = original speed

  // Which parts to strip out of the mix. Applied to the decoded audio before
  // any pitch/tempo work, so the two compose.
  var removal = { vocals: false, bass: false, drums: false, harmonic: false };
  var processed = null;       // buffer after removal, or the source when none

  // SOLA settings, in frames at 44.1kHz.
  // SEQ is the flat run copied per frame, OVERLAP the crossfade between
  // frames, SEEK how far we may slide a frame to find the alignment that
  // matches what is already written.
  var SEQ = 2048;             // ~46ms
  var OVERLAP = 512;          // ~12ms
  var SEEK = 512;             // ~12ms of slack, covers periods down to ~86Hz
  var COARSE = 8;             // stride for the first correlation pass
  var fade = null;            // raised-cosine crossfade ramp, OVERLAP long

  // Rendered buffers kept by "semitones|tempo" so going back to a key you
  // already tried is instant. Budgeted by sample count, not by entry count -
  // one render of a long stereo song is tens of megabytes, and holding several
  // would exhaust the WebView.
  var cache = {};
  var cacheOrder = [];
  var cachedSamples = 0;

  // Stretch buffer, reused by every channel and every render
  var scratch = null;
  function scratchBuffer(len) {
    // Not cleared on reuse: the stretch writes every sample before it is read,
    // and clearing tens of megabytes per channel costs more than the render.
    if (!scratch || scratch.length < len) scratch = new Float32Array(len);
    return scratch;
  }
  var CACHE_SAMPLE_BUDGET = 20000000;   // ~80MB of float32

  function send(msg) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  function fail(where, err) {
    send({ type: 'error', message: where + ': ' + (err && err.message ? err.message : String(err)) });
  }

  function makeWindow(n) {
    var w = new Float32Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  function ensureContext() {
    if (ctx) return ctx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor();
    fade = new Float32Array(OVERLAP);
    for (var i = 0; i < OVERLAP; i++) {
      fade[i] = 0.5 - 0.5 * Math.cos((Math.PI * i) / OVERLAP);
    }
    return ctx;
  }

  // ---- Stems: what is in the mix, and taking parts of it out ---------------
  //
  // No model runs here, so this cannot tell a guitar from a keyboard. What it
  // can do is separate by the properties that survive in a stereo mixdown:
  //
  //   vocals   - lead vocals sit in the centre, equal in both channels, so the
  //              mid signal in the vocal band is mostly them
  //   bass     - everything under the bass cutoff
  //   drums    - percussion is broadband and brief: strong across frequency,
  //              unsteady over time
  //   harmonic - sustained pitched material: narrow in frequency, steady in
  //              time (the opposite test to drums)
  //
  // Everything runs on an STFT with Hann windows at 50% overlap, which sums
  // back to unity, so with nothing selected the audio comes back untouched.

  var FFT_N = 2048;
  var FFT_HOP = 1024;
  var BASS_HZ = 250;          // bass lives below this
  var VOCAL_LO_HZ = 200;      // lead vocal band
  var VOCAL_HI_HZ = 4000;
  var HIST_FRAMES = 9;        // time window for the "is it steady" test
  var FREQ_SMOOTH = 9;        // bin window for the "is it broadband" test

  function anyRemoval() {
    return removal.vocals || removal.bass || removal.drums || removal.harmonic;
  }

  /** Inverse FFT of a conjugate-symmetric spectrum; real result lands in re. */
  function ifft(re, im) {
    var n = re.length, i;
    for (i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    for (i = 0; i < n; i++) re[i] = re[i] / n;
  }

  /**
   * One STFT pass over the decoded audio.
   *
   * With "stats" it only measures how much of each part is present; otherwise
   * it writes the mix into "out" with the selected parts removed.
   */
  function stftPass(stats, out) {
    var sr = buffer.sampleRate;
    var channels = buffer.numberOfChannels;
    var inLen = buffer.length;
    var N = FFT_N, HOPN = FFT_HOP, half = N / 2;
    var win = makeWindow(N);
    var srcL = buffer.getChannelData(0);
    var srcR = channels > 1 ? buffer.getChannelData(1) : srcL;
    var outL = out ? out.getChannelData(0) : null;
    var outR = out && channels > 1 ? out.getChannelData(1) : null;

    var reL = new Float32Array(N), imL = new Float32Array(N);
    var reR = new Float32Array(N), imR = new Float32Array(N);
    var mag = new Float32Array(half + 1);
    var freqSmooth = new Float32Array(half + 1);
    var history = [];
    for (var h = 0; h < HIST_FRAMES; h++) history.push(new Float32Array(half + 1));
    var histAt = 0, histFilled = 0;
    var sortBuf = new Float32Array(HIST_FRAMES);
    var prevMag = new Float32Array(half + 1);

    var bassBin = Math.max(1, Math.round((BASS_HZ * N) / sr));
    var vocalLo = Math.max(1, Math.round((VOCAL_LO_HZ * N) / sr));
    var vocalHi = Math.min(half, Math.round((VOCAL_HI_HZ * N) / sr));
    var halfWin = (FREQ_SMOOTH - 1) / 2;

    var i, b, k;

    // Measuring what is in the mix does not need the whole song. Take a
    // contiguous minute from 10% in - past the intro, still representative -
    // so detection stays quick. Frames must stay adjacent for the flux test,
    // so this is one window rather than scattered samples.
    var from = 0, to = inLen;
    if (stats && inLen > sr * 75) {
      from = Math.floor(inLen * 0.1);
      to = Math.min(inLen, from + sr * 60);
    }

    for (var pos = from; pos + N <= to; pos += HOPN) {
      for (i = 0; i < N; i++) {
        var w = win[i];
        reL[i] = srcL[pos + i] * w; imL[i] = 0;
        reR[i] = srcR[pos + i] * w; imR[i] = 0;
      }
      fft(reL, imL);
      if (channels > 1) fft(reR, imR);

      // Total energy across the channels drives both detectors. Using the
      // mono sum instead would hide anything panned to the sides - a guitar
      // out of phase between the channels would read as silence and get
      // masked away with the drums.
      for (b = 0; b <= half; b++) {
        var eL = reL[b] * reL[b] + imL[b] * imL[b];
        var eR = channels > 1 ? reR[b] * reR[b] + imR[b] * imR[b] : 0;
        mag[b] = Math.sqrt(eL + eR);
      }

      // Broadband test: this bin against its neighbours
      for (b = 0; b <= half; b++) {
        var lo = b - halfWin; if (lo < 0) lo = 0;
        var hi = b + halfWin; if (hi > half) hi = half;
        var running = 0;
        for (k = lo; k <= hi; k++) running += mag[k];
        freqSmooth[b] = running / (hi - lo + 1);
      }

      history[histAt].set(mag);
      histAt = (histAt + 1) % HIST_FRAMES;
      if (histFilled < HIST_FRAMES) histFilled++;

      for (b = 0; b <= half; b++) {
        // Steady test: the median of this bin over the recent frames.
        // A median, not an average: one loud drum hit barely moves a median,
        // so the hit stands out sharply against it. An average is dragged up
        // by the hit itself, which is what made drum removal so timid.
        var count = histFilled;
        for (var f2 = 0; f2 < count; f2++) {
          var v = history[f2][b];
          var q = f2 - 1;
          while (q >= 0 && sortBuf[q] > v) { sortBuf[q + 1] = sortBuf[q]; q--; }
          sortBuf[q + 1] = v;
        }
        var timeAvg = count ? sortBuf[count >> 1] : 0;

        var hEnergy = timeAvg * timeAvg;              // steady    -> harmonic
        var pEnergy = freqSmooth[b] * freqSmooth[b];  // broadband -> percussive
        var denom = hEnergy + pEnergy + 1e-12;
        var maskH = hEnergy / denom;
        var maskP = pEnergy / denom;

        var inVocalBand = b >= vocalLo && b <= vocalHi;

        var midR = channels > 1 ? (reL[b] + reR[b]) * 0.5 : reL[b];
        var midI = channels > 1 ? (imL[b] + imR[b]) * 0.5 : imL[b];
        var sideR = channels > 1 ? (reL[b] - reR[b]) * 0.5 : 0;
        var sideI = channels > 1 ? (imL[b] - imR[b]) * 0.5 : 0;
        var midE = midR * midR + midI * midI;
        var sideE = sideR * sideR + sideI * sideI;

        if (stats) {
          var e = midE + sideE;
          stats.total += e;
          if (b < bassBin) stats.bass += e;
          // Centre energy weighted by how sustained it is: a centred snare is
          // not a singer, so percussive centre content must not count here.
          if (inVocalBand) {
            stats.centre += midE * maskH;
            stats.sides += sideE * maskH;
          }
          stats.perc += e * maskP;
          stats.harm += e * maskH;
          // Spectral flux - energy appearing suddenly - is what actually tells
          // percussion apart. Sustained parts barely move between frames.
          var rise = mag[b] - prevMag[b];
          if (rise > 0) stats.flux += rise;
          stats.magSum += mag[b];
          continue;
        }

        var gain = 1;
        if (removal.drums) gain *= maskH;        // keep only the steady part
        if (removal.harmonic) gain *= maskP;     // keep only the transient part
        if (removal.bass && b < bassBin) gain *= 0.03;

        midR *= gain; midI *= gain;
        sideR *= gain; sideI *= gain;

        // Vocals: drop the centre inside the vocal band only, so centred bass
        // and cymbals survive.
        if (removal.vocals && inVocalBand) {
          midR *= 0.03; midI *= 0.03;
        }

        reL[b] = midR + sideR; imL[b] = midI + sideI;
        reR[b] = midR - sideR; imR[b] = midI - sideI;

        // Mirror into the negative frequencies for a real inverse transform
        if (b > 0 && b < half) {
          reL[N - b] = reL[b]; imL[N - b] = -imL[b];
          reR[N - b] = reR[b]; imR[N - b] = -imR[b];
        }
      }

      if (stats) { prevMag.set(mag); continue; }

      ifft(reL, imL);
      if (channels > 1) ifft(reR, imR);

      for (i = 0; i < N; i++) {
        if (pos + i >= inLen) break;
        outL[pos + i] += reL[i];
        if (outR) outR[pos + i] += reR[i];
      }
    }
  }

  function analyzeStems() {
    if (!buffer) { send({ type: 'error', message: 'analyze: nothing loaded' }); return; }
    try {
      var stats = { total: 0, bass: 0, centre: 0, sides: 0, perc: 0, harm: 0, flux: 0, magSum: 0 };
      stftPass(stats, null);
      var total = stats.total + 1e-12;
      var stereo = buffer.numberOfChannels > 1;

      // Centre content only means "vocals" when there are sides to compare with
      var centreShare = stereo ? stats.centre / (stats.centre + stats.sides + 1e-12) : 0;
      var vocalRatio = stereo ? stats.centre / total : 0;
      var bassRatio = stats.bass / total;
      var fluxRatio = stats.flux / (stats.magSum + 1e-12);
      var harmRatio = stats.harm / total;

      var pct = function (value, full) {
        return Math.max(0, Math.min(100, Math.round((value / full) * 100)));
      };

      send({
        type: 'stems',
        stereo: stereo,
        parts: [
          { id: 'vocals', level: pct(vocalRatio, 0.45),
            present: stereo && vocalRatio > 0.07 && centreShare > 0.45,
            note: stereo ? '' : 'Needs a stereo track' },
          { id: 'bass', level: pct(bassRatio, 0.5),
            present: bassRatio > 0.06, note: '' },
          { id: 'drums', level: pct(fluxRatio, 0.22),
            present: fluxRatio > 0.06, note: '' },
          { id: 'harmonic', level: pct(harmRatio, 0.8),
            present: harmRatio > 0.25, note: '' }
        ]
      });
    } catch (err) {
      fail('analyze', err);
    }
  }

  /** Rebuild the source with the selected parts taken out. */
  function applyRemoval() {
    if (!buffer) return;
    if (!anyRemoval()) { processed = buffer; return; }
    var out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    stftPass(null, out);
    processed = out;
  }

  // ---- Rendering -----------------------------------------------------------

  /**
   * Find where to take the next frame from so it lines up with the audio
   * already written.
   *
   * This is the whole trick. Overlap-adding two chunks of a waveform that are
   * out of phase makes them partially cancel, and because that happens once
   * per frame it is heard as a periodic flutter - a fan over the voice. So
   * before mixing, slide the source window within +/-SEEK and keep the offset
   * whose waveform best correlates with the tail already in the output.
   *
   * Normalised correlation, coarse pass first, then refined around the winner.
   */
  function findBestOffset(src, inStart, dst, outPos, inLen) {
    var lo = Math.max(-SEEK, -inStart);
    var hi = Math.min(SEEK, inLen - OVERLAP - inStart - 1);
    if (hi < lo) return 0;

    var best = 0;
    var bestScore = -Infinity;
    var delta, i, a, b, dot, energy, score, idx;

    for (delta = lo; delta <= hi; delta += COARSE) {
      dot = 0; energy = 0;
      idx = inStart + delta;
      for (i = 0; i < OVERLAP; i += COARSE) {
        a = dst[outPos + i];
        b = src[idx + i];
        dot += a * b;
        energy += b * b;
      }
      score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) { bestScore = score; best = delta; }
    }

    var refineLo = Math.max(lo, best - COARSE);
    var refineHi = Math.min(hi, best + COARSE);
    bestScore = -Infinity;
    var refined = best;
    for (delta = refineLo; delta <= refineHi; delta++) {
      dot = 0; energy = 0;
      idx = inStart + delta;
      for (i = 0; i < OVERLAP; i++) {
        a = dst[outPos + i];
        b = src[idx + i];
        dot += a * b;
        energy += b * b;
      }
      score = dot / Math.sqrt(energy + 1e-9);
      if (score > bestScore) { bestScore = score; refined = delta; }
    }
    return refined;
  }

  /**
   * Time-stretch one channel by "factor" (>1 = longer) without touching pitch.
   *
   * Straight-line loops on purpose: an earlier version produced the stretch
   * lazily from inside the resampling loop, which meant a bounds check and a
   * closure call for every one of the millions of output samples. That cost
   * more than the buffer it saved, and the sliding window it needed could not
   * always free enough room, which put small clicks back into the output.
   *
   * "offsets" collects the alignment chosen per frame on the first channel and
   * replays it on the rest, so every channel is cut in the same place, the
   * stereo image stays put, and the search runs once rather than per channel.
   */
  function solaStretch(src, dst, inLen, outLen, factor, offsets, reuse) {
    var analysisHop = Math.max(1, Math.round(SEQ / factor));
    var copyLen = SEQ + OVERLAP;

    // The opening frame has nothing to align against, so it is copied as-is
    var first = Math.min(copyLen, inLen, outLen);
    for (var n = 0; n < first; n++) dst[n] = src[n];

    var writePos = SEQ;
    var frame = 0;
    var produced = first;

    while (writePos + OVERLAP < outLen) {
      var nominal = frame * analysisHop + SEQ;
      if (nominal + OVERLAP >= inLen) break;

      var delta;
      if (reuse) {
        delta = offsets[frame] || 0;
        if (nominal + delta < 0) delta = 0;
        if (nominal + delta + OVERLAP >= inLen) delta = 0;
      } else {
        delta = findBestOffset(src, nominal, dst, writePos, inLen);
        offsets[frame] = delta;
      }

      var read = nominal + delta;

      // The last frame keeps whatever input is left rather than stopping
      // short, which would end the song on an abrupt step.
      var avail = Math.min(copyLen, inLen - read, outLen - writePos);
      if (avail <= OVERLAP) break;

      // Crossfade into what is already there, then run on flat
      for (var i = 0; i < OVERLAP; i++) {
        var w = fade[i];
        dst[writePos + i] = dst[writePos + i] * (1 - w) + src[read + i] * w;
      }
      for (var j = OVERLAP; j < avail; j++) {
        dst[writePos + j] = src[read + j];
      }

      produced = Math.max(produced, writePos + avail);
      writePos += SEQ;
      frame += 1;
    }
    return produced;
  }

  /**
   * Build the shifted audio: stretch by p/tempo so the pitch is untouched,
   * then resample by p, which moves the pitch and puts the length back to what
   * the tempo asks for.
   */
  function renderShifted() {
    var key = semitones + '|' + tempo + '|' +
      (removal.vocals ? 'v' : '') + (removal.bass ? 'b' : '') +
      (removal.drums ? 'd' : '') + (removal.harmonic ? 'h' : '');
    if (cache[key]) return cache[key];

    var srcBuffer = processed || buffer;
    var p = Math.pow(2, semitones / 12);
    var channels = srcBuffer.numberOfChannels;
    var inLen = srcBuffer.length;
    var outLen = Math.max(1, Math.floor(inLen / tempo));

    // Nothing to do
    if (semitones === 0 && tempo === 1) return srcBuffer;

    var out = ctx.createBuffer(channels, outLen, srcBuffer.sampleRate);
    var stretchFactor = p / tempo;
    var stretchLen = Math.ceil(inLen * stretchFactor) + SEQ + OVERLAP + 4;
    var offsets = [];

    for (var c = 0; c < channels; c++) {
      var src = srcBuffer.getChannelData(c);
      var dst = out.getChannelData(c);

      if (stretchFactor === 1) {
        // Pure resample - no stretching, so no frames to align
        for (var n0 = 0; n0 < outLen; n0++) {
          var rp0 = n0 * p;
          var i00 = Math.floor(rp0);
          if (i00 + 1 >= inLen) break;
          var f0 = rp0 - i00;
          dst[n0] = src[i00] * (1 - f0) + src[i00 + 1] * f0;
        }
        continue;
      }

      // One scratch buffer, reused by every channel and every render
      var stretched = scratchBuffer(stretchLen);
      var produced = solaStretch(src, stretched, inLen, stretchLen, stretchFactor, offsets, c > 0);

      var written = 0;
      for (var n = 0; n < outLen; n++) {
        var rp = n * p;
        var i0 = Math.floor(rp);
        if (i0 + 1 >= produced) break;
        var frac = rp - i0;
        dst[n] = stretched[i0] * (1 - frac) + stretched[i0 + 1] * frac;
        written = n;
      }

      // Ease the last few milliseconds down. Whatever the source does at its
      // very end, the buffer must not stop on a step - that is an audible pop.
      var TAIL_FADE = 256;
      var fadeFrom = Math.max(0, written - TAIL_FADE + 1);
      for (var tf = fadeFrom; tf <= written; tf++) {
        dst[tf] *= (written - tf) / TAIL_FADE;
      }
    }

    var size = outLen * channels;
    if (size <= CACHE_SAMPLE_BUDGET) {
      while (cacheOrder.length && cachedSamples + size > CACHE_SAMPLE_BUDGET) {
        var oldest = cacheOrder.shift();
        cachedSamples -= cache[oldest].length * cache[oldest].numberOfChannels;
        delete cache[oldest];
      }
      cache[key] = out;
      cacheOrder.push(key);
      cachedSamples += size;
    }
    return out;
  }

  // ---- Playback ------------------------------------------------------------

  function currentPosition() {
    if (!rendered) return 0;
    if (!playing) return startOffset;
    return Math.min(rendered.duration, startOffset + (ctx.currentTime - startedAt));
  }

  function stopSource() {
    if (!source) return;
    stopping = true;
    try { source.stop(); } catch (e) {}
    try { source.disconnect(); } catch (e) {}
    source = null;
    stopping = false;
  }

  function startSource(offsetSeconds) {
    stopSource();
    if (!rendered) return;

    var offset = Math.max(0, Math.min(rendered.duration - 0.01, offsetSeconds || 0));
    source = ctx.createBufferSource();
    source.buffer = rendered;
    source.connect(ctx.destination);
    source.onended = function () {
      if (stopping) return;
      playing = false;
      startOffset = 0;
      send({ type: 'ended' });
      statusTick();
    };
    startedAt = ctx.currentTime;
    startOffset = offset;
    source.start(0, offset);
    playing = true;
  }

  function statusTick() {
    if (!rendered || !ctx) return;
    send({
      type: 'status',
      isPlaying: playing,
      position: currentPosition(),
      duration: rendered.duration
    });
  }
  setInterval(statusTick, 250);

  /**
   * Re-render for the current pitch/tempo and pick playback back up where it
   * left off. Position is carried through the ORIGINAL timeline so a tempo
   * change does not jump the song.
   */
  function refreshRender() {
    if (!buffer) return;

    var wasPlaying = playing;
    var positionInOriginal = currentPosition() * renderedTempo;

    stopSource();
    playing = false;
    send({ type: 'rendering' });

    // Yield once so the app can show its spinner before we block on the render
    setTimeout(function () {
      try {
        rendered = renderShifted();
        renderedTempo = tempo;
        var resumeAt = positionInOriginal / tempo;
        startOffset = Math.max(0, Math.min(rendered.duration, resumeAt));
        send({ type: 'rendered', duration: rendered.duration });
        if (wasPlaying) {
          if (ctx.state === 'suspended') ctx.resume();
          startSource(startOffset);
        }
        statusTick();
      } catch (err) {
        fail('render', err);
      }
    }, 0);
  }

  // ---- Key detection -------------------------------------------------------

  // In-place iterative radix-2 FFT (real input, complex in re/im arrays)
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var k = 0; k < n; k += len) {
        var cr = 1, ci = 0;
        for (var m = 0; m < len / 2; m++) {
          var ar = re[k + m], ai = im[k + m];
          var br = re[k + m + len / 2] * cr - im[k + m + len / 2] * ci;
          var bi = re[k + m + len / 2] * ci + im[k + m + len / 2] * cr;
          re[k + m] = ar + br; im[k + m] = ai + bi;
          re[k + m + len / 2] = ar - br; im[k + m + len / 2] = ai - bi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // Krumhansl-Schmuckler tonal hierarchy profiles
  var MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  var SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Keys conventionally written with flats: F, Bb, Eb, Ab, Db, Gb major
  var FLAT_MAJOR = { 5: 1, 10: 1, 3: 1, 8: 1, 1: 1, 6: 1 };
  // and D, G, C, F minor
  var FLAT_MINOR = { 2: 1, 7: 1, 0: 1, 5: 1 };

  function keyName(tonic, minor) {
    var flat = minor ? FLAT_MINOR[tonic] : FLAT_MAJOR[tonic];
    var name = flat ? FLAT_NAMES[tonic] : SHARP_NAMES[tonic];
    return minor ? name + 'm' : name;
  }

  function correlate(chroma, profile, shift) {
    var n = 12, sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += chroma[(i + shift) % 12]; sy += profile[i]; }
    var mx = sx / n, my = sy / n, num = 0, dx = 0, dy = 0;
    for (var k = 0; k < n; k++) {
      var a = chroma[(k + shift) % 12] - mx;
      var b = profile[k] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    if (dx <= 0 || dy <= 0) return 0;
    return num / Math.sqrt(dx * dy);
  }

  function detectKey() {
    if (!buffer) { send({ type: 'error', message: 'detectKey: nothing loaded' }); return; }
    try {
      var sr = buffer.sampleRate;
      var mono = buffer.getChannelData(0);
      var second = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

      var N = 4096;
      var hop = 4096;                       // analyse ~every 93ms, plenty for key
      var chroma = new Float32Array(12);
      var re = new Float32Array(N);
      var im = new Float32Array(N);
      var win = makeWindow(N);

      // Stay in the band where fundamentals dominate: C2 (65Hz) to ~C6 (1000Hz).
      // Higher up, a note's own harmonics start outweighing other notes'
      // fundamentals and the chart drifts toward the dominant key.
      var minBin = Math.max(2, Math.floor((65 * N) / sr));
      var maxBin = Math.min(N / 2 - 2, Math.ceil((1000 * N) / sr));
      var mags = new Float32Array(maxBin + 2);

      for (var start = 0; start + N < mono.length; start += hop) {
        for (var i = 0; i < N; i++) {
          var s = second ? (mono[start + i] + second[start + i]) * 0.5 : mono[start + i];
          re[i] = s * win[i];
          im[i] = 0;
        }
        fft(re, im);

        for (var mb = minBin - 1; mb <= maxBin + 1; mb++) {
          mags[mb] = Math.sqrt(re[mb] * re[mb] + im[mb] * im[mb]);
        }

        for (var b = minBin; b <= maxBin; b++) {
          var mag = mags[b];
          if (mag <= 0) continue;
          // Count spectral peaks only - skirts and leakage smear the chroma
          if (mag < mags[b - 1] || mag < mags[b + 1]) continue;
          var freq = (b * sr) / N;
          var midi = 69 + 12 * Math.log(freq / 440) / Math.LN2;
          var pc = Math.round(midi) % 12;
          if (pc < 0) pc += 12;
          chroma[pc] += mag;
        }
      }

      var total = 0;
      for (var t = 0; t < 12; t++) total += chroma[t];
      if (total <= 0) { send({ type: 'error', message: 'detectKey: no tonal content found' }); return; }

      var scored = [];
      for (var tonic = 0; tonic < 12; tonic++) {
        scored.push({ tonic: tonic, minor: false, score: correlate(chroma, MAJOR_PROFILE, tonic) });
        scored.push({ tonic: tonic, minor: true,  score: correlate(chroma, MINOR_PROFILE, tonic) });
      }
      scored.sort(function (a, b) { return b.score - a.score; });

      var best = scored[0];
      var runnerUp = scored[1];
      // Confidence: how clearly the winner beats the next candidate, scaled to
      // a readable 0-100 with the absolute fit factored in.
      var margin = Math.max(0, best.score - runnerUp.score);
      var confidence = Math.max(0, Math.min(100, Math.round((best.score * 60) + (margin * 250))));

      send({
        type: 'key',
        key: keyName(best.tonic, best.minor),
        root: keyName(best.tonic, false),
        minor: best.minor,
        confidence: confidence
      });
    } catch (err) {
      fail('detectKey', err);
    }
  }

  // ---- Loading -------------------------------------------------------------

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function finishLoad() {
    try {
      ensureContext();
      var bytes = base64ToBytes(chunks.join(''));
      chunks = [];
      ctx.decodeAudioData(
        bytes.buffer,
        function (decoded) {
          buffer = decoded;
          processed = decoded;
          removal = { vocals: false, bass: false, drums: false, harmonic: false };
          cache = {};
          cacheOrder = [];
          cachedSamples = 0;
          stopSource();
          playing = false;
          startOffset = 0;
          rendered = decoded;         // nothing to shift yet, play it as it is
          renderedTempo = 1;
          semitones = 0;
          tempo = 1;
          send({
            type: 'loaded',
            duration: decoded.duration,
            sampleRate: decoded.sampleRate,
            channels: decoded.numberOfChannels
          });
        },
        function (err) { fail('decode', err || new Error('decodeAudioData failed')); }
      );
    } catch (err) {
      fail('load', err);
    }
  }

  // ---- Command handling ----------------------------------------------------

  function handle(msg) {
    switch (msg.type) {
      case 'load-start':
        chunks = [];
        break;
      case 'load-chunk':
        chunks.push(msg.data);
        break;
      case 'load-end':
        finishLoad();
        break;
      case 'play':
        if (!rendered) return;
        ensureContext();
        if (ctx.state === 'suspended') ctx.resume();
        startSource(startOffset);
        statusTick();
        break;
      case 'pause':
        if (!playing) return;
        startOffset = currentPosition();
        stopSource();
        playing = false;
        statusTick();
        break;
      case 'stop':
        stopSource();
        playing = false;
        startOffset = 0;
        statusTick();
        break;
      case 'seek':
        if (!rendered) return;
        if (playing) {
          startSource(msg.seconds);
        } else {
          startOffset = Math.max(0, Math.min(rendered.duration, msg.seconds));
        }
        statusTick();
        break;
      case 'set-pitch':
        var nextSemitones = Number(msg.semitones) || 0;
        if (nextSemitones === semitones) return;
        semitones = nextSemitones;
        refreshRender();
        break;
      case 'set-tempo':
        var nextTempo = Math.max(0.5, Math.min(2, Number(msg.tempo) || 1));
        if (nextTempo === tempo) return;
        tempo = nextTempo;
        refreshRender();
        break;
      case 'detect-key':
        detectKey();
        break;
      case 'analyze-stems':
        analyzeStems();
        break;
      case 'set-removal':
        var next = {
          vocals: !!msg.vocals, bass: !!msg.bass,
          drums: !!msg.drums, harmonic: !!msg.harmonic
        };
        if (next.vocals === removal.vocals && next.bass === removal.bass &&
            next.drums === removal.drums && next.harmonic === removal.harmonic) return;
        removal = next;
        var wasPlaying2 = playing;
        var posBefore = currentPosition() * renderedTempo;
        stopSource();
        playing = false;
        send({ type: 'rendering' });
        setTimeout(function () {
          try {
            applyRemoval();
            cache = {}; cacheOrder = []; cachedSamples = 0;
            rendered = renderShifted();
            renderedTempo = tempo;
            startOffset = Math.max(0, Math.min(rendered.duration, posBefore / tempo));
            send({ type: 'rendered', duration: rendered.duration });
            if (wasPlaying2) {
              if (ctx.state === 'suspended') ctx.resume();
              startSource(startOffset);
            }
            statusTick();
          } catch (err) {
            fail('removal', err);
          }
        }, 0);
        break;
      default:
        break;
    }
  }

  function onMessage(event) {
    try {
      handle(JSON.parse(event.data));
    } catch (err) {
      fail('message', err);
    }
  }

  // Android delivers to document, iOS to window - listen on both
  document.addEventListener('message', onMessage);
  window.addEventListener('message', onMessage);

  send({ type: 'ready' });
})();
</script>
</body>
</html>`
