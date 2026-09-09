#!/usr/bin/env node
// Render the real WebView synth in Chromium. No React Native device, browser
// driver, or extra npm dependencies are required (Node 22+ provides WebSocket).
// Usage: node scripts/pad-audio-check.cjs [--chrome PATH] [--source PATH] [--json PATH]
// Add --report-only to collect measurements without enforcing regressions.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { spawn } = require('node:child_process');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const sourcePath = path.resolve(option('--source', path.join(__dirname, '../lib/padEngineHtml.ts')));
const chromePath = option('--chrome', process.env.CHROME_PATH ||
  (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome'));
const reportOnly = process.argv.includes('--report-only');
const jsonPath = option('--json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Evaluate the same exported HTML used by the WebView, including its imported
// preset data. Reading a script out of raw TypeScript misses interpolations.
function createTypeScriptLoader() {
  const cache = new Map();
  function load(filename) {
    const resolved = path.resolve(filename);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const { outputText } = ts.transpileModule(readFileSync(resolved, 'utf8'), {
      fileName: resolved,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const localRequire = name => {
      assert.ok(name.startsWith('./') || name.startsWith('../'), `Unexpected engine dependency: ${name}`);
      const dependency = path.resolve(path.dirname(resolved), name);
      return load(path.extname(dependency) ? dependency : `${dependency}.ts`);
    };
    vm.runInNewContext(outputText, { module, exports: module.exports, require: localRequire }, { filename: resolved });
    return module.exports;
  }
  return load;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    socket,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out: ${method}`));
        }, 60000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
  };
}

// This function is serialized into the browser and uses native audio nodes.
async function render(engineScript, scenario) {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const sampleRate = 48000;
  const audio = new win.OfflineAudioContext(2, Math.ceil(scenario.seconds * sampleRate), sampleRate);
  const nativeResume = audio.resume.bind(audio);
  let rendering = false;
  const messages = [];
  const nodes = [];
  const oscillators = [];
  const snapshots = [];
  for (const method of ['createGain', 'createBiquadFilter', 'createOscillator', 'createStereoPanner',
    'createDynamicsCompressor', 'createConvolver']) {
    if (!audio[method]) continue;
    const create = audio[method].bind(audio);
    audio[method] = (...args) => {
      const node = create(...args);
      const record = { method, node, disconnected: false, ended: false };
      nodes.push(record);
      const disconnect = node.disconnect.bind(node);
      node.disconnect = (...destinations) => {
        record.disconnected = true;
        return disconnect(...destinations);
      };
      if (method === 'createOscillator') {
        oscillators.push(record);
        node.addEventListener('ended', () => { record.ended = true; });
      }
      return node;
    };
  }
  audio.resume = () => rendering ? nativeResume() : Promise.resolve();
  win.AudioContext = function () { return audio; };
  if (scenario.fallback) {
    Object.defineProperty(win.AudioParam.prototype, 'cancelAndHoldAtTime', { value: undefined });
  }
  let seed = 123456789;
  win.Math.random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  win.ReactNativeWebView = { postMessage: text => messages.push(JSON.parse(text)) };
  const dispatch = message => win.dispatchEvent(new win.MessageEvent('message', { data: JSON.stringify(message) }));
  const snapshot = label => snapshots.push({
    label,
    time: audio.currentTime,
    oscillatorsCreated: oscillators.length,
    oscillatorsActive: oscillators.filter(record => !record.ended).length,
    nodesConnected: nodes.filter(record => !record.disconnected).length,
    masterGain: nodes.find(record => record.method === 'createGain')?.node.gain.value ?? 0,
    voices: oscillators.filter(record => !record.ended).map(({ node }) => ({
      frequency: node.frequency.value, detune: node.detune.value, wave: node.type,
    })),
  });
  try {
    win.eval(engineScript);
    for (const message of scenario.beforeStart || []) dispatch(message);
    if (scenario.initialStart !== false) dispatch({
      type: 'start', root: scenario.root || 0, minor: !!scenario.minor,
      volume: scenario.volume ?? 1, preset: scenario.preset,
    });
    snapshot('start');
    const suspensions = (scenario.events || []).map(event => audio.suspend(event.at).then(async () => {
      snapshot(`${event.label}:before`);
      if (event.message) dispatch(event.message);
      snapshot(`${event.label}:after`);
      await nativeResume();
    }));
    rendering = true;
    const output = await audio.startRendering();
    await Promise.all(suspensions);
    // ended handlers are queued tasks; allow graph disposal to finish first.
    await new Promise(resolve => setTimeout(resolve, 0));
    snapshot('end');
    const channels = [output.getChannelData(0), output.getChannelData(1)];
    function measure(from, to) {
      const first = Math.max(2, Math.floor(from * sampleRate));
      const last = Math.min(output.length, Math.ceil(to * sampleRate));
      let peak = 0;
      let sumSquares = 0;
      let maxStep = 0;
      let maxCurvature = 0;
      let curvatureTime = 0;
      for (const data of channels) {
        for (let i = first; i < last; i++) {
          const value = data[i];
          peak = Math.max(peak, Math.abs(value));
          sumSquares += value * value;
          maxStep = Math.max(maxStep, Math.abs(value - data[i - 1]));
          const curvature = Math.abs(value - 2 * data[i - 1] + data[i - 2]);
          if (curvature > maxCurvature) {
            maxCurvature = curvature;
            curvatureTime = i / sampleRate;
          }
        }
      }
      return { peak, rms: Math.sqrt(sumSquares / ((last - first) * 2)), maxStep, maxCurvature, curvatureTime };
    }
    function spectrum() {
      // Compare normalized frequency-band energy, so presets must differ in
      // tone instead of merely having different names, levels, or phases.
      const size = 8192;
      const bands = new Array(48).fill(0);
      for (const from of [5, 5.2, 5.4, 5.6]) {
        const real = new Float64Array(size);
        const imaginary = new Float64Array(size);
        const first = Math.floor(from * sampleRate);
        for (let i = 0; i < size; i++) {
          real[i] = (channels[0][first + i] + channels[1][first + i]) *
            0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
        }
        for (let i = 1, j = 0; i < size; i++) {
          let bit = size >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) [real[i], real[j]] = [real[j], real[i]];
        }
        for (let length = 2; length <= size; length <<= 1) {
          const angle = -2 * Math.PI / length;
          const stepReal = Math.cos(angle);
          const stepImaginary = Math.sin(angle);
          for (let offset = 0; offset < size; offset += length) {
            let twiddleReal = 1;
            let twiddleImaginary = 0;
            for (let i = 0; i < length / 2; i++) {
              const a = offset + i;
              const b = a + length / 2;
              const r = real[b] * twiddleReal - imaginary[b] * twiddleImaginary;
              const im = real[b] * twiddleImaginary + imaginary[b] * twiddleReal;
              real[b] = real[a] - r;
              imaginary[b] = imaginary[a] - im;
              real[a] += r;
              imaginary[a] += im;
              const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
              twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
              twiddleReal = nextReal;
            }
          }
        }
        for (let i = 1; i < size / 2; i++) {
          const frequency = i * sampleRate / size;
          const band = Math.floor(Math.log(frequency / 40) / Math.log(8000 / 40) * bands.length);
          if (band >= 0 && band < bands.length) bands[band] += real[i] ** 2 + imaginary[i] ** 2;
        }
      }
      const total = bands.reduce((sum, value) => sum + value, 0);
      return bands.map(value => total ? value / total : 0);
    }
    return {
      name: scenario.name,
      preset: scenario.preset,
      root: scenario.root || 0,
      minor: !!scenario.minor,
      audio: measure(0, scenario.seconds),
      held: measure(5, Math.min(6, scenario.seconds)),
      tail: measure(scenario.seconds - 0.5, scenario.seconds),
      probes: (scenario.probes || []).map(at => ({ at, ...measure(at - 0.01, at + 0.05) })),
      windows: (scenario.windows || []).map(([from, to]) => ({ from, to, ...measure(from, to) })),
      snapshots,
      spectrum: scenario.fingerprint ? spectrum() : undefined,
      messages,
      errors: messages.filter(message => message.type === 'error'),
    };
  } finally {
    frame.remove();
  }
}

async function main() {
  const load = createTypeScriptLoader();
  const { PAD_ENGINE_HTML } = load(sourcePath);
  const { PAD_PRESETS, DEFAULT_PAD_PRESET } = load(path.join(path.dirname(sourcePath), 'padPresets.ts'));
  assert.equal(typeof PAD_ENGINE_HTML, 'string', 'The engine must export its WebView HTML');
  assert.ok(Array.isArray(PAD_PRESETS) && PAD_PRESETS.length >= 6, 'The engine must offer at least six presets');
  const presetIds = PAD_PRESETS.map(preset => preset.id);
  assert.equal(new Set(presetIds).size, presetIds.length, 'Preset IDs must be unique');
  assert.ok(presetIds.includes(DEFAULT_PAD_PRESET), 'The default preset must exist');
  const match = PAD_ENGINE_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'The pad engine must contain a script');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pad-audio-check-'));
  let browser;
  let cdp;
  let browserErrors = '';
  try {
    browser = spawn(chromePath, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', data => { browserErrors = (browserErrors + data).slice(-4000); });
    browser.on('error', error => { browserErrors += error.message; });
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      const activePort = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      if (activePort) { port = Number(activePort.split('\n')[0]); break; }
      if (browser.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(port, `Chrome failed to start: ${browserErrors}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(target => target.type === 'page');
    assert.ok(page, 'Chrome did not expose a page');
    cdp = await connect(page.webSocketDebuggerUrl);
    const results = [];
    async function run(scenario) {
      const result = await cdp.call('Runtime.evaluate', {
        expression: `(${render.toString()})(${JSON.stringify(match[1])}, ${JSON.stringify(scenario)})`,
        awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      const value = result.result.value;
      assert.ok(value, 'Browser returned no measurements');
      results.push(value);
      return value;
    }
    const probes = [1, 1.4, 2, 2.04, 5, 5.1, 5.2, 5.3, 5.4, 5.6, 7.6, 8.2, 10];
    const references = new Map();
    for (const preset of presetIds) {
      references.set(preset, await run({ name: `held-${preset}-reference`, preset, seconds: 11, probes, fingerprint: true }));
      for (const minor of [false, true]) {
        for (let root = 0; root < 12; root++) {
          if (root === 0 && !minor) continue;
          await run({ name: `held-${preset}-${root}-${minor ? 'minor' : 'major'}`, preset, root, minor, seconds: 6 });
        }
      }
      console.log(`Rendered all 24 chords for ${preset}.`);
    }
    const reference = references.get(DEFAULT_PAD_PRESET);
    const presetTransitions = [];
    const stoppedSelections = [];
    const ignoredSelections = [];
    for (const fallback of [false, true]) {
      const suffix = fallback ? '-fallback' : '';
      await run({ name: `volume-during-fade${suffix}`, seconds: 7, fallback, probes: [2, 2.04], events: [
        { at: 2, label: 'volume-down', message: { type: 'setVolume', volume: 0.35 } },
        { at: 2.04, label: 'volume-up', message: { type: 'setVolume', volume: 0.8 } },
      ] });
      await run({ name: `rapid-key-changes${suffix}`, seconds: 10, fallback, probes: [1, 1.4, 2], events: [
        { at: 1, label: 'key-one', message: { type: 'setKey', root: 7 } },
        { at: 1.4, label: 'key-two', message: { type: 'setKey', root: 2, minor: true } },
        { at: 2, label: 'key-three', message: { type: 'setKey', root: 9, minor: true } },
      ] });
      await run({ name: `steady-volume-change${suffix}`, seconds: 11, fallback, probes: [10], events: [
        { at: 10, label: 'volume-down', message: { type: 'setVolume', volume: 0.3 } },
      ] });
      await run({ name: `rapid-key-changes-steady${suffix}`, seconds: 10, fallback, probes: [5, 5.1],
        windows: [[4.5, 5], [5.3, 5.8]], events: [
          { at: 5, label: 'key-one', message: { type: 'setKey', root: 7 } },
          { at: 5.1, label: 'key-two', message: { type: 'setKey', root: 2, minor: true } },
        ],
      });
      for (let i = 0; i < presetIds.length; i++) {
        const preset = presetIds[(i + 1) % presetIds.length];
        const targetPreset = presetIds[i];
        const result = await run({
          name: `preset-${preset}-to-${targetPreset}${suffix}`, preset, root: 7, minor: true,
          volume: 0.37, seconds: 11, fallback, probes: [5], windows: [[4.5, 5], [5.3, 5.8]], events: [
            { at: 5, label: 'preset', message: { type: 'setPreset', preset: targetPreset } },
          ],
        });
        presetTransitions.push({ result, targetPreset, root: 7, minor: true, volume: 0.37 });
      }
      const rapid = await run({
        name: `rapid-preset-and-key-changes${suffix}`, preset: 'warm', root: 7, minor: true,
        volume: 0.37, seconds: 11, fallback, probes: [5, 5.1, 5.2, 5.3, 5.4, 5.6],
        windows: [[4.5, 5], [5.8, 6.3]], events: [
          { at: 5, label: 'prayer', message: { type: 'setPreset', preset: 'prayer' } },
          { at: 5.1, label: 'shimmer', message: { type: 'setPreset', preset: 'shimmer' } },
          { at: 5.2, label: 'strings', message: { type: 'setPreset', preset: 'strings' } },
          { at: 5.3, label: 'key', message: { type: 'setKey', root: 9, minor: true } },
          { at: 5.4, label: 'organ', message: { type: 'setPreset', preset: 'organ' } },
          { at: 5.6, label: 'praise', message: { type: 'setPreset', preset: 'praise' } },
        ],
      });
      presetTransitions.push({ result: rapid, targetPreset: 'praise', root: 9, minor: true, volume: 0.37 });
      const atomicStart = await run({
        name: `start-with-new-key-and-preset${suffix}`, preset: 'warm', volume: 0.37,
        seconds: 11, fallback, probes: [5], events: [
          { at: 5, label: 'start-new-sound', message: { type: 'start', root: 9, minor: true, preset: 'organ', volume: 0.37 } },
        ],
      });
      presetTransitions.push({ result: atomicStart, targetPreset: 'organ', root: 9, minor: true, volume: 0.37 });
      ignoredSelections.push(await run({
        name: `same-and-unknown-preset${suffix}`, preset: 'strings', seconds: 7, fallback, events: [
          { at: 1, label: 'same-preset', message: { type: 'setPreset', preset: 'strings' } },
          { at: 1.4, label: 'unknown-preset', message: { type: 'setPreset', preset: '__missing__' } },
          { at: 2, label: 'same-start', message: { type: 'start', root: 0, preset: 'strings', volume: 1 } },
          { at: 2.4, label: 'invalid-preset', message: { type: 'setPreset', preset: null } },
        ],
      }));
      stoppedSelections.push(await run({
        name: `stopped-preset-selection-and-restart${suffix}`, initialStart: false, seconds: 18, fallback,
        probes: [7.6], events: [
          { at: 0.1, label: 'stopped-select', message: { type: 'setPreset', preset: 'strings' } },
          { at: 0.2, label: 'stopped-unknown', message: { type: 'setPreset', preset: '__missing__' } },
          { at: 1, label: 'stopped-same', message: { type: 'setPreset', preset: 'strings' } },
          { at: 1.4, label: 'stopped-reselect', message: { type: 'setPreset', preset: 'organ' } },
          { at: 2, label: 'first-start', message: { type: 'start', root: 7, minor: true, volume: 0.37 } },
          { at: 7, label: 'stop', message: { type: 'stop' } },
          { at: 7.6, label: 'restart', message: { type: 'start', root: 7, minor: true, volume: 0.37 } },
          { at: 11.8, label: 'restart-settled' },
          { at: 12, label: 'final-stop', message: { type: 'stop' } },
          { at: 16, label: 'final-stopped-selection', message: { type: 'setPreset', preset: 'prayer' } },
        ],
      }));
    }
    const restart = await run({ name: 'stop-start-stop', seconds: 15, probes: [5.6, 8.2], events: [
      { at: 5, label: 'stop', message: { type: 'stop' } },
      { at: 5.6, label: 'restart', message: { type: 'start', root: 5, volume: 1 } },
      { at: 10, label: 'final-stop', message: { type: 'stop' } },
    ] });
    const repeat = await run({ name: 'repeated-same-key', seconds: 7, events: [
      { at: 1, label: 'same-key', message: { type: 'setKey', root: 0 } },
      { at: 1.4, label: 'same-start', message: { type: 'start', root: 0, volume: 1 } },
      { at: 2, label: 'same-key-again', message: { type: 'setKey', root: 0 } },
    ] });

    const failures = [];
    const check = (condition, message) => { if (!condition) failures.push(message); };
    for (const result of results) {
      check(result.errors.length === 0, `${result.name}: engine reported errors: ${JSON.stringify(result.errors)}`);
      check(result.audio.peak < 1, `${result.name}: peak ${result.audio.peak} clips`);
      if (result.name.startsWith('held')) check(result.held.rms > 0.003, `${result.name}: held chord is effectively silent`);
      for (const probe of result.probes) {
        const referenceProbe = (references.get(result.preset) || reference).probes.find(item => item.at === probe.at);
        // Curvature detects a broadband click while allowing normal waveform
        // slopes and modest harmonic changes as chords crossfade.
        const changesPreset = /^(preset-|rapid-preset-|start-with-|stopped-preset-)/.test(result.name);
        const normalCurvature = changesPreset
          ? Math.max(...Array.from(references.values(), item => item.audio.maxCurvature))
          : referenceProbe.maxCurvature;
        const ceiling = Math.max(0.0002, normalCurvature * 6);
        check(probe.maxCurvature < ceiling,
          `${result.name} at ${probe.at}s: abrupt waveform change ${probe.maxCurvature.toFixed(6)} exceeds ${ceiling.toFixed(6)}`);
      }
    }
    check(repeat.snapshots.at(-1).oscillatorsCreated === repeat.snapshots[0].oscillatorsCreated,
      'Repeated commands for the sounding key rebuild its voices');
    for (const result of results.filter(item => item.name.startsWith('rapid-key-changes'))) {
      check(result.snapshots.at(-1).oscillatorsActive === result.snapshots[0].oscillatorsActive,
        `${result.name}: retired oscillators still active`);
      check(result.snapshots.at(-1).nodesConnected === result.snapshots[0].nodesConnected,
        `${result.name}: retired audio nodes remain connected`);
    }
    for (const result of results.filter(item => item.name.startsWith('rapid-key-changes-steady'))) {
      check(result.windows[1].rms > result.windows[0].rms * 0.35,
        `${result.name}: rapid key changes cause an audible gap (${result.windows[1].rms.toFixed(4)} RMS)`);
    }
    check(restart.snapshots.at(-1).oscillatorsActive === 0, 'Stopped synth still has active oscillators');
    check(restart.tail.peak < 0.00001, 'Stopped synth still produces audio after its release');
    check(restart.snapshots.at(-1).nodesConnected < restart.snapshots[0].nodesConnected,
      'Stopped voice banks remain connected');

    const heldChord = (preset, root, minor) => results.find(result => result.name.startsWith('held') &&
      result.preset === preset && result.root === root && result.minor === minor);
    const sameVoices = (actual, expected) => JSON.stringify(actual.voices) === JSON.stringify(expected.voices);
    for (const { result, targetPreset, root, minor, volume } of presetTransitions) {
      const expected = heldChord(targetPreset, root, minor).snapshots.at(-1);
      const final = result.snapshots.at(-1);
      check(sameVoices(final, expected), `${result.name}: final sound does not preserve the requested preset/key/mode`);
      check(Math.abs(final.masterGain - expected.masterGain * volume) < 0.000001,
        `${result.name}: changing the sound changes the selected volume`);
      check(final.oscillatorsActive === expected.oscillatorsActive,
        `${result.name}: retired preset oscillators remain active`);
      check(final.nodesConnected === expected.nodesConnected,
        `${result.name}: retired preset nodes remain connected`);
      if (result.windows.length) {
        const targetRms = heldChord(targetPreset, root, minor).held.rms * volume;
        const minimum = Math.min(result.windows[0].rms, targetRms) * 0.35;
        check(result.windows[1].rms > minimum, `${result.name}: changing the sound leaves an audible gap`);
      }
      if (result.name.startsWith('start-with-')) {
        const before = result.snapshots.find(snapshot => snapshot.label === 'start-new-sound:before');
        const after = result.snapshots.find(snapshot => snapshot.label === 'start-new-sound:after');
        check(after.oscillatorsCreated - before.oscillatorsCreated === expected.oscillatorsActive,
          `${result.name}: combined start creates unnecessary intermediate voice banks`);
      }
    }
    for (const result of ignoredSelections) {
      check(result.snapshots.at(-1).oscillatorsCreated === result.snapshots[0].oscillatorsCreated,
        `${result.name}: same or unknown presets rebuild voices`);
      check(sameVoices(result.snapshots.at(-1), result.snapshots[0]),
        `${result.name}: same or unknown presets change the sounding voices`);
    }
    for (const result of stoppedSelections) {
      const firstStart = result.snapshots.find(snapshot => snapshot.label === 'first-start:before');
      check(firstStart.oscillatorsCreated === 0 && firstStart.nodesConnected === 0,
        `${result.name}: choosing a sound while stopped starts the audio engine`);
      const expected = heldChord('organ', 7, true).snapshots.at(-1);
      for (const label of ['first-start:after', 'restart-settled:after']) {
        const snapshot = result.snapshots.find(item => item.label === label);
        check(sameVoices(snapshot, expected), `${result.name}: ${label} loses the selected sound, key, or mode`);
      }
      const before = result.snapshots.find(snapshot => snapshot.label === 'final-stopped-selection:before');
      const after = result.snapshots.find(snapshot => snapshot.label === 'final-stopped-selection:after');
      check(after.oscillatorsCreated === before.oscillatorsCreated,
        `${result.name}: changing sounds after stopping starts new voices`);
      check(result.snapshots.at(-1).oscillatorsActive === 0, `${result.name}: stopped preset voices remain active`);
      check(result.tail.peak < 0.00001, `${result.name}: stopped preset still produces audio`);
    }
    const spectralDistances = [];
    for (let i = 0; i < presetIds.length; i++) {
      for (let j = i + 1; j < presetIds.length; j++) {
        const a = references.get(presetIds[i]).spectrum;
        const b = references.get(presetIds[j]).spectrum;
        const distance = a.reduce((sum, value, band) => sum + Math.abs(value - b[band]), 0) / 2;
        spectralDistances.push({ presets: [presetIds[i], presetIds[j]], distance });
        check(distance > 0.06,
          `${presetIds[i]} and ${presetIds[j]} have nearly identical normalized spectra (${distance.toFixed(4)})`);
      }
    }

    const report = { source: sourcePath, sampleRate: 48000, spectralDistances, results, failures };
    if (jsonPath) await fs.writeFile(path.resolve(jsonPath), JSON.stringify(report, null, 2) + '\n');
    const held = results.filter(result => result.name.startsWith('held'));
    console.log(`Held chords: ${held.length}, peak ${Math.max(...held.map(result => result.audio.peak)).toFixed(6)}, ` +
      `RMS ${Math.min(...held.map(result => result.held.rms)).toFixed(6)}-${Math.max(...held.map(result => result.held.rms)).toFixed(6)}.`);
    console.log(`Preset tone comparisons: ${spectralDistances.length}, minimum spectral distance ` +
      `${Math.min(...spectralDistances.map(item => item.distance)).toFixed(4)}.`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    if (jsonPath) console.log(`Measurements: ${path.resolve(jsonPath)}`);
    if (failures.length && !reportOnly) process.exitCode = 1;
    else console.log(`${reportOnly ? 'MEASURED' : 'PASS'}: ${results.length} native stereo renders; ${failures.length} regression failures.`);
  } finally {
    if (cdp) {
      await cdp.call('Browser.close').catch(() => {});
      cdp.socket.close();
    }
    if (browser && browser.exitCode === null) {
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]);
      if (browser.exitCode === null) browser.kill();
    }
    // Only remove the temporary profile created above, inside the OS temp dir.
    const relativeProfile = path.relative(path.resolve(os.tmpdir()), path.resolve(profile));
    if (!relativeProfile.startsWith('..') && !path.isAbsolute(relativeProfile) &&
      relativeProfile.startsWith('pad-audio-check-')) {
      await fs.rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
    }
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
