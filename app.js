/**
 * MobilePDF - 纯前端 PDF 原样修改与解密工具
 * Core Application Logic
 */

// Configure PDF.js Worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Global Application State
const state = {
  pdfDoc: null,
  pdfData: null,
  fileName: '',
  password: '',
  passwordCallback: null,
  currentPage: 1,
  totalPages: 1,
  
  // View & Canvas
  baseWidth: 0,
  baseHeight: 0,
  currentZoom: 1.0,
  baseScale: 1.5, // 1.5x base scale for retina crisp rendering
  mode: 'edit',   // 'edit' | 'browse'
  tool: 'cover-edit', // 'browse' | 'cover-edit' | 'add-text' | 'signature' | 'brush' | 'mask' | 'select'

  // Per-page Fabric objects serialized storage
  pageStates: {},
  historyStack: {},

  // Drawing & Tools state
  isDrawingBox: false,
  boxStartX: 0,
  boxStartY: 0,
  rubberBandRect: null,

  textColor: '#111827',
  fontSize: 16,
  isBold: false,
  maskColor: '#ffffff',
  brushWidth: 3,
  brushColor: '#dc2626',

  // Panning & Touch state
  isPanning: false,
  panStartX: 0,
  panStartY: 0,
  panScrollLeft: 0,
  panScrollTop: 0,
  initialPinchDist: null,
  initialPinchZoom: 1.0,
};

// Fabric Canvas instance
let fabricCanvas = null;

// DOM Elements
const elements = {
  viewportWrapper: document.getElementById('viewport-wrapper'),
  workspaceView: document.getElementById('workspace-view'),
  emptyState: document.getElementById('empty-state'),
  canvasContainer: document.getElementById('canvas-container'),
  pdfCanvas: document.getElementById('pdf-canvas'),
  fabricWrapper: document.getElementById('fabric-wrapper'),

  // Header & Controls
  fileNameLabel: document.getElementById('file-name-label'),
  pageNavControls: document.getElementById('page-nav-controls'),
  currentPageNum: document.getElementById('current-page-num'),
  totalPageNum: document.getElementById('total-page-num'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  btnOpenPdf: document.getElementById('btn-open-pdf'),
  pdfFileInput: document.getElementById('pdf-file-input'),
  btnExportPdf: document.getElementById('btn-export-pdf'),
  modeSwitchGroup: document.getElementById('mode-switch-group'),
  btnModeBrowse: document.getElementById('btn-mode-browse'),
  btnModeEdit: document.getElementById('btn-mode-edit'),

  // Zoom HUD
  floatingZoomHud: document.getElementById('floating-zoom-hud'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomReset: document.getElementById('btn-zoom-reset'),
  btnZoomFit: document.getElementById('btn-zoom-fit'),
  btnZoom200: document.getElementById('btn-zoom-200'),
  zoomPercentageLabel: document.getElementById('zoom-percentage-label'),

  // Toolbar buttons
  toolBrowse: document.getElementById('tool-browse'),
  toolCoverEdit: document.getElementById('tool-cover-edit'),
  toolAddText: document.getElementById('tool-add-text'),
  toolSignature: document.getElementById('tool-signature'),
  toolBrush: document.getElementById('tool-brush'),
  toolMask: document.getElementById('tool-mask'),
  imageUploadInput: document.getElementById('image-upload-input'),
  btnUndo: document.getElementById('btn-undo'),

  // Context Property Bar
  propertyBar: document.getElementById('contextual-property-bar'),
  textPropControls: document.getElementById('text-prop-controls'),
  maskPropControls: document.getElementById('mask-prop-controls'),
  brushPropControls: document.getElementById('brush-prop-controls'),
  labelFontSize: document.getElementById('label-font-size'),
  btnFontMinus: document.getElementById('btn-font-minus'),
  btnFontPlus: document.getElementById('btn-font-plus'),
  inputTextColor: document.getElementById('input-text-color'),
  btnTextBold: document.getElementById('btn-text-bold'),
  inputMaskColor: document.getElementById('input-mask-color'),
  brushWidthSlider: document.getElementById('brush-width-slider'),
  btnDeleteSelected: document.getElementById('btn-delete-selected'),

  // Modals
  passwordModal: document.getElementById('password-modal'),
  passwordForm: document.getElementById('password-form'),
  passwordInput: document.getElementById('password-input'),
  btnTogglePasswordVisibility: document.getElementById('btn-toggle-password-visibility'),
  passwordErrorTip: document.getElementById('password-error-tip'),
  passwordErrorText: document.getElementById('password-error-text'),
  btnCancelPassword: document.getElementById('btn-cancel-password'),

  signatureModal: document.getElementById('signature-modal'),
  signatureCanvas: document.getElementById('signature-canvas'),
  btnCloseSignature: document.getElementById('btn-close-signature'),
  btnClearSignature: document.getElementById('btn-clear-signature'),
  btnCancelSignature: document.getElementById('btn-cancel-signature'),
  btnConfirmSignature: document.getElementById('btn-confirm-signature'),

  exportProgressModal: document.getElementById('export-progress-modal'),
  exportProgressText: document.getElementById('export-progress-text'),

  toastPill: document.getElementById('toast-pill'),
  toastIcon: document.getElementById('toast-icon'),
  toastMessage: document.getElementById('toast-message'),

  // Empty state buttons
  btnDropzoneUpload: document.getElementById('btn-dropzone-upload'),
  btnLoadSampleContract: document.getElementById('btn-load-sample-contract'),
  btnLoadSampleEncrypted: document.getElementById('btn-load-sample-encrypted'),
};

// Customize Fabric defaults for comfortable touch experience on mobile
fabric.Object.prototype.transparentCorners = false;
fabric.Object.prototype.cornerColor = '#2563eb';
fabric.Object.prototype.cornerStrokeColor = '#ffffff';
fabric.Object.prototype.borderColor = '#3b82f6';
fabric.Object.prototype.cornerSize = 14;         // Large corner handle for thumbs
fabric.Object.prototype.touchCornerSize = 32;    // Responsive touch area
fabric.Object.prototype.cornerStyle = 'circle';
fabric.Object.prototype.padding = 4;

// ==========================================
// 1. Toast Notification Helper
// ==========================================
let toastTimer = null;
function showToast(message, type = 'info') {
  clearTimeout(toastTimer);
  elements.toastMessage.textContent = message;

  if (type === 'success') {
    elements.toastIcon.className = 'fa-solid fa-circle-check text-emerald-400';
  } else if (type === 'error') {
    elements.toastIcon.className = 'fa-solid fa-circle-exclamation text-rose-400';
  } else {
    elements.toastIcon.className = 'fa-solid fa-circle-info text-blue-400';
  }

  elements.toastPill.classList.remove('opacity-0', 'translate-y-[-20px]', 'pointer-events-none');
  elements.toastPill.classList.add('opacity-100', 'translate-y-0');

  toastTimer = setTimeout(() => {
    elements.toastPill.classList.remove('opacity-100', 'translate-y-0');
    elements.toastPill.classList.add('opacity-0', 'translate-y-[-20px]', 'pointer-events-none');
  }, 2800);
}

// ==========================================
// 2. PDF Loading & Password Handling
// ==========================================
async function openPdfFile(arrayBuffer, fileName = 'document.pdf', password = '') {
  // Clone ArrayBuffer to avoid detachment by PDF.js worker transfer
  state.pdfData = arrayBuffer.slice(0);
  state.fileName = fileName;
  state.password = password;
  state.passwordCallback = null;

  elements.fileNameLabel.textContent = fileName;
  elements.btnExportPdf.disabled = true;

  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer.slice(0),
    password: password,
    cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
    cMapPacked: true,
  });

  // Password Exception Callback from PDF.js
  loadingTask.onPassword = function (callback, reason) {
    state.passwordCallback = callback;
    const isIncorrect = (reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD);
    showPasswordModal(isIncorrect);
  };

  try {
    state.pdfDoc = await loadingTask.promise;
    state.totalPages = state.pdfDoc.numPages;
    state.currentPage = 1;
    state.pageStates = {}; // Clear previous page edits
    state.historyStack = {};

    hidePasswordModal();
    elements.btnExportPdf.disabled = false;
    elements.pageNavControls.classList.remove('hidden');
    elements.modeSwitchGroup.classList.remove('hidden');
    elements.modeSwitchGroup.classList.add('flex');
    elements.floatingZoomHud.classList.remove('hidden');
    elements.floatingZoomHud.classList.add('flex');

    updatePaginationUI();
    await renderPage(1);
    
    // Fit to width initially on mobile
    if (window.innerWidth < 768) {
      setTimeout(() => fitToScreenWidth(), 150);
    }

    showToast(password ? 'PDF 已成功解锁并加载！' : 'PDF 加载成功！', 'success');
  } catch (err) {
    if (err.name === 'PasswordException') {
      // Handled by onPassword callback
    } else {
      console.error('Failed to load PDF:', err);
      showToast('加载 PDF 失败: ' + err.message, 'error');
    }
  }
}

// Password Modal Controls
function showPasswordModal(isIncorrect = false) {
  elements.passwordModal.classList.remove('hidden');
  elements.passwordInput.value = '';
  elements.passwordInput.focus();

  if (isIncorrect) {
    elements.passwordErrorTip.classList.remove('hidden');
    elements.passwordErrorText.textContent = '密码不正确，请重新输入';
  } else {
    elements.passwordErrorTip.classList.add('hidden');
  }
}

function hidePasswordModal() {
  elements.passwordModal.classList.add('hidden');
  elements.passwordInput.value = '';
  elements.passwordErrorTip.classList.add('hidden');
}

function submitPassword() {
  const entered = elements.passwordInput.value;
  if (!entered) {
    elements.passwordErrorTip.classList.remove('hidden');
    elements.passwordErrorText.textContent = '请输入密码';
    return;
  }
  state.password = entered;
  if (state.passwordCallback) {
    state.passwordCallback(entered);
  } else {
    openPdfFile(state.pdfData, state.fileName, entered);
  }
}

// ==========================================
// 3. Page Rendering & Fabric Overlay
// ==========================================
let isRendering = false;

async function renderPage(pageNum) {
  if (!state.pdfDoc || isRendering) return;
  isRendering = true;

  try {
    // 1. Save current page's Fabric objects before switching
    if (fabricCanvas && state.currentPage) {
      saveCurrentPageState(state.currentPage);
    }

    state.currentPage = pageNum;
    updatePaginationUI();

    // 2. Fetch page from PDF.js
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: state.baseScale });
    
    state.baseWidth = viewport.width;
    state.baseHeight = viewport.height;

    // 3. Render base PDF onto pdf-canvas
    const pdfCanvas = elements.pdfCanvas;
    pdfCanvas.width = state.baseWidth;
    pdfCanvas.height = state.baseHeight;
    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });

    await page.render({
      canvasContext: ctx,
      viewport: viewport,
    }).promise;

    // 4. Initialize or resize Fabric Overlay Canvas
    if (!fabricCanvas) {
      fabricCanvas = new fabric.Canvas('fabric-canvas', {
        selection: true,
        preserveObjectStacking: true,
        stopContextMenu: true,
        fireRightClick: true,
      });
      setupFabricEventListeners();
    } else {
      fabricCanvas.clear();
    }

    fabricCanvas.setWidth(state.baseWidth);
    fabricCanvas.setHeight(state.baseHeight);

    // 5. Restore saved objects for this page
    if (state.pageStates[pageNum]) {
      await new Promise(resolve => {
        fabricCanvas.loadFromJSON(state.pageStates[pageNum], () => {
          fabricCanvas.renderAll();
          resolve();
        });
      });
    }

    // 6. Apply zoom scaling
    applyZoom();

    // 7. Show workspace, hide empty state
    elements.emptyState.classList.add('hidden');
    elements.workspaceView.classList.remove('hidden');

    applyCurrentMode();
  } catch (err) {
    console.error('Error rendering page:', err);
    showToast('页面渲染失败: ' + err.message, 'error');
  } finally {
    isRendering = false;
  }
}

function saveCurrentPageState(pageNum) {
  if (!fabricCanvas) return;
  state.pageStates[pageNum] = fabricCanvas.toJSON(['data', 'isMask', 'isText']);
}

function updatePaginationUI() {
  elements.currentPageNum.textContent = state.currentPage;
  elements.totalPageNum.textContent = state.totalPages;
  elements.btnPrevPage.disabled = (state.currentPage <= 1);
  elements.btnNextPage.disabled = (state.currentPage >= state.totalPages);
}

// ==========================================
// 4. Zoom & Pan Handlers (Mobile-First)
// ==========================================
function setZoom(newZoom) {
  state.currentZoom = Math.min(3.0, Math.max(0.4, Math.round(newZoom * 100) / 100));
  elements.zoomPercentageLabel.textContent = `${Math.round(state.currentZoom * 100)}%`;
  applyZoom();
}

function applyZoom() {
  if (!fabricCanvas || !state.baseWidth) return;

  const w = state.baseWidth * state.currentZoom;
  const h = state.baseHeight * state.currentZoom;

  fabricCanvas.setZoom(state.currentZoom);
  fabricCanvas.setDimensions({ width: w, height: h });

  elements.pdfCanvas.style.width = `${w}px`;
  elements.pdfCanvas.style.height = `${h}px`;

  elements.canvasContainer.style.width = `${w}px`;
  elements.canvasContainer.style.height = `${h}px`;
}

function fitToScreenWidth() {
  if (!state.baseWidth) return;
  const availableWidth = elements.viewportWrapper.clientWidth - 28;
  const fitZoom = Math.max(0.4, Math.min(1.5, availableWidth / state.baseWidth));
  setZoom(fitZoom);
}

// ==========================================
// 5. Modes & Tools Architecture
// ==========================================
function setMode(newMode) {
  state.mode = newMode;
  if (newMode === 'browse') {
    elements.btnModeBrowse.className = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition bg-white text-blue-600 shadow-sm';
    elements.btnModeEdit.className = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition text-slate-600 hover:text-slate-900';
    setTool('browse');
    showToast('已进入浏览模式：可单指滑动拖拽，双指缩放', 'info');
  } else {
    elements.btnModeEdit.className = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition bg-white text-blue-600 shadow-sm';
    elements.btnModeBrowse.className = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition text-slate-600 hover:text-slate-900';
    if (state.tool === 'browse') {
      setTool('cover-edit');
    } else {
      applyCurrentMode();
    }
    showToast('已进入编辑模式：支持框选改字、添加签名', 'info');
  }
}

function setTool(toolName) {
  state.tool = toolName;

  // Update Toolbar UI active state
  document.querySelectorAll('.toolbar-btn').forEach(btn => {
    btn.classList.remove('active-tool');
    const iconWrapper = btn.querySelector('.tool-icon-bg');
    if (iconWrapper) {
      iconWrapper.className = 'w-8 h-8 rounded-full flex items-center justify-center text-sm mb-0.5 tool-icon-bg';
    }
  });

  const activeBtn = document.querySelector(`[data-tool="${toolName}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active-tool');
    const iconWrapper = activeBtn.querySelector('.tool-icon-bg');
    if (iconWrapper) {
      iconWrapper.className = 'w-8 h-8 rounded-full flex items-center justify-center text-sm mb-0.5 tool-icon-bg bg-blue-100 text-blue-600';
    }
  }

  // Auto switch mode pill if browse clicked
  if (toolName === 'browse' && state.mode !== 'browse') {
    setMode('browse');
    return;
  }
  if (toolName !== 'browse' && state.mode === 'browse') {
    setMode('edit');
    return;
  }

  applyCurrentMode();
}

function applyCurrentMode() {
  if (!fabricCanvas) return;

  // Reset drawing & selections
  fabricCanvas.isDrawingMode = (state.tool === 'brush');
  if (fabricCanvas.isDrawingMode) {
    fabricCanvas.freeDrawingBrush.width = parseInt(state.brushWidth, 10);
    fabricCanvas.freeDrawingBrush.color = state.brushColor;
  }

  if (state.tool === 'browse') {
    fabricCanvas.selection = false;
    fabricCanvas.discardActiveObject();
    fabricCanvas.defaultCursor = 'grab';
    fabricCanvas.hoverCursor = 'grab';
    fabricCanvas.forEachObject(obj => obj.selectable = false);
  } else if (state.tool === 'cover-edit' || state.tool === 'mask') {
    fabricCanvas.selection = false;
    fabricCanvas.discardActiveObject();
    fabricCanvas.defaultCursor = 'crosshair';
    fabricCanvas.hoverCursor = 'crosshair';
    fabricCanvas.forEachObject(obj => obj.selectable = true);
  } else {
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = 'default';
    fabricCanvas.hoverCursor = 'move';
    fabricCanvas.forEachObject(obj => obj.selectable = true);
  }

  updatePropertyBar();
  fabricCanvas.requestRenderAll();
}

// ==========================================
// 6. "Cover & Edit" (遮盖改字) Core Mechanism
// ==========================================
function setupFabricEventListeners() {
  // Mouse down / Touch start
  fabricCanvas.on('mouse:down', (opt) => {
    if (state.tool === 'cover-edit' || state.tool === 'mask') {
      state.isDrawingBox = true;
      const pointer = opt.pointer || (opt.e ? fabricCanvas.getPointer(opt.e) : { x: 0, y: 0 });
      state.boxStartX = pointer.x;
      state.boxStartY = pointer.y;

      state.rubberBandRect = new fabric.Rect({
        left: state.boxStartX,
        top: state.boxStartY,
        width: 0,
        height: 0,
        fill: 'rgba(59, 130, 246, 0.15)',
        stroke: '#2563eb',
        strokeWidth: 1.5,
        strokeDashArray: [4, 4],
        selectable: false,
        evented: false,
      });
      fabricCanvas.add(state.rubberBandRect);
    }
  });

  // Mouse move / Touch drag
  fabricCanvas.on('mouse:move', (opt) => {
    if (!state.isDrawingBox || !state.rubberBandRect) return;
    const pointer = opt.pointer || (opt.e ? fabricCanvas.getPointer(opt.e) : { x: 0, y: 0 });
    const left = Math.min(state.boxStartX, pointer.x);
    const top = Math.min(state.boxStartY, pointer.y);
    const width = Math.abs(state.boxStartX - pointer.x);
    const height = Math.abs(state.boxStartY - pointer.y);

    state.rubberBandRect.set({ left, top, width, height });
    fabricCanvas.requestRenderAll();
  });

  // Mouse up / Touch end
  fabricCanvas.on('mouse:up', (opt) => {
    if (!state.isDrawingBox || !state.rubberBandRect) return;
    state.isDrawingBox = false;

    fabricCanvas.remove(state.rubberBandRect);
    const pointer = opt.pointer || (opt.e ? fabricCanvas.getPointer(opt.e) : { x: 0, y: 0 });
    const left = Math.min(state.boxStartX, pointer.x);
    const top = Math.min(state.boxStartY, pointer.y);
    const width = Math.abs(state.boxStartX - pointer.x);
    const height = Math.abs(state.boxStartY - pointer.y);

    state.rubberBandRect = null;

    // Minimum drag threshold to prevent accidental clicks
    if (width < 6 || height < 6) return;

    // 1. Auto extract background color around the bounding box from pdf-canvas
    const sampledBgColor = samplePdfBackgroundColor(left, top, width, height);

    // 2. Create the solid mask rectangle
    const maskRect = new fabric.Rect({
      left: left,
      top: top,
      width: width,
      height: height,
      fill: sampledBgColor,
      selectable: true,
      hasBorders: true,
      borderColor: '#94a3b8',
      cornerSize: 12,
      strokeWidth: 0,
      data: { isMask: true, id: 'mask_' + Date.now() },
    });
    fabricCanvas.add(maskRect);

    // 3. If in 'cover-edit' mode, immediately spawn in-place editable Textbox
    if (state.tool === 'cover-edit') {
      const calculatedFontSize = Math.max(12, Math.min(Math.round(height * 0.72), 48));
      state.fontSize = calculatedFontSize;

      const textbox = new fabric.Textbox('点击输入修改文字', {
        left: left,
        top: top + Math.max(0, (height - calculatedFontSize * 1.25) / 2),
        width: Math.max(width, 100),
        fontSize: calculatedFontSize,
        fill: state.textColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: state.isBold ? 'bold' : 'normal',
        editable: true,
        data: { isText: true, linkedMaskId: maskRect.data.id },
      });

      fabricCanvas.add(textbox);
      fabricCanvas.setActiveObject(textbox);
      textbox.enterEditing();
      textbox.selectAll();

      showToast('已覆盖原文字，可直接打字替换！', 'info');
    } else {
      fabricCanvas.setActiveObject(maskRect);
      showToast('已生成遮罩块覆盖原内容！', 'info');
    }

    // Switch to select tool so user can tweak or tap freely
    setTool('select');
    fabricCanvas.requestRenderAll();
  });

  // Selection events
  fabricCanvas.on('selection:created', updatePropertyBar);
  fabricCanvas.on('selection:updated', updatePropertyBar);
  fabricCanvas.on('selection:cleared', updatePropertyBar);

  // Object modified (for history)
  fabricCanvas.on('object:modified', () => {
    saveCurrentPageState(state.currentPage);
  });
}

// Sample background color from underlying rendered PDF page
function samplePdfBackgroundColor(left, top, width, height) {
  try {
    const pdfCanvas = elements.pdfCanvas;
    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });
    
    // Sample 5 points around the bounding box border (slightly outside)
    const points = [
      { x: Math.max(0, left - 2), y: Math.max(0, top - 2) },
      { x: Math.min(pdfCanvas.width - 1, left + width + 2), y: Math.max(0, top - 2) },
      { x: Math.max(0, left - 2), y: Math.min(pdfCanvas.height - 1, top + height + 2) },
      { x: left + width / 2, y: Math.max(0, top - 2) },
      { x: Math.max(0, left - 2), y: top + height / 2 },
    ];

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (const p of points) {
      const pixel = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
      if (pixel[3] > 80) { // Opaque enough
        rSum += pixel[0];
        gSum += pixel[1];
        bSum += pixel[2];
        count++;
      }
    }

    if (count > 0) {
      const r = Math.round(rSum / count);
      const g = Math.round(gSum / count);
      const b = Math.round(bSum / count);
      return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
    }
  } catch (err) {
    console.warn('Could not sample background color:', err);
  }
  return '#ffffff'; // Default to white
}

// ==========================================
// 7. Context Property Bar Controller
// ==========================================
function updatePropertyBar() {
  if (!fabricCanvas) return;
  const activeObj = fabricCanvas.getActiveObject();

  if (activeObj) {
    elements.propertyBar.classList.remove('hidden');

    if (activeObj.type === 'textbox' || activeObj.type === 'i-text') {
      elements.textPropControls.classList.remove('hidden');
      elements.textPropControls.classList.add('flex');
      elements.maskPropControls.classList.add('hidden');
      elements.brushPropControls.classList.add('hidden');

      elements.labelFontSize.textContent = Math.round(activeObj.fontSize || 16);
      elements.inputTextColor.value = activeObj.fill || '#111827';
      elements.btnTextBold.className = (activeObj.fontWeight === 'bold')
        ? 'w-6 h-6 rounded bg-blue-600 text-white flex items-center justify-center font-bold text-xs'
        : 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 flex items-center justify-center font-bold text-xs';
    } else if (activeObj.data?.isMask || activeObj.type === 'rect') {
      elements.maskPropControls.classList.remove('hidden');
      elements.maskPropControls.classList.add('flex');
      elements.textPropControls.classList.add('hidden');
      elements.brushPropControls.classList.add('hidden');

      elements.inputMaskColor.value = activeObj.fill || '#ffffff';
    } else {
      elements.textPropControls.classList.add('hidden');
      elements.maskPropControls.classList.add('hidden');
      elements.brushPropControls.classList.add('hidden');
    }
  } else if (state.tool === 'brush') {
    elements.propertyBar.classList.remove('hidden');
    elements.brushPropControls.classList.remove('hidden');
    elements.brushPropControls.classList.add('flex');
    elements.textPropControls.classList.add('hidden');
    elements.maskPropControls.classList.add('hidden');
  } else {
    elements.propertyBar.classList.add('hidden');
  }
}

// ==========================================
// 8. Add Text, Image & Signature
// ==========================================
function addSimpleText() {
  if (!fabricCanvas) return;

  const centerPoint = fabricCanvas.getVpCenter();
  const textbox = new fabric.Textbox('点击编辑文字', {
    left: Math.max(20, centerPoint.x - 60),
    top: Math.max(20, centerPoint.y - 20),
    width: 140,
    fontSize: state.fontSize || 16,
    fill: state.textColor || '#111827',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: state.isBold ? 'bold' : 'normal',
    data: { isText: true },
  });

  fabricCanvas.add(textbox);
  fabricCanvas.setActiveObject(textbox);
  textbox.enterEditing();
  textbox.selectAll();
  setTool('select');
  fabricCanvas.requestRenderAll();
  showToast('已添加文字框', 'info');
}

function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file || !fabricCanvas) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    fabric.Image.fromURL(evt.target.result, (img) => {
      // Scale down image if too large
      const maxW = fabricCanvas.getWidth() * 0.4;
      if (img.width > maxW) {
        img.scale(maxW / img.width);
      }
      img.set({
        left: fabricCanvas.getVpCenter().x - (img.getScaledWidth() / 2),
        top: fabricCanvas.getVpCenter().y - (img.getScaledHeight() / 2),
      });

      fabricCanvas.add(img);
      fabricCanvas.setActiveObject(img);
      setTool('select');
      fabricCanvas.requestRenderAll();
      showToast('图片已插入，可自由缩放移动', 'success');
    });
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ==========================================
// 9. Signature Pad Drawing Logic
// ==========================================
let sigCtx = null;
let isSigning = false;
let sigPenColor = '#000000';

function initSignatureBoard() {
  const c = elements.signatureCanvas;
  sigCtx = c.getContext('2d');
  sigCtx.lineWidth = 3;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = sigPenColor;

  const getPos = (evt) => {
    const rect = c.getBoundingClientRect();
    const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
    const scaleX = c.width / rect.width;
    const scaleY = c.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  };

  const startDraw = (e) => {
    isSigning = true;
    const pos = getPos(e);
    sigCtx.beginPath();
    sigCtx.moveTo(pos.x, pos.y);
    e.preventDefault();
  };

  const moveDraw = (e) => {
    if (!isSigning) return;
    const pos = getPos(e);
    sigCtx.lineTo(pos.x, pos.y);
    sigCtx.stroke();
    e.preventDefault();
  };

  const endDraw = () => {
    isSigning = false;
  };

  c.addEventListener('mousedown', startDraw);
  c.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', endDraw);

  c.addEventListener('touchstart', startDraw, { passive: false });
  c.addEventListener('touchmove', moveDraw, { passive: false });
  window.addEventListener('touchend', endDraw);
}

function clearSignature() {
  if (sigCtx) {
    sigCtx.clearRect(0, 0, elements.signatureCanvas.width, elements.signatureCanvas.height);
  }
}

function insertSignature() {
  // Check if anything was drawn
  const imgData = sigCtx.getImageData(0, 0, elements.signatureCanvas.width, elements.signatureCanvas.height);
  let hasDrawing = false;
  for (let i = 3; i < imgData.data.length; i += 4) {
    if (imgData.data[i] > 20) {
      hasDrawing = true;
      break;
    }
  }

  if (!hasDrawing) {
    showToast('请先在框内书写签名', 'error');
    return;
  }

  const dataUrl = elements.signatureCanvas.toDataURL('image/png');
  fabric.Image.fromURL(dataUrl, (img) => {
    // scale to sensible size
    img.scale(0.5);
    const center = fabricCanvas.getVpCenter();
    img.set({
      left: Math.max(20, center.x - (img.getScaledWidth() / 2)),
      top: Math.max(20, center.y - (img.getScaledHeight() / 2)),
    });

    fabricCanvas.add(img);
    fabricCanvas.setActiveObject(img);
    setTool('select');
    fabricCanvas.requestRenderAll();
    elements.signatureModal.classList.add('hidden');
    clearSignature();
    showToast('签名已插入！', 'success');
  });
}

// ==========================================
// 10. Multi-Touch Gestures & Pan Panning
// ==========================================
function setupTouchAndPan() {
  const wrapper = elements.viewportWrapper;

  wrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // Pinch start
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      state.initialPinchDist = dist;
      state.initialPinchZoom = state.currentZoom;
    } else if (e.touches.length === 1 && state.mode === 'browse') {
      // Pan start
      state.isPanning = true;
      state.panStartX = e.touches[0].clientX;
      state.panStartY = e.touches[0].clientY;
      state.panScrollLeft = wrapper.scrollLeft;
      state.panScrollTop = wrapper.scrollTop;
    }
  }, { passive: false });

  wrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && state.initialPinchDist) {
      // Pinch move
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / state.initialPinchDist;
      setZoom(state.initialPinchZoom * factor);
      e.preventDefault();
    } else if (e.touches.length === 1 && state.isPanning && state.mode === 'browse') {
      // Pan move
      const dx = e.touches[0].clientX - state.panStartX;
      const dy = e.touches[0].clientY - state.panStartY;
      wrapper.scrollLeft = state.panScrollLeft - dx;
      wrapper.scrollTop = state.panScrollTop - dy;
      e.preventDefault();
    }
  }, { passive: false });

  wrapper.addEventListener('touchend', () => {
    state.isPanning = false;
    state.initialPinchDist = null;
  });

  // Mouse pan support for desktop in browse mode
  wrapper.addEventListener('mousedown', (e) => {
    if (state.mode === 'browse') {
      state.isPanning = true;
      state.panStartX = e.clientX;
      state.panStartY = e.clientY;
      state.panScrollLeft = wrapper.scrollLeft;
      state.panScrollTop = wrapper.scrollTop;
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.isPanning && state.mode === 'browse') {
      const dx = e.clientX - state.panStartX;
      const dy = e.clientY - state.panStartY;
      wrapper.scrollLeft = state.panScrollLeft - dx;
      wrapper.scrollTop = state.panScrollTop - dy;
    }
  });

  window.addEventListener('mouseup', () => {
    state.isPanning = false;
  });
}

// ==========================================
// 11. PDF Export & Decrypted File Generation
// ==========================================
async function exportModifiedPdf() {
  if (!state.pdfDoc) return;
  showExportProgress(true, '正在准备导出...');

  try {
    // 1. Save current page state
    saveCurrentPageState(state.currentPage);

    let finalPdfBytes;

    // Strategy Check: Can we use original PDF with pdf-lib?
    // If PDF is password protected or encrypted, pdf-lib cannot modify encrypted streams.
    // Instead, we use Decrypted Reconstruction via PDF.js!
    let canUseDirectPdfLib = (!state.password);
    let originalDoc = null;

    if (canUseDirectPdfLib) {
      try {
        originalDoc = await PDFLib.PDFDocument.load(state.pdfData, { ignoreEncryption: true });
      } catch (e) {
        console.warn('Original PDF has encryption or strict protection, switching to decrypted reconstruction:', e);
        canUseDirectPdfLib = false;
      }
    }

    if (canUseDirectPdfLib && originalDoc) {
      // --- Strategy A: Direct Overlay onto Original Vector Pages ---
      for (let p = 1; p <= state.totalPages; p++) {
        showExportProgress(true, `正在合成第 ${p} / ${state.totalPages} 页修改...`);
        const overlayPngUrl = await generatePageOverlayPng(p);
        if (overlayPngUrl) {
          const embeddedImage = await originalDoc.embedPng(overlayPngUrl);
          const pdfPage = originalDoc.getPage(p - 1);
          const { width, height } = pdfPage.getSize();
          pdfPage.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: width,
            height: height,
          });
        }
      }
      showExportProgress(true, '正在封装保存已修改的 PDF...');
      finalPdfBytes = await originalDoc.save();
    } else {
      // --- Strategy B: Decrypted PDF Reconstruction ---
      // PDF.js has already decrypted every single page with the password!
      // We render high-resolution 2x composite pages and build a brand-new, 100% UNLOCKED PDF!
      showExportProgress(true, '正在生成已解除密码的无密码纯净 PDF...');
      const newDoc = await PDFLib.PDFDocument.create();

      for (let p = 1; p <= state.totalPages; p++) {
        showExportProgress(true, `正在解密并合成第 ${p} / ${state.totalPages} 页...`);
        const composite = await renderDecryptedPageComposite(p);
        const embeddedImage = await newDoc.embedPng(composite.dataUrl);
        const newPage = newDoc.addPage([composite.widthPt, composite.heightPt]);
        newPage.drawImage(embeddedImage, {
          x: 0,
          y: 0,
          width: composite.widthPt,
          height: composite.heightPt,
        });
      }

      showExportProgress(true, '正在导出已解密的无密码 PDF...');
      finalPdfBytes = await newDoc.save();
    }

    // Trigger Browser Download
    const blob = new Blob([finalPdfBytes], { type: 'application/pdf' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const baseName = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    a.download = `${baseName}_已修改.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    showExportProgress(false);
    
    // Confetti celebration
    if (window.confetti) {
      window.confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
    }
    showToast('导出成功！已保存为可直接打开的新 PDF', 'success');
  } catch (err) {
    console.error('Export failed:', err);
    showExportProgress(false);
    showToast('导出失败: ' + err.message, 'error');
  }
}

// Generates transparent overlay PNG for a single page
async function generatePageOverlayPng(pageNum) {
  if (pageNum === state.currentPage && fabricCanvas) {
    if (fabricCanvas.getObjects().length === 0) return null;
    return fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
  }

  const jsonState = state.pageStates[pageNum];
  if (!jsonState || !jsonState.objects || jsonState.objects.length === 0) {
    return null;
  }

  return new Promise(resolve => {
    const tempCanvas = document.createElement('canvas');
    const staticCanvas = new fabric.StaticCanvas(tempCanvas);
    staticCanvas.setWidth(state.baseWidth);
    staticCanvas.setHeight(state.baseHeight);

    staticCanvas.loadFromJSON(jsonState, () => {
      staticCanvas.renderAll();
      const url = staticCanvas.toDataURL({ format: 'png', multiplier: 1 });
      staticCanvas.dispose();
      resolve(url);
    });
  });
}

// Renders decrypted base PDF + Fabric overlay at 2x crisp resolution
async function renderDecryptedPageComposite(pageNum) {
  const page = await state.pdfDoc.getPage(pageNum);
  const ptViewport = page.getViewport({ scale: 1.0 });
  const renderViewport = page.getViewport({ scale: 2.0 }); // 2x DPI

  const offscreen = document.createElement('canvas');
  offscreen.width = renderViewport.width;
  offscreen.height = renderViewport.height;
  const ctx = offscreen.getContext('2d');

  // 1. Render decrypted PDF base
  await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

  // 2. Render fabric modifications on top
  const jsonState = (pageNum === state.currentPage && fabricCanvas) 
    ? fabricCanvas.toJSON(['data', 'isMask', 'isText']) 
    : state.pageStates[pageNum];

  if (jsonState && jsonState.objects && jsonState.objects.length > 0) {
    await new Promise(resolve => {
      const fabricOffscreen = document.createElement('canvas');
      const staticCanvas = new fabric.StaticCanvas(fabricOffscreen);
      staticCanvas.setWidth(renderViewport.width);
      staticCanvas.setHeight(renderViewport.height);
      staticCanvas.setZoom(2.0 / state.baseScale);

      staticCanvas.loadFromJSON(jsonState, () => {
        staticCanvas.renderAll();
        ctx.drawImage(fabricOffscreen, 0, 0);
        staticCanvas.dispose();
        resolve();
      });
    });
  }

  return {
    dataUrl: offscreen.toDataURL('image/png'),
    widthPt: ptViewport.width,
    heightPt: ptViewport.height,
  };
}

function showExportProgress(show, text = '') {
  if (show) {
    elements.exportProgressText.textContent = text;
    elements.exportProgressModal.classList.remove('hidden');
  } else {
    elements.exportProgressModal.classList.add('hidden');
  }
}

// ==========================================
// 12. Setup UI Event Listeners
// ==========================================
function setupEventListeners() {
  // File Upload Handlers
  const handleFile = (file) => {
    if (!file || file.type !== 'application/pdf') {
      showToast('请选择有效的 PDF 文件', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      openPdfFile(e.target.result, file.name);
    };
    reader.readAsArrayBuffer(file);
  };

  elements.btnOpenPdf.addEventListener('click', () => elements.pdfFileInput.click());
  elements.btnDropzoneUpload.addEventListener('click', () => elements.pdfFileInput.click());
  elements.pdfFileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag and drop onto empty state
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  // Demo Samples
  elements.btnLoadSampleContract.addEventListener('click', async () => {
    try {
      showToast('正在加载商务合作协议样例...', 'info');
      const res = await fetch('./sample/contract-sample.pdf');
      const buf = await res.arrayBuffer();
      openPdfFile(buf, '商务合作协议_样例.pdf');
    } catch (e) {
      showToast('加载测试样例失败: ' + e.message, 'error');
    }
  });

  elements.btnLoadSampleEncrypted.addEventListener('click', async () => {
    try {
      showToast('正在加载密码保护样例 (密码: test)...', 'info');
      const res = await fetch('./sample/encrypted-sample.pdf');
      const buf = await res.arrayBuffer();
      openPdfFile(buf, '加密文档_样例.pdf');
    } catch (e) {
      showToast('加载测试样例失败: ' + e.message, 'error');
    }
  });

  // Pagination
  elements.btnPrevPage.addEventListener('click', () => {
    if (state.currentPage > 1) renderPage(state.currentPage - 1);
  });
  elements.btnNextPage.addEventListener('click', () => {
    if (state.currentPage < state.totalPages) renderPage(state.currentPage + 1);
  });

  // Mode Switch
  elements.btnModeBrowse.addEventListener('click', () => setMode('browse'));
  elements.btnModeEdit.addEventListener('click', () => setMode('edit'));

  // Quick Zoom HUD
  elements.btnZoomIn.addEventListener('click', () => setZoom(state.currentZoom + 0.25));
  elements.btnZoomOut.addEventListener('click', () => setZoom(state.currentZoom - 0.25));
  elements.btnZoomReset.addEventListener('click', () => setZoom(1.0));
  elements.btnZoomFit.addEventListener('click', () => fitToScreenWidth());
  elements.btnZoom200.addEventListener('click', () => setZoom(2.0));

  // Bottom Toolbar Tools
  elements.toolBrowse.addEventListener('click', () => setTool('browse'));
  elements.toolCoverEdit.addEventListener('click', () => setTool('cover-edit'));
  elements.toolAddText.addEventListener('click', () => {
    setTool('add-text');
    addSimpleText();
  });
  elements.toolSignature.addEventListener('click', () => {
    elements.signatureModal.classList.remove('hidden');
    clearSignature();
  });
  elements.toolBrush.addEventListener('click', () => setTool('brush'));
  elements.toolMask.addEventListener('click', () => setTool('mask'));
  elements.imageUploadInput.addEventListener('change', handleImageUpload);

  // Undo Button
  elements.btnUndo.addEventListener('click', () => {
    if (!fabricCanvas) return;
    const objects = fabricCanvas.getObjects();
    if (objects.length > 0) {
      fabricCanvas.remove(objects[objects.length - 1]);
      saveCurrentPageState(state.currentPage);
      fabricCanvas.requestRenderAll();
      showToast('已撤销上一步操作', 'info');
    } else {
      showToast('当前页暂无操作可撤销', 'info');
    }
  });

  // Export Button
  elements.btnExportPdf.addEventListener('click', exportModifiedPdf);

  // Password Modal Form
  elements.passwordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitPassword();
  });
  elements.btnCancelPassword.addEventListener('click', hidePasswordModal);
  elements.btnTogglePasswordVisibility.addEventListener('click', () => {
    const isPass = (elements.passwordInput.type === 'password');
    elements.passwordInput.type = isPass ? 'text' : 'password';
    elements.btnTogglePasswordVisibility.innerHTML = isPass 
      ? '<i class="fa-regular fa-eye-slash text-sm"></i>' 
      : '<i class="fa-regular fa-eye text-sm"></i>';
  });

  // Signature Modal Events
  elements.btnCloseSignature.addEventListener('click', () => elements.signatureModal.classList.add('hidden'));
  elements.btnCancelSignature.addEventListener('click', () => elements.signatureModal.classList.add('hidden'));
  elements.btnClearSignature.addEventListener('click', clearSignature);
  elements.btnConfirmSignature.addEventListener('click', insertSignature);
  document.querySelectorAll('.sig-color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sig-color-btn').forEach(b => b.classList.remove('border-2', 'border-blue-500'));
      btn.classList.add('border-2', 'border-blue-500');
      sigPenColor = btn.dataset.color;
      if (sigCtx) sigCtx.strokeStyle = sigPenColor;
    });
  });

  // Property Bar Events
  elements.btnFontMinus.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fontSize', Math.max(10, (obj.fontSize || 16) - 2));
      elements.labelFontSize.textContent = Math.round(obj.fontSize);
      fabricCanvas.requestRenderAll();
    }
  });
  elements.btnFontPlus.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fontSize', Math.min(72, (obj.fontSize || 16) + 2));
      elements.labelFontSize.textContent = Math.round(obj.fontSize);
      fabricCanvas.requestRenderAll();
    }
  });
  elements.btnTextBold.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      const isBold = (obj.fontWeight === 'bold');
      obj.set('fontWeight', isBold ? 'normal' : 'bold');
      updatePropertyBar();
      fabricCanvas.requestRenderAll();
    }
  });
  elements.inputTextColor.addEventListener('input', (e) => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fill', e.target.value);
      fabricCanvas.requestRenderAll();
    }
  });
  document.querySelectorAll('.text-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      const obj = fabricCanvas?.getActiveObject();
      if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
        obj.set('fill', color);
        elements.inputTextColor.value = color;
        fabricCanvas.requestRenderAll();
      }
    });
  });

  // Mask Color Swatches
  elements.inputMaskColor.addEventListener('input', (e) => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj) {
      obj.set('fill', e.target.value);
      fabricCanvas.requestRenderAll();
    }
  });
  document.querySelectorAll('.mask-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      const obj = fabricCanvas?.getActiveObject();
      if (obj) {
        obj.set('fill', color);
        elements.inputMaskColor.value = color;
        fabricCanvas.requestRenderAll();
      }
    });
  });

  // Brush Controls
  elements.brushWidthSlider.addEventListener('input', (e) => {
    state.brushWidth = e.target.value;
    if (fabricCanvas?.freeDrawingBrush) {
      fabricCanvas.freeDrawingBrush.width = parseInt(e.target.value, 10);
    }
  });
  document.querySelectorAll('.brush-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      state.brushColor = btn.dataset.color;
      if (fabricCanvas?.freeDrawingBrush) {
        fabricCanvas.freeDrawingBrush.color = state.brushColor;
      }
    });
  });

  // Delete Selected Object
  elements.btnDeleteSelected.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj) {
      // If linked mask exists, delete mask too
      if (obj.data?.linkedMaskId) {
        const mask = fabricCanvas.getObjects().find(o => o.data?.id === obj.data.linkedMaskId);
        if (mask) fabricCanvas.remove(mask);
      }
      fabricCanvas.remove(obj);
      fabricCanvas.discardActiveObject();
      saveCurrentPageState(state.currentPage);
      updatePropertyBar();
      fabricCanvas.requestRenderAll();
      showToast('已删除选中元素', 'info');
    }
  });

  // Keyboard Delete / Backspace support on desktop
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const activeObj = fabricCanvas?.getActiveObject();
      // Only delete if not actively typing inside a textbox
      if (activeObj && !activeObj.isEditing) {
        elements.btnDeleteSelected.click();
      }
    }
  });

  // Window resize handler
  window.addEventListener('resize', () => {
    if (state.pdfDoc && window.innerWidth < 768) {
      fitToScreenWidth();
    }
  });
}

// Initialize Application
function initApp() {
  setupEventListeners();
  initSignatureBoard();
  setupTouchAndPan();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
