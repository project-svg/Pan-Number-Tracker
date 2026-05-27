// content.js — runs on ird.gov.np/pan-search/
// Signals background that the page is ready

(function() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', signal);
  } else {
    signal();
  }
  function signal() {
    chrome.runtime.sendMessage({ type: 'PAGE_READY' });
  }
})();
