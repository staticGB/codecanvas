// Injected code panel for Excalidraw - uses the same socket relay
(function() {
  let panelReady = false;
  let code = '<!DOCTYPE html>\n<html>\n<head>\n  <title>Hello</title>\n  <style>\n    body { font-family: sans-serif; padding: 1rem; background: #f5f5f5; }\n    h1 { color: #333; }\n  </style>\n</head>\n<body>\n  <h1>Collab Code!</h1>\n  <p>Edit and both see changes live.</p>\n</body>\n</html>';
  let codeTimer = null;
  let editor = null;
  let previewFrame = null;

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'code-panel';
    panel.innerHTML = `
      <div id="cp-header">
        <span id="cp-title">&lt;/&gt; Code</span>
        <span id="cp-status">offline</span>
        <button id="cp-toggle-btn">_</button>
        <button id="cp-close-btn">\u00d7</button>
      </div>
      <div id="cp-body">
        <div id="cp-editor-wrap">
          <div id="cp-gutter"></div>
          <textarea id="cp-editor" spellcheck="false" placeholder="HTML/CSS/JS..."></textarea>
        </div>
        <div id="cp-preview-wrap">
          <div id="cp-preview-header">
            <span>Preview</span>
            <button id="cp-run-btn">\u25b6 Run</button>
          </div>
          <iframe id="cp-preview" sandbox="allow-scripts allow-modals allow-same-origin"></iframe>
        </div>
      </div>
      <style>
        #code-panel {
          position: fixed; bottom: 0; right: 0; width: 50%; height: 45%;
          background: #1e1e1e; border: 1px solid #333; border-radius: 8px 0 0 0;
          z-index: 999999; display: flex; flex-direction: column;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          box-shadow: -4px -4px 20px rgba(0,0,0,0.4);
          transition: height 0.25s ease;
        }
        #code-panel.collapsed { height: 36px !important; }
        #code-panel.collapsed #cp-body { display: none; }
        #code-panel.hidden { display: none; }
        #cp-header {
          display: flex; align-items: center; padding: 5px 10px;
          background: #2d2d2d; border-radius: 8px 0 0 0; cursor: move;
          flex-shrink: 0; gap: 8px; user-select: none;
        }
        #cp-title { font-size: 12px; font-weight: 600; color: #ff6b6b; }
        #cp-status { font-size: 10px; padding: 2px 6px; border-radius: 3px; background: #333; color: #888; }
        #cp-status.online { color: #4ade80; background: #1a3a1a; }
        #cp-header button {
          background: none; border: none; color: #888; cursor: pointer;
          font-size: 14px; padding: 0 4px; line-height: 1;
        }
        #cp-header button:hover { color: #fff; }
        #cp-close-btn { margin-left: auto; }
        #cp-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
        #cp-editor-wrap {
          flex: 1; display: flex; overflow: hidden; min-height: 0;
          border-bottom: 1px solid #333;
        }
        #cp-gutter {
          width: 36px; background: #1e1e1e; color: #555; text-align: right;
          padding: 6px 4px; font-family: 'Courier New', monospace; font-size: 12px;
          line-height: 1.5; overflow: hidden; user-select: none; flex-shrink: 0;
          border-right: 1px solid #2a2a2a;
        }
        #cp-gutter div { padding-right: 4px; }
        #cp-editor {
          flex: 1; background: transparent; border: none; outline: none; resize: none;
          color: #d4d4d4; font-family: 'Courier New', monospace; font-size: 12px;
          line-height: 1.5; padding: 6px 8px; tab-size: 2; white-space: pre; overflow: auto;
        }
        #cp-preview-wrap { height: 40%; display: flex; flex-direction: column; flex-shrink: 0; }
        #cp-preview-header {
          display: flex; align-items: center; padding: 3px 8px;
          background: #252525; border-bottom: 1px solid #333; flex-shrink: 0;
        }
        #cp-preview-header span { font-size: 11px; color: #888; }
        #cp-run-btn {
          margin-left: auto; background: #2ea043; border: none; color: #fff;
          padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;
        }
        #cp-run-btn:hover { background: #3fb950; }
        #cp-preview { flex: 1; width: 100%; border: none; background: #fff; }
      </style>
    `;
    document.body.appendChild(panel);

    editor = document.getElementById('cp-editor');
    previewFrame = document.getElementById('cp-preview');
    const gutter = document.getElementById('cp-gutter');
    const runBtn = document.getElementById('cp-run-btn');
    const toggleBtn = document.getElementById('cp-toggle-btn');
    const closeBtn = document.getElementById('cp-close-btn');

    function updateGutter() {
      const n = (editor.value.match(/\n/g)||[]).length + 1;
      let h = '';
      for (let i = 1; i <= n; i++) h += '<div>'+i+'</div>';
      gutter.innerHTML = h;
    }

    function runPreview() {
      const d = previewFrame.contentDocument || previewFrame.contentWindow.document;
      d.open(); d.write(editor.value); d.close();
    }

    function onEdit() {
      updateGutter();
      clearTimeout(codeTimer);
      codeTimer = setTimeout(() => {
        sendCode(editor.value);
        runPreview();
      }, 400);
    }

    editor.value = code;
    updateGutter();
    runPreview();

    editor.addEventListener('input', onEdit);
    editor.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = this.selectionStart, en = this.selectionEnd;
        this.value = this.value.substring(0,s) + '  ' + this.value.substring(en);
        this.selectionStart = this.selectionEnd = s + 2;
        onEdit();
      }
    });

    runBtn.addEventListener('click', runPreview);
    toggleBtn.addEventListener('click', () => panel.classList.toggle('collapsed'));
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

    panelReady = true;
  }

  function sendCode(codeText) {
    var portal = window.__excalidrawPortal;
    if (portal && portal.isOpen()) {
      portal._broadcastSocketData({type: "CODE", payload: {code: codeText}});
    }
  }

  // Listen for incoming code
  window.__onCodeUpdate = function(payload) {
    if (payload && payload.code && editor) {
      if (editor.value !== payload.code) {
        editor.value = payload.code;
        var evt = new Event('input');
        editor.dispatchEvent(evt);
        var d = previewFrame.contentDocument || previewFrame.contentWindow.document;
        d.open(); d.write(payload.code); d.close();
      }
    }
  };

  // Wait for portal and create panel
  function waitForPortal() {
    if (window.__excalidrawPortal) {
      if (!panelReady) {
        createPanel();
        var statusEl = document.getElementById('cp-status');
        var checkOnline = setInterval(function() {
          if (window.__excalidrawPortal && window.__excalidrawPortal.isOpen()) {
            statusEl.textContent = 'live';
            statusEl.className = 'online';
            clearInterval(checkOnline);
          }
        }, 1000);
      }
    } else {
      setTimeout(waitForPortal, 500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForPortal);
  } else {
    waitForPortal();
  }
})();
