/**
 * Instagram 3×4 Grid Maker
 * Canvas-based image editor with drag, zoom, and touch gestures.
 * Uses Pointer Events API for cross-device gesture handling.
 * Uses requestAnimationFrame for smooth 60fps rendering.
 */

;(function () {
  'use strict';

  /* ==========================================================
     Constants
     ========================================================== */
  const COLS = 3;
  const ROWS = 4;
  const GRID_LINE_COLOR = 'rgba(255, 255, 255, 0.35)';
  const GRID_LINE_WIDTH = 2;
  const GRID_LINE_DASH = [];
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 10;
  const ZOOM_SENSITIVITY = 0.003;
  const PINCH_ZOOM_SENSITIVITY = 0.008;
  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
  const ACCEPTED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp'
  ]);

  /* ==========================================================
     State
     ========================================================== */
  let state = {
    image: null,        // HTMLImageElement
    imageWidth: 0,
    imageHeight: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    // Grid dimensions in canvas pixels
    gridW: 0,
    gridH: 0,
  };

  // Pointer tracking
  let pointers = new Map(); // pointerId -> { x, y, startX, startY }
  let lastPinchDist = 0;
  let isDragging = false;
  let needsRender = false;

  // Double-tap detection
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  // Original file reference for upload
  let originalFile = null;

  /* ==========================================================
     DOM References
     ========================================================== */
  const $ = (sel) => document.querySelector(sel);
  const uploadPage  = $('#upload-page');
  const editorPage  = $('#editor-page');
  const dropzone    = $('#dropzone');
  const fileInput   = $('#file-input');
  const canvas      = $('#editor-canvas');
  const ctx         = canvas.getContext('2d');
  const wrapper     = $('#canvas-wrapper');
  const btnBack     = $('#btn-back');
  const btnReset    = $('#btn-reset');
  const btnDownload = $('#btn-download');
  const zoomIn      = $('#zoom-in');
  const zoomOut     = $('#zoom-out');
  const zoomLabel   = $('#zoom-label');
  const processingOverlay = $('#processing-overlay');
  const errorModal  = $('#error-modal');
  const errorMessage = $('#error-message');
  const btnModalClose = $('#btn-modal-close');

  /* ==========================================================
     Upload Page — File Selection & Validation
     ========================================================== */

  // Click to open file picker
  dropzone.addEventListener('click', () => fileInput.click());

  // File chosen via picker
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  });

  // Drag & drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  /**
   * Validate and load the selected image file.
   */
  function handleFile(file) {
    // Reset input so the same file can be re-selected
    fileInput.value = '';

    // Validate MIME type
    if (!ACCEPTED_TYPES.has(file.type)) {
      showError('Unsupported format. Please use JPG, PNG, or WEBP.');
      return;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      showError('Image is too large. Maximum size is 25 MB.');
      return;
    }

    originalFile = file;

    // Load image via FileReader → data URL
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.imageWidth = img.naturalWidth;
        state.imageHeight = img.naturalHeight;
        openEditor();
      };
      img.onerror = () => {
        showError('Failed to load image. The file may be corrupt.');
      };
      img.src = e.target.result;
    };
    reader.onerror = () => {
      showError('Failed to read the file.');
    };
    reader.readAsDataURL(file);
  }

  /* ==========================================================
     Editor — Initialization
     ========================================================== */

  function openEditor() {
    uploadPage.classList.remove('active');
    editorPage.classList.add('active');
    initCanvas();
    setupPointerEvents();
  }

  function closeEditor() {
    editorPage.classList.remove('active');
    uploadPage.classList.add('active');
    cleanup();
  }

  /**
   * Size the canvas to match the wrapper (the grid area),
   * then compute the initial scale so the image covers the grid.
   */
  function initCanvas() {
    resizeCanvas();
    fitImage();
    requestRender();
  }

  /**
   * Make the canvas pixel dimensions match the wrapper's CSS size.
   * Accounts for devicePixelRatio for crisp rendering.
   */
  function resizeCanvas() {
    // REPLACED
    const rect = wrapper.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Force 3:4 aspect ratio so each tile is exactly square
    let gridW, gridH;
    if (rect.width / rect.height < COLS / ROWS) {
      gridW = rect.width;
      gridH = rect.width * ROWS / COLS;
    } else {
      gridH = rect.height;
      gridW = rect.height * COLS / ROWS;
    }

    state.gridW = gridW;
    state.gridH = gridH;

    canvas.width  = Math.round(gridW * dpr);
    canvas.height = Math.round(gridH * dpr);
    canvas.style.width  = gridW + 'px';
    canvas.style.height = gridH + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * Scale and center the image so it covers the entire grid area.
   */
  function fitImage() {
    const { imageWidth: iw, imageHeight: ih, gridW: gw, gridH: gh } = state;
    if (!iw || !ih || !gw || !gh) return;

    const scaleX = gw / iw;
    const scaleY = gh / ih;
    state.scale = Math.max(scaleX, scaleY);

    // Center the image
    state.offsetX = (gw - iw * state.scale) / 2;
    state.offsetY = (gh - ih * state.scale) / 2;

    updateZoomLabel();
  }

  /**
   * Reset to initial fit position.
   */
  function resetPosition() {
    fitImage();
    requestRender();
  }

  /* ==========================================================
     Canvas Rendering — requestAnimationFrame loop
     ========================================================== */

  let rafId = null;

  function requestRender() {
    needsRender = true;
    if (rafId === null) {
      rafId = requestAnimationFrame(renderLoop);
    }
  }

  function renderLoop() {
    rafId = null;
    if (needsRender) {
      needsRender = false;
      render();
    }
  }

  /**
   * Full render pass: image → grid overlay.
   */
  function render() {
    const { gridW: w, gridH: h, offsetX, offsetY, scale, image } = state;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Draw image with transform
    if (image) {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);
      ctx.restore();
    }

    // Draw grid overlay
    drawGrid(w, h);
  }

  /**
   * Draw the 3×4 grid lines on top of the image.
   */
  function drawGrid(w, h) {
    ctx.save();
    ctx.strokeStyle = GRID_LINE_COLOR;
    ctx.lineWidth = GRID_LINE_WIDTH;
    ctx.setLineDash(GRID_LINE_DASH);

    const cellW = w / COLS;
    const cellH = h / ROWS;

    // Vertical lines
    for (let c = 1; c < COLS; c++) {
      const x = Math.round(c * cellW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Horizontal lines
    for (let r = 1; r < ROWS; r++) {
      const y = Math.round(r * cellH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ==========================================================
     Pointer Events — Cross-device drag, pinch-zoom, double-tap
     ========================================================== */

  function setupPointerEvents() {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup',   onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave',  onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Prevent browser touch gestures on canvas
    canvas.style.touchAction = 'none';
  }

  function cleanup() {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup',   onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave',  onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    pointers.clear();
  }

  function onPointerDown(e) {
    e.preventDefault();
    const id = e.pointerId;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    pointers.set(id, { x, y, startX: x, startY: y });
    canvas.setPointerCapture(id);

    // Double-tap detection (single pointer only)
    if (pointers.size === 1 && e.pointerType === 'touch') {
      const now = Date.now();
      const dt = now - lastTapTime;
      const dx = x - lastTapX;
      const dy = y - lastTapY;
      if (dt < 300 && Math.abs(dx) < 40 && Math.abs(dy) < 40) {
        resetPosition();
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
      lastTapX = x;
      lastTapY = y;
    }
  }

  function onPointerMove(e) {
    e.preventDefault();
    const id = e.pointerId;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (!pointers.has(id)) return;

    const prev = pointers.get(id);
    pointers.set(id, { x, y, startX: prev.startX, startY: prev.startY });

    if (pointers.size === 1) {
      // Single-pointer drag
      const dx = x - prev.x;
      const dy = y - prev.y;
      state.offsetX += dx;
      state.offsetY += dy;
      requestRender();
    } else if (pointers.size === 2) {
      // Two-pointer pinch zoom
      const pts = Array.from(pointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

      if (lastPinchDist > 0) {
        // Calculate zoom center (midpoint)
        const cx = (pts[0].x + pts[1].x) / 2;
        const cy = (pts[0].y + pts[1].y) / 2;

        // Zoom factor
        const factor = dist / lastPinchDist;
        zoomAtPoint(cx, cy, factor);
        requestRender();
      }
      lastPinchDist = dist;
    }
  }

  function onPointerUp(e) {
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      lastPinchDist = 0;
    }
  }

  /**
   * Mouse wheel zoom centered on pointer.
   */
  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Zoom direction
    const factor = e.deltaY < 0
      ? 1 + ZOOM_SENSITIVITY * Math.abs(e.deltaY)
      : 1 / (1 + ZOOM_SENSITIVITY * Math.abs(e.deltaY));

    zoomAtPoint(x, y, factor);
    requestRender();
  }

  /**
   * Apply zoom centered on a specific point (x, y) in grid coordinates.
   * Keeps the point under the cursor stationary.
   */
  function zoomAtPoint(cx, cy, factor) {
    const oldScale = state.scale;
    const newScale = clampScale(oldScale * factor);

    // Adjust offset so that (cx, cy) stays fixed
    state.offsetX = cx - (cx - state.offsetX) * (newScale / oldScale);
    state.offsetY = cy - (cy - state.offsetY) * (newScale / oldScale);
    state.scale = newScale;
    updateZoomLabel();
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  function updateZoomLabel() {
    zoomLabel.textContent = Math.round(state.scale * 100) + '%';
  }

  /* ==========================================================
     Zoom Buttons
     ========================================================== */

  zoomIn.addEventListener('click', () => {
    const cx = state.gridW / 2;
    const cy = state.gridH / 2;
    zoomAtPoint(cx, cy, 1.25);
    requestRender();
  });

  zoomOut.addEventListener('click', () => {
    const cx = state.gridW / 2;
    const cy = state.gridH / 2;
    zoomAtPoint(cx, cy, 0.8);
    requestRender();
  });

  /* ==========================================================
     Navigation & Reset
     ========================================================== */

  btnBack.addEventListener('click', closeEditor);
  btnReset.addEventListener('click', resetPosition);

  /* ==========================================================
     Download — Send to Backend API
     ========================================================== */

  btnDownload.addEventListener('click', downloadGrid);

  async function downloadGrid() {
    if (!state.image) {
      showError('No image loaded.');
      return;
    }

    processingOverlay.hidden = false;

    try {
      const { gridW, gridH, offsetX, offsetY, scale, image } = state;
      const tileW = gridW / COLS;
      const tileH = gridH / ROWS;

      // Off-screen canvas at native resolution (no DPR — output pixels)
      const offCanvas = document.createElement('canvas');
      offCanvas.width  = Math.round(gridW);
      offCanvas.height = Math.round(gridH);
      const offCtx = offCanvas.getContext('2d');

      // Replicate the editor transform
      offCtx.save();
      offCtx.translate(offsetX, offsetY);
      offCtx.scale(scale, scale);
      offCtx.drawImage(image, 0, 0);
      offCtx.restore();

      // JSZip must be loaded (added via CDN in index.html)
      if (typeof JSZip === 'undefined') {
        throw new Error('JSZip not loaded. Please refresh and try again.');
      }

      const zip = new JSZip();

      // Slice into COLS × ROWS tiles, numbered in reading order
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const left   = Math.round(col * tileW);
          const top    = Math.round(row * tileH);
          const right  = Math.round((col + 1) * tileW);
          const bottom = Math.round((row + 1) * tileH);
          const tw = right - left;
          const th = bottom - top;

          const tileCanvas = document.createElement('canvas');
          tileCanvas.width  = tw;
          tileCanvas.height = th;
          tileCanvas.getContext('2d').drawImage(offCanvas, left, top, tw, th, 0, 0, tw, th);

          // toBlob is async; wrap in Promise
          const blob = await new Promise((res) =>
            tileCanvas.toBlob(res, 'image/jpeg', 0.92)
          );

          const idx = (COLS * ROWS) - (row * COLS + col);
          const name = `upload_${String(idx).padStart(2, '0')}.jpg`;
          zip.file(name, blob);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instagram_grid.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

    } catch (err) {
      showError(err.message || 'Download failed. Please try again.');
    } finally {
      processingOverlay.hidden = true;
    }
  }

  /* ==========================================================
     Error Modal
     ========================================================== */

  function showError(msg) {
    errorMessage.textContent = msg;
    errorModal.hidden = false;
  }

  btnModalClose.addEventListener('click', () => {
    errorModal.hidden = true;
  });

  errorModal.addEventListener('click', (e) => {
    if (e.target === errorModal) {
      errorModal.hidden = true;
    }
  });

  /* ==========================================================
     Resize Handling
     ========================================================== */

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!editorPage.classList.contains('active')) return;

      // Remember how the image was positioned relative to the grid
      const oldGridW = state.gridW;
      const oldGridH = state.gridH;

      resizeCanvas();

      // Scale offset proportionally to new grid size
      if (oldGridW > 0 && oldGridH > 0) {
        state.offsetX *= state.gridW / oldGridW;
        state.offsetY *= state.gridH / oldGridH;
      }

      requestRender();
    }, 100);
  });

})();
