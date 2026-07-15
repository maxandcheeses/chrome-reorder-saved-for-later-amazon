const STORAGE_KEY = 'sfl_settings';
const DEFAULTS = {
  bumpDelayMs: 600,
  reloadAfterApply: true
};

let order = []; // array of keys, top to bottom (may include manual reordering)
let naturalOrder = []; // array of keys in the order Amazon's page actually shows them
let itemsByKey = new Map();
let activeTabId = null;
let statusPollHandle = null;
let watchHandle = null;
let applyInProgress = false;
let loadingAll = false;

function $(id) { return document.getElementById(id); }

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}

async function getActiveTab() {
  const [tab] = await new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  return tab;
}

function renderList() {
  const listEl = $('list');
  listEl.innerHTML = '';
  order.forEach((key, idx) => {
    const item = itemsByKey.get(key);
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.key = key;

    const badge = document.createElement('input');
    badge.type = 'number';
    badge.className = 'badge';
    badge.min = '1';
    badge.max = String(order.length);
    badge.value = String(idx + 1);
    badge.title = 'Type a number to jump this item to that position';
    badge.addEventListener('mousedown', (e) => e.stopPropagation());
    badge.addEventListener('focus', () => { li.draggable = false; });
    badge.addEventListener('blur', () => { li.draggable = true; });
    badge.addEventListener('change', () => {
      const newPos = Math.min(Math.max(1, Math.round(Number(badge.value)) || (idx + 1)), order.length);
      moveKeyToPosition(key, newPos);
    });
    badge.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') badge.blur();
    });

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '⠿';

    const img = document.createElement('img');
    img.alt = '';
    if (item && item.image) {
      img.src = item.image;
    } else {
      img.style.visibility = 'hidden';
    }
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item ? item.title : key;
    title.title = item ? item.title : key;

    li.append(badge, handle, img, title);
    listEl.appendChild(li);
  });
  attachDragHandlers();
}

function moveKeyToPosition(key, newPos) {
  const fromIdx = order.indexOf(key);
  if (fromIdx === -1) return;
  order.splice(fromIdx, 1);
  order.splice(newPos - 1, 0, key);
  renderList();
  persistOrder();
}

// Saves the current manual arrangement in the content script's memory so
// it survives the popup being closed (Chrome throws away all popup JS
// state on close). Deliberately NOT chrome.storage: that would survive
// page reloads/navigation/tab close too, and a stale reorder silently
// reapplying itself after the user has navigated away and back (or the
// page reloaded) would be surprising. Keeping it in the content script's
// memory means it's naturally wiped whenever that script is torn down —
// i.e. exactly when the page is closed, reloaded, or navigated away from.
function persistOrder() {
  if (!activeTabId) return;
  const isCustom = !arraysEqual(order, naturalOrder);
  sendToTab(activeTabId, { type: 'SFL_SET_PENDING_ORDER', order: isCustom ? order : null }).catch(() => {});
  updateResetButton();
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function updateResetButton() {
  const btn = $('resetBtn');
  if (!btn) return;
  btn.disabled = arraysEqual(order, naturalOrder);
}

// Reverts to the order items actually appear in on the Amazon page,
// discarding any pending manual arrangement.
function resetOrder() {
  order = naturalOrder.slice();
  if (activeTabId) {
    sendToTab(activeTabId, { type: 'SFL_SET_PENDING_ORDER', order: null }).catch(() => {});
  }
  renderList();
  updateResetButton();
}

async function applyPendingOrder(tabId) {
  let res;
  try {
    res = await sendToTab(tabId, { type: 'SFL_GET_PENDING_ORDER' });
  } catch (err) {
    return;
  }
  const pending = res && res.order;
  if (Array.isArray(pending) && pending.length) {
    const liveSet = new Set(order);
    const pendingFiltered = pending.filter((k) => liveSet.has(k));
    const pendingSet = new Set(pendingFiltered);
    const remaining = order.filter((k) => !pendingSet.has(k));
    order = pendingFiltered.concat(remaining);
  }
}

function attachDragHandlers() {
  let dragSourceKey = null;
  const listEl = $('list');
  listEl.querySelectorAll('li').forEach((li) => {
    li.addEventListener('dragstart', () => {
      dragSourceKey = li.dataset.key;
      li.classList.add('drag-source');
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('drag-source');
      listEl.querySelectorAll('li').forEach((el) => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      const targetKey = li.dataset.key;
      if (!dragSourceKey || dragSourceKey === targetKey) return;
      const fromIdx = order.indexOf(dragSourceKey);
      const toIdx = order.indexOf(targetKey);
      if (fromIdx === -1 || toIdx === -1) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, dragSourceKey);
      renderList();
      persistOrder();
    });
  });
}

function setMsg(text, isWarning, isLoading) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('warning', !!isWarning);
  el.classList.toggle('loading', !!isLoading);
}

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function setIncompleteBanner(show) {
  $('incompleteBanner').style.display = show ? 'flex' : 'none';
}

function setLoadAllDisabled(disabled) {
  $('loadAllBtnInline').disabled = disabled;
}

// Merge a fresh snapshot from the page into our local order/metadata rather
// than blindly replacing it: newly-discovered items (from Amazon lazy-
// loading more as you scroll) are appended to the end, items no longer on
// the page are dropped, and the relative order of items we already know
// about — including any manual drag-reordering — is left untouched.
function mergeItems(items) {
  const liveKeys = items.map((i) => i.key);
  const liveSet = new Set(liveKeys);
  items.forEach((i) => itemsByKey.set(i.key, i));

  order = order.filter((k) => liveSet.has(k));
  const knownSet = new Set(order);
  const newKeys = liveKeys.filter((k) => !knownSet.has(k));
  order = order.concat(newKeys);

  naturalOrder = naturalOrder.filter((k) => liveSet.has(k)).concat(newKeys);

  return newKeys.length;
}

// Runs continuously while the popup is open (started as soon as we confirm
// we're on a cart tab with a saved-for-later section), polling for a quick
// snapshot of whatever Amazon currently has rendered. This picks up items
// that show up from the user's own manual scrolling, not just from the
// "Load all items" button.
function startWatching(tabId) {
  stopWatching();
  watchHandle = setInterval(async () => {
    if (applyInProgress) return;

    let snap;
    try {
      snap = await sendToTab(tabId, { type: 'SFL_GET_ITEMS', skipScroll: true });
    } catch (err) {
      stopWatching();
      return;
    }

    const items = (snap && snap.items) || [];
    if (items.length === 0) return;

    const added = mergeItems(items);
    if (added > 0) {
      renderList();
      updateResetButton();
    }

    if (loadingAll) {
      setMsg(`Scrolling to load all saved items… ${order.length} found so far.`, false, true);
    } else {
      setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, then Apply.`);
      setIncompleteBanner(!!(snap && snap.mayBeIncomplete));
    }
    $('applyBtn').disabled = order.length === 0;
  }, 1200);
}

function stopWatching() {
  if (watchHandle) {
    clearInterval(watchHandle);
    watchHandle = null;
  }
}

// Polls the content script's live auto-scroll progress (SFL_GET_LOAD_STATUS)
// while "Load all items" is running, so the message shows a growing count
// instead of one static string for the whole scroll. Returns a function
// that stops the polling.
function pollLoadAllStatus(tabId) {
  const handle = setInterval(async () => {
    let res;
    try {
      res = await sendToTab(tabId, { type: 'SFL_GET_LOAD_STATUS' });
    } catch (err) {
      clearInterval(handle);
      return;
    }
    const ls = res && res.loadStatus;
    if (!ls || !ls.loading) return;
    setMsg(`Scrolling through the page to load all saved items… ${ls.foundCount} found so far.`, false, true);
  }, 400);
  return () => clearInterval(handle);
}

// skipScroll=true (default, used on popup open / Refresh): quick scan of
// whatever Amazon has already rendered, no page scrolling.
// skipScroll=false (used by the "Load all items" button): scrolls the page
// to force Amazon to lazy-load every saved item first.
async function fetchItems(skipScroll) {
  setIncompleteBanner(false);
  setMsg(skipScroll ? 'Loading items from the page…' : 'Scrolling through the page to load all saved items…', false, !skipScroll);
  $('applyBtn').disabled = true;
  setLoadAllDisabled(true);

  const tab = await getActiveTab();
  if (!tab) {
    setMsg('No active tab found.');
    setLoadAllDisabled(false);
    return;
  }
  activeTabId = tab.id;

  let ping;
  try {
    ping = await sendToTab(tab.id, { type: 'SFL_PING' });
  } catch (err) {
    setMsg('Open your Amazon cart page (with "Saved for later" items) in this tab, then reopen this popup.');
    setLoadAllDisabled(false);
    return;
  }

  if (!ping || !ping.hasSavedItems) {
    setMsg('No "Saved for later" section found on this page. Scroll to it or reload, then hit Refresh.');
    setLoadAllDisabled(false);
    return;
  }

  // Keep (or start) the live background watcher going regardless of which
  // button triggered this — it's what picks up items from manual scrolling.
  startWatching(tab.id);
  loadingAll = !skipScroll;

  // While Amazon is being scrolled to force-load every item, poll the
  // content script's live scroll progress so the message updates in real
  // time instead of sitting on a single static "Scrolling…" string for
  // however long the scroll takes.
  const stopLoadStatusPoll = skipScroll ? null : pollLoadAllStatus(tab.id);

  let res;
  try {
    res = await sendToTab(tab.id, { type: 'SFL_GET_ITEMS', skipScroll });
  } catch (err) {
    setMsg(`Could not reach the page: ${err.message}`, true);
    loadingAll = false;
    if (stopLoadStatusPoll) stopLoadStatusPoll();
    setLoadAllDisabled(false);
    return;
  }
  loadingAll = false;
  if (stopLoadStatusPoll) stopLoadStatusPoll();

  const items = (res && res.items) || [];
  mergeItems(items);
  await applyPendingOrder(tab.id);

  setLoadAllDisabled(false);

  if (order.length === 0) {
    setMsg('No saved items found.');
    return;
  }

  setMsg(`${order.length} saved item(s). Drag or type a position number to reorder, then Apply.`);
  setIncompleteBanner(!!(res && res.mayBeIncomplete));
  $('applyBtn').disabled = false;
  renderList();
  updateResetButton();

  // In case a reorder from a previous popup session is still running.
  pollStatus();
}

function loadItems() {
  return fetchItems(true);
}

function loadAllItems() {
  return fetchItems(false);
}

async function applyOrder() {
  if (!activeTabId) return;
  applyInProgress = true;
  $('applyBtn').disabled = true;
  setStatus('Starting…');
  try {
    await sendToTab(activeTabId, { type: 'SFL_APPLY_ORDER', order });
  } catch (err) {
    setStatus(`Could not reach the page: ${err.message}`, true);
    $('applyBtn').disabled = false;
    applyInProgress = false;
    return;
  }
  pollStatus();
}

function pollStatus() {
  if (statusPollHandle) clearInterval(statusPollHandle);
  statusPollHandle = setInterval(async () => {
    if (!activeTabId) return;
    let res;
    try {
      res = await sendToTab(activeTabId, { type: 'SFL_GET_STATUS' });
    } catch (err) {
      clearInterval(statusPollHandle);
      applyInProgress = false;
      return;
    }
    const s = res && res.status;
    if (!s) return;
    if (s.running) {
      applyInProgress = true;
      setStatus(s.message || `Reordering ${s.current}/${s.total}…`);
      $('applyBtn').disabled = true;
    } else if (s.error) {
      applyInProgress = false;
      setStatus(s.message, true);
      $('applyBtn').disabled = false;
      clearInterval(statusPollHandle);
    } else if (s.done) {
      applyInProgress = false;
      setStatus(s.message);
      $('applyBtn').disabled = false;
      clearInterval(statusPollHandle);
      // The content script already cleared its pending order as soon as
      // SFL_APPLY_ORDER was sent — the applied order is now the page's
      // real order.
      loadItems();
    }
  }, 800);
}

function loadSettings() {
  chrome.storage.local.get(STORAGE_KEY, (res) => {
    const s = { ...DEFAULTS, ...(res[STORAGE_KEY] || {}) };
    $('delay').value = s.bumpDelayMs;
    $('reloadAfterApply').checked = s.reloadAfterApply;
  });
}

function saveSettings() {
  const s = {
    bumpDelayMs: Number($('delay').value) || DEFAULTS.bumpDelayMs,
    reloadAfterApply: $('reloadAfterApply').checked
  };
  chrome.storage.local.set({ [STORAGE_KEY]: s });
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadItems();

  $('refreshBtn').addEventListener('click', loadItems);
  $('loadAllBtnInline').addEventListener('click', loadAllItems);
  $('applyBtn').addEventListener('click', applyOrder);
  $('resetBtn').addEventListener('click', resetOrder);
  $('settingsBtn').addEventListener('click', () => {
    const panel = $('settingsPanel');
    const opening = panel.style.display !== 'block';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) {
      // Let the new height take effect before scrolling, so the settings
      // aren't cut off at the bottom of the popup.
      requestAnimationFrame(() => {
        panel.scrollIntoView({ block: 'end' });
      });
    }
  });
  $('delay').addEventListener('change', saveSettings);
  $('reloadAfterApply').addEventListener('change', saveSettings);
});

window.addEventListener('unload', () => {
  stopWatching();
  if (statusPollHandle) clearInterval(statusPollHandle);
});
