// popup.js — Stateless UI. All state lives in background.js via chrome.storage.

// ── INIT ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load current state from background on open
  const state = await sendMsg({ type: 'GET_STATE' });
  if (state) applyState(state);

  // Listen for live updates while popup is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') applyState(msg.state);
  });
});

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

// ── APPLY STATE TO UI ─────────────────────────────────
function applyState(state) {
  if (!state) return;

  // Stats
  const c = state.counters || {};
  document.getElementById('c-f').textContent  = c.FILER || 0;
  document.getElementById('c-nf').textContent = c['NON-FILER'] || 0;
  document.getElementById('c-c').textContent  = c.CAPTCHA || 0;
  document.getElementById('c-e').textContent  = c.ERROR || 0;
  document.getElementById('c-p').textContent  = c.PENDING || 0;

  // Progress bar
  const rows = state.rows || [];
  const done = (c.FILER || 0) + (c['NON-FILER'] || 0) + (c.CAPTCHA || 0) + (c.ERROR || 0) + (c.SKIPPED || 0);
  const pct = rows.length ? (done / rows.length * 100) : 0;
  document.getElementById('prog-bar').style.width = pct + '%';

  // Buttons
  const running = state.running;
  const hasRows = rows.length > 0;
  document.getElementById('btn-start').disabled = running || !hasRows;
  document.getElementById('btn-stop').disabled  = !running;
  document.getElementById('btn-dl').disabled    = !hasRows;

  // File name
  if (state.fileName) document.getElementById('file-name').textContent = state.fileName;

  // Log
  renderLog(state.log || []);

  // Results
  renderResults(rows);

  // CAPTCHA notice
  const hasCaptcha = (state.log || []).slice(-3).some(l => l.cls === 'c-b' && l.msg.includes('CAPTCHA'));
  if (running && hasCaptcha) showCaptchaNotice();
  else hideCaptchaNotice();
}

// ── TABS ───────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── FILE UPLOAD ────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag'); processFile(e.dataTransfer.files[0]); });
document.getElementById('file-input').addEventListener('change', e => processFile(e.target.files[0]));

function processFile(file) {
  if (!file) return;
  document.getElementById('file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const panColName = document.getElementById('pan-col').value.trim() || 'PAN_NUMBER';
      const wsName = wb.SheetNames.find(n => n.toLowerCase().includes('pan')) || wb.SheetNames[0];
      const ws = wb.Sheets[wsName];
      const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!data.length) { localLog('File empty or unreadable.', 'c-a'); return; }

      const headers = Object.keys(data[0]);
      const panHeader = headers.find(h => h.trim().toUpperCase() === panColName.toUpperCase())
                     || headers.find(h => h.toUpperCase().includes('PAN'));

      if (!panHeader) {
        localLog(`Column "${panColName}" not found. Available: ${headers.join(', ')}`, 'c-a');
        return;
      }

      const delaySeconds = parseFloat(document.getElementById('delay-s').value) || 4;

      const rows = data.map((row, i) => {
        const pan = String(row[panHeader] || '').trim();
        const existing = String(row['FILING_STATUS'] || '').trim().toUpperCase();
        const alreadyDone = existing === 'FILER' || existing === 'NON-FILER';
        return {
          idx: i, pan,
          status: alreadyDone ? existing : 'PENDING',
          year: row['FILER_YEAR'] || '',
          remarks: row['REMARKS'] || '',
          skipped: alreadyDone
        };
      }).filter(r => r.pan && r.pan !== 'nan' && r.pan !== 'undefined');

      await sendMsg({ type: 'LOAD_ROWS', rows, fileName: file.name, delaySeconds });
    } catch(err) {
      localLog('Parse error: ' + err.message, 'c-a');
    }
  };
  reader.readAsBinaryString(file);
}

// ── LOG ────────────────────────────────────────────────
function renderLog(logEntries) {
  const box = document.getElementById('log');
  box.innerHTML = logEntries.map(e =>
    `<div class="log-line"><span class="log-t">${e.t}</span><span class="${e.cls}">${e.msg}</span></div>`
  ).join('');
  box.scrollTop = box.scrollHeight;
}

// For local parse errors before state is loaded
function localLog(msg, cls = 'c-x') {
  const box = document.getElementById('log');
  const t = new Date().toTimeString().slice(0, 8);
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-t">${t}</span><span class="${cls}">${msg}</span>`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── RESULTS ────────────────────────────────────────────
function renderResults(rows) {
  const list = document.getElementById('results-list');
  if (!rows || !rows.length) { list.innerHTML = '<div class="empty">No results yet. Run a check first.</div>'; return; }
  list.innerHTML = rows.map(r => `
    <div class="result-row">
      <div>
        <div class="r-pan">${r.pan}</div>
        <div class="r-year">${r.year || (r.skipped ? 'skipped' : '—')}</div>
      </div>
      <span class="tag ${tagClass(r.status)}">${r.status}</span>
    </div>
  `).join('');
}

function tagClass(s) {
  return { FILER: 'tag-f', 'NON-FILER': 'tag-nf', CAPTCHA: 'tag-c', ERROR: 'tag-e' }[s] || 'tag-p';
}

// ── CAPTCHA NOTICE ─────────────────────────────────────
function showCaptchaNotice() {
  document.getElementById('captcha-notice').style.display = 'block';
  // Set up tab link
  chrome.tabs.query({ url: 'https://ird.gov.np/pan-search/*' }, tabs => {
    if (tabs[0]) {
      document.getElementById('tab-hint').onclick = () => chrome.tabs.update(tabs[0].id, { active: true });
    }
  });
}
function hideCaptchaNotice() {
  document.getElementById('captcha-notice').style.display = 'none';
}

// ── EXPORT ────────────────────────────────────────────
async function exportExcel() {
  const state = await sendMsg({ type: 'GET_STATE' });
  if (!state || !state.rows.length) return;
  const { rows, counters } = state;

  const wb = XLSX.utils.book_new();
  const data = rows.map((r, i) => ({
    'S.N.': i + 1,
    'PAN_NUMBER': r.pan,
    'FILING_STATUS': r.status,
    'FILER_YEAR':     r.status === 'FILER'     ? (r.year || '') : '',
    'NON_FILER_YEAR': r.status === 'NON-FILER' ? (r.year || '') : '',
    'REMARKS': r.remarks || ''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 5 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'PAN Filing Status');

  const sum = [
    ['IRD Nepal PAN Filing Status Report'],
    ['Generated:', new Date().toLocaleString('en-NP')], [],
    ['Category', 'Count'],
    ['Total PANs', rows.length],
    ['Filer', counters.FILER || 0],
    ['Non-Filer', counters['NON-FILER'] || 0],
    ['CAPTCHA Required', counters.CAPTCHA || 0],
    ['Error', counters.ERROR || 0],
    ['Skipped (pre-filled)', counters.SKIPPED || 0],
    [],
    ['Note: NON_FILER_YEAR column shows the fiscal year IRD checked for non-filers.'],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(sum);
  ws2['!cols'] = [{ wch: 24 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

  const d = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `PAN_Filing_Status_${d}.xlsx`);
}

// ── BUTTONS ────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', async () => {
  const delay = parseFloat(document.getElementById('delay-s').value) || 4;
  await sendMsg({ type: 'SET_DELAY', delaySeconds: delay });
  await sendMsg({ type: 'START' });
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  await sendMsg({ type: 'STOP' });
});

document.getElementById('btn-dl').addEventListener('click', exportExcel);

document.getElementById('btn-reset').addEventListener('click', async () => {
  const state = await sendMsg({ type: 'GET_STATE' });
  if (state && state.running) { localLog('Stop first.', 'c-a'); return; }
  await sendMsg({ type: 'RESET' });
  document.getElementById('file-input').value = '';
  document.getElementById('file-name').textContent = 'No file loaded';
});
