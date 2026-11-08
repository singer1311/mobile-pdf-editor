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
  tool: 'tap-edit', // 'tap-edit' | 'cover-edit' | 'browse' | 'add-text' | 'signature' | 'brush' | 'mask' | 'select'

  // Per-page Fabric objects serialized storage & extracted text
  pageStates: {},
  pageTextLines: {},
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

// Expose state for inspection & debugging
window.state = state;

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
  btnConvertAllText: document.getElementById('btn-convert-all-text'),
  btnComparePreview: document.getElementById('btn-compare-preview'),
  btnRevertPage: document.getElementById('btn-revert-page'),
  smartEditTipBanner: document.getElementById('smart-edit-tip-banner'),
  btnCloseTipBanner: document.getElementById('btn-close-tip-banner'),
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
  toolTapEdit: document.getElementById('tool-tap-edit'),
  toolCoverEdit: document.getElementById('tool-cover-edit'),
  toolConvertPage: document.getElementById('tool-convert-page'),
  toolBrowse: document.getElementById('tool-browse'),
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

  // Compare & Fast Download Modal
  compareModal: document.getElementById('compare-modal'),
  comparePageNum: document.getElementById('compare-page-num'),
  btnCloseCompareModal: document.getElementById('btn-close-compare-modal'),
  tabCompareModified: document.getElementById('tab-compare-modified'),
  tabCompareOriginal: document.getElementById('tab-compare-original'),
  compareOriginalContainer: document.getElementById('compare-original-container'),
  compareModifiedContainer: document.getElementById('compare-modified-container'),
  compareOriginalImg: document.getElementById('compare-original-img'),
  compareModifiedImg: document.getElementById('compare-modified-img'),
  btnRevertCurrentPage: document.getElementById('btn-revert-current-page'),
  btnCancelCompare: document.getElementById('btn-cancel-compare'),
  btnFastDownloadPdf: document.getElementById('btn-fast-download-pdf'),

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
    if (elements.btnConvertAllText) {
      elements.btnConvertAllText.classList.remove('hidden');
      elements.btnConvertAllText.classList.add('flex');
    }
    if (elements.btnComparePreview) {
      elements.btnComparePreview.classList.remove('hidden');
      elements.btnComparePreview.classList.add('flex');
    }
    if (elements.btnRevertPage) {
      elements.btnRevertPage.classList.remove('hidden');
      elements.btnRevertPage.classList.add('flex');
    }
    if (elements.smartEditTipBanner) {
      elements.smartEditTipBanner.classList.remove('hidden');
      elements.smartEditTipBanner.classList.add('flex');
    }

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
      window.fabricCanvas = fabricCanvas;
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

    // 5.1 Pre-extract and cache text lines for smart Word-like click editing
    try {
      state.pageTextLines[pageNum] = await extractPageTextLines(page, viewport);
    } catch (e) {
      console.warn('Text extraction warning:', e);
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
  } else if (state.tool === 'tap-edit') {
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = 'text';
    fabricCanvas.hoverCursor = 'text';
    fabricCanvas.forEachObject(obj => {
      if (obj.data?.isMask) {
        obj.selectable = false;
        obj.evented = false;
      } else {
        obj.selectable = true;
        obj.evented = true;
      }
    });
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
// 6. Word-Like Direct Tap-To-Edit & Convert
// ==========================================
function setupFabricEventListeners() {
  // Mouse down / Touch start
  fabricCanvas.on('mouse:down', (opt) => {
    const pointer = opt.pointer || (opt.e ? fabricCanvas.getPointer(opt.e) : { x: 0, y: 0 });

    // 1. Smart Word-like "Tap to Edit"
    if (state.tool === 'tap-edit') {
      const activeObj = fabricCanvas.getActiveObject();

      // If an object is currently editing, check if user clicked outside its strict bounds
      if (activeObj && activeObj.isEditing) {
        const inActive = (
          pointer.x >= activeObj.left - 2 &&
          pointer.x <= activeObj.left + activeObj.getScaledWidth() + 2 &&
          pointer.y >= activeObj.top - 2 &&
          pointer.y <= activeObj.top + activeObj.getScaledHeight() + 2
        );

        if (!inActive) {
          activeObj.exitEditing();
          fabricCanvas.discardActiveObject();
        }
      }

      // Check all existing textboxes first (closest match)
      const textboxes = fabricCanvas.getObjects().filter(o => o.data?.isText);
      const hitBox = findClosestObject(textboxes, pointer);
      if (hitBox) {
        fabricCanvas.setActiveObject(hitBox);
        setTimeout(() => {
          hitBox.enterEditing();
          hitBox.hiddenTextarea?.focus();
          fabricCanvas.requestRenderAll();
        }, 30);
        return;
      }

      // If not an existing textbox, check extracted text lines from the PDF
      const lines = state.pageTextLines[state.currentPage] || [];
      const hitLine = findClosestTextLine(lines, pointer);

      if (hitLine) {
        // Check if an existing textbox already covers this line (by line ID or exact coordinate match)
        const existing = fabricCanvas.getObjects().find(o => 
          o.data?.isText &&
          (o.data?.lineId === hitLine.id ||
           (Math.abs(o.left - hitLine.left) < 6 && Math.abs(o.top - hitLine.top) < 4))
        );

        if (existing) {
          fabricCanvas.setActiveObject(existing);
          setTimeout(() => {
            existing.enterEditing();
            existing.hiddenTextarea?.focus();
            fabricCanvas.requestRenderAll();
          }, 30);
          return;
        }

        // Convert this specific text line to an in-place Word textbox immediately!
        convertLineToTextbox(hitLine, true);
        return;
      }
    }

    // 2. Cover & Edit / Pure Mask Rubberband Dragging
    if (state.tool === 'cover-edit' || state.tool === 'mask') {
      state.isDrawingBox = true;
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

    // 1. Smart dual-sample background and text color from PDF
    const colors = samplePdfColors(left, top, width, height);

    // 2. Create the solid mask rectangle
    const maskId = 'mask_' + Date.now();
    const maskRect = new fabric.Rect({
      left: left,
      top: top,
      width: width,
      height: height,
      fill: colors.bgColor,
      selectable: (state.tool === 'mask'),
      hasBorders: true,
      borderColor: '#94a3b8',
      cornerSize: 12,
      strokeWidth: 0,
      data: { isMask: true, id: maskId },
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
        fill: colors.textColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: state.isBold ? 'bold' : 'normal',
        editable: true,
        data: { isText: true, linkedMaskId: maskId },
      });

      fabricCanvas.add(textbox);
      fabricCanvas.setActiveObject(textbox);
      textbox.enterEditing();
      textbox.selectAll();

      showToast('已覆盖原文字，可直接打字替换！', 'info');
      setTool('tap-edit');
    } else {
      fabricCanvas.setActiveObject(maskRect);
      showToast('已生成遮罩块覆盖原内容！', 'info');
      setTool('select');
    }

    fabricCanvas.requestRenderAll();
  });

  // Double click / Tap to edit support for textboxes
  fabricCanvas.on('mouse:dblclick', (opt) => {
    if (opt.target && (opt.target.type === 'textbox' || opt.target.type === 'i-text')) {
      opt.target.enterEditing();
    }
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

// Find the closest interactive textbox to the pointer with generous finger tolerance
function findClosestObject(objects, pt) {
  if (!objects || objects.length === 0) return null;

  const candidates = [];

  for (const o of objects) {
    const w = o.getScaledWidth ? o.getScaledWidth() : (o.width || 0);
    const h = o.getScaledHeight ? o.getScaledHeight() : (o.height || 0);
    const centerY = o.top + h / 2;
    const vDist = Math.abs(pt.y - centerY);
    const maxV = Math.max(22, (o.fontSize || 16) * 1.35);

    if (vDist <= maxV) {
      const inX = (pt.x >= o.left - 18 && pt.x <= o.left + w + 22);
      let score = vDist;
      if (!inX) {
        const xDist = (pt.x < o.left) ? (o.left - pt.x) : (pt.x - (o.left + w));
        if (xDist > 40) continue;
        score += xDist * 1.5;
      }
      candidates.push({ obj: o, score, vDist });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].obj;
}

// Find the closest PDF extracted text line to the pointer with generous finger tolerance
function findClosestTextLine(lines, pt) {
  if (!lines || lines.length === 0) return null;

  const candidates = [];

  for (const line of lines) {
    const centerY = line.top + line.height / 2;
    const vDist = Math.abs(pt.y - centerY);
    const maxV = Math.max(22, line.canvasFontSize * 1.35);

    // If pointer is within vertical range of this line
    if (vDist <= maxV) {
      const inX = (pt.x >= line.left - 18 && pt.x <= line.left + line.width + 22);
      let score = vDist;
      if (!inX) {
        // If not directly inside X, penalize distance by horizontal offset
        const xDist = (pt.x < line.left) ? (line.left - pt.x) : (pt.x - (line.left + line.width));
        if (xDist > 40) continue; // Too far horizontally
        score += xDist * 1.5;
      }
      candidates.push({ line, score, vDist });
    }
  }

  if (candidates.length === 0) {
    // Fallback: check 2D distance to center of each line (within 45px)
    let bestLine = null;
    let minD = 45;
    for (const line of lines) {
      const cx = line.left + line.width / 2;
      const cy = line.top + line.height / 2;
      const d = Math.hypot(pt.x - cx, pt.y - cy);
      if (d < minD) {
        minD = d;
        bestLine = line;
      }
    }
    return bestLine;
  }

  // Pick the line with the lowest score (closest vertical & horizontal)
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].line;
}

// Convert a single extracted text line to a Word-like interactive in-place Textbox
function convertLineToTextbox(line, shouldEditImmediately = true) {
  // 1. Sample surrounding background color and text contrast color
  const colors = samplePdfColors(line.left, line.top, line.width, line.height);
  const isBoldFinal = Boolean(line.isBold);

  const maskId = 'mask_' + Math.random().toString(36).substr(2, 9);
  const textId = 'text_' + Math.random().toString(36).substr(2, 9);

  // 2. Solid background mask perfectly covers original PDF text (tight vertical bounds)
  const maskRect = new fabric.Rect({
    left: Math.max(0, line.left - 2),
    top: Math.max(0, line.top - 1),
    width: line.width + 4,
    height: Math.max(line.height + 2, line.canvasFontSize * 1.15),
    fill: colors.bgColor,
    selectable: false,
    evented: false,
    strokeWidth: 0,
    data: { isMask: true, id: maskId, lineId: line.id, linkedTextId: textId },
  });
  fabricCanvas.add(maskRect);

  // 3. In-place editable Textbox preserving original font size, color, weight, and font family
  const textbox = new fabric.Textbox(line.text, {
    left: line.left,
    top: line.top,
    width: Math.max(line.width + 8, 40),
    fontSize: line.canvasFontSize,
    fill: colors.textColor,
    fontFamily: line.fontFamily || 'system-ui, -apple-system, sans-serif',
    fontWeight: isBoldFinal ? 'bold' : 'normal',
    editable: true,
    hasBorders: true,
    borderColor: '#3b82f6',
    borderDashArray: [3, 3],
    borderScaleFactor: 1.0,
    padding: 0,            // 0 padding so vertical bounds do not collide with neighboring lines
    lineHeight: 1.05,      // compact line height so bottom doesn't cover the line below
    transparentCorners: false,
    cornerColor: '#2563eb',
    cornerSize: 8,         // compact handles
    touchCornerSize: 14,   // sensible touch radius, won't shadow adjacent lines
    data: {
      isText: true,
      id: textId,
      lineId: line.id,
      linkedMaskId: maskId,
      originalText: line.text,
      isBoldOriginal: isBoldFinal,
    },
  });

  fabricCanvas.add(textbox);

  if (shouldEditImmediately) {
    fabricCanvas.setActiveObject(textbox);
    setTimeout(() => {
      textbox.enterEditing();
      textbox.selectAll();
      textbox.hiddenTextarea?.focus();
      fabricCanvas.requestRenderAll();
    }, 50);
    showToast('已进入 Word 修改模式，直接打字替换！', 'info');
  }

  saveCurrentPageState(state.currentPage);
  fabricCanvas.requestRenderAll();
  return textbox;
}

// One-Click Word Mode: Convert all text lines on the current page to editable textboxes
async function convertAllTextToEditable() {
  if (!state.pdfDoc || !fabricCanvas) {
    showToast('请先打开 PDF 文件', 'error');
    return;
  }

  showToast('正在识别当前页文字，生成 Word 文本框...', 'info');

  let lines = state.pageTextLines[state.currentPage];
  if (!lines || lines.length === 0) {
    const page = await state.pdfDoc.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: state.baseScale });
    lines = await extractPageTextLines(page, viewport);
    state.pageTextLines[state.currentPage] = lines;
  }

  if (!lines || lines.length === 0) {
    showToast('当前页未检测到可选文字（可能是纯扫描图片）', 'warning');
    return;
  }

  let count = 0;
  for (const line of lines) {
    // Avoid creating duplicates if a textbox already covers this position
    const alreadyExists = fabricCanvas.getObjects().some(o => 
      o.data?.isText &&
      (o.data?.lineId === line.id || 
       (Math.abs(o.left - line.left) < 6 && Math.abs(o.top - line.top) < 4))
    );

    if (!alreadyExists) {
      convertLineToTextbox(line, false);
      count++;
    }
  }

  saveCurrentPageState(state.currentPage);
  setTool('tap-edit');
  fabricCanvas.requestRenderAll();

  if (count > 0) {
    showToast(`🎉 已将本页 ${count} 处文字全部转为 Word 文本框，直接点击文字即可修改！`, 'success');
    if (window.confetti) {
      window.confetti({ particleCount: 70, spread: 70, origin: { y: 0.8 } });
    }
  } else {
    showToast('本页文字已全部转为文本框，点击任意文字即可修改！', 'info');
  }
}

// Accurately detect whether a font is bold using PDF.js font descriptor metadata & name patterns
function isFontBold(page, fontName) {
  if (!fontName) return false;
  const fnLower = fontName.toLowerCase();
  if (
    fnLower.includes('bold') ||
    fnLower.includes('black') ||
    fnLower.includes('heavy') ||
    fnLower.includes('demi') ||
    fnLower.includes('semi') ||
    fnLower.endsWith('bd') ||
    fnLower.includes('-b') ||
    fnLower.includes('_b')
  ) {
    return true;
  }
  try {
    let fontObj = null;
    if (page?.commonObjs?.has && page.commonObjs.has(fontName)) {
      fontObj = page.commonObjs.get(fontName);
    } else if (page?.objs?.has && page.objs.has(fontName)) {
      fontObj = page.objs.get(fontName);
    }
    if (fontObj) {
      if (fontObj.bold === true || fontObj.black === true) return true;
      if (fontObj.weight && (fontObj.weight >= 600 || fontObj.weight === 'bold')) return true;
      const realName = (fontObj.name || fontObj.loadedName || fontObj.fallbackName || '').toLowerCase();
      if (
        realName.includes('bold') ||
        realName.includes('black') ||
        realName.includes('heavy') ||
        realName.includes('demi') ||
        realName.includes('semi') ||
        realName.endsWith('bd') ||
        realName.includes('-b') ||
        realName.includes('_b')
      ) {
        return true;
      }
    }
  } catch (e) {
    console.warn('isFontBold error:', e);
  }
  return false;
}

// Detect font family category (serif vs sans-serif vs monospace)
function detectFontFamily(page, fontName) {
  if (!fontName) return 'system-ui, -apple-system, sans-serif';
  try {
    let fontObj = null;
    if (page?.commonObjs?.has && page.commonObjs.has(fontName)) {
      fontObj = page.commonObjs.get(fontName);
    } else if (page?.objs?.has && page.objs.has(fontName)) {
      fontObj = page.objs.get(fontName);
    }
    if (fontObj) {
      if (fontObj.isMonospace) return 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      if (fontObj.isSerifFont) return 'Georgia, Cambria, "Times New Roman", Times, serif';
    }
  } catch (e) {}
  return 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
}

// Extract and cluster text items from PDF.js into coherent text lines
async function extractPageTextLines(page, viewport) {
  try {
    const textContent = await page.getTextContent();
    const rawItems = textContent.items.filter(it => it.str && it.str.trim().length > 0);
    if (rawItems.length === 0) return [];

    const items = rawItems.map(it => {
      const [vx, vy] = viewport.convertToViewportPoint(it.transform[4], it.transform[5]);
      const pdfFontSize = Math.hypot(it.transform[0], it.transform[1]) || 12;
      const canvasFontSize = Math.round(pdfFontSize * state.baseScale);
      const width = Math.max(it.width * state.baseScale, it.str.length * canvasFontSize * 0.52);
      const height = (it.height || pdfFontSize) * state.baseScale;
      const top = vy - canvasFontSize * 0.95;

      const isBold = isFontBold(page, it.fontName);
      const fontFamily = detectFontFamily(page, it.fontName);

      return {
        str: it.str,
        fontName: it.fontName || '',
        fontFamily,
        isBold,
        canvasFontSize,
        pdfFontSize,
        vx, vy,
        left: vx,
        top,
        width,
        height: Math.max(height, canvasFontSize * 1.15),
      };
    });

    // Sort items: top to bottom, then left to right
    items.sort((a, b) => {
      if (Math.abs(a.vy - b.vy) > 6) {
        return a.vy - b.vy;
      }
      return a.left - b.left;
    });

    const lines = [];
    let currentLine = null;

    for (const item of items) {
      if (!currentLine) {
        currentLine = { ...item, text: item.str, items: [item] };
        continue;
      }

      const sameBaseline = Math.abs(currentLine.vy - item.vy) <= Math.max(5, item.canvasFontSize * 0.35);
      const xGap = item.left - (currentLine.left + currentLine.width);
      const sameWeight = (currentLine.isBold === item.isBold);
      const fontDiff = Math.abs(currentLine.canvasFontSize - item.canvasFontSize);
      const sameFontSize = (fontDiff <= 2.5);
      const isWordAdjacent = (xGap >= -8 && xGap <= Math.min(20, item.canvasFontSize * 1.25));

      // Only merge if on the same baseline, reasonably close, SAME font size, and sharing the same bold style!
      // This strictly prevents merging across table columns (like '11/15/23' and '$82.71')!
      if (sameBaseline && sameWeight && sameFontSize && isWordAdjacent) {
        const addSpace = (xGap > 1 && !currentLine.text.endsWith(' ') && !item.str.startsWith(' ')) ? ' ' : '';
        currentLine.text += addSpace + item.str;
        currentLine.width = (item.left + item.width) - currentLine.left;
        currentLine.height = Math.max(currentLine.height, item.height);
        currentLine.canvasFontSize = Math.max(currentLine.canvasFontSize, item.canvasFontSize);
        currentLine.items.push(item);
      } else {
        currentLine.id = 'line_p' + (page.pageNumber || state.currentPage) + '_' + lines.length;
        lines.push(currentLine);
        currentLine = { ...item, text: item.str, items: [item] };
      }
    }
    if (currentLine) {
      currentLine.id = 'line_p' + (page.pageNumber || state.currentPage) + '_' + lines.length;
      lines.push(currentLine);
    }
    return lines;
  } catch (err) {
    console.warn('Failed to extract page text lines:', err);
    return [];
  }
}

// Smart dual-sampling: samples both perimeter background color and text contrast color
function samplePdfColors(left, top, width, height) {
  try {
    const pdfCanvas = elements.pdfCanvas;
    if (!pdfCanvas) return { bgColor: '#ffffff', textColor: '#111827' };
    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });

    const l = Math.max(0, Math.floor(left));
    const t = Math.max(0, Math.floor(top));
    const w = Math.min(pdfCanvas.width - l, Math.ceil(width));
    const h = Math.min(pdfCanvas.height - t, Math.ceil(height));

    if (w <= 0 || h <= 0) return { bgColor: '#ffffff', textColor: '#111827' };

    // 1. Perimeter sampling for true background color (points slightly outside bounding box)
    const perimeterPoints = [
      { x: l - 3, y: t - 3 },
      { x: l + Math.floor(w / 2), y: t - 3 },
      { x: l + w + 3, y: t - 3 },
      { x: l - 3, y: t + Math.floor(h / 2) },
      { x: l + w + 3, y: t + Math.floor(h / 2) },
      { x: l - 3, y: t + h + 3 },
      { x: l + Math.floor(w / 2), y: t + h + 3 },
      { x: l + w + 3, y: t + h + 3 },
    ];

    let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
    for (const p of perimeterPoints) {
      const px = Math.min(pdfCanvas.width - 1, Math.max(0, p.x));
      const py = Math.min(pdfCanvas.height - 1, Math.max(0, p.y));
      const pixel = ctx.getImageData(px, py, 1, 1).data;
      if (pixel[3] > 80) {
        bgR += pixel[0];
        bgG += pixel[1];
        bgB += pixel[2];
        bgCount++;
      }
    }

    let bg = { r: 255, g: 255, b: 255 };
    if (bgCount > 0) {
      bg = {
        r: Math.round(bgR / bgCount),
        g: Math.round(bgG / bgCount),
        b: Math.round(bgB / bgCount),
      };
      // Snap near-white document paper to pure white
      if (bg.r > 235 && bg.g > 235 && bg.b > 235) {
        bg = { r: 255, g: 255, b: 255 };
      }
    }

    // 2. Interior contrast sampling for text color
    const imgData = ctx.getImageData(l, t, w, h).data;
    let textR = 0, textG = 0, textB = 0, textCount = 0;

    for (let i = 0; i < imgData.length; i += 16) { // step by 4 pixels (16 bytes)
      const r = imgData[i], g = imgData[i + 1], b = imgData[i + 2], a = imgData[i + 3];
      if (a < 100) continue;
      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      if (dist > 38) { // Distinct contrast from background
        textR += r;
        textG += g;
        textB += b;
        textCount++;
      }
    }

    let text = { r: 17, g: 24, b: 39 };
    if (textCount > 0) {
      text = {
        r: Math.round(textR / textCount),
        g: Math.round(textG / textCount),
        b: Math.round(textB / textCount),
      };
    }

    // Verify text contrast against background to prevent washed-out / light-on-light text
    const bgBrightness = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
    const textBrightness = (text.r * 299 + text.g * 587 + text.b * 114) / 1000;
    if (bgBrightness > 150 && textBrightness > 110) {
      text = { r: 17, g: 24, b: 39 }; // Force dark ink on light background
    } else if (bgBrightness <= 150 && textBrightness < 140) {
      text = { r: 255, g: 255, b: 255 }; // Force white ink on dark background
    }

    const toHex = (c) => `#${((1 << 24) + (c.r << 16) + (c.g << 8) + c.b).toString(16).slice(1)}`;
    return {
      bgColor: toHex(bg),
      textColor: toHex(text),
    };
  } catch (err) {
    console.warn('samplePdfColors error:', err);
    return { bgColor: '#ffffff', textColor: '#111827' };
  }
}

function samplePdfBackgroundColor(left, top, width, height) {
  return samplePdfColors(left, top, width, height).bgColor;
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
// 12. Before & After Comparison & Revert
// ==========================================
async function openCompareModal() {
  if (!state.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error');
    return;
  }

  showToast('正在生成对比预览...', 'info');

  try {
    saveCurrentPageState(state.currentPage);
    elements.comparePageNum.textContent = state.currentPage;

    // 1. Render pristine original PDF page without any Fabric modifications
    const page = await state.pdfDoc.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: 1.5 });
    const origCanvas = document.createElement('canvas');
    origCanvas.width = viewport.width;
    origCanvas.height = viewport.height;
    const origCtx = origCanvas.getContext('2d');
    await page.render({ canvasContext: origCtx, viewport }).promise;
    elements.compareOriginalImg.src = origCanvas.toDataURL('image/png');

    // 2. Render modified composite page (original PDF + Fabric modifications)
    const compCanvas = document.createElement('canvas');
    compCanvas.width = viewport.width;
    compCanvas.height = viewport.height;
    const compCtx = compCanvas.getContext('2d');
    compCtx.drawImage(origCanvas, 0, 0);

    if (fabricCanvas) {
      const fabricDataUrl = fabricCanvas.toDataURL({
        format: 'png',
        multiplier: 1.0 / state.currentZoom,
      });
      await new Promise((resolve) => {
        const overlayImg = new Image();
        overlayImg.onload = () => {
          compCtx.drawImage(overlayImg, 0, 0, viewport.width, viewport.height);
          resolve();
        };
        overlayImg.src = fabricDataUrl;
      });
    }
    elements.compareModifiedImg.src = compCanvas.toDataURL('image/png');

    // 3. Show modal & handle responsive visibility
    elements.compareModal.classList.remove('hidden');

    if (window.innerWidth >= 768) {
      elements.compareModifiedContainer.classList.remove('hidden');
      elements.compareOriginalContainer.classList.remove('hidden');
    } else {
      switchCompareTab('modified');
    }
  } catch (err) {
    console.error('Error generating comparison:', err);
    showToast('生成对比失败: ' + err.message, 'error');
  }
}

function closeCompareModal() {
  elements.compareModal.classList.add('hidden');
}

function switchCompareTab(tab) {
  if (window.innerWidth >= 768) {
    elements.compareModifiedContainer.classList.remove('hidden');
    elements.compareOriginalContainer.classList.remove('hidden');
    return;
  }
  if (tab === 'modified') {
    elements.tabCompareModified.className = 'px-3 py-1.5 rounded-md bg-white text-blue-600 shadow-sm transition';
    elements.tabCompareOriginal.className = 'px-3 py-1.5 rounded-md text-slate-600 hover:text-slate-900 transition';
    elements.compareModifiedContainer.classList.remove('hidden');
    elements.compareOriginalContainer.classList.add('hidden');
  } else {
    elements.tabCompareOriginal.className = 'px-3 py-1.5 rounded-md bg-white text-blue-600 shadow-sm transition';
    elements.tabCompareModified.className = 'px-3 py-1.5 rounded-md text-slate-600 hover:text-slate-900 transition';
    elements.compareOriginalContainer.classList.remove('hidden');
    elements.compareModifiedContainer.classList.add('hidden');
  }
}

// Revert current page to pure untouched original PDF
function revertCurrentPage() {
  const confirmed = confirm('确定要将当前页一键还原回原始 PDF 吗？\n当前页的所有修改（文字替换、遮罩、批注）都将被撤销并恢复原样。');
  if (!confirmed) return;

  if (fabricCanvas) {
    fabricCanvas.clear();
  }
  delete state.pageStates[state.currentPage];
  delete state.historyStack[state.currentPage];

  closeCompareModal();
  saveCurrentPageState(state.currentPage);
  fabricCanvas.requestRenderAll();
  showToast('当前页已一键转回原始 PDF 原貌！', 'success');
}

// ==========================================
// 13. Setup UI Event Listeners
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

  // Word Mode & Direct Edit Buttons
  if (elements.btnConvertAllText) {
    elements.btnConvertAllText.addEventListener('click', convertAllTextToEditable);
  }
  if (elements.btnComparePreview) {
    elements.btnComparePreview.addEventListener('click', openCompareModal);
  }
  if (elements.btnRevertPage) {
    elements.btnRevertPage.addEventListener('click', revertCurrentPage);
  }
  if (elements.toolConvertPage) {
    elements.toolConvertPage.addEventListener('click', convertAllTextToEditable);
  }
  if (elements.toolTapEdit) {
    elements.toolTapEdit.addEventListener('click', () => setTool('tap-edit'));
  }
  if (elements.btnCloseTipBanner) {
    elements.btnCloseTipBanner.addEventListener('click', () => {
      elements.smartEditTipBanner.classList.add('hidden');
    });
  }

  // Compare & Fast Download Modal Listeners
  if (elements.btnCloseCompareModal) {
    elements.btnCloseCompareModal.addEventListener('click', closeCompareModal);
  }
  if (elements.btnCancelCompare) {
    elements.btnCancelCompare.addEventListener('click', closeCompareModal);
  }
  if (elements.tabCompareModified) {
    elements.tabCompareModified.addEventListener('click', () => switchCompareTab('modified'));
  }
  if (elements.tabCompareOriginal) {
    elements.tabCompareOriginal.addEventListener('click', () => switchCompareTab('original'));
  }
  if (elements.btnRevertCurrentPage) {
    elements.btnRevertCurrentPage.addEventListener('click', revertCurrentPage);
  }
  if (elements.btnFastDownloadPdf) {
    elements.btnFastDownloadPdf.addEventListener('click', () => {
      closeCompareModal();
      exportModifiedPdf();
    });
  }

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
      saveCurrentPageState(state.currentPage);
    }
  });
  elements.btnFontPlus.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fontSize', Math.min(72, (obj.fontSize || 16) + 2));
      elements.labelFontSize.textContent = Math.round(obj.fontSize);
      fabricCanvas.requestRenderAll();
      saveCurrentPageState(state.currentPage);
    }
  });
  elements.btnTextBold.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      const isBold = (obj.fontWeight === 'bold');
      const targetWeight = isBold ? 'normal' : 'bold';
      obj.set('fontWeight', targetWeight);
      if (obj.isEditing && obj.selectionStart !== obj.selectionEnd) {
        obj.setSelectionStyles({ fontWeight: targetWeight });
      }
      updatePropertyBar();
      fabricCanvas.requestRenderAll();
      saveCurrentPageState(state.currentPage);
      showToast(isBold ? '已取消加粗' : '已设置为加粗', 'info');
    }
  });
  elements.inputTextColor.addEventListener('input', (e) => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fill', e.target.value);
      fabricCanvas.requestRenderAll();
      saveCurrentPageState(state.currentPage);
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
        saveCurrentPageState(state.currentPage);
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

// Expose functions for debugging & tests
window.openPdfFile = openPdfFile;
window.openCompareModal = openCompareModal;
window.revertCurrentPage = revertCurrentPage;
window.exportModifiedPdf = exportModifiedPdf;
window.convertAllTextToEditable = convertAllTextToEditable;

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
