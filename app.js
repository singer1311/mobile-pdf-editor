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

// Custom Fabric properties preserved across page switches, drafts, and PDF export
const SERIALIZE_PROPS = [
  'data',
  'isMask',
  'isText',
  'selectable',
  'evented',
  'editable',
  'padding',
  'borderColor',
  'borderDashArray',
  'borderScaleFactor',
  'cornerColor',
  'cornerSize',
  'touchCornerSize',
  'transparentCorners',
];

let _measureCanvas = null;
function measureTextLineWidth(text, fontSize = 16, fontWeight = 'normal', fontFamily = 'system-ui, -apple-system, sans-serif') {
  try {
    if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
    const ctx = _measureCanvas.getContext('2d');
    ctx.font = `${fontWeight || 'normal'} ${fontSize || 16}px ${fontFamily || 'system-ui, -apple-system, sans-serif'}`;
    let maxW = 0;
    for (const line of String(text || '').split('\n')) {
      const w = ctx.measureText(line).width;
      if (w > maxW) maxW = w;
    }
    return maxW;
  } catch (e) {
    return String(text || '').length * (fontSize || 16) * 0.55;
  }
}

// Ensures serialized Fabric JSON is 100% valid for Fabric 5.3.1 loadFromJSON (prevents stylesToArray/stylesFromArray crashes)
function normalizePageStateJson(pageState) {
  if (!pageState || typeof pageState !== 'object') return pageState;
  const cloned = JSON.parse(JSON.stringify(pageState));
  delete cloned.viewportTransform;
  if (!Array.isArray(cloned.objects)) {
    cloned.objects = [];
    return cloned;
  }
  cloned.objects.forEach(o => {
    if (!o || typeof o !== 'object') return;
    if (o.type === 'textbox' || o.type === 'i-text' || o.type === 'text') {
      o.styles = Array.isArray(o.styles) ? o.styles.filter(Boolean) : [];
      if (o.padding === undefined) o.padding = 0;
      if (!o.lineHeight) o.lineHeight = 1.05;
    }
    if (o.data?.isMask && o.data?.linkedTextId) {
      o.selectable = false;
      o.evented = false;
    }
  });
  return cloned;
}

function normalizeAllPageStates(pageStates) {
  if (!pageStates || typeof pageStates !== 'object') return {};
  const result = {};
  for (const [pageKey, st] of Object.entries(pageStates)) {
    if (st) result[pageKey] = normalizePageStateJson(st);
  }
  return result;
}

// Ensures live Fabric Canvas / StaticCanvas objects never have undefined/invalid styles before toJSON()
function sanitizeFabricCanvasObjects(targetCanvas) {
  if (!targetCanvas || typeof targetCanvas.getObjects !== 'function') return;
  targetCanvas.getObjects().forEach(o => {
    if (o.type === 'textbox' || o.type === 'i-text' || o.type === 'text') {
      if (!o.styles || typeof o.styles !== 'object' || Array.isArray(o.styles)) {
        o.styles = {};
      }
    }
    if (o.data?.isMask && o.data?.linkedTextId && targetCanvas === fabricCanvas && state.tool !== 'mask') {
      o.selectable = false;
      o.evented = false;
    }
  });
}

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
  btnBatchReplace: document.getElementById('btn-batch-replace'),
  toolBatchReplace: document.getElementById('tool-batch-replace'),
  btnReplaceThisText: document.getElementById('btn-replace-this-text'),
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
  textBgPropControls: document.getElementById('text-bg-prop-controls'),
  inputTextBgColor: document.getElementById('input-text-bg-color'),
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

  // Batch Replace Modal
  modalBatchReplace: document.getElementById('modal-batch-replace'),
  btnCloseReplaceModal: document.getElementById('btn-close-replace-modal'),
  btnCancelReplace: document.getElementById('btn-cancel-replace'),
  btnExecuteReplace: document.getElementById('btn-execute-replace'),
  inputReplaceFind: document.getElementById('input-replace-find'),
  inputReplaceTarget: document.getElementById('input-replace-target'),
  replaceMatchCountBadge: document.getElementById('replace-match-count-badge'),
  replacePreviewContainer: document.getElementById('replace-preview-container'),
  replacePreviewList: document.getElementById('replace-preview-list'),
  chkReplaceExact: document.getElementById('chk-replace-exact'),
  btnClearReplaceFind: document.getElementById('btn-clear-replace-find'),

  // Draft Recovery Banner
  draftRecoveryBanner: document.getElementById('draft-recovery-banner'),
  draftRecoveryText: document.getElementById('draft-recovery-text'),
  btnRestoreDraft: document.getElementById('btn-restore-draft'),
  btnDiscardDraft: document.getElementById('btn-discard-draft'),

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
async function openPdfFile(arrayBuffer, fileName = 'document.pdf', password = '', initialPageStates = null) {
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
    state.pageStates = initialPageStates ? normalizeAllPageStates(initialPageStates) : {}; // Restore & self-heal draft edits if present
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
    if (elements.btnBatchReplace) {
      elements.btnBatchReplace.classList.remove('hidden');
      elements.btnBatchReplace.classList.add('flex');
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
    if (fabricCanvas) {
      fabricCanvas.clear();
    }
    await renderPage(1, true);
    
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
let isTransitioningPage = false;

async function renderPage(pageNum, skipSaveCurrent = false) {
  if (!state.pdfDoc || isRendering) return;
  isRendering = true;

  try {
    // 1. Save previous page's Fabric objects BEFORE changing currentPage or clearing canvas
    if (!skipSaveCurrent && fabricCanvas && state.currentPage) {
      saveCurrentPageState(state.currentPage);
    }

    isTransitioningPage = true;

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

    // 4. Initialize or clear Fabric Overlay Canvas atomically with currentPage update
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

    state.currentPage = pageNum;
    updatePaginationUI();

    fabricCanvas.setWidth(state.baseWidth);
    fabricCanvas.setHeight(state.baseHeight);

    // 5. Restore saved objects for this page
    if (state.pageStates[pageNum]) {
      const normalizedState = normalizePageStateJson(state.pageStates[pageNum]);
      state.pageStates[pageNum] = normalizedState;
      await new Promise(resolve => {
        fabricCanvas.loadFromJSON(normalizedState, () => {
          sanitizeFabricCanvasObjects(fabricCanvas);
          isTransitioningPage = false;
          sanitizeMaskColors();
          fabricCanvas.renderAll();
          resolve();
        });
      });
    } else {
      isTransitioningPage = false;
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
    isTransitioningPage = false;
    isRendering = false;
  }
}

function saveCurrentPageState(pageNum) {
  if (!fabricCanvas || isTransitioningPage) return;
  const p = pageNum || state.currentPage;
  sanitizeFabricCanvasObjects(fabricCanvas);
  const json = fabricCanvas.toJSON(SERIALIZE_PROPS);
  delete json.viewportTransform;
  state.pageStates[p] = normalizePageStateJson(json);
  saveDraftToStorage();
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
    fabricCanvas.forEachObject(obj => {
      if (obj.data?.isMask && obj.data?.linkedTextId && state.tool !== 'mask') {
        obj.selectable = false;
        obj.evented = false;
      } else {
        obj.selectable = true;
        obj.evented = true;
      }
    });
  } else {
    fabricCanvas.selection = true;
    fabricCanvas.defaultCursor = 'default';
    fabricCanvas.hoverCursor = 'move';
    fabricCanvas.forEachObject(obj => {
      if (obj.data?.isMask && obj.data?.linkedTextId) {
        obj.selectable = false;
        obj.evented = false;
      } else {
        obj.selectable = true;
        obj.evented = true;
      }
    });
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

      const initialWidth = Math.max(width + 20, 100);
      const textbox = new fabric.Textbox('点击输入修改文字', {
        left: left,
        top: top + Math.max(0, (height - calculatedFontSize * 1.25) / 2),
        width: initialWidth,
        fontSize: calculatedFontSize,
        fill: colors.textColor,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontWeight: state.isBold ? 'bold' : 'normal',
        splitByGrapheme: true,
        editable: true,
        data: {
          isText: true,
          linkedMaskId: maskId,
          initialWidth: initialWidth,
          initialMaskWidth: width,
        },
      });

      textbox.on('changed', () => updateTextDimensionsAndMask(textbox));
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

  // Auto-expand textbox width and linked mask dynamically as user types!
  fabricCanvas.on('text:changed', (opt) => {
    if (opt.target && opt.target.data?.isText) {
      updateTextDimensionsAndMask(opt.target);
    }
  });

  // Object modified (for history)
  fabricCanvas.on('object:modified', () => {
    saveCurrentPageState(state.currentPage);
  });
}

// Detect if the text is inside a colored container (e.g. a dark blue header card or pastel callout box) and find its right boundary
function findContainerRightBoundary(left, top, width, maskColor, sourceCanvas = null, height = 14) {
  try {
    const pdfCanvas = sourceCanvas || elements.pdfCanvas;
    if (!pdfCanvas || !maskColor) return 0;
    // White masks on white paper never visually protrude; allow free expansion over neighboring text
    if (maskColor.toLowerCase() === '#ffffff') return 0;

    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });

    let targetR, targetG, targetB;
    if (maskColor.startsWith('#') && (maskColor.length === 7 || maskColor.length === 4)) {
      const hex = maskColor.replace('#', '');
      const step = hex.length === 3 ? 1 : 2;
      targetR = parseInt(hex.substring(0, step), 16) * (hex.length === 3 ? 17 : 1);
      targetG = parseInt(hex.substring(step, step * 2), 16) * (hex.length === 3 ? 17 : 1);
      targetB = parseInt(hex.substring(step * 2, step * 3), 16) * (hex.length === 3 ? 17 : 1);
    } else {
      return 0;
    }

    // Scan from just inside the left edge so even previously oversized masks snap to the true container edge
    const scanStartX = Math.max(0, Math.round(left + Math.min(width || 12, 12)));
    const maxScanLen = Math.min(600, pdfCanvas.width - scanStartX);
    if (maxScanLen <= 3) return 0;

    const h = Math.max(4, Math.round(height || 14));
    const y1 = Math.min(pdfCanvas.height - 1, Math.max(0, Math.round(top + 1)));
    const y2 = Math.min(pdfCanvas.height - 1, Math.max(0, Math.round(top + h * 0.5)));
    const y3 = Math.min(pdfCanvas.height - 1, Math.max(0, Math.round(top + h - 2)));

    const row1 = ctx.getImageData(scanStartX, y1, maxScanLen, 1).data;
    const row2 = ctx.getImageData(scanStartX, y2, maxScanLen, 1).data;
    const row3 = ctx.getImageData(scanStartX, y3, maxScanLen, 1).data;

    const isOutside = (row, idx) => {
      const i = idx * 4;
      const diff = Math.abs(row[i] - targetR) + Math.abs(row[i + 1] - targetG) + Math.abs(row[i + 2] - targetB);
      return diff > 22;
    };

    // Require 3 consecutive X columns where top, middle, and bottom all exit the container fill
    for (let i = 0; i < maxScanLen - 2; i++) {
      if (
        isOutside(row1, i) && isOutside(row2, i) && isOutside(row3, i) &&
        isOutside(row1, i + 1) && isOutside(row2, i + 1) && isOutside(row3, i + 1) &&
        isOutside(row1, i + 2) && isOutside(row2, i + 2) && isOutside(row3, i + 2)
      ) {
        const edgeX = scanStartX + i;
        return Math.max(8, Math.floor(edgeX - left));
      }
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

// Automatically expand textbox width and linked background mask as the user types
function updateTextDimensionsAndMask(obj) {
  if (!obj || !obj.data?.isText) return;

  // 1. Calculate true text width across all lines
  const maxLineWidth = measureTextLineWidth(
    obj.text || '',
    obj.fontSize || 16,
    obj.fontWeight || 'normal',
    obj.fontFamily || 'system-ui, -apple-system, sans-serif'
  );

  // 2. Expand textbox width for cursor room, transparent so zero visual side-effects
  const baseWidth = obj.data.initialWidth || 50;
  const desiredWidth = Math.max(baseWidth, Math.ceil(maxLineWidth + 16));
  if (desiredWidth > obj.width) {
    obj.set('width', desiredWidth);
    if (obj.initDimensions) obj.initDimensions();
  }

  // 3. Mask width: Tightly fitted to text, NEVER oversized, NEVER sticking out of containers!
  if (obj.data?.linkedMaskId && fabricCanvas) {
    const mask = fabricCanvas.getObjects().find(o => o.data?.id === obj.data.linkedMaskId);
    if (mask) {
      const origMaskWidth = obj.data.initialMaskWidth || mask.data?.initialMaskWidth || mask.width;
      const isModified = (obj.data.originalText === undefined || obj.text !== obj.data.originalText);

      // Only expand mask beyond original PDF ink width when user actually modified the text and made it wider
      let targetMaskWidth = origMaskWidth;
      if (isModified && maxLineWidth > origMaskWidth - 1) {
        targetMaskWidth = Math.ceil(maxLineWidth + 2);
      }

      // Clamp to container right boundary if inside a colored card/block
      const maxAllowed = findContainerRightBoundary(mask.left, mask.top, origMaskWidth, mask.fill, null, mask.height);
      if (maxAllowed > 0 && targetMaskWidth > maxAllowed) {
        targetMaskWidth = maxAllowed;
      }

      mask.set({
        width: targetMaskWidth,
        height: Math.max(mask.height, (obj.getScaledHeight ? obj.getScaledHeight() : obj.height) + 1),
      });
    }
  }

  saveCurrentPageState(state.currentPage);
  if (fabricCanvas) fabricCanvas.requestRenderAll();
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
  const fontFamilyFinal = line.fontFamily || 'system-ui, -apple-system, sans-serif';

  const maskId = 'mask_' + Math.random().toString(36).substr(2, 9);
  const textId = 'text_' + Math.random().toString(36).substr(2, 9);

  const maskTop = Math.max(0, line.top - 1);
  const maskHeight = Math.max(line.height + 2, line.canvasFontSize * 1.15);
  let initialMaskWidth = line.width;
  const maxAllowedMask = findContainerRightBoundary(line.left, maskTop, initialMaskWidth, colors.bgColor, null, maskHeight);
  if (maxAllowedMask > 0 && initialMaskWidth > maxAllowedMask) {
    initialMaskWidth = maxAllowedMask;
  }

  // 2. Solid background mask perfectly covers original PDF text (tight bounds)
  const maskRect = new fabric.Rect({
    left: line.left,
    top: maskTop,
    width: initialMaskWidth,
    height: maskHeight,
    fill: colors.bgColor,
    selectable: false,
    evented: false,
    strokeWidth: 0,
    data: { 
      isMask: true, 
      id: maskId, 
      lineId: line.id, 
      linkedTextId: textId,
      initialMaskWidth: initialMaskWidth,
      initialLeft: line.left,
      bgColor: colors.bgColor,
    },
  });
  fabricCanvas.add(maskRect);

  const measuredW = measureTextLineWidth(line.text, line.canvasFontSize, isBoldFinal ? 'bold' : 'normal', fontFamilyFinal);
  const initialWidth = Math.max(line.width + 16, Math.ceil(measuredW + 16), 40);

  // 3. In-place editable Textbox preserving original font size, color, weight, and font family
  const textbox = new fabric.Textbox(line.text, {
    left: line.left,
    top: line.top,
    width: initialWidth,
    fontSize: line.canvasFontSize,
    fill: colors.textColor,
    backgroundColor: 'transparent',
    fontFamily: fontFamilyFinal,
    fontWeight: isBoldFinal ? 'bold' : 'normal',
    splitByGrapheme: true,
    editable: true,
    hasBorders: true,
    borderColor: '#93c5fd',
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
      initialWidth: initialWidth,
      initialMaskWidth: initialMaskWidth,
    },
  });

  textbox.on('changed', () => updateTextDimensionsAndMask(textbox));
  fabricCanvas.add(textbox);

  if (shouldEditImmediately) {
    fabricCanvas.setActiveObject(textbox);
    setTimeout(() => {
      textbox.enterEditing();
      textbox.selectAll();
      if (textbox.hiddenTextarea) {
        textbox.hiddenTextarea.style.fontSize = '16px';
        textbox.hiddenTextarea.focus();
      }
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
    // Skip hidden/invisible PDF metadata text (e.g. white-on-white internal tags with 0 visible ink pixels)
    const sampled = samplePdfColors(line.left, line.top, line.width, line.height);
    if (!sampled.hasVisibleInk) continue;

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
      const width = (it.width && it.width > 0)
        ? (it.width * state.baseScale + 2)
        : Math.max(8, it.str.length * canvasFontSize * 0.5);
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

// Smart interior mode sampling: immune to borders, lines, and adjacent elements
function samplePdfColors(left, top, width, height, sourceCanvas = null) {
  try {
    const pdfCanvas = sourceCanvas || elements.pdfCanvas;
    if (!pdfCanvas) return { bgColor: '#ffffff', textColor: '#111827', hasVisibleInk: true };
    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });

    const l = Math.max(0, Math.floor(left));
    const t = Math.max(0, Math.floor(top));
    const w = Math.min(pdfCanvas.width - l, Math.ceil(width));
    const h = Math.min(pdfCanvas.height - t, Math.ceil(height));

    if (w <= 0 || h <= 0) return { bgColor: '#ffffff', textColor: '#111827', hasVisibleInk: true };

    // 1. Interior mode sampling: characters take ~15-25% of area; background is the dominant mode
    // Sample strictly INSIDE the text box to avoid grabbing outside borders or lines
    const imgData = ctx.getImageData(l, t, w, h).data;
    const colorHistogram = new Map();

    const stride = 12; // 3 pixels * 4 bytes for fast, representative sampling
    for (let i = 0; i < imgData.length; i += stride) {
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];
      const a = imgData[i + 3];
      if (a < 80) continue;

      // 8-level buckets to group subtle noise, strictly clamped to [0, 255]
      const qr = Math.min(255, Math.max(0, Math.round(r / 8) * 8));
      const qg = Math.min(255, Math.max(0, Math.round(g / 8) * 8));
      const qb = Math.min(255, Math.max(0, Math.round(b / 8) * 8));
      const key = `${qr},${qg},${qb}`;

      const entry = colorHistogram.get(key) || { count: 0, sumR: 0, sumG: 0, sumB: 0 };
      entry.count++;
      entry.sumR += r;
      entry.sumG += g;
      entry.sumB += b;
      colorHistogram.set(key, entry);
    }

    // Find dominant color bucket (mode)
    let dominantEntry = null;
    let maxCount = 0;
    for (const entry of colorHistogram.values()) {
      if (entry.count > maxCount) {
        maxCount = entry.count;
        dominantEntry = entry;
      }
    }

    // Authentic average RGB of the dominant bucket (preserves exact authentic tint without quantization steps)
    let bg = { r: 255, g: 255, b: 255 };
    if (dominantEntry && dominantEntry.count > 0) {
      bg = {
        r: Math.round(dominantEntry.sumR / dominantEntry.count),
        g: Math.round(dominantEntry.sumG / dominantEntry.count),
        b: Math.round(dominantEntry.sumB / dominantEntry.count),
      };
    }

    // Snap to pure neutral white ONLY if all channels are >= 248 and almost equal (neutral paper scan noise)
    // NEVER snap tinted backgrounds (like light blue #e8f3fb, light gray, pastel) to white!
    const isPureNeutralWhite = (bg.r >= 248 && bg.g >= 248 && bg.b >= 248 &&
                                Math.abs(bg.r - bg.g) <= 4 &&
                                Math.abs(bg.r - bg.b) <= 4 &&
                                Math.abs(bg.g - bg.b) <= 4);
    if (isPureNeutralWhite) {
      bg = { r: 255, g: 255, b: 255 };
    }

    // 2. Interior contrast sampling for text ink color
    let textR = 0, textG = 0, textB = 0, textCount = 0;
    for (let i = 0; i < imgData.length; i += stride) {
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];
      const a = imgData[i + 3];
      if (a < 80) continue;

      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      if (dist > 45) { // Distinct contrast from background
        textR += r;
        textG += g;
        textB += b;
        textCount++;
      }
    }

    // Fallback full-pixel check for very thin strokes (e.g. '1', '.', '|') so visible glyphs are never missed
    if (textCount === 0) {
      for (let i = 0; i < imgData.length; i += 4) {
        if (imgData[i + 3] < 80) continue;
        const dist = Math.abs(imgData[i] - bg.r) + Math.abs(imgData[i + 1] - bg.g) + Math.abs(imgData[i + 2] - bg.b);
        if (dist > 30) {
          textR += imgData[i];
          textG += imgData[i + 1];
          textB += imgData[i + 2];
          textCount++;
        }
      }
    }

    let text = { r: 17, g: 24, b: 39 }; // Default dark charcoal
    if (textCount > 0) {
      text = {
        r: Math.round(textR / textCount),
        g: Math.round(textG / textCount),
        b: Math.round(textB / textCount),
      };
    }

    // Verify text contrast against background
    const bgBrightness = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
    const textBrightness = (text.r * 299 + text.g * 587 + text.b * 114) / 1000;
    if (bgBrightness > 140 && textBrightness > 100) {
      text = { r: 17, g: 24, b: 39 }; // Force dark ink on light background
    } else if (bgBrightness <= 140 && textBrightness < 140) {
      text = { r: 255, g: 255, b: 255 }; // Force white ink on dark background
    }

    // Bulletproof hex formatter: clamps to [0, 255] and pads 2 digits (zero bit-shift overflow risk)
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v || 0)));
    const toHex = (c) => `#${clamp(c.r).toString(16).padStart(2, '0')}${clamp(c.g).toString(16).padStart(2, '0')}${clamp(c.b).toString(16).padStart(2, '0')}`;

    return {
      bgColor: toHex(bg),
      textColor: toHex(text),
      hasVisibleInk: textCount > 0,
    };
  } catch (err) {
    console.warn('samplePdfColors error:', err);
    return { bgColor: '#ffffff', textColor: '#111827', hasVisibleInk: true };
  }
}

// Auto-heals any legacy bugged yellow/lime masks, protruding masks, or invisible ghost metadata from older drafts
function sanitizeMaskColors() {
  if (!fabricCanvas) return;
  let modified = false;
  const objects = [...fabricCanvas.getObjects()];
  const toRemove = new Set();

  objects.forEach(o => {
    if (toRemove.has(o)) return;

    // 1. Heal legacy bit-shift yellow/lime masks
    if (o.data?.isMask && (o.fill === '#e0f900' || o.fill === '#e4f850' || o.fill === '#e0f800')) {
      const trueColors = samplePdfColors(o.left, o.top, o.width, o.height);
      o.set('fill', trueColors.bgColor);
      if (o.data) o.data.bgColor = trueColors.bgColor;
      modified = true;
    }

    // 2. Clamp any colored mask that protrudes beyond its colored box boundary
    if (o.data?.isMask && o.fill && o.fill.toLowerCase() !== '#ffffff') {
      const maxAllowed = findContainerRightBoundary(o.left, o.top, o.width, o.fill, null, o.height);
      if (maxAllowed > 0 && o.width > maxAllowed + 1) {
        o.set('width', maxAllowed);
        if (o.data && o.data.initialMaskWidth > maxAllowed) {
          o.data.initialMaskWidth = maxAllowed;
        }
        modified = true;
      }
    }

    // 3. Remove unmodified ghost textboxes created over invisible white-on-white PDF metadata (e.g. 'Counter')
    if (o.data?.isText && o.data?.originalText !== undefined && o.text === o.data.originalText && o.data?.linkedMaskId) {
      const mask = objects.find(m => m.data?.id === o.data.linkedMaskId);
      const checkW = mask ? mask.width : o.width;
      const checkH = mask ? mask.height : (o.height || 16);
      const checkColors = samplePdfColors(o.left, o.top, checkW, checkH);
      if (!checkColors.hasVisibleInk) {
        toRemove.add(o);
        if (mask) toRemove.add(mask);
        modified = true;
      }
    }
  });

  if (toRemove.size > 0) {
    toRemove.forEach(item => fabricCanvas.remove(item));
  }

  // 4. Ensure modified textboxes from off-screen batch replace have sufficient width & mask coverage
  fabricCanvas.getObjects().forEach(o => {
    if (o.data?.isText && o.data?.linkedMaskId && o.data?.originalText !== undefined && o.text !== o.data.originalText) {
      const maxLineW = measureTextLineWidth(o.text || '', o.fontSize || 16, o.fontWeight || 'normal', o.fontFamily);
      if (maxLineW + 14 > o.width) {
        o.set('width', Math.ceil(maxLineW + 16));
        if (o.initDimensions) o.initDimensions();
        modified = true;
      }
      const mask = fabricCanvas.getObjects().find(m => m.data?.id === o.data.linkedMaskId);
      if (mask && maxLineW > mask.width) {
        let nextMaskW = Math.ceil(maxLineW + 2);
        const maxAllowed = findContainerRightBoundary(mask.left, mask.top, mask.width, mask.fill, null, mask.height);
        if (maxAllowed > 0 && nextMaskW > maxAllowed) nextMaskW = maxAllowed;
        if (nextMaskW !== mask.width) {
          mask.set('width', nextMaskW);
          modified = true;
        }
      }
    }
  });

  if (modified) {
    fabricCanvas.requestRenderAll();
    saveCurrentPageState(state.currentPage);
  }
}

function samplePdfBackgroundColor(left, top, width, height, sourceCanvas = null) {
  return samplePdfColors(left, top, width, height, sourceCanvas).bgColor;
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

      if (activeObj.data?.linkedMaskId) {
        const mask = fabricCanvas.getObjects().find(o => o.data?.id === activeObj.data.linkedMaskId);
        if (mask && elements.textBgPropControls && elements.inputTextBgColor) {
          elements.textBgPropControls.classList.remove('hidden');
          elements.textBgPropControls.classList.add('flex');
          elements.inputTextBgColor.value = mask.fill || '#ffffff';
        }
      } else if (elements.textBgPropControls) {
        elements.textBgPropControls.classList.add('hidden');
        elements.textBgPropControls.classList.remove('flex');
      }
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
  const rawState = (pageNum === state.currentPage && fabricCanvas && !isTransitioningPage)
    ? (() => { sanitizeFabricCanvasObjects(fabricCanvas); return fabricCanvas.toJSON(SERIALIZE_PROPS); })()
    : state.pageStates[pageNum];

  const jsonState = normalizePageStateJson(rawState);
  if (!jsonState || !jsonState.objects || jsonState.objects.length === 0) {
    return null;
  }

  const page = await state.pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: state.baseScale });

  return new Promise(resolve => {
    const tempCanvas = document.createElement('canvas');
    const staticCanvas = new fabric.StaticCanvas(tempCanvas, {
      enableRetinaScaling: false
    });
    staticCanvas.setWidth(baseViewport.width);
    staticCanvas.setHeight(baseViewport.height);
    staticCanvas.setZoom(1.0);

    staticCanvas.loadFromJSON(jsonState, () => {
      sanitizeFabricCanvasObjects(staticCanvas);
      staticCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
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
  const rawState = (pageNum === state.currentPage && fabricCanvas && !isTransitioningPage)
    ? (() => { sanitizeFabricCanvasObjects(fabricCanvas); return fabricCanvas.toJSON(SERIALIZE_PROPS); })()
    : state.pageStates[pageNum];

  const jsonState = normalizePageStateJson(rawState);

  if (jsonState && jsonState.objects && jsonState.objects.length > 0) {
    const scaleFactor = 2.0 / state.baseScale;
    await new Promise(resolve => {
      const fabricOffscreen = document.createElement('canvas');
      const staticCanvas = new fabric.StaticCanvas(fabricOffscreen, {
        enableRetinaScaling: false
      });
      staticCanvas.setWidth(renderViewport.width);
      staticCanvas.setHeight(renderViewport.height);
      staticCanvas.setZoom(scaleFactor);

      staticCanvas.loadFromJSON(jsonState, () => {
        sanitizeFabricCanvasObjects(staticCanvas);
        staticCanvas.setViewportTransform([scaleFactor, 0, 0, scaleFactor, 0, 0]);
        staticCanvas.renderAll();
        ctx.drawImage(fabricOffscreen, 0, 0, renderViewport.width, renderViewport.height);
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

    // 2. Render modified composite page (original PDF + clean Retina-independent Fabric overlay)
    const compCanvas = document.createElement('canvas');
    compCanvas.width = viewport.width;
    compCanvas.height = viewport.height;
    const compCtx = compCanvas.getContext('2d');
    compCtx.drawImage(origCanvas, 0, 0);

    const fabricDataUrl = await generatePageOverlayPng(state.currentPage);
    if (fabricDataUrl) {
      await new Promise((resolve) => {
        const overlayImg = new Image();
        overlayImg.onload = () => {
          compCtx.drawImage(overlayImg, 0, 0, viewport.width, viewport.height);
          resolve();
        };
        overlayImg.onerror = () => resolve();
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
  if (elements.inputTextBgColor) {
    elements.inputTextBgColor.addEventListener('input', (e) => {
      const activeObj = fabricCanvas?.getActiveObject();
      if (activeObj && activeObj.data?.linkedMaskId) {
        const mask = fabricCanvas.getObjects().find(o => o.data?.id === activeObj.data.linkedMaskId);
        if (mask) {
          mask.set('fill', e.target.value);
          if (mask.data) mask.data.bgColor = e.target.value;
          fabricCanvas.requestRenderAll();
          saveCurrentPageState(state.currentPage);
        }
      }
    });
  }
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

  // Batch Find & Replace Event Listeners
  elements.btnBatchReplace?.addEventListener('click', () => openBatchReplaceModal());
  elements.toolBatchReplace?.addEventListener('click', () => openBatchReplaceModal());
  elements.btnReplaceThisText?.addEventListener('click', () => {
    const act = fabricCanvas?.getActiveObject();
    openBatchReplaceModal(act?.text?.trim());
  });
  elements.btnCloseReplaceModal?.addEventListener('click', closeBatchReplaceModal);
  elements.btnCancelReplace?.addEventListener('click', closeBatchReplaceModal);
  elements.btnExecuteReplace?.addEventListener('click', executeBatchReplace);
  elements.inputReplaceFind?.addEventListener('input', updateReplacePreview);
  elements.chkReplaceExact?.addEventListener('change', updateReplacePreview);
  document.querySelectorAll('input[name="replace-scope"]').forEach(r => r.addEventListener('change', updateReplacePreview));
  elements.btnClearReplaceFind?.addEventListener('click', () => {
    elements.inputReplaceFind.value = '';
    updateReplacePreview();
    elements.inputReplaceFind.focus();
  });

  // Shortcut Ctrl+H / Cmd+H for batch replace
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      openBatchReplaceModal();
    }
  });

  // Prevent accidental loss of unsaved changes
  window.addEventListener('beforeunload', (e) => {
    const hasEdits = Object.values(state.pageStates).some(st => st?.objects?.length > 0) ||
                     (fabricCanvas && fabricCanvas.getObjects().length > 0);
    if (hasEdits) {
      saveDraftToStorage();
      e.preventDefault();
      e.returnValue = '您有未保存的修改，确定要离开吗？系统已在本地为您暂存草稿。';
      return e.returnValue;
    }
  });
}

// ==========================================
// 14. Batch Find & Replace Logic (一键批量查找替换)
// ==========================================
function openBatchReplaceModal(prefillFind = null) {
  if (!state.pdfDoc) {
    showToast('请先打开 PDF 文件', 'error');
    return;
  }

  let initialFind = prefillFind;
  if (!initialFind && fabricCanvas) {
    const activeObj = fabricCanvas.getActiveObject();
    if (activeObj && activeObj.data?.isText && activeObj.text) {
      initialFind = activeObj.text.trim();
    }
  }

  if (initialFind) {
    elements.inputReplaceFind.value = initialFind;
    elements.btnClearReplaceFind.classList.remove('hidden');
  } else {
    elements.btnClearReplaceFind.classList.add('hidden');
  }

  elements.modalBatchReplace.classList.remove('hidden');
  updateReplacePreview();

  setTimeout(() => {
    if (initialFind) {
      elements.inputReplaceTarget.focus();
    } else {
      elements.inputReplaceFind.focus();
    }
  }, 50);
}

function closeBatchReplaceModal() {
  elements.modalBatchReplace.classList.add('hidden');
}

// Compute live matching preview across current or all pages (extracts unvisited pages on demand)
let _replacePreviewSeq = 0;
async function updateReplacePreview() {
  const mySeq = ++_replacePreviewSeq;
  const findStr = (elements.inputReplaceFind.value || '').trim();
  const scope = document.querySelector('input[name="replace-scope"]:checked')?.value || 'all';
  const exact = elements.chkReplaceExact.checked;

  if (!findStr) {
    elements.replaceMatchCountBadge.textContent = '请输入查找内容';
    elements.replaceMatchCountBadge.className = 'text-[11px] font-medium text-slate-400';
    elements.btnExecuteReplace.disabled = true;
    elements.replacePreviewContainer.classList.add('hidden');
    elements.btnClearReplaceFind.classList.add('hidden');
    return;
  }

  elements.btnClearReplaceFind.classList.remove('hidden');

  let matchCount = 0;
  const previewItems = [];

  const pagesToScan = (scope === 'all') 
    ? Array.from({ length: state.totalPages }, (_, i) => i + 1)
    : [state.currentPage];

  for (const p of pagesToScan) {
    // 1. Check existing fabric textboxes on current page or saved state
    if (p === state.currentPage && fabricCanvas) {
      const activeObjs = fabricCanvas.getObjects();
      for (const obj of activeObjs) {
        if (obj.data?.isText && obj.text) {
          const matched = exact ? (obj.text.trim() === findStr) : obj.text.includes(findStr);
          if (matched) {
            matchCount++;
            if (previewItems.length < 5) {
              previewItems.push(`第 ${p} 页 (已编辑): "${obj.text.substring(0, 30)}"`);
            }
          }
        }
      }
    } else if (state.pageStates[p]?.objects) {
      for (const obj of state.pageStates[p].objects) {
        if (obj.data?.isText && obj.text) {
          const matched = exact ? (obj.text.trim() === findStr) : obj.text.includes(findStr);
          if (matched) {
            matchCount++;
            if (previewItems.length < 5) {
              previewItems.push(`第 ${p} 页 (已编辑): "${obj.text.substring(0, 30)}"`);
            }
          }
        }
      }
    }

    // 2. Lazily extract text lines for unvisited pages so Page 2+ matches are always discovered!
    let lines = state.pageTextLines[p];
    if ((!lines || lines.length === 0) && state.pdfDoc) {
      try {
        const page = await state.pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: state.baseScale });
        lines = await extractPageTextLines(page, viewport);
        state.pageTextLines[p] = lines;
      } catch (e) {
        console.warn(`Extract lines for page ${p} failed:`, e);
        lines = [];
      }
    }
    lines = lines || [];

    const convertedLineIds = new Set();
    if (p === state.currentPage && fabricCanvas) {
      fabricCanvas.getObjects().forEach(o => {
        if (o.data?.lineId) convertedLineIds.add(o.data.lineId);
      });
    } else if (state.pageStates[p]?.objects) {
      state.pageStates[p].objects.forEach(o => {
        if (o.data?.lineId) convertedLineIds.add(o.data.lineId);
      });
    }

    for (const l of lines) {
      if (convertedLineIds.has(l.id)) continue;
      const matched = exact ? (l.text.trim() === findStr) : l.text.includes(findStr);
      if (matched) {
        matchCount++;
        if (previewItems.length < 5) {
          previewItems.push(`第 ${p} 页: "${l.text.substring(0, 30)}"`);
        }
      }
    }
  }

  if (mySeq !== _replacePreviewSeq) return;

  if (matchCount > 0) {
    elements.replaceMatchCountBadge.textContent = `找到 ${matchCount} 处匹配项`;
    elements.replaceMatchCountBadge.className = 'text-[11px] font-bold text-emerald-600';
    elements.btnExecuteReplace.disabled = false;
    elements.replacePreviewContainer.classList.remove('hidden');
    elements.replacePreviewList.innerHTML = previewItems
      .map(item => `<div class="truncate text-slate-700 py-0.5"><i class="fa-solid fa-check text-emerald-500 mr-1 text-[10px]"></i>${item}</div>`)
      .join('');
  } else {
    elements.replaceMatchCountBadge.textContent = '未找到匹配项';
    elements.replaceMatchCountBadge.className = 'text-[11px] font-medium text-rose-500';
    elements.btnExecuteReplace.disabled = true;
    elements.replacePreviewContainer.classList.add('hidden');
  }
}

// Execute Batch Replacement across current or all pages
async function executeBatchReplace() {
  const findStr = (elements.inputReplaceFind.value || '').trim();
  const replaceStr = elements.inputReplaceTarget.value || '';
  const scope = document.querySelector('input[name="replace-scope"]:checked')?.value || 'all';
  const exact = elements.chkReplaceExact.checked;

  if (!findStr) {
    showToast('请输入要查找的内容', 'error');
    return;
  }

  closeBatchReplaceModal();
  showToast(`正在批量替换: "${findStr}" ➔ "${replaceStr}"...`, 'info');

  let totalReplaced = 0;

  try {
    // 1. Current Page Processing
    if (fabricCanvas) {
      const activeObjs = fabricCanvas.getObjects();
      const convertedLineIds = new Set();

      // Step A: Replace inside active Fabric Textboxes
      activeObjs.forEach(obj => {
        if (obj.data?.isText && obj.text) {
          if (obj.data.lineId) convertedLineIds.add(obj.data.lineId);
          const matched = exact ? (obj.text.trim() === findStr) : obj.text.includes(findStr);
          if (matched) {
            const nextText = exact ? replaceStr : obj.text.replaceAll(findStr, replaceStr);
            if (nextText !== obj.text) {
              obj.set('text', nextText);
              updateTextDimensionsAndMask(obj);
              totalReplaced++;
            }
          }
        }
      });

      // Step B: Replace unconverted PDF text lines on current page
      let currentLines = state.pageTextLines[state.currentPage];
      if (!currentLines || currentLines.length === 0) {
        const page = await state.pdfDoc.getPage(state.currentPage);
        const viewport = page.getViewport({ scale: state.baseScale });
        currentLines = await extractPageTextLines(page, viewport);
        state.pageTextLines[state.currentPage] = currentLines;
      }

      currentLines.forEach(line => {
        if (convertedLineIds.has(line.id)) return;
        const matched = exact ? (line.text.trim() === findStr) : line.text.includes(findStr);
        if (matched) {
          const sampled = samplePdfColors(line.left, line.top, line.width, line.height);
          if (!sampled.hasVisibleInk) return;
          const nextText = exact ? replaceStr : line.text.replaceAll(findStr, replaceStr);
          const tb = convertLineToTextbox(line, false);
          if (tb) {
            tb.set('text', nextText);
            updateTextDimensionsAndMask(tb);
            totalReplaced++;
          }
        }
      });

      fabricCanvas.requestRenderAll();
      saveCurrentPageState(state.currentPage);
    }

    // 2. All Pages Processing (if scope === 'all')
    if (scope === 'all' && state.totalPages > 1) {
      for (let p = 1; p <= state.totalPages; p++) {
        if (p === state.currentPage) continue;

        let pLines = state.pageTextLines[p];
        if (!pLines || pLines.length === 0) {
          const page = await state.pdfDoc.getPage(p);
          const viewport = page.getViewport({ scale: state.baseScale });
          pLines = await extractPageTextLines(page, viewport);
          state.pageTextLines[p] = pLines;
        }

        if (!state.pageStates[p]) {
          state.pageStates[p] = { version: '5.3.0', objects: [] };
        } else {
          state.pageStates[p] = normalizePageStateJson(state.pageStates[p]);
        }

        const pObjects = state.pageStates[p].objects || [];
        const pConvertedLineIds = new Set();
        pObjects.forEach(obj => {
          if (obj.data?.isText && obj.data.lineId) pConvertedLineIds.add(obj.data.lineId);
        });

        const hasExistingMatches = pObjects.some(obj => obj.data?.isText && obj.text && (exact ? (obj.text.trim() === findStr) : obj.text.includes(findStr)));
        const hasUnconvertedMatches = pLines.some(line => !pConvertedLineIds.has(line.id) && (exact ? (line.text.trim() === findStr) : line.text.includes(findStr)));

        let pCanvas = null;
        if (hasExistingMatches || hasUnconvertedMatches) {
          try {
            const page = await state.pdfDoc.getPage(p);
            const viewport = page.getViewport({ scale: state.baseScale });
            pCanvas = document.createElement('canvas');
            pCanvas.width = viewport.width;
            pCanvas.height = viewport.height;
            const pCtx = pCanvas.getContext('2d', { willReadFrequently: true });
            await page.render({ canvasContext: pCtx, viewport }).promise;
          } catch (e) {
            console.warn(`Render page ${p} for color sampling failed:`, e);
          }
        }

        // Step A: Update already-converted textboxes on page p
        pObjects.forEach(obj => {
          if (obj.data?.isText && obj.text) {
            const matched = exact ? (obj.text.trim() === findStr) : obj.text.includes(findStr);
            if (matched) {
              const nextText = exact ? replaceStr : obj.text.replaceAll(findStr, replaceStr);
              if (nextText !== obj.text) {
                obj.text = nextText;
                obj.styles = Array.isArray(obj.styles) ? obj.styles : [];
                const measuredW = measureTextLineWidth(nextText, obj.fontSize || 16, obj.fontWeight || 'normal', obj.fontFamily);
                obj.width = Math.max(obj.width || 40, Math.ceil(measuredW + 16));
                if (obj.data?.linkedMaskId) {
                  const linkedMask = pObjects.find(m => m.data?.id === obj.data.linkedMaskId);
                  if (linkedMask) {
                    const origMaskW = obj.data.initialMaskWidth || linkedMask.data?.initialMaskWidth || linkedMask.width;
                    let targetMaskW = Math.max(origMaskW, Math.ceil(measuredW + 2));
                    const maxAllowed = findContainerRightBoundary(linkedMask.left, linkedMask.top, origMaskW, linkedMask.fill, pCanvas, linkedMask.height);
                    if (maxAllowed > 0 && targetMaskW > maxAllowed) targetMaskW = maxAllowed;
                    linkedMask.width = targetMaskW;
                  }
                }
                totalReplaced++;
              }
            }
          }
        });

        // Step B: Create authentic serialized Fabric Rect + Textbox objects for unconverted matches on page p
        pLines.forEach(line => {
          if (pConvertedLineIds.has(line.id)) return;
          const matched = exact ? (line.text.trim() === findStr) : line.text.includes(findStr);
          if (matched) {
            const lineColors = samplePdfColors(line.left, line.top, line.width, line.height, pCanvas);
            if (!lineColors.hasVisibleInk) return;

            const nextText = exact ? replaceStr : line.text.replaceAll(findStr, replaceStr);
            const maskId = 'mask_' + Math.random().toString(36).substr(2, 9);
            const textId = 'text_' + Math.random().toString(36).substr(2, 9);
            const isBoldFinal = Boolean(line.isBold);
            const fontFamilyFinal = line.fontFamily || 'system-ui, -apple-system, sans-serif';

            const measuredW = measureTextLineWidth(nextText, line.canvasFontSize, isBoldFinal ? 'bold' : 'normal', fontFamilyFinal);
            const maskTop = Math.max(0, line.top - 1);
            const maskHeight = Math.max(line.height + 2, line.canvasFontSize * 1.15);

            let targetMaskWidth = Math.max(line.width, Math.ceil(measuredW + 2));
            const maxAllowed = findContainerRightBoundary(line.left, maskTop, line.width, lineColors.bgColor, pCanvas, maskHeight);
            if (maxAllowed > 0 && targetMaskWidth > maxAllowed) {
              targetMaskWidth = maxAllowed;
            }
            const initialMaskWidth = (maxAllowed > 0 && line.width > maxAllowed) ? maxAllowed : line.width;
            const initialWidth = Math.max(line.width + 16, Math.ceil(measuredW + 16), 40);

            const tempMask = new fabric.Rect({
              left: line.left,
              top: maskTop,
              width: targetMaskWidth,
              height: maskHeight,
              fill: lineColors.bgColor,
              selectable: false,
              evented: false,
              strokeWidth: 0,
              data: {
                isMask: true,
                id: maskId,
                lineId: line.id,
                linkedTextId: textId,
                initialMaskWidth: initialMaskWidth,
                initialLeft: line.left,
                bgColor: lineColors.bgColor,
              },
            });

            const tempTextbox = new fabric.Textbox(nextText, {
              left: line.left,
              top: line.top,
              width: initialWidth,
              fontSize: line.canvasFontSize,
              fill: lineColors.textColor,
              backgroundColor: 'transparent',
              fontFamily: fontFamilyFinal,
              fontWeight: isBoldFinal ? 'bold' : 'normal',
              splitByGrapheme: true,
              editable: true,
              hasBorders: true,
              borderColor: '#93c5fd',
              borderDashArray: [3, 3],
              borderScaleFactor: 1.0,
              padding: 0,
              lineHeight: 1.05,
              transparentCorners: false,
              cornerColor: '#2563eb',
              cornerSize: 8,
              touchCornerSize: 14,
              data: {
                isText: true,
                id: textId,
                lineId: line.id,
                linkedMaskId: maskId,
                originalText: line.text,
                isBoldOriginal: isBoldFinal,
                initialWidth: initialWidth,
                initialMaskWidth: initialMaskWidth,
              },
            });

            const maskObj = tempMask.toObject(SERIALIZE_PROPS);
            const textObj = tempTextbox.toObject(SERIALIZE_PROPS);
            textObj.styles = Array.isArray(textObj.styles) ? textObj.styles : [];

            pObjects.push(maskObj, textObj);
            totalReplaced++;
          }
        });

        state.pageStates[p] = normalizePageStateJson({
          version: state.pageStates[p].version || '5.3.0',
          objects: pObjects,
        });
      }
    }

    saveDraftToStorage();

    if (totalReplaced > 0) {
      showToast(`🎉 成功完成批量替换！共替换了 ${totalReplaced} 处内容`, 'success');
      if (typeof confetti === 'function') {
        confetti({ particleCount: 35, spread: 60, origin: { y: 0.8 } });
      }
    } else {
      showToast('未找到需要替换的内容', 'info');
    }
  } catch (err) {
    console.error('Batch replace error:', err);
    showToast('批量替换失败: ' + err.message, 'error');
  }
}

// ==========================================
// 15. IndexedDB Auto-Save & Draft Recovery
// ==========================================
const DB_NAME = 'MobilePdfDraftsDB';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';

function openDraftDb() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => {
      console.warn('IndexedDB open error:', e);
      resolve(null);
    };
  });
}

let saveDraftTimeout = null;
function saveDraftToStorage() {
  if (!state.pdfData || !state.fileName) return;

  clearTimeout(saveDraftTimeout);
  saveDraftTimeout = setTimeout(async () => {
    try {
      const hasEdits = Object.values(state.pageStates).some(st => st?.objects?.length > 0) ||
                       (fabricCanvas && fabricCanvas.getObjects().length > 0);
      if (!hasEdits) return;

      const db = await openDraftDb();
      if (!db) return;

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record = {
        id: 'active_draft',
        fileName: state.fileName,
        pdfData: state.pdfData,
        password: state.password || '',
        pageStates: state.pageStates,
        currentPage: state.currentPage,
        timestamp: Date.now(),
      };
      store.put(record);
    } catch (err) {
      console.warn('Auto-save draft failed:', err);
    }
  }, 1000);
}

async function checkPendingDraftOnStartup() {
  try {
    const db = await openDraftDb();
    if (!db) return;

    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get('active_draft');

    req.onsuccess = () => {
      const draft = req.result;
      if (!draft || !draft.pdfData) return;

      const dateStr = new Date(draft.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      elements.draftRecoveryText.textContent = `检测到您之前有未完成的编辑草稿（${draft.fileName || 'PDF文档'} · ${dateStr}）`;
      elements.draftRecoveryBanner.classList.remove('hidden');
      elements.draftRecoveryBanner.classList.add('flex');

      elements.btnRestoreDraft.onclick = async () => {
        try {
          elements.draftRecoveryBanner.classList.add('hidden');
          showToast('正在恢复历史编辑草稿...', 'info');
          await openPdfFile(draft.pdfData, draft.fileName || '已恢复草稿.pdf', draft.password || '', draft.pageStates);
          if (draft.currentPage && draft.currentPage > 1) {
            await renderPage(draft.currentPage);
          }
          showToast('草稿已成功恢复！您可以继续编辑', 'success');
        } catch (err) {
          showToast('恢复草稿失败: ' + err.message, 'error');
        }
      };

      elements.btnDiscardDraft.onclick = async () => {
        elements.draftRecoveryBanner.classList.add('hidden');
        clearDraftStorage();
        showToast('已清除本地暂存草稿', 'info');
      };
    };
  } catch (err) {
    console.warn('Check pending draft error:', err);
  }
}

async function clearDraftStorage() {
  try {
    const db = await openDraftDb();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('active_draft');
  } catch (err) {
    console.warn('Clear draft error:', err);
  }
}

// Expose functions for debugging & tests
window.openPdfFile = openPdfFile;
window.openCompareModal = openCompareModal;
window.revertCurrentPage = revertCurrentPage;
window.exportModifiedPdf = exportModifiedPdf;
window.convertAllTextToEditable = convertAllTextToEditable;
window.openBatchReplaceModal = openBatchReplaceModal;
window.executeBatchReplace = executeBatchReplace;

// Initialize Application
function initApp() {
  setupEventListeners();
  initSignatureBoard();
  setupTouchAndPan();
  checkPendingDraftOnStartup();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
