// CodeCanvas panel for Excalidraw
// A floating, draggable, resizable code editor + live preview that syncs
// across everyone viewing the same Excalidraw room, via a small external
// relay server (see relay-server/README.md). Falls back to local-only mode
// (localStorage only, no cross-browser sync) if the relay isn't reachable.
(function () {
  "use strict";

  // ---- Configuration ---------------------------------------------------
  // Set this to your deployed relay's wss:// URL. See relay-server/README.md.
  const RELAY_URL = "wss://proud-james-criteria-obviously.trycloudflare.com";

  const DEFAULT_CODE =
    "<!DOCTYPE html>\n<html>\n<head>\n  <title>Hello</title>\n  <style>\n    body { font-family: sans-serif; padding: 1rem; background: #f5f5f5; }\n    h1 { color: #333; }\n  </style>\n</head>\n<body>\n  <h1>Collab Code!</h1>\n  <p>Edit and everyone in this room sees it live.</p>\n  <script>\n    console.log('Hello from CodeCanvas');\n  <\/script>\n</body>\n</html>";

  const BROADCAST_DEBOUNCE_MS = 350;
  const REMOTE_SUPPRESS_WINDOW_MS = 1200; // ignore inbound updates this soon after local typing
  const RECONNECT_BASE_DELAY_MS = 1000;
  const RECONNECT_MAX_DELAY_MS = 15000;

  // ---- Room identity ------------------------------------------------------
  // Excalidraw puts the room id + encryption key in the URL hash, e.g.
  // #room=abc123,someKey. Every collaborator in the same room has the same
  // hash, so we reuse it directly as our own relay's room key. If there's no
  // hash, the user isn't in a shared room - panel still works, just local.
  function getRoomId() {
    const hash = window.location.hash || "";
    if (hash.length > 1) return hash.slice(1);
    return null;
  }

  const roomId = getRoomId();
  const storageKey = "codecanvas:" + (roomId || "local");
  const clientId = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : "c" + Math.random().toString(36).slice(2);

  // ---- State ---------------------------------------------------------------
  let panelEl = null;
  let editorEl = null;
  let previewEl = null;
  let statusEl = null;
  let gutterEl = null;
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let reconnectTimer = null;
  let broadcastTimer = null;
  let lastLocalEditAt = 0;
  let currentCode = loadCachedCode() || DEFAULT_CODE;

  // ---- Local cache (instant restore on refresh, works even with no relay) -
  function loadCachedCode() {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  }

  function saveCachedCode(code) {
    try {
      window.localStorage.setItem(storageKey, code);
    } catch {
      /* ignore quota/availability errors */
    }
  }

  // ---- Build the floating toggle button (sits next to Excalidraw's own UI) -
  function createToggleButton() {
    const btn = document.createElement("button");
    btn.id = "cc-toggle-launcher";
    btn.type = "button";
    btn.title = "Toggle Code Canvas";
    btn.innerHTML = '<span style="font-family:monospace">&lt;/&gt;</span> Code';
    btn.addEventListener("click", () => {
      if (!panelEl) {
        buildPanel();
      }
      panelEl.classList.toggle("cc-hidden");
    });
    document.body.appendChild(btn);
  }

  // ---- Build the panel itself -----------------------------------------------
  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "cc-panel";
    panelEl.innerHTML = `
      <div id="cc-header">
        <span id="cc-title">&lt;/&gt; Code Canvas</span>
        <span id="cc-status">local only</span>
        <button id="cc-min-btn" title="Collapse">_</button>
        <button id="cc-close-btn" title="Close">&times;</button>
      </div>
      <div id="cc-body">
        <div id="cc-editor-pane">
          <div id="cc-editor-wrap">
            <div id="cc-gutter"></div>
            <textarea id="cc-editor" spellcheck="false" placeholder="HTML / CSS / JS goes here..."></textarea>
          </div>
        </div>
        <div id="cc-preview-pane">
          <div id="cc-preview-header">
            <span>Preview</span>
            <button id="cc-run-btn">&#9654; Run</button>
          </div>
          <iframe id="cc-preview" sandbox="allow-scripts allow-modals"></iframe>
        </div>
      </div>
      <div id="cc-resize-handle" title="Resize"></div>
    `;
    document.body.appendChild(panelEl);
    injectStyles();

    editorEl = panelEl.querySelector("#cc-editor");
    previewEl = panelEl.querySelector("#cc-preview");
    statusEl = panelEl.querySelector("#cc-status");
    gutterEl = panelEl.querySelector("#cc-gutter");

    const runBtn = panelEl.querySelector("#cc-run-btn");
    const minBtn = panelEl.querySelector("#cc-min-btn");
    const closeBtn = panelEl.querySelector("#cc-close-btn");
    const header = panelEl.querySelector("#cc-header");
    const resizeHandle = panelEl.querySelector("#cc-resize-handle");

    editorEl.value = currentCode;
    updateGutter();
    runPreview();

    editorEl.addEventListener("input", onLocalEdit);
    editorEl.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const s = editorEl.selectionStart;
        const en = editorEl.selectionEnd;
        editorEl.value =
          editorEl.value.substring(0, s) + "  " + editorEl.value.substring(en);
        editorEl.selectionStart = editorEl.selectionEnd = s + 2;
        onLocalEdit();
      }
    });

    runBtn.addEventListener("click", runPreview);
    minBtn.addEventListener("click", () => panelEl.classList.toggle("cc-collapsed"));
    closeBtn.addEventListener("click", () => panelEl.classList.add("cc-hidden"));

    makeDraggable(header, panelEl);
    makeResizable(resizeHandle, panelEl);

    connectRelay();
  }

  function injectStyles() {
    if (document.getElementById("cc-styles")) return;
    const style = document.createElement("style");
    style.id = "cc-styles";
    style.textContent = `
      #cc-toggle-launcher {
        position: fixed; top: 12px; right: 12px; z-index: 1000000;
        background: #fff; color: #1e1e1e; border: 1px solid #e0e0e0;
        border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 600;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,0.15);
        display: flex; align-items: center; gap: 6px;
      }
      #cc-toggle-launcher:hover { background: #f5f5f5; }
      html.dark #cc-toggle-launcher { background: #232329; color: #e3e3e8; border-color: #3a3a42; }

      #cc-panel {
        position: fixed; top: 70px; right: 20px; width: 720px; height: 440px;
        min-width: 380px; min-height: 220px;
        background: #1e1e1e; border: 1px solid #333; border-radius: 10px;
        z-index: 999999; display: flex; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 8px 30px rgba(0,0,0,0.45); overflow: hidden;
      }
      #cc-panel.cc-hidden { display: none; }
      #cc-panel.cc-collapsed { height: 38px !important; }
      #cc-panel.cc-collapsed #cc-body,
      #cc-panel.cc-collapsed #cc-resize-handle { display: none; }

      #cc-header {
        display: flex; align-items: center; padding: 6px 10px;
        background: #2d2d2d; cursor: move; flex-shrink: 0; gap: 8px;
        user-select: none; border-bottom: 1px solid #333;
      }
      #cc-title { font-size: 12px; font-weight: 700; color: #ff6b6b; }
      #cc-status {
        font-size: 10px; padding: 2px 7px; border-radius: 10px;
        background: #3a3a3a; color: #999;
      }
      #cc-status.cc-live { background: #1a3a1a; color: #4ade80; }
      #cc-status.cc-connecting { background: #3a3320; color: #f9e2af; }
      #cc-header button {
        background: none; border: none; color: #888; cursor: pointer;
        font-size: 14px; padding: 0 5px; line-height: 1;
      }
      #cc-header button:hover { color: #fff; }
      #cc-close-btn { margin-left: auto; }

      #cc-body { flex: 1; display: flex; overflow: hidden; min-height: 0; }
      #cc-editor-pane { flex: 1; display: flex; min-width: 0; border-right: 1px solid #333; }
      #cc-editor-wrap { flex: 1; display: flex; overflow: hidden; min-height: 0; }
      #cc-gutter {
        width: 38px; background: #1e1e1e; color: #555; text-align: right;
        padding: 8px 4px; font-family: 'Cascadia Code', 'Courier New', monospace;
        font-size: 12px; line-height: 1.5; overflow: hidden; user-select: none;
        flex-shrink: 0; border-right: 1px solid #2a2a2a;
      }
      #cc-gutter div { padding-right: 4px; }
      #cc-editor {
        flex: 1; background: transparent; border: none; outline: none; resize: none;
        color: #d4d4d4; font-family: 'Cascadia Code', 'Courier New', monospace;
        font-size: 12px; line-height: 1.5; padding: 8px 8px; tab-size: 2;
        white-space: pre; overflow: auto;
      }
      #cc-preview-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      #cc-preview-header {
        display: flex; align-items: center; padding: 5px 10px;
        background: #252525; border-bottom: 1px solid #333; flex-shrink: 0;
      }
      #cc-preview-header span { font-size: 11px; color: #888; }
      #cc-run-btn {
        margin-left: auto; background: #2ea043; border: none; color: #fff;
        padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 11px;
      }
      #cc-run-btn:hover { background: #3fb950; }
      #cc-preview { flex: 1; width: 100%; border: none; background: #fff; }

      #cc-resize-handle {
        position: absolute; bottom: 0; right: 0; width: 16px; height: 16px;
        cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 50%, #555 50%);
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Editor / preview behaviour ----------------------------------------
  function updateGutter() {
    const lineCount = (editorEl.value.match(/\n/g) || []).length + 1;
    let html = "";
    for (let i = 1; i <= lineCount; i++) html += "<div>" + i + "</div>";
    gutterEl.innerHTML = html;
  }

  function runPreview() {
    previewEl.srcdoc = editorEl.value;
  }

  function onLocalEdit() {
    updateGutter();
    lastLocalEditAt = Date.now();
    currentCode = editorEl.value;
    saveCachedCode(currentCode);

    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      runPreview();
      sendUpdate(currentCode);
    }, BROADCAST_DEBOUNCE_MS);
  }

  function applyRemoteCode(code) {
    if (code == null || code === currentCode) return;
    // Don't clobber someone mid-keystroke - their next edit will broadcast
    // and reconcile shortly after anyway.
    if (Date.now() - lastLocalEditAt < REMOTE_SUPPRESS_WINDOW_MS) return;

    const hadFocus = document.activeElement === editorEl;
    currentCode = code;
    editorEl.value = code;
    saveCachedCode(code);
    updateGutter();
    runPreview();
    if (hadFocus) {
      editorEl.selectionStart = editorEl.selectionEnd = editorEl.value.length;
    }
  }

  // ---- Dragging / resizing -------------------------------------------------
  function makeDraggable(handleEl, targetEl) {
    let startX, startY, startLeft, startTop, dragging = false;
    handleEl.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = targetEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      targetEl.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      targetEl.style.left = startLeft + (e.clientX - startX) + "px";
      targetEl.style.top = startTop + (e.clientY - startY) + "px";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function makeResizable(handleEl, targetEl) {
    let startX, startY, startW, startH, resizing = false;
    handleEl.addEventListener("mousedown", (e) => {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = targetEl.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener("mousemove", (e) => {
      if (!resizing) return;
      targetEl.style.width = Math.max(380, startW + (e.clientX - startX)) + "px";
      targetEl.style.height = Math.max(220, startH + (e.clientY - startY)) + "px";
    });
    window.addEventListener("mouseup", () => {
      resizing = false;
    });
  }

  // ---- Relay connection ------------------------------------------------------
  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = cls || "";
  }

  function connectRelay() {
    if (!roomId) {
      setStatus("local only (no room)", "");
      return;
    }
    if (!RELAY_URL || RELAY_URL.includes("YOUR-DEPLOYED-HOST-HERE")) {
      setStatus("local only (relay not configured)", "");
      return;
    }

    setStatus("connecting\u2026", "cc-connecting");
    try {
      ws = new WebSocket(RELAY_URL);
    } catch {
      setStatus("local only (relay unreachable)", "");
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_BASE_DELAY_MS;
      ws.send(JSON.stringify({ type: "join", room: roomId }));
      setStatus("live", "cc-live");
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "init") {
        // Server's stored code wins over our local cache only if it actually
        // has something - otherwise keep whatever we restored from cache.
        if (msg.code != null) applyRemoteCode(msg.code);
        setStatus("live", "cc-live");
      } else if (msg.type === "update") {
        applyRemoteCode(msg.code);
      } else if (msg.type === "peers") {
        const n = msg.count || 1;
        setStatus("live \u00b7 " + n + (n === 1 ? " here" : " here"), "cc-live");
      }
    });

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => {
      setStatus("reconnecting\u2026", "cc-connecting");
    });
  }

  function scheduleReconnect() {
    setStatus("reconnecting\u2026", "cc-connecting");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.6, RECONNECT_MAX_DELAY_MS);
      connectRelay();
    }, reconnectDelay);
  }

  function sendUpdate(code) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "update", room: roomId, code }));
    }
  }

  // ---- Fix the green dot in Excalidraw's own toolbar --------
  // The compiled bundle has a green dot that opens sandbox.html (now deleted).
  // We rename it, change its icon, and wire it to our panel instead.
  // Uses event delegation so it survives React re-renders.
  let greenDotDelegationWired = false;

  function fixGreenDot() {
    // Find the green dot label/button (original title or already-renamed)
    const labels = document.querySelectorAll(
      'label[title="Open Code Sandbox"], label[title="Code Canvas"]'
    );
    let found = false;
    for (const label of labels) {
      found = true;
      label.title = "Code Canvas";
      const btn = label.querySelector("button");
      if (btn) {
        btn.setAttribute("aria-label", "Code Canvas");
        // Replace the green circle with a </> icon (if not already done)
        const svg = btn.querySelector("svg");
        if (svg && !svg.innerHTML.includes("&lt;/&gt;")) {
          svg.innerHTML = `
            <text x="8" y="12" text-anchor="middle" font-size="10"
              font-family="monospace" font-weight="bold" fill="currentColor">&lt;/&gt;</text>
          `;
        }
      }
    }
    // Wire one global delegation listener on body (capture phase, survives React)
    if (found && !greenDotDelegationWired) {
      greenDotDelegationWired = true;
      document.body.addEventListener(
        "click",
        (e) => {
          // Check if the click landed on or inside the code canvas button
          const target = e.target;
          const btn = target.closest('button[aria-label="Code Canvas"]');
          if (btn) {
            e.preventDefault();
            e.stopPropagation();
            if (!panelEl) {
              buildPanel();
            }
            panelEl.classList.toggle("cc-hidden");
          }
        },
        true // capture phase — fires before React's synthetic events
      );
    }
  }

  // ---- Boot -----------------------------------------------------------------
  // Excalidraw's React SPA aggressively re-renders its DOM, especially when
  // joining a room ("Loading scene…" phase). We use a resilient polling loop
  // that re-injects the button any time it disappears, even across multiple
  // React re-renders.
  function ensureInject() {
    if (!document.getElementById("cc-toggle-launcher")) {
      createToggleButton();
    }
    fixGreenDot();
    // If the panel was built but disappeared, reset so next click rebuilds it
    if (panelEl && !document.body.contains(panelEl)) {
      panelEl = null;
      editorEl = null;
      previewEl = null;
      statusEl = null;
      gutterEl = null;
    }
  }

  // Initial injection after DOM is ready
  function boot() {
    ensureInject();
    // Poll every 500ms — survives React re-rendering DOM at any point
    setInterval(ensureInject, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
