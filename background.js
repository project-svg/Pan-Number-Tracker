// background.js — Service worker for IRD PAN Checker
// ALL queue/state logic lives here so it survives popup close

let irdTabId = null;

// ── STATE (persisted to storage) ────────────────────────
const DEFAULT_STATE = {
  rows: [],
  counters: { FILER: 0, 'NON-FILER': 0, CAPTCHA: 0, ERROR: 0, PENDING: 0, SKIPPED: 0 },
  running: false,
  currentIdx: 0,
  pendingQueue: [],   // array of pan strings
  log: [],
  delaySeconds: 4
};

async function getState() {
  const s = await chrome.storage.local.get('state');
  return s.state || { ...DEFAULT_STATE };
}

async function setState(patch) {
  const current = await getState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ state: next });
  // Notify any open popups
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: next }).catch(() => {});
}

// ── MESSAGE ROUTER ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, err: e.message }));
  return true; // keep channel open for async
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

    case 'GET_STATE':
      return await getState();

    case 'START': {
      const state = await getState();
      if (state.running) return { ok: false };
      const pendingQueue = state.rows
        .filter(r => !r.skipped && r.status === 'PENDING')
        .map(r => r.pan);
      if (!pendingQueue.length) {
        await appendLog('No pending PANs to check.', 'c-x');
        return { ok: false };
      }
      await setState({ running: true, currentIdx: 0, pendingQueue });
      await appendLog(`Starting ${pendingQueue.length} PANs…`, 'c-x');
      await ensureIRDTab();
      await waitForTabLoad(irdTabId);
      await sleep(1200);
      runNext();
      return { ok: true };
    }

    case 'STOP': {
      await setState({ running: false });
      await appendLog('Stopped.', 'c-x');
      await closeIRDTab();
      return { ok: true };
    }

    case 'RESET': {
      await closeIRDTab();
      await chrome.storage.local.set({ state: { ...DEFAULT_STATE, log: [{ t: '--:--:--', msg: 'Ready.', cls: 'c-x' }] } });
      chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: { ...DEFAULT_STATE, log: [{ t: '--:--:--', msg: 'Ready.', cls: 'c-x' }] } }).catch(() => {});
      return { ok: true };
    }

    case 'LOAD_ROWS': {
      // popup parsed the Excel and sends rows + delay
      const { rows, delaySeconds } = msg;
      const counters = { FILER: 0, 'NON-FILER': 0, CAPTCHA: 0, ERROR: 0, PENDING: 0, SKIPPED: 0 };
      rows.forEach(r => {
        if (r.skipped) { counters[r.status]++; counters.SKIPPED++; }
        else counters.PENDING++;
      });
      await setState({ rows, counters, currentIdx: 0, pendingQueue: [], running: false, delaySeconds });
      await appendLog(`Loaded ${rows.length} PANs (${counters.SKIPPED} skipped, ${counters.PENDING} pending).`, 'c-x');
      return { ok: true };
    }

    case 'SET_DELAY': {
      await setState({ delaySeconds: msg.delaySeconds });
      return { ok: true };
    }

    case 'RESULT_FROM_PAGE': {
      await handleResult(msg.payload);
      return { ok: true };
    }

    case 'PAGE_READY':
      // content script signals page loaded — not needed now but kept for future
      return { ok: true };
  }
  return { ok: false, err: 'unknown message type' };
}

// ── QUEUE ENGINE ─────────────────────────────────────────
async function runNext() {
  const state = await getState();
  if (!state.running || state.currentIdx >= state.pendingQueue.length) {
    await finishChecking();
    return;
  }

  const pan = state.pendingQueue[state.currentIdx];
  await appendLog(`[${state.currentIdx + 1}/${state.pendingQueue.length}] Checking ${pan}…`, 'c-x');
  await checkPAN(pan);
}

async function handleResult(payload) {
  const { pan, status, year, remarks } = payload;
  const state = await getState();
  if (!state.running) return;

  // Update the row
  const rows = state.rows.map(r => r.pan === pan ? { ...r, status, year, remarks } : r);

  // Update counters
  const counters = { ...state.counters };
  counters.PENDING = Math.max(0, counters.PENDING - 1);
  if (status === 'FILER') counters.FILER++;
  else if (status === 'NON-FILER') counters['NON-FILER']++;
  else if (status === 'CAPTCHA') counters.CAPTCHA++;
  else counters.ERROR++;

  const colorMap = { FILER: 'c-g', 'NON-FILER': 'c-r', CAPTCHA: 'c-b', ERROR: 'c-a' };
  const label = status === 'FILER' ? `${pan} → FILER ${year ? '(' + year + ')' : ''}`
              : status === 'NON-FILER' ? `${pan} → NON-FILER`
              : status === 'CAPTCHA'   ? `${pan} → CAPTCHA — solve in IRD tab`
              : `${pan} → ERROR: ${remarks}`;

  const nextIdx = state.currentIdx + 1;
  await setState({ rows, counters, currentIdx: nextIdx });
  await appendLog(label, colorMap[status] || 'c-a');

  if (status === 'CAPTCHA') {
    // Wait 30s then continue
    await appendLog('Waiting 30s for CAPTCHA…', 'c-b');
    await sleep(30000);
    const s2 = await getState();
    if (!s2.running) return;
  } else {
    const s2 = await getState();
    const delay = (s2.delaySeconds || 4) * 1000;
    await appendLog(`Waiting ${s2.delaySeconds || 4}s…`, 'c-x');
    await sleep(delay);
  }

  const s3 = await getState();
  if (!s3.running || s3.currentIdx >= s3.pendingQueue.length) {
    await finishChecking();
    return;
  }
  runNext();
}

async function finishChecking() {
  await setState({ running: false });
  await appendLog('Done! Export results from the popup.', 'c-g');
  await closeIRDTab();
}

// ── PAN CHECK ────────────────────────────────────────────
async function checkPAN(pan, retryCount = 0) {
  // Always navigate to a fresh page before injecting
  await ensureIRDTab();
  await waitForTabLoad(irdTabId);
  // Extra settle time — IRD's JS framework needs time to mount the form
  await sleep(1500);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: irdTabId },
      func: fillAndSubmitPAN,
      args: [pan]
    });
  } catch(e) {
    if (retryCount < 2) {
      // Reload and retry up to 2 times
      await appendLog(`Injection failed for ${pan}, retrying… (${retryCount + 1}/2)`, 'c-x');
      try {
        await chrome.tabs.reload(irdTabId);
        await waitForTabLoad(irdTabId);
        await sleep(2000);
        return checkPAN(pan, retryCount + 1);
      } catch(e2) { /* fall through to error */ }
    }
    chrome.runtime.sendMessage({
      type: 'RESULT_FROM_PAGE',
      payload: { pan, status: 'ERROR', year: '', remarks: 'Script injection failed: ' + e.message }
    }).catch(() => {});
  }
}

// ── IRD TAB ──────────────────────────────────────────────
async function ensureIRDTab() {
  if (irdTabId) {
    try {
      const tab = await chrome.tabs.get(irdTabId);
      if (tab) {
        // Navigate to fresh pan-search page for each check
        await chrome.tabs.update(irdTabId, { url: 'https://ird.gov.np/pan-search/' });
        await waitForTabLoad(irdTabId);
        return;
      }
    } catch(e) { irdTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'https://ird.gov.np/pan-search/', active: false });
  irdTabId = tab.id;
  // Clean up if user closes it
  chrome.tabs.onRemoved.addListener((tid) => { if (tid === irdTabId) irdTabId = null; });
}

async function closeIRDTab() {
  if (irdTabId) {
    try { await chrome.tabs.remove(irdTabId); } catch(e) {}
    irdTabId = null;
  }
}

// ── HELPERS ──────────────────────────────────────────────
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') { resolve(); return; }
      } catch(e) { resolve(); return; }
      setTimeout(check, 300);
    };
    check();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function appendLog(msg, cls = 'c-x') {
  const state = await getState();
  const t = new Date().toTimeString().slice(0, 8);
  const log = [...(state.log || []).slice(-100), { t, msg, cls }]; // keep last 100
  await setState({ log });
}

// ── INJECTED INTO IRD PAGE ────────────────────────────────
function fillAndSubmitPAN(pan) {

  // ── Helper: normalise any fiscal-year token to canonical "YYYY/YY" format ──
  function normaliseYear(raw) {
    if (!raw) return '';
    raw = raw.trim();
    const m = raw.match(/^(\d{4})[\/\-\.](\d{2,4})$/);
    if (m) {
      const startYear = parseInt(m[1], 10);
      const suffix    = m[2];
      let endYear;
      if (suffix.length === 4) {
        endYear = parseInt(suffix, 10);
      } else if (suffix.length === 3) {
        const leadingDigit = Math.floor(startYear / 1000);
        endYear = leadingDigit * 1000 + parseInt(suffix, 10);
        if (endYear <= startYear) endYear += 100;
      } else {
        const century = Math.floor(startYear / 100) * 100;
        endYear = century + parseInt(suffix, 10);
        if (endYear <= startYear) endYear += 100;
      }
      const endSuffix = String(endYear).slice(-2);
      return `${startYear}/${endSuffix}`;
    }
    if (/^\d{4}$/.test(raw)) return raw;
    return raw;
  }

  // ── Helper: extract a fiscal year token from a single cell/string ──
  function extractYearToken(text) {
    if (!text) return '';
    if (/\d{4}[.\-]\d{2}[.\-]\d{2}/.test(text)) return '';
    const rangeMatch = text.match(/(\d{4})[\/\-\.](\d{2,4})(?![\d\/\-\.])/);
    if (rangeMatch) return normaliseYear(rangeMatch[0]);
    const sinceMatch = text.match(/(?:since|:\s*)(\d{4})\b/i);
    if (sinceMatch) return sinceMatch[1];
    const bareMatch = text.match(/\b(20[6-9]\d)\b/);
    if (bareMatch) return bareMatch[1];
    return '';
  }

  // ── Helper: extract ALL fiscal years from page text ──
  function extractYears(body) {
    const allMatches = [...body.matchAll(/\b(\d{4}[\/\-\.]\d{2,4})\b/g)].map(m => m[1]);
    const keywordMatches = [...body.matchAll(/(?:F\.?Y\.?|fiscal\s*year|year|असार|साल)\s*[:\-]?\s*(\d{4}(?:[\/\-\.]\d{2,4})?)/gi)].map(m => m[1]);
    const sinceMatches = [...body.matchAll(/(?:since|Non-filer:\s*)(\d{4})\b/gi)].map(m => m[1]);
    const tableCells = Array.from(document.querySelectorAll('td, th'))
      .map(el => el.innerText.trim())
      .filter(t => /^\d{4}[\/\-\.]\d{2,4}$/.test(t));
    const combined = [...new Set([...allMatches, ...keywordMatches, ...tableCells])];
    const rangeYears = combined.map(normaliseYear).filter(Boolean);
    const standaloneYears = sinceMatches.filter(y => !rangeYears.length);
    const all = [...rangeYears, ...standaloneYears].filter(Boolean);
    if (!all.length) return '';
    return all.sort((a, b) => yearSortKey(b) - yearSortKey(a))[0];
  }

  function yearSortKey(y) {
    if (!y) return 0;
    const m = y.match(/^(\d{4})/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // ── Helper: extract NON-FILER year from the Status cell of the YEARLY (Y) Income Tax row ──
  function extractYearFromTable() {
    let yearFromYRow = '';
    let yearFromAnyNonFilerCell = '';
    document.querySelectorAll('table tr').forEach(row => {
      const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
      if (!cells.length) return;
      const isYearlyRow = cells.some(c => c === 'Y');
      cells.forEach(cellText => {
        if (!/non-filer/i.test(cellText)) return;
        const y = extractYearToken(cellText);
        if (!y) return;
        if (isYearlyRow && !yearFromYRow) yearFromYRow = y;
        if (!yearFromAnyNonFilerCell) yearFromAnyNonFilerCell = y;
      });
    });
    return yearFromYRow || yearFromAnyNonFilerCell;
  }

  // ── Helper: count RESULT table rows (excludes nav/layout tables) ──
  // IRD page has navigation tables with few cells. A result table has
  // at least 2 columns AND 2+ data rows.
  function hasResultTable() {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.some(t => {
      const rows = t.querySelectorAll('tr');
      if (rows.length < 2) return false;
      // Must have at least 2 columns (not a single-cell layout table)
      const firstDataRow = rows[rows.length - 1];
      const cols = firstDataRow.querySelectorAll('td, th');
      return cols.length >= 2;
    });
  }

  // ── Helper: set input value in a way that works for React/Angular/plain HTML ──
  function setInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(input, value);
    ['input', 'change', 'blur', 'keyup'].forEach(evtName => {
      input.dispatchEvent(new Event(evtName, { bubbles: true }));
    });
  }

  // ── Find the PAN input field ──
  const allInputs = Array.from(document.querySelectorAll('input'));
  let panInput = allInputs.find(i => {
    const n = (i.name || i.id || i.placeholder || '').toLowerCase();
    return n.includes('pan') || n.includes('regno') || n.includes('tax') || n.includes('vat');
  });
  if (!panInput) {
    panInput = allInputs.find(i =>
      (i.type === 'text' || i.type === '' || i.type === 'number') &&
      i.offsetParent !== null && !i.hidden && !i.disabled && !i.readOnly
    );
  }
  if (!panInput) {
    chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status: 'ERROR', year: '', remarks: 'PAN input not found' } });
    return;
  }

  // Fill the value with events for both plain and framework-driven forms
  panInput.focus();
  setInputValue(panInput, pan);

  const form = panInput.closest('form') || document.querySelector('form');
  const submitBtn = form
    ? form.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"]):not([type="reset"])')
    : document.querySelector('button[type="submit"]');

  // ── RESULT DETECTION ──
  // Use a short debounce so we don't fire on intermediate DOM mutations
  let debounceTimer = null;
  let settled = false;

  function processResult() {
    if (settled) return;
    const body = document.body.innerText || '';
    const lower = body.toLowerCase();

    if (lower.includes('captcha') || lower.includes('recaptcha')) {
      settled = true;
      observer.disconnect();
      chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status: 'CAPTCHA', year: '', remarks: 'CAPTCHA required' } });
      return;
    }

    // A real result must include a keyword AND (a result table OR explicit "not found" text)
    const hasKeyword = lower.includes('filer') ||
                       /no\s+records?|not\s+found|record\s+not\s+found/i.test(body);
    const hasTable   = hasResultTable();

    if (!hasKeyword && !hasTable) return; // not ready yet

    settled = true;
    observer.disconnect();

    let status = 'ERROR';
    if (/non[\s-]?filer|no\s+records?|not\s+filed|record\s+not\s+found/i.test(body)) status = 'NON-FILER';
    else if (/\bfiler\b|\bfiled\b|return\s+filed/i.test(body)) status = 'FILER';
    else if (hasTable) status = 'FILER'; // table present but no explicit keyword — treat as FILER

    let year = '';
    if (status === 'FILER') {
      year = extractYearFromTable() || extractYears(body);
    } else if (status === 'NON-FILER') {
      year = extractYearFromTable();
      if (!year) {
        const notFoundMatch = body.match(/(?:not\s+found|no\s+record)[^\n]*?(\d{4}(?:[\/\-]\d{2,4})?)/i);
        if (notFoundMatch) year = normaliseYear(notFoundMatch[1]);
      }
      if (!year) year = extractYears(body);
    }

    const remarks = status === 'NON-FILER' && year ? `No filing found for FY ${year}` : '';
    chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status, year, remarks } });
  }

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    // 600ms debounce — wait for DOM to finish updating before reading result
    debounceTimer = setTimeout(processResult, 600);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Hard timeout: 18 seconds (up from 10s — IRD site is slow)
  setTimeout(() => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    clearTimeout(debounceTimer);

    const body = document.body.innerText || '';
    const lower = body.toLowerCase();

    if (lower.includes('captcha')) {
      chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status: 'CAPTCHA', year: '', remarks: 'CAPTCHA required' } });
      return;
    }

    // Last-ditch scrape on timeout
    if (lower.includes('filer') || /no\s+records?|not\s+found/i.test(body)) {
      const status = /non[\s-]?filer|no\s+records?|not\s+filed|record\s+not\s+found/i.test(body) ? 'NON-FILER'
                   : /\bfiler\b|\bfiled\b/i.test(body) ? 'FILER' : 'ERROR';
      const allYears = [...body.matchAll(/\b(\d{4}[\/\-]\d{2,4})\b/g)].map(m => normaliseYear(m[1]));
      const year = [...new Set(allYears)].filter(Boolean).sort((a, b) => {
        const ya = parseInt(a), yb = parseInt(b);
        return yb - ya;
      })[0] || '';
      const remarks = status === 'NON-FILER' && year ? `No filing found for FY ${year}` : (status === 'ERROR' ? 'Timeout — result unclear' : '');
      chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status, year, remarks } });
    } else {
      chrome.runtime.sendMessage({ type: 'RESULT_FROM_PAGE', payload: { pan, status: 'ERROR', year: '', remarks: 'Timeout — no result after 18s' } });
    }
  }, 18000);

  // Small delay before submitting to let the observer settle
  setTimeout(() => {
    if (submitBtn) submitBtn.click();
    else if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
  }, 200);
}
