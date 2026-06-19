// CodeCanvas panel for Excalidraw
// Syncs code via Excalidraw's OWN collaboration socket — no relay server needed.
// Stores code as a hidden text element in the scene, and Excalidraw's built-in
// collaboration (room sync) carries it to every collaborator for free.
//
// NO DEPENDENCIES. NO RELAY SERVER. LIVES FOREVER ON GITHUB PAGES.
(function () {
  "use strict";

  const DEFAULT_CODE =
    "<!DOCTYPE html>\n<html>\n<head>\n  <title>Hello</title>\n  <style>\n    body { font-family: sans-serif; padding: 1rem; background: #f5f5f5; }\n    h1 { color: #333; }\n  </style>\n</head>\n<body>\n  <h1>Collab Code!</h1>\n  <p>Edit and everyone in this room sees it live.</p>\n  <script>\n    console.log('Hello from CodeCanvas');\n  <\/script>\n</body>\n</html>";

  const CODE_ELEMENT_ID = "__codecanvas__";
  const POLL_INTERVAL_MS = 800;
  const REMOTE_SUPPRESS_WINDOW_MS = 1200;

  // ---- State ---------------------------------------------------------------
  let excalidrawAPI = null;
  let getElements = null;
  let panelEl = null;
  let editorEl = null;
  let previewEl = null;
  let statusEl = null;
  let gutterEl = null;
  let lastLocalEditAt = 0;
  let knownCodeHash = 0;

  // ---- Find Excalidraw's API via React fiber -------------------------------
  function findExcalidrawAPI() {
    const root = document.getElementById("root");
    if (!root) return false;

    // Find the React fiber/container key
    const containerKey = Object.keys(root).find((k) =>
      k.startsWith("__reactContainer$")
    );
    if (!containerKey) return false;

    const seen = new WeakSet();
    let foundAPI = null;
    let foundElements = null;

    function walk(fiber) {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);

      const name =
        fiber.elementType?.name ||
        fiber.elementType?.displayName ||
        "";

      // Check for ExcalidrawElementsContext — holds the elements accessor
      if (
        name === "ExcalidrawElementsContext" &&
        fiber.child?.memoizedProps?.value
      ) {
        const val = fiber.child.memoizedProps.value;
        if (val && val.getElementsIncludingDeleted) {
          foundElements = val;
        }
      }

      // Check for ExcalidrawAPIContext — holds updateScene and other methods
      if (
        name === "ExcalidrawAPIContext" &&
        fiber.child?.memoizedProps?.value
      ) {
        const val = fiber.child.memoizedProps.value;
        if (val && val.updateScene) {
          foundAPI = val;
        }
      }

      let child = fiber.child;
      while (child) {
        walk(child);
        child = child.sibling;
      }
    }

    walk(root[containerKey]);

    if (foundAPI && foundElements) {
      excalidrawAPI = foundAPI;
      // Use the context's getElementsIncludingDeleted to read elements
      // (the elements array reference changes on every update)
      getElements = () => {
        // Re-walk to get latest elements context reference
        const seen2 = new WeakSet();
        let elementsCtx = null;
        function walk2(f) {
          if (!f || seen2.has(f)) return;
          seen2.add(f);
          const n =
            f.elementType?.name || f.elementType?.displayName || "";
          if (
            n === "ExcalidrawElementsContext" &&
            f.child?.memoizedProps?.value
          ) {
            const val = f.child.memoizedProps.value;
            if (val && val.getElementsIncludingDeleted) {
              elementsCtx = val;
              return;
            }
          }
          let c = f.child;
          while (c) {
            walk2(c);
            c = c.sibling;
          }
        }
        walk2(root[containerKey]);
        if (elementsCtx) {
          try {
            return elementsCtx.getElementsIncludingDeleted();
          } catch { return []; }
        }
        return [];
      };
      return true;
    }
    return false;
  }

  // ---- Excalidraw scene helpers --------------------------------------------
  function getCodeElement(elements) {
    if (!elements) return null;
    for (const el of elements) {
      if (el.id === CODE_ELEMENT_ID || el.text?.startsWith?.("__CODECANVAS__")) {
        return el;
      }
    }
    return null;
  }

  function extractCodeFromElement(el) {
    if (!el || !el.text) return null;
    // Format: __CODECANVAS__|||<base64-encoded-code>|||
    // We use a delimiter to avoid URL encoding issues with arbitrary HTML
    const prefix = "__CODECANVAS__|||";
    const suffix = "|||";
    const raw = el.text;
    if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) return null;
    const encoded = raw.slice(prefix.length, -suffix.length);
    try {
      return decodeURIComponent(escape(atob(encoded)));
    } catch {
      return null;
    }
  }

  function encodeCodeForElement(code) {
    const prefix = "__CODECANVAS__|||";
    const suffix = "|||";
    try {
      const encoded = btoa(unescape(encodeURIComponent(code)));
      return prefix + encoded + suffix;
    } catch {
      // Fallback for very large codes — truncate if necessary
      return prefix + btoa(code.slice(0, 50000)) + suffix;
    }
  }

  function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash;
  }

  function updateCodeElement(code) {
    if (!excalidrawAPI || !excalidrawAPI.ready) return;

    const elements = getElements();
    if (!elements) return;

    const existing = getCodeElement(elements);
    const text = encodeCodeForElement(code);

    if (existing) {
      // Update existing element
      excalidrawAPI.updateScene({
        elements: elements.map((el) =>
          el.id === CODE_ELEMENT_ID ? { ...el, text } : el
        ),
      });
    } else {
      // Create new hidden text element way off-screen
      const newEl = {
        id: CODE_ELEMENT_ID,
        type: "text",
        x: -99999,
        y: -99999,
        width: 1,
        height: 1,
        text,
        fontSize: 1,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        strokeColor: "#000000",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 1,
        opacity: 0,
        angle: 0,
        groupIds: [],
        boundElements: null,
        isDeleted: false,
        seed: Math.floor(Math.random() * 1000000),
        containerId: null,
        originalText: text,
        autoResize: true,
        updated: Date.now(),
        version: 1,
      };
      excalidrawAPI.updateScene({
        elements: [...elements, newEl],
      });
    }
  }

  function pollForRemoteChanges() {
    if (!excalidrawAPI || !getElements) return;

    // Don't overwrite while user is actively typing
    if (Date.now() - lastLocalEditAt < REMOTE_SUPPRESS_WINDOW_MS) return;

    const elements = getElements();
    if (!elements) return;

    const codeEl = getCodeElement(elements);
    if (!codeEl) return;

    const code = extractCodeFromElement(codeEl);
    if (!code) return;

    const hash = hashCode(code);
    if (hash === knownCodeHash) return; // no change

    knownCodeHash = hash;

    // Update the editor and preview if this is a remote change
    if (editorEl && editorEl.value !== code) {
      const hadFocus = document.activeElement === editorEl;
      editorEl.value = code;
      updateGutter();
      runPreview();
      saveCachedCode(code);
      if (hadFocus) {
        editorEl.selectionStart = editorEl.selectionEnd = editorEl.value.length;
      }
    }
  }

  // ---- Local cache (instant restore on refresh) ---------------------------
  function getRoomId() {
    const hash = window.location.hash || "";
    if (hash.length > 1) return hash.slice(1);
    return null;
  }

  const roomId = getRoomId();
  const storageKey = "codecanvas:" + (roomId || "local");

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
      /* ignore */
    }
  }

  // ---- Build the floating toggle button ------------------------------------
  function createToggleButton() {
    const btn = document.createElement("button");
    btn.id = "cc-toggle-launcher";
    btn.type = "button";
    btn.title = "Toggle Code Canvas";
    btn.innerHTML = '<span style="font-family:monospace">&lt;/&gt;</span> Code';
    btn.addEventListener("click", () => {
      if (!panelEl) {
        buildPanel();
      } else {
        panelEl.classList.toggle("cc-hidden");
      }
    });
    document.body.appendChild(btn);
  }

  // ---- Build the panel ------------------------------------------------------
  function buildPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "cc-panel";
    panelEl.innerHTML = `
      <div id="cc-header">
        <span id="cc-title">&lt;/&gt; Code Canvas</span>
        <span id="cc-status">connecting…</span>
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

    // Load cached code or default
    let initialCode = loadCachedCode() || DEFAULT_CODE;

    // If we already have a known code from the scene, use that instead
    const elements = getElements ? getElements() : null;
    if (elements) {
      const codeEl = getCodeElement(elements);
      const code = codeEl ? extractCodeFromElement(codeEl) : null;
      if (code) {
        initialCode = code;
        knownCodeHash = hashCode(code);
      }
    }

    editorEl.value = initialCode;
    currentCode = initialCode;
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

    // Broadcast to Excalidraw scene
    updateCodeElement(currentCode);
    setStatus("live · Excalidraw sync", "cc-live");
  }

  let currentCode = "";
  let broadcastTimer = null;

  function onLocalEdit() {
    updateGutter();
    lastLocalEditAt = Date.now();
    currentCode = editorEl.value;
    saveCachedCode(currentCode);
    knownCodeHash = hashCode(currentCode);

    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      runPreview();
      // Broadcast to Excalidraw's scene — their collaboration server syncs it
      if (excalidrawAPI && excalidrawAPI.ready) {
        updateCodeElement(currentCode);
      }
    }, 350);
  }

  let lastCodeForPreview = "";

  function updateGutter() {
    const lineCount = (editorEl.value.match(/\n/g) || []).length + 1;
    let html = "";
    for (let i = 1; i <= lineCount; i++) html += "<div>" + i + "</div>";
    if (gutterEl) gutterEl.innerHTML = html;
  }

  function runPreview() {
    if (previewEl && editorEl.value !== lastCodeForPreview) {
      previewEl.srcdoc = editorEl.value;
      lastCodeForPreview = editorEl.value;
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
    window.addEventListener("mouseup", () => { dragging = false; });
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
    window.addEventListener("mouseup", () => { resizing = false; });
  }

  // ---- Status ---------------------------------------------------------------
  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = cls || "";
  }

  // ---- Styles ---------------------------------------------------------------
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

  // ---- Fix the green dot ----------------------------------------------------
  let greenDotDelegationWired = false;

  function fixGreenDot() {
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
        const svg = btn.querySelector("svg");
        if (svg && !svg.innerHTML.includes("&lt;/&gt;")) {
          svg.innerHTML = `
            <text x="8" y="12" text-anchor="middle" font-size="10"
              font-family="monospace" font-weight="bold" fill="currentColor">&lt;/&gt;</text>
          `;
        }
      }
    }
    if (found) {
      if (greenDotDelegationWired) {
        document.body.removeEventListener("click", greenDotClickHandler, true);
      }
      greenDotDelegationWired = true;
      document.body.addEventListener("click", greenDotClickHandler, true);
    }
  }

  function greenDotClickHandler(e) {
    const btn = e.target.closest('button[aria-label="Code Canvas"]');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (!panelEl) {
        buildPanel();
      } else {
        panelEl.classList.toggle("cc-hidden");
      }
    }
  }

  // ---- Boot -----------------------------------------------------------------
  function ensureInject() {
    if (!document.getElementById("cc-toggle-launcher")) {
      createToggleButton();
    }
    fixGreenDot();
    if (panelEl && !document.body.contains(panelEl)) {
      panelEl = null;
      editorEl = null;
      previewEl = null;
      statusEl = null;
      gutterEl = null;
    }
  }

  function boot() {
    // First, find the Excalidraw API
    // Retry finding it since Excalidraw might still be initializing
    let attempts = 0;
    const maxAttempts = 50; // ~25 seconds
    const findInterval = setInterval(() => {
      attempts++;
      if (findExcalidrawAPI()) {
        clearInterval(findInterval);
        console.log("[CodeCanvas] Hooked into Excalidraw API");
        setStatus("ready", "cc-live");
        // Start polling for remote changes
        setInterval(pollForRemoteChanges, POLL_INTERVAL_MS);
      } else if (attempts >= maxAttempts) {
        clearInterval(findInterval);
        console.warn("[CodeCanvas] Could not find Excalidraw API — will work in local-only mode");
        setStatus("local only", "");
      }
    }, 500);

    // Inject the UI button immediately
    ensureInject();
    setInterval(ensureInject, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
