// Control bar: switch between live headset and recorded playback.
//
// Kept separate from sketch.js so the visualization stays purely about turning
// numbers into pixels. sketch.js reads window.appState for display only.

window.appState = { mode: 'live', recording: {}, playback: {} };

(() => {
  const $ = (id) => document.getElementById(id);
  const modeEl = $('mode'), msgEl = $('msg');
  const btnLive = $('btnLive'), btnRec = $('btnRec'), btnPlay = $('btnPlay'), btnLoop = $('btnLoop');
  const btnSim = $('btnSim');
  const filesEl = $('files'), recInfo = $('recinfo'), playInfo = $('playinfo');

  let loop = false;
  let recording = false;
  let playing = false;

  const say = (t, ms = 3000) => {
    msgEl.textContent = t;
    if (ms) setTimeout(() => { if (msgEl.textContent === t) msgEl.textContent = ''; }, ms);
  };

  const post = async (url, body) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  };

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  async function refreshList(selectFile) {
    const { recordings } = await (await fetch('/api/recordings')).json();
    const current = selectFile || filesEl.value;
    filesEl.innerHTML = '<option value="">— recordings —</option>';
    for (const r of recordings) {
      const o = document.createElement('option');
      o.value = r.file;
      o.textContent = `${r.file.replace(/\.jsonl$/, '')}  (${Math.round(r.bytes / 1024)} KB)`;
      filesEl.appendChild(o);
    }
    if (current) filesEl.value = current;
    btnPlay.disabled = !filesEl.value;
  }

  btnLive.onclick = async () => {
    await post('/api/live');
    say('switched to live headset');
  };

  btnSim.onclick = async () => {
    if (window.appState.mode === 'simulated') { await post('/api/live'); return; }
    await post('/api/simulate');
    say('simulated signal — synthetic, not a real recording', 5000);
  };

  btnRec.onclick = async () => {
    if (!recording) {
      const r = await post('/api/record/start');
      if (!r.ok) return say(r.error || 'could not start recording');
      say(`recording to ${r.file}`);
    } else {
      const r = await post('/api/record/stop');
      if (r.ok) {
        say(`saved ${r.file} — ${fmt(r.ms)}, ${Math.round(r.bytes / 1024)} KB`, 6000);
        refreshList(r.file);
      }
    }
  };

  btnPlay.onclick = async () => {
    if (playing) { await post('/api/live'); return; }
    if (!filesEl.value) return say('pick a recording first');
    const r = await post('/api/play', { file: filesEl.value, loop });
    if (!r.ok) return say(r.error || 'could not play');
    say(`playing ${r.file} (${fmt(r.durationMs)})`);
  };

  btnLoop.onclick = () => {
    loop = !loop;
    btnLoop.classList.toggle('on', loop);
    if (playing) post('/api/play', { file: filesEl.value, loop });
  };

  filesEl.onchange = () => { btnPlay.disabled = !filesEl.value; };

  // The server pushes state on the same WebSocket the sketch uses; this just
  // reflects it into the controls.
  window.applyState = (s) => {
    window.appState = s;
    recording = s.recording && s.recording.active;
    playing = s.playback && s.playback.active;

    const LABEL = { playback: 'PLAYBACK', simulated: 'SIMULATED', live: 'LIVE' };
    modeEl.textContent = LABEL[s.mode] || 'LIVE';
    modeEl.className = s.mode || 'live';

    const sim = s.mode === 'simulated';
    btnSim.textContent = sim ? '■ Stop sim' : 'Simulate';
    btnSim.classList.toggle('on', sim);

    btnRec.textContent = recording ? '■ Stop' : '● Record';
    btnRec.classList.toggle('rec', recording);
    btnRec.disabled = s.mode !== 'live';
    recInfo.innerHTML = recording
      ? `<span id="recdot">●</span> ${fmt(s.recording.ms)} · ${Math.round(s.recording.bytes / 1024)} KB`
      : '';

    btnPlay.textContent = playing ? '■ Stop' : '▶ Play';
    btnPlay.disabled = !playing && !filesEl.value;
    playInfo.textContent = playing
      ? `${fmt(s.playback.posMs)} / ${fmt(s.playback.durationMs)}`
      : '';
    btnLoop.classList.toggle('on', loop);
  };

  refreshList();
})();
