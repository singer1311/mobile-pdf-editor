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
  isScannedPage: {},
  isImageSource: false,

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
  'shadow',
  'opacity',
  'angle',
  'charSpacing',
  'fontStyle',
  'fontFamily',
  'borderColor',
  'borderDashArray',
  'borderScaleFactor',
  'cornerColor',
  'cornerSize',
  'touchCornerSize',
  'transparentCorners',
];

// Override fabric.Rect._render so masks with a generated paper-texture patch (_patchCanvas) draw seamlessly
const _origFabricRectRender = fabric.Rect.prototype._render;
fabric.Rect.prototype._render = function (ctx) {
  if (this.data?.isMask && !this.data?.customSolidColor && this._patchCanvas) {
    ctx.save();
    ctx.drawImage(
      this._patchCanvas,
      -this.width / 2,
      -this.height / 2,
      this.width,
      this.height
    );
    ctx.restore();
    return;
  }
  _origFabricRectRender.call(this, ctx);
};

// Parse #rrggbb or #rgb hex into { r, g, b }
function parseHexRgb(hexStr, fallback = { r: 255, g: 255, b: 255 }) {
  if (!hexStr || typeof hexStr !== 'string' || !hexStr.startsWith('#')) return fallback;
  const h = hexStr.slice(1);
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16) || 0,
      g: parseInt(h[1] + h[1], 16) || 0,
      b: parseInt(h[2] + h[2], 16) || 0,
    };
  }
  if (h.length >= 6) {
    return {
      r: parseInt(h.slice(0, 2), 16) || 0,
      g: parseInt(h.slice(2, 4), 16) || 0,
      b: parseInt(h.slice(4, 6), 16) || 0,
    };
  }
  return fallback;
}

// Builds a seamless paper-texture & lighting-gradient inpainted patch for a mask Rect
function buildMaskSeamlessPatch(maskObj, sourcePdfCanvas = null, coordScale = 1.0) {
  try {
    if (!maskObj || !maskObj.data?.isMask) return;
    if (maskObj.data?.customSolidColor) {
      maskObj._patchCanvas = null;
      return;
    }
    const pdfCanvas = sourcePdfCanvas || elements.pdfCanvas;
    if (!pdfCanvas || pdfCanvas.width <= 0 || pdfCanvas.height <= 0) return;

    const sx = Math.max(0, Math.floor((maskObj.left || 0) * coordScale));
    const sy = Math.max(0, Math.floor((maskObj.top || 0) * coordScale));
    const sw = Math.min(pdfCanvas.width - sx, Math.max(1, Math.ceil((maskObj.width || 1) * coordScale)));
    const sh = Math.min(pdfCanvas.height - sy, Math.max(1, Math.ceil((maskObj.height || 1) * coordScale)));
    if (sw <= 1 || sh <= 1) return;

    const pad = 2;
    const bx = Math.max(0, sx - pad);
    const by = Math.max(0, sy - pad);
    const bw = Math.min(pdfCanvas.width - bx, sw + pad * 2);
    const bh = Math.min(pdfCanvas.height - by, sh + pad * 2);

    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });
    const srcData = ctx.getImageData(bx, by, bw, bh).data;
    const baseRgb = parseHexRgb(maskObj.fill || maskObj.data?.bgColor || '#ffffff');

    // Measure background variance & horizontal lighting gradient on non-ink pixels
    let sumDiffSq = 0;
    let bgCount = 0;
    let leftSumR = 0, leftSumG = 0, leftSumB = 0, leftCnt = 0;
    let rightSumR = 0, rightSumG = 0, rightSumB = 0, rightCnt = 0;

    for (let y = 0; y < bh; y += 2) {
      for (let x = 0; x < bw; x += 2) {
        const idx = (y * bw + x) * 4;
        if (srcData[idx + 3] < 80) continue;
        const r = srcData[idx];
        const g = srcData[idx + 1];
        const b = srcData[idx + 2];
        const dist = Math.abs(r - baseRgb.r) + Math.abs(g - baseRgb.g) + Math.abs(b - baseRgb.b);
        if (dist <= 44) {
          const avgDiff = dist / 3;
          sumDiffSq += avgDiff * avgDiff;
          bgCount++;
          if (x < bw * 0.35) {
            leftSumR += r; leftSumG += g; leftSumB += b; leftCnt++;
          } else if (x > bw * 0.65) {
            rightSumR += r; rightSumG += g; rightSumB += b; rightCnt++;
          }
        }
      }
    }

    const bgStdDev = bgCount > 4 ? Math.sqrt(sumDiffSq / bgCount) : 0;
    let leftRightDiff = 0;
    if (leftCnt > 0 && rightCnt > 0) {
      leftRightDiff =
        Math.abs(leftSumR / leftCnt - rightSumR / rightCnt) +
        Math.abs(leftSumG / leftCnt - rightSumG / rightCnt) +
        Math.abs(leftSumB / leftCnt - rightSumB / rightCnt);
    }

    // Fast path: if pure uniform digital background (< 0.85 stdDev and < 2.0 gradient), flat fill is already 100% exact
    if (bgStdDev < 0.85 && leftRightDiff < 2.0 && !state.isScannedPage[state.currentPage]) {
      maskObj._patchCanvas = null;
      return;
    }

    const ox = sx - bx;
    const oy = sy - by;
    const isVerticalStrip = (sh > sw * 1.35);

    // If vertical strip (e.g. -90° rotated text on a card/scan), profile LEFT and RIGHT rims per row y!
    // Otherwise profile TOP and BOTTOM rims per column x!
    const expBgR = new Float32Array(bw * bh);
    const expBgG = new Float32Array(bw * bh);
    const expBgB = new Float32Array(bw * bh);

    if (isVerticalStrip) {
      const rawLeftBg = new Array(bh);
      const rawRightBg = new Array(bh);
      for (let y = 0; y < bh; y++) {
        const leftPixels = [], rightPixels = [];
        for (let ry = Math.max(0, y - 3); ry <= Math.min(bh - 1, y + 3); ry++) {
          for (let rx = 0; rx < Math.min(bw, ox + 3); rx++) {
            const i = (ry * bw + rx) * 4;
            leftPixels.push({ r: srcData[i], g: srcData[i + 1], b: srcData[i + 2], lum: srcData[i] + srcData[i + 1] + srcData[i + 2] });
          }
          for (let rx = Math.max(0, ox + sw - 3); rx < bw; rx++) {
            const i = (ry * bw + rx) * 4;
            rightPixels.push({ r: srcData[i], g: srcData[i + 1], b: srcData[i + 2], lum: srcData[i] + srcData[i + 1] + srcData[i + 2] });
          }
        }
        leftPixels.sort((a, b) => b.lum - a.lum);
        rightPixels.sort((a, b) => b.lum - a.lum);
        const lTop = leftPixels.slice(0, Math.max(1, Math.ceil(leftPixels.length * 0.65)));
        const rTop = rightPixels.slice(0, Math.max(1, Math.ceil(rightPixels.length * 0.65)));
        rawLeftBg[y] = lTop.length > 0 ? {
          r: lTop.reduce((s, p) => s + p.r, 0) / lTop.length,
          g: lTop.reduce((s, p) => s + p.g, 0) / lTop.length,
          b: lTop.reduce((s, p) => s + p.b, 0) / lTop.length,
        } : { ...baseRgb };
        rawRightBg[y] = rTop.length > 0 ? {
          r: rTop.reduce((s, p) => s + p.r, 0) / rTop.length,
          g: rTop.reduce((s, p) => s + p.g, 0) / rTop.length,
          b: rTop.reduce((s, p) => s + p.b, 0) / rTop.length,
        } : { ...rawLeftBg[y] };
      }

      for (let y = 0; y < bh; y++) {
        let lr = 0, lg = 0, lb = 0, rr = 0, rg = 0, rb = 0, cnt = 0;
        for (let k = Math.max(0, y - 4); k <= Math.min(bh - 1, y + 4); k++) {
          lr += rawLeftBg[k].r; lg += rawLeftBg[k].g; lb += rawLeftBg[k].b;
          rr += rawRightBg[k].r; rg += rawRightBg[k].g; rb += rawRightBg[k].b;
          cnt++;
        }
        const lAvg = { r: lr / cnt, g: lg / cnt, b: lb / cnt };
        const rAvg = { r: rr / cnt, g: rg / cnt, b: rb / cnt };
        for (let x = 0; x < bw; x++) {
          const tX = Math.max(0, Math.min(1, (x - ox) / Math.max(1, sw - 1)));
          const p = y * bw + x;
          expBgR[p] = lAvg.r * (1 - tX) + rAvg.r * tX;
          expBgG[p] = lAvg.g * (1 - tX) + rAvg.g * tX;
          expBgB[p] = lAvg.b * (1 - tX) + rAvg.b * tX;
        }
      }
    } else {
      // Horizontal text strip: profile TOP and BOTTOM rims per column x
      const rawTopBg = new Array(bw);
      const rawBotBg = new Array(bw);
      for (let x = 0; x < bw; x++) {
        const topPixels = [], botPixels = [];
        for (let rx = Math.max(0, x - 3); rx <= Math.min(bw - 1, x + 3); rx++) {
          for (let ry = 0; ry < Math.min(bh, oy + 3); ry++) {
            const i = (ry * bw + rx) * 4;
            topPixels.push({ r: srcData[i], g: srcData[i + 1], b: srcData[i + 2], lum: srcData[i] + srcData[i + 1] + srcData[i + 2] });
          }
          for (let ry = Math.max(0, oy + sh - 3); ry < bh; ry++) {
            const i = (ry * bw + rx) * 4;
            botPixels.push({ r: srcData[i], g: srcData[i + 1], b: srcData[i + 2], lum: srcData[i] + srcData[i + 1] + srcData[i + 2] });
          }
        }
        topPixels.sort((a, b) => b.lum - a.lum);
        botPixels.sort((a, b) => b.lum - a.lum);
        const tTop = topPixels.slice(0, Math.max(1, Math.ceil(topPixels.length * 0.65)));
        const bTop = botPixels.slice(0, Math.max(1, Math.ceil(botPixels.length * 0.65)));
        rawTopBg[x] = tTop.length > 0 ? {
          r: tTop.reduce((s, p) => s + p.r, 0) / tTop.length,
          g: tTop.reduce((s, p) => s + p.g, 0) / tTop.length,
          b: tTop.reduce((s, p) => s + p.b, 0) / tTop.length,
        } : { ...baseRgb };
        rawBotBg[x] = bTop.length > 0 ? {
          r: bTop.reduce((s, p) => s + p.r, 0) / bTop.length,
          g: bTop.reduce((s, p) => s + p.g, 0) / bTop.length,
          b: bTop.reduce((s, p) => s + p.b, 0) / bTop.length,
        } : { ...rawTopBg[x] };
      }

      for (let x = 0; x < bw; x++) {
        let tr = 0, tg = 0, tb = 0, br = 0, bg = 0, bb = 0, cnt = 0;
        for (let k = Math.max(0, x - 4); k <= Math.min(bw - 1, x + 4); k++) {
          tr += rawTopBg[k].r; tg += rawTopBg[k].g; tb += rawTopBg[k].b;
          br += rawBotBg[k].r; bg += rawBotBg[k].g; bb += rawBotBg[k].b;
          cnt++;
        }
        const tAvg = { r: tr / cnt, g: tg / cnt, b: tb / cnt };
        const bAvg = { r: br / cnt, g: bg / cnt, b: bb / cnt };
        for (let y = 0; y < bh; y++) {
          const tY = Math.max(0, Math.min(1, (y - oy) / Math.max(1, sh - 1)));
          const p = y * bw + x;
          expBgR[p] = tAvg.r * (1 - tY) + bAvg.r * tY;
          expBgG[p] = tAvg.g * (1 - tY) + bAvg.g * tY;
          expBgB[p] = tAvg.b * (1 - tY) + bAvg.b * tY;
        }
      }
    }

    // Detect ink strokes vs clean background pattern, dilate by 3px with soft feathering, and run harmonic Laplace diffusion!
    const rawInk = new Uint8Array(bw * bh);
    for (let p = 0; p < bw * bh; p++) {
      const i = p * 4;
      const r = srcData[i], g = srcData[i + 1], b = srcData[i + 2];
      const dist = Math.abs(r - expBgR[p]) + Math.abs(g - expBgG[p]) + Math.abs(b - expBgB[p]);
      const darkDiff = (expBgR[p] - r) + (expBgG[p] - g) + (expBgB[p] - b);
      if (darkDiff > 38 || dist > 48 || (r < 108 && g < 108 && b < 108 && darkDiff > 24)) {
        rawInk[p] = 1;
      }
    }

    const inkWeight = new Float32Array(bw * bh);
    const fillR = new Float32Array(bw * bh);
    const fillG = new Float32Array(bw * bh);
    const fillB = new Float32Array(bw * bh);

    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let minDistSq = 99;
        for (let dy = -3; dy <= 3; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= bh) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= bw) continue;
            if (rawInk[ny * bw + nx]) {
              const d2 = dx * dx + dy * dy;
              if (d2 < minDistSq) minDistSq = d2;
            }
          }
        }
        const p = y * bw + x;
        const i = p * 4;
        if (minDistSq <= 2) inkWeight[p] = 1.0;
        else if (minDistSq <= 5) inkWeight[p] = 0.85;
        else if (minDistSq <= 9) inkWeight[p] = 0.55;
        else if (minDistSq <= 13) inkWeight[p] = 0.25;

        if (inkWeight[p] === 0) {
          fillR[p] = srcData[i];
          fillG[p] = srcData[i + 1];
          fillB[p] = srcData[i + 2];
        } else {
          fillR[p] = expBgR[p];
          fillG[p] = expBgG[p];
          fillB[p] = expBgB[p];
        }
      }
    }

    // 4 passes of 5x5 harmonic Laplace diffusion over ink pixels so background patterns flow seamlessly across erased strokes
    for (let iter = 0; iter < 4; iter++) {
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const p = y * bw + x;
          if (inkWeight[p] === 0) continue;
          let sr = 0, sg = 0, sb = 0, wSum = 0;
          for (let dy = -2; dy <= 2; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= bh) continue;
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= bw) continue;
              const np = ny * bw + nx;
              const w = inkWeight[np] === 0 ? 2.5 : 1.0;
              sr += fillR[np] * w;
              sg += fillG[np] * w;
              sb += fillB[np] * w;
              wSum += w;
            }
          }
          fillR[p] = sr / wSum;
          fillG[p] = sg / wSum;
          fillB[p] = sb / wSum;
        }
      }
    }

    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = sw;
    patchCanvas.height = sh;
    const patchCtx = patchCanvas.getContext('2d');
    const outImg = patchCtx.createImageData(sw, sh);
    const out = outImg.data;
    const grainAmp = Math.min(5.5, Math.max(0.8, bgStdDev * 1.15));

    for (let y = 0; y < sh; y++) {
      const py = Math.min(bh - 1, oy + y);
      for (let x = 0; x < sw; x++) {
        const px = Math.min(bw - 1, ox + x);
        const p = py * bw + px;
        const srcIdx = p * 4;
        const origR = srcData[srcIdx];
        const origG = srcData[srcIdx + 1];
        const origB = srcData[srcIdx + 2];
        const w = inkWeight[p];

        const hash = (((sx + x) * 73856093) ^ ((sy + y) * 19349663)) & 0xff;
        const grain = ((hash / 255) - 0.5) * 2 * grainAmp;
        const inpaintR = Math.max(0, Math.min(255, fillR[p] + grain));
        const inpaintG = Math.max(0, Math.min(255, fillG[p] + grain));
        const inpaintB = Math.max(0, Math.min(255, fillB[p] + grain));

        const finalR = Math.round(origR * (1 - w) + inpaintR * w);
        const finalG = Math.round(origG * (1 - w) + inpaintG * w);
        const finalB = Math.round(origB * (1 - w) + inpaintB * w);

        // Soft 1px outer rim feathering where there is no dark ink on the boundary
        let alpha = 255;
        if ((x === 0 || x === sw - 1 || y === 0 || y === sh - 1) && w < 0.5) {
          alpha = 180;
        }

        const outIdx = (y * sw + x) * 4;
        out[outIdx] = finalR;
        out[outIdx + 1] = finalG;
        out[outIdx + 2] = finalB;
        out[outIdx + 3] = alpha;
      }
    }

    patchCtx.putImageData(outImg, 0, 0);
    maskObj._patchCanvas = patchCanvas;
  } catch (err) {
    console.warn('buildMaskSeamlessPatch warning:', err);
  }
}

function prepareSeamlessMasksForCanvas(targetCanvas, sourcePdfCanvas = null, coordScale = 1.0) {
  if (!targetCanvas || typeof targetCanvas.getObjects !== 'function') return;
  const pdfCanvas = sourcePdfCanvas || elements.pdfCanvas;
  if (!pdfCanvas) return;
  targetCanvas.getObjects().forEach(o => {
    if (o.data?.isMask) {
      buildMaskSeamlessPatch(o, pdfCanvas, coordScale);
    }
  });
}

// Toggle subtle scan-ink optical blend on a Textbox so new text matches scanned ink softness
function applyScanInkBlend(textbox, enable = true) {
  if (!textbox) return;
  if (!textbox.data) textbox.data = {};
  textbox.data.scanBlend = Boolean(enable);
  if (enable) {
    textbox.set({
      opacity: 0.94,
      shadow: new fabric.Shadow({
        color: textbox.fill || '#1f2937',
        blur: 0.45,
        offsetX: 0,
        offsetY: 0,
      }),
    });
  } else {
    textbox.set({
      opacity: 1.0,
      shadow: null,
    });
  }
}

let _measureCanvas = null;
function measureTextLineWidth(text, fontSize = 16, fontWeight = 'normal', fontFamily = 'system-ui, -apple-system, sans-serif', charSpacing = 0) {
  try {
    if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
    const ctx = _measureCanvas.getContext('2d');
    const fs = fontSize || 16;
    ctx.font = `${fontWeight || 'normal'} ${fs}px ${fontFamily || 'system-ui, -apple-system, sans-serif'}`;
    const extraPerChar = charSpacing ? ((charSpacing / 1000) * fs) : 0;
    let maxW = 0;
    for (const line of String(text || '').split('\n')) {
      const extra = line.length > 1 ? (line.length - 1) * extraPerChar : 0;
      const w = ctx.measureText(line).width + extra;
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
  btnPageJump: document.getElementById('btn-page-jump'),
  currentPageNum: document.getElementById('current-page-num'),
  totalPageNum: document.getElementById('total-page-num'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  btnOpenPdf: document.getElementById('btn-open-pdf'),
  btnRotatePage: document.getElementById('btn-rotate-page'),
  btnOcrPage: document.getElementById('btn-ocr-page'),
  toolOcrPage: document.getElementById('tool-ocr-page'),
  scanDetectedBanner: document.getElementById('scan-detected-banner'),
  scanBannerText: document.getElementById('scan-banner-text'),
  btnScanRotate: document.getElementById('btn-scan-rotate'),
  btnOcrFastEng: document.getElementById('btn-ocr-fast-eng'),
  btnOcrChiEng: document.getElementById('btn-ocr-chi-eng'),
  btnCloseScanBanner: document.getElementById('btn-close-scan-banner'),
  btnRestoreSeamlessMask: document.getElementById('btn-restore-seamless-mask'),
  btnToggleScanBlend: document.getElementById('btn-toggle-scan-blend'),
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
  btnModeSelect: document.getElementById('btn-mode-select'),
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
  toolSelect: document.getElementById('tool-select'),
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
  selectFontFamily: document.getElementById('select-font-family'),
  labelFontSize: document.getElementById('label-font-size'),
  btnFontMinus: document.getElementById('btn-font-minus'),
  btnFontPlus: document.getElementById('btn-font-plus'),
  inputTextColor: document.getElementById('input-text-color'),
  btnTextBold: document.getElementById('btn-text-bold'),
  btnTextItalic: document.getElementById('btn-text-italic'),
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
  replaceDetectedChipsContainer: document.getElementById('replace-detected-chips-container'),
  replaceChipsTitle: document.getElementById('replace-chips-title'),
  btnRescanInReplace: document.getElementById('btn-rescan-in-replace'),
  replaceDetectedChips: document.getElementById('replace-detected-chips'),
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
async function openPdfFile(arrayBuffer, fileName = 'document.pdf', password = '', initialPageStates = null, isImageSource = false) {
  // Clone ArrayBuffer to avoid detachment by PDF.js worker transfer
  state.pdfData = arrayBuffer.slice(0);
  state.fileName = fileName;
  state.password = password;
  state.passwordCallback = null;
  state.isImageSource = Boolean(isImageSource);
  state.pageTextLines = {};
  state.isScannedPage = {};

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
    if (elements.btnRotatePage) {
      elements.btnRotatePage.classList.remove('hidden');
      elements.btnRotatePage.classList.add('flex');
    }
    if (elements.btnOcrPage) {
      elements.btnOcrPage.classList.remove('hidden');
      elements.btnOcrPage.classList.add('flex');
    }
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
          prepareSeamlessMasksForCanvas(fabricCanvas, elements.pdfCanvas, 1.0);
          fabricCanvas.renderAll();
          resolve();
        });
      });
    } else {
      isTransitioningPage = false;
    }

    // 5.1 Pre-extract and cache text lines for smart Word-like click editing (preserve existing OCR lines if already recognized)
    try {
      const existingLines = state.pageTextLines[pageNum];
      const hasOcrLines = Array.isArray(existingLines) && existingLines.some(l => l.isOcr);
      if (!hasOcrLines) {
        state.pageTextLines[pageNum] = await extractPageTextLines(page, viewport);
      }
      const currentLines = state.pageTextLines[pageNum] || [];
      const visibleLines = currentLines.filter(l => {
        const c = samplePdfColors(l.left, l.top, l.width, l.height);
        return c.hasVisibleInk;
      });
      if (state.isImageSource || visibleLines.length <= 2) {
        state.isScannedPage[pageNum] = true;
        if (elements.scanDetectedBanner && !hasOcrLines) {
          elements.scanDetectedBanner.classList.remove('hidden');
          elements.scanDetectedBanner.classList.add('flex');
        }
      } else {
        if (elements.scanDetectedBanner) {
          elements.scanDetectedBanner.classList.add('hidden');
        }
      }
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

let isRestoringHistory = false;
let historyBatchPreSnapshot = null;

function beginHistoryBatch(pageNum) {
  const p = pageNum || state.currentPage;
  const emptyStr = JSON.stringify({ version: '5.3.0', objects: [] });
  historyBatchPreSnapshot = state.pageStates[p] ? JSON.stringify(state.pageStates[p]) : emptyStr;
  isRestoringHistory = true;
}

function endHistoryBatch(pageNum) {
  const p = pageNum || state.currentPage;
  isRestoringHistory = false;
  if (!fabricCanvas) {
    historyBatchPreSnapshot = null;
    return;
  }
  sanitizeFabricCanvasObjects(fabricCanvas);
  const json = fabricCanvas.toJSON(SERIALIZE_PROPS);
  delete json.viewportTransform;
  const normalized = normalizePageStateJson(json);
  const nextStr = JSON.stringify(normalized);
  if (historyBatchPreSnapshot && nextStr !== historyBatchPreSnapshot) {
    if (!Array.isArray(state.historyStack[p])) state.historyStack[p] = [];
    if (state.historyStack[p][state.historyStack[p].length - 1] !== historyBatchPreSnapshot) {
      state.historyStack[p].push(historyBatchPreSnapshot);
      if (state.historyStack[p].length > 25) state.historyStack[p].shift();
    }
  }
  historyBatchPreSnapshot = null;
  state.pageStates[p] = normalized;
  saveDraftToStorage();
}

function saveCurrentPageState(pageNum) {
  if (!fabricCanvas || isTransitioningPage) return;
  const p = pageNum || state.currentPage;
  sanitizeFabricCanvasObjects(fabricCanvas);
  const json = fabricCanvas.toJSON(SERIALIZE_PROPS);
  delete json.viewportTransform;
  const normalized = normalizePageStateJson(json);

  if (!isRestoringHistory) {
    const emptyStateStr = JSON.stringify({ version: normalized?.version || '5.3.0', objects: [] });
    const prevStr = state.pageStates[p] ? JSON.stringify(state.pageStates[p]) : emptyStateStr;
    const nextStr = JSON.stringify(normalized);
    if (prevStr !== nextStr) {
      if (!Array.isArray(state.historyStack[p])) state.historyStack[p] = [];
      const last = state.historyStack[p][state.historyStack[p].length - 1];
      if (last !== prevStr) {
        state.historyStack[p].push(prevStr);
        if (state.historyStack[p].length > 25) state.historyStack[p].shift();
      }
    }
  }

  state.pageStates[p] = normalized;
  saveDraftToStorage();
}

async function undoLastAction() {
  if (!fabricCanvas || !state.pdfDoc) return;
  const p = state.currentPage;
  const stack = state.historyStack[p];

  if (!Array.isArray(stack) || stack.length === 0) {
    // Fallback for any unsaved legacy objects
    const objects = fabricCanvas.getObjects();
    if (objects.length > 0) {
      const topObj = objects[objects.length - 1];
      if (topObj.data?.linkedMaskId) {
        const mask = objects.find(o => o.data?.id === topObj.data.linkedMaskId);
        if (mask) fabricCanvas.remove(mask);
      }
      fabricCanvas.remove(topObj);
      saveCurrentPageState(p);
      updatePropertyBar();
      fabricCanvas.requestRenderAll();
      showToast('已撤销上一步操作', 'info');
    } else {
      showToast('当前页暂无更多可撤销操作', 'info');
    }
    return;
  }

  const prevJsonStr = stack.pop();
  const prevState = normalizePageStateJson(JSON.parse(prevJsonStr));

  isRestoringHistory = true;
  try {
    fabricCanvas.discardActiveObject();
    await new Promise((resolve) => {
      fabricCanvas.loadFromJSON(prevState, () => {
        sanitizeFabricCanvasObjects(fabricCanvas);
        sanitizeMaskColors();
        prepareSeamlessMasksForCanvas(fabricCanvas, elements.pdfCanvas, 1.0);
        fabricCanvas.getObjects().forEach(o => {
          if (o.data?.isText) {
            o.on('changed', () => updateTextDimensionsAndMask(o));
          }
        });
        fabricCanvas.renderAll();
        resolve();
      });
    });
    state.pageStates[p] = prevState;
    applyCurrentMode();
    saveDraftToStorage();
    showToast('已撤销上一步操作', 'info');
  } catch (err) {
    console.error('Undo failed:', err);
    showToast('撤销失败: ' + err.message, 'error');
  } finally {
    isRestoringHistory = false;
  }
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
  const activeClass = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition bg-white text-blue-600 shadow-sm';
  const inactiveClass = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition text-slate-600 hover:text-slate-900';

  if (elements.btnModeBrowse) elements.btnModeBrowse.className = (newMode === 'browse') ? activeClass : inactiveClass;
  if (elements.btnModeSelect) elements.btnModeSelect.className = (newMode === 'select') ? activeClass : inactiveClass;
  if (elements.btnModeEdit) elements.btnModeEdit.className = (newMode === 'edit') ? activeClass : inactiveClass;

  if (newMode === 'browse') {
    setTool('browse');
    showToast('已进入浏览模式：可单指滑动拖拽，双指缩放', 'info');
  } else if (newMode === 'select') {
    setTool('select');
    showToast('已进入选中模式：点击或框选任意文字即可选中、移动、缩放或一键替换', 'info');
  } else {
    if (state.tool === 'browse' || state.tool === 'select') {
      setTool('tap-edit');
    } else {
      applyCurrentMode();
    }
    showToast('已进入编辑模式：点击文字直接改，或框选区域无痕改字', 'info');
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

  // Sync top mode switcher pill
  const activeClass = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition bg-white text-blue-600 shadow-sm';
  const inactiveClass = 'px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-md flex items-center space-x-1 transition text-slate-600 hover:text-slate-900';

  if (toolName === 'browse') {
    state.mode = 'browse';
    if (elements.btnModeBrowse) elements.btnModeBrowse.className = activeClass;
    if (elements.btnModeSelect) elements.btnModeSelect.className = inactiveClass;
    if (elements.btnModeEdit) elements.btnModeEdit.className = inactiveClass;
  } else if (toolName === 'select') {
    state.mode = 'select';
    if (elements.btnModeBrowse) elements.btnModeBrowse.className = inactiveClass;
    if (elements.btnModeSelect) elements.btnModeSelect.className = activeClass;
    if (elements.btnModeEdit) elements.btnModeEdit.className = inactiveClass;
  } else {
    state.mode = 'edit';
    if (elements.btnModeBrowse) elements.btnModeBrowse.className = inactiveClass;
    if (elements.btnModeSelect) elements.btnModeSelect.className = inactiveClass;
    if (elements.btnModeEdit) elements.btnModeEdit.className = activeClass;
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
    state.selectDownX = pointer.x;
    state.selectDownY = pointer.y;
    state.selectHadTarget = Boolean(opt.target);

    // 1. Smart Word-like "Tap to Edit" OR "Select" on unedited PDF text lines
    if (state.tool === 'tap-edit' || (state.tool === 'select' && !opt.target)) {
      const isSelectOnly = (state.tool === 'select');
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
        updatePropertyBar();
        if (!isSelectOnly) {
          setTimeout(() => {
            hitBox.enterEditing();
            hitBox.hiddenTextarea?.focus();
            fabricCanvas.requestRenderAll();
          }, 30);
        } else {
          fabricCanvas.requestRenderAll();
          showToast('已选中文本框：可拖动位置、调字号颜色、点「替换」或双击打字', 'info');
        }
        return;
      }

      // If not an existing textbox, check extracted/OCR text lines from the PDF
      const lines = state.pageTextLines[state.currentPage] || [];
      const hitLine = findClosestTextLine(lines, pointer);

      if (hitLine) {
        const existing = fabricCanvas.getObjects().find(o => 
          o.data?.isText &&
          (o.data?.lineId === hitLine.id ||
           (Math.abs(o.left - hitLine.left) < 6 && Math.abs(o.top - hitLine.top) < 6))
        );

        if (existing) {
          fabricCanvas.setActiveObject(existing);
          updatePropertyBar();
          if (!isSelectOnly) {
            setTimeout(() => {
              existing.enterEditing();
              existing.hiddenTextarea?.focus();
              fabricCanvas.requestRenderAll();
            }, 30);
          } else {
            fabricCanvas.requestRenderAll();
          }
          return;
        }

        // Convert this specific text line to an in-place Word textbox immediately!
        const tb = convertLineToTextbox(hitLine, !isSelectOnly);
        if (isSelectOnly && tb) {
          fabricCanvas.setActiveObject(tb);
          updatePropertyBar();
          fabricCanvas.requestRenderAll();
          showToast(`已选中「${hitLine.text.substring(0, 18)}」：可移动、缩放、点顶部「替换」或双击改字！`, 'info');
        }
        return;
      }
    }

    // 2. Cover & Edit / Pure Mask Rubberband Dragging (also enabled as fallback drag in tap-edit on scanned pages)
    if (state.tool === 'cover-edit' || state.tool === 'mask' || (state.tool === 'tap-edit' && state.isScannedPage[state.currentPage] && !opt.target)) {
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
  fabricCanvas.on('mouse:up', async (opt) => {
    const pointer = opt.pointer || (opt.e ? fabricCanvas.getPointer(opt.e) : { x: 0, y: 0 });

    // In 'select' mode: if user dragged a marquee box over unedited PDF/scan text (and no Fabric object was selected), select & convert those lines or OCR that box!
    if (state.tool === 'select' && !state.isDrawingBox && !state.selectHadTarget && !fabricCanvas.getActiveObject()) {
      const sLeft = Math.min(state.selectDownX || 0, pointer.x);
      const sTop = Math.min(state.selectDownY || 0, pointer.y);
      const sWidth = Math.abs((state.selectDownX || 0) - pointer.x);
      const sHeight = Math.abs((state.selectDownY || 0) - pointer.y);
      if (sWidth >= 10 && sHeight >= 10) {
        const pageLines = state.pageTextLines[state.currentPage] || [];
        const matchedLines = pageLines.filter(l => {
          const ox = Math.max(0, Math.min(sLeft + sWidth, l.left + l.width) - Math.max(sLeft, l.left));
          const oy = Math.max(0, Math.min(sTop + sHeight, l.top + l.height) - Math.max(sTop, l.top));
          return ox > 4 && oy > 4;
        });
        if (matchedLines.length > 0) {
          const createdBoxes = [];
          for (const l of matchedLines) {
            let tb = fabricCanvas.getObjects().find(o => o.data?.isText && o.data?.lineId === l.id);
            if (!tb) tb = convertLineToTextbox(l, false);
            if (tb) createdBoxes.push(tb);
          }
          if (createdBoxes.length === 1) {
            fabricCanvas.setActiveObject(createdBoxes[0]);
          } else if (createdBoxes.length > 1) {
            const sel = new fabric.ActiveSelection(createdBoxes, { canvas: fabricCanvas });
            fabricCanvas.setActiveObject(sel);
          }
          updatePropertyBar();
          fabricCanvas.requestRenderAll();
          showToast(`已框选选中 ${createdBoxes.length} 处文字！`, 'success');
          return;
        } else {
          // Scanned area with no pre-extracted line: crop-OCR that box and select it!
          await createAndSelectBoxWithLocalOcr(sLeft, sTop, sWidth, sHeight, false);
          return;
        }
      }
    }

    if (!state.isDrawingBox || !state.rubberBandRect) return;
    state.isDrawingBox = false;

    fabricCanvas.remove(state.rubberBandRect);
    const left = Math.min(state.boxStartX, pointer.x);
    const top = Math.min(state.boxStartY, pointer.y);
    const width = Math.abs(state.boxStartX - pointer.x);
    const height = Math.abs(state.boxStartY - pointer.y);

    state.rubberBandRect = null;

    // Minimum drag threshold to prevent accidental clicks
    if (width < 6 || height < 6) {
      if (state.tool === 'tap-edit' && state.isScannedPage[state.currentPage]) {
        const lines = state.pageTextLines[state.currentPage] || [];
        if (lines.length <= 2) {
          showToast('此页为扫描图片：请按住拖动框选文字无痕改，或点顶部「扫描识字」开启点击即改！', 'info');
        }
      }
      return;
    }

    const isCoverEditAction = (state.tool === 'cover-edit' || state.tool === 'tap-edit');

    if (isCoverEditAction) {
      await createAndSelectBoxWithLocalOcr(left, top, width, height, true);
    } else {
      const colors = samplePdfColors(left, top, width, height);
      const maskId = 'mask_' + Date.now();
      const maskRect = new fabric.Rect({
        left: left,
        top: top,
        width: width,
        height: height,
        fill: colors.bgColor,
        selectable: true,
        evented: true,
        hasBorders: true,
        borderColor: '#94a3b8',
        cornerSize: 12,
        strokeWidth: 0,
        data: {
          isMask: true,
          id: maskId,
          initialMaskWidth: width,
          initialLeft: left,
          bgColor: colors.bgColor,
        },
      });
      buildMaskSeamlessPatch(maskRect, elements.pdfCanvas, 1.0);
      fabricCanvas.add(maskRect);
      fabricCanvas.setActiveObject(maskRect);
      showToast('已生成无痕背景遮罩覆盖原内容！', 'info');
      setTool('select');
      saveCurrentPageState(state.currentPage);
      fabricCanvas.requestRenderAll();
    }
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

  // Object modified / freehand brush stroke (for history & multi-page persistence)
  fabricCanvas.on('object:modified', () => {
    saveCurrentPageState(state.currentPage);
  });
  fabricCanvas.on('path:created', () => {
    saveCurrentPageState(state.currentPage);
  });
}

// Create a seamless mask + Textbox from a dragged rectangle, auto-recognizing its text via overlap or fast local crop OCR
async function createAndSelectBoxWithLocalOcr(left, top, width, height, enterEditingImmediately = true) {
  if (!fabricCanvas) return null;
  const colors = samplePdfColors(left, top, width, height);
  const maskId = 'mask_' + Date.now();
  const textId = 'text_' + Date.now();

  const maskRect = new fabric.Rect({
    left: left,
    top: top,
    width: width,
    height: height,
    fill: colors.bgColor,
    selectable: false,
    evented: false,
    hasBorders: true,
    borderColor: '#94a3b8',
    cornerSize: 12,
    strokeWidth: 0,
    data: {
      isMask: true,
      id: maskId,
      linkedTextId: textId,
      initialMaskWidth: width,
      initialMaskHeight: height,
      initialLeft: left,
      baseBottomY: top + height,
      bgColor: colors.bgColor,
    },
  });
  buildMaskSeamlessPatch(maskRect, elements.pdfCanvas, 1.0);
  fabricCanvas.add(maskRect);

  const isVerticalBox = (height > width * 1.65 && (state.isScannedPage[state.currentPage] || (state.pageTextLines[state.currentPage] || []).some(l => l.angle === -90)));
  const inkBounds = detectInkBoundsInBox(left, top, width, height, colors.bgColor);

  let prefillText = '';
  const pageLines = state.pageTextLines[state.currentPage] || [];
  for (const l of pageLines) {
    const overlapX = Math.max(0, Math.min(left + width, l.left + l.width) - Math.max(left, l.left));
    const overlapY = Math.max(0, Math.min(top + height, l.top + l.height) - Math.max(top, l.top));
    if (overlapX > 4 && overlapY > 4 && l.text && l.text.trim()) {
      prefillText = l.text.trim();
      break;
    }
  }

  // If no pre-extracted line matched and Tesseract is available, run fast local crop OCR on this exact box!
  if (!prefillText && typeof Tesseract !== 'undefined' && elements.pdfCanvas) {
    try {
      const cropCanvas = document.createElement('canvas');
      if (isVerticalBox) {
        cropCanvas.width = Math.max(16, Math.round(height * 1.5));
        cropCanvas.height = Math.max(16, Math.round(width * 1.5));
        const cCtx = cropCanvas.getContext('2d');
        cCtx.translate(cropCanvas.width / 2, cropCanvas.height / 2);
        cCtx.rotate(Math.PI / 2);
        cCtx.drawImage(elements.pdfCanvas, left, top, width, height, -cropCanvas.height / 2, -cropCanvas.width / 2, cropCanvas.height, cropCanvas.width);
      } else {
        cropCanvas.width = Math.max(16, Math.round(width * 1.5));
        cropCanvas.height = Math.max(16, Math.round(height * 1.5));
        cropCanvas.getContext('2d').drawImage(elements.pdfCanvas, left, top, width, height, 0, 0, cropCanvas.width, cropCanvas.height);
      }
      const res = await Tesseract.recognize(cropCanvas, 'eng');
      const rawTxt = (res?.data?.text || '').replace(/\s+/g, ' ').trim();
      const normTxt = cleanOcrToken(rawTxt);
      if (normTxt) prefillText = normTxt;
    } catch (e) {}
  }

  if (!prefillText) prefillText = '点击输入修改文字';

  let calculatedFontSize, textLeft, textTop, initialWidth;
  if (isVerticalBox) {
    const charH = (inkBounds && inkBounds.inkWidth >= 6) ? inkBounds.inkWidth : width;
    calculatedFontSize = Math.max(10, Math.min(Math.round(charH * 0.85), 52));
    textLeft = (inkBounds && inkBounds.inkWidth >= 6) ? inkBounds.inkLeft : left;
    textTop = top + height;
    initialWidth = Math.max(height + 20, 80);
  } else {
    const hasTightInk = inkBounds && inkBounds.inkHeight >= 6;
    calculatedFontSize = hasTightInk
      ? Math.max(10, Math.min(Math.round(inkBounds.inkHeight * 1.02), 48))
      : Math.max(12, Math.min(Math.round(height * 0.72), 48));
    textLeft = hasTightInk ? inkBounds.inkLeft : left;
    textTop = hasTightInk
      ? Math.max(top, Math.round(inkBounds.inkTop - calculatedFontSize * 0.08))
      : top + Math.max(0, (height - calculatedFontSize * 1.18) / 2);
    initialWidth = Math.max(width + 20, 100);
  }
  state.fontSize = calculatedFontSize;
  const detectedBold = inkBounds ? inkBounds.isBold : Boolean(colors.isBoldInk || state.isBold);

  const textbox = new fabric.Textbox(prefillText, {
    left: textLeft,
    top: textTop,
    angle: isVerticalBox ? -90 : 0,
    width: initialWidth,
    fontSize: calculatedFontSize,
    fill: colors.textColor,
    backgroundColor: 'transparent',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontWeight: detectedBold ? 'bold' : 'normal',
    splitByGrapheme: true,
    editable: true,
    hasBorders: true,
    borderColor: '#93c5fd',
    borderDashArray: [3, 3],
    padding: 0,
    lineHeight: 1.05,
    cornerColor: '#2563eb',
    cornerSize: 8,
    touchCornerSize: 14,
    data: {
      isText: true,
      id: textId,
      linkedMaskId: maskId,
      originalText: prefillText === '点击输入修改文字' ? undefined : prefillText,
      isVerticalCcw: isVerticalBox,
      initialWidth: initialWidth,
      initialMaskWidth: width,
      initialMaskHeight: height,
      baseBottomY: top + height,
    },
  });

  if (state.isScannedPage[state.currentPage] || colors.isScannedBg) {
    applyScanInkBlend(textbox, true);
  }

  textbox.on('changed', () => updateTextDimensionsAndMask(textbox));
  fabricCanvas.add(textbox);
  fabricCanvas.setActiveObject(textbox);
  updatePropertyBar();

  if (enterEditingImmediately) {
    textbox.enterEditing();
    textbox.selectAll();
    showToast('已无痕修复底纹并识别原文字，直接打字替换！', 'info');
    setTool('tap-edit');
  } else {
    showToast(`已框选选中「${prefillText}」，可拖动、调字号、点「替换」或双击改字！`, 'success');
  }

  saveCurrentPageState(state.currentPage);
  fabricCanvas.requestRenderAll();
  return textbox;
}

// Detect tight ink bounding box and stroke density inside a dragged region (for pixel-accurate font sizing on scanned images)
function detectInkBoundsInBox(left, top, width, height, bgHex, sourceCanvas = null) {
  try {
    const pdfCanvas = sourceCanvas || elements.pdfCanvas;
    if (!pdfCanvas) return null;
    const ctx = pdfCanvas.getContext('2d', { willReadFrequently: true });

    const l = Math.max(0, Math.floor(left));
    const t = Math.max(0, Math.floor(top));
    const w = Math.min(pdfCanvas.width - l, Math.ceil(width));
    const h = Math.min(pdfCanvas.height - t, Math.ceil(height));
    if (w < 4 || h < 4) return null;

    const bg = parseHexRgb(bgHex || '#ffffff');
    const data = ctx.getImageData(l, t, w, h).data;

    let minX = w, maxX = -1, minY = h, maxY = -1;
    let inkPixels = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 80) continue;
        const dist = Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b);
        if (dist > 45) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          inkPixels++;
        }
      }
    }

    if (maxX < minX || maxY < minY || inkPixels < 3) return null;
    const inkW = Math.max(4, maxX - minX + 1);
    const inkH = Math.max(4, maxY - minY + 1);
    const inkDensity = inkPixels / Math.max(1, inkW * inkH);

    return {
      inkLeft: l + minX,
      inkTop: t + minY,
      inkWidth: inkW,
      inkHeight: inkH,
      inkDensity,
      isBold: inkDensity > 0.26,
    };
  } catch (e) {
    return null;
  }
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

  const isVerticalCcw = (obj.angle === -90 || obj.data?.isVerticalCcw);

  // 1. Calculate true text width across all lines (accounting for charSpacing)
  const maxLineWidth = measureTextLineWidth(
    obj.text || '',
    obj.fontSize || 16,
    obj.fontWeight || 'normal',
    obj.fontFamily || 'system-ui, -apple-system, sans-serif',
    obj.charSpacing || 0
  );

  // 2. Expand textbox width for cursor room, transparent so zero visual side-effects
  const baseWidth = obj.data.initialWidth || 50;
  const desiredWidth = Math.max(baseWidth, Math.ceil(maxLineWidth + 16));
  if (desiredWidth > obj.width) {
    obj.set('width', desiredWidth);
    if (obj.initDimensions) obj.initDimensions();
  }

  // 3. Mask dimensions: Tightly fitted to text, NEVER oversized, NEVER sticking out of containers!
  if (obj.data?.linkedMaskId && fabricCanvas) {
    const mask = fabricCanvas.getObjects().find(o => o.data?.id === obj.data.linkedMaskId);
    if (mask) {
      const isModified = (obj.data.originalText === undefined || obj.text !== obj.data.originalText);

      if (isVerticalCcw) {
        const origMaskHeight = obj.data.initialMaskHeight || mask.data?.initialMaskHeight || mask.height;
        const baseBottomY = obj.data.baseBottomY || mask.data?.baseBottomY || (mask.top + mask.height);
        let targetMaskHeight = origMaskHeight;
        if (isModified && maxLineWidth > origMaskHeight - 1) {
          targetMaskHeight = Math.ceil(maxLineWidth + 4);
        }
        mask.set({
          top: Math.max(0, baseBottomY - targetMaskHeight),
          height: targetMaskHeight,
        });
      } else {
        const origMaskWidth = obj.data.initialMaskWidth || mask.data?.initialMaskWidth || mask.width;
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
      buildMaskSeamlessPatch(mask, elements.pdfCanvas, 1.0);
    }
  }

  saveCurrentPageState(state.currentPage);
  if (fabricCanvas) fabricCanvas.requestRenderAll();
}

// Find the closest interactive textbox to the pointer with generous finger tolerance (supports both 0° horizontal and -90° vertical textboxes)
function findClosestObject(objects, pt) {
  if (!objects || objects.length === 0) return null;

  const candidates = [];

  for (const o of objects) {
    const w = o.getScaledWidth ? o.getScaledWidth() : (o.width || 0);
    const h = o.getScaledHeight ? o.getScaledHeight() : (o.height || 0);

    if (o.angle === -90 || o.data?.isVerticalCcw) {
      // Vertical -90° textbox: anchored at bottom-left (o.left, o.top), extends UP by w and RIGHT by h
      const boxLeft = o.left;
      const boxRight = o.left + h;
      const boxTop = o.top - w;
      const boxBottom = o.top;
      if (pt.x >= boxLeft - 14 && pt.x <= boxRight + 14 && pt.y >= boxTop - 14 && pt.y <= boxBottom + 14) {
        const cx = (boxLeft + boxRight) / 2;
        const dist = Math.abs(pt.x - cx);
        candidates.push({ obj: o, score: dist, vDist: dist });
      }
      continue;
    }

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

// Find the closest PDF/OCR extracted text line to the pointer (supports both 0° horizontal and -90° vertical lines)
function findClosestTextLine(lines, pt) {
  if (!lines || lines.length === 0) return null;

  const candidates = [];

  for (const line of lines) {
    if (line.angle === -90) {
      // Vertical -90° line: line.left..line.left+line.width horizontally, line.top..line.top+line.height vertically
      if (
        pt.x >= line.left - 16 &&
        pt.x <= line.left + line.width + 16 &&
        pt.y >= line.top - 16 &&
        pt.y <= line.top + line.height + 16
      ) {
        const cx = line.left + line.width / 2;
        const xDist = Math.abs(pt.x - cx);
        candidates.push({ line, score: xDist, vDist: xDist });
      }
      continue;
    }

    const centerY = line.top + line.height / 2;
    const vDist = Math.abs(pt.y - centerY);
    const maxV = Math.max(22, line.canvasFontSize * 1.35);

    // If pointer is within vertical range of this line
    if (vDist <= maxV) {
      const inX = (pt.x >= line.left - 18 && pt.x <= line.left + line.width + 22);
      let score = vDist;
      if (!inX) {
        const xDist = (pt.x < line.left) ? (line.left - pt.x) : (pt.x - (line.left + line.width));
        if (xDist > 40) continue;
        score += xDist * 1.5;
      }
      candidates.push({ line, score, vDist });
    }
  }

  if (candidates.length === 0) {
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

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].line;
}

// Convert a single extracted text line to a Word-like interactive in-place Textbox (supports 0° horizontal and -90° vertical lines)
function convertLineToTextbox(line, shouldEditImmediately = true) {
  // 1. Sample surrounding background color and text contrast color
  const colors = samplePdfColors(line.left, line.top, line.width, line.height);
  const isBoldFinal = Boolean(line.isBold || (line.isOcr && colors.isBoldInk));
  const fontFamilyFinal = line.fontFamily || 'system-ui, -apple-system, sans-serif';
  const isVerticalCcw = (line.angle === -90);

  const maskId = 'mask_' + Math.random().toString(36).substr(2, 9);
  const textId = 'text_' + Math.random().toString(36).substr(2, 9);

  let maskLeft = line.left;
  let maskTop = Math.max(0, line.top - 1);
  let initialMaskWidth = line.width;
  let maskHeight = isVerticalCcw
    ? line.height + 2
    : Math.max(line.height + 2, line.canvasFontSize * 1.15);

  if (!isVerticalCcw) {
    const maxAllowedMask = findContainerRightBoundary(line.left, maskTop, initialMaskWidth, colors.bgColor, null, maskHeight);
    if (maxAllowedMask > 0 && initialMaskWidth > maxAllowedMask) {
      initialMaskWidth = maxAllowedMask;
    }
  }

  // 2. Background mask perfectly covers original PDF/scan text (with seamless texture patch on scanned pages)
  const maskRect = new fabric.Rect({
    left: maskLeft,
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
      initialMaskHeight: maskHeight,
      initialLeft: maskLeft,
      baseBottomY: maskTop + maskHeight,
      bgColor: colors.bgColor,
    },
  });
  buildMaskSeamlessPatch(maskRect, elements.pdfCanvas, 1.0);
  fabricCanvas.add(maskRect);

  const targetSpan = isVerticalCcw ? line.height : line.width;
  const baseMeasuredW = measureTextLineWidth(line.text, line.canvasFontSize, isBoldFinal ? 'bold' : 'normal', fontFamilyFinal, 0);
  let computedCharSpacing = line.charSpacing || 0;
  if (!computedCharSpacing && line.isOcr && line.text && line.text.length > 1 && baseMeasuredW < targetSpan - 6) {
    computedCharSpacing = Math.max(0, Math.min(260, Math.round(((targetSpan - baseMeasuredW) / (line.text.length - 1)) / line.canvasFontSize * 1000)));
  }

  const measuredW = measureTextLineWidth(line.text, line.canvasFontSize, isBoldFinal ? 'bold' : 'normal', fontFamilyFinal, computedCharSpacing);
  const initialWidth = Math.max(targetSpan + 16, Math.ceil(measuredW + 16), 40);

  // 3. In-place editable Textbox preserving original font size, color, weight, angle, and spacing
  const textbox = new fabric.Textbox(line.text, {
    left: isVerticalCcw ? (line.textLeft ?? line.left) : line.left,
    top: isVerticalCcw ? (line.textTop ?? (line.top + line.height)) : line.top,
    angle: isVerticalCcw ? -90 : 0,
    charSpacing: computedCharSpacing,
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
      isVerticalCcw: isVerticalCcw,
      initialWidth: initialWidth,
      initialMaskWidth: initialMaskWidth,
      initialMaskHeight: maskHeight,
      baseBottomY: maskTop + maskHeight,
    },
  });

  if (state.isScannedPage[state.currentPage] || colors.isScannedBg || line.isOcr) {
    applyScanInkBlend(textbox, true);
  }

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
    showToast('已进入无痕修改模式，直接打字替换！', 'info');
  }

  saveCurrentPageState(state.currentPage);
  fabricCanvas.requestRenderAll();
  return textbox;
}

// One-Click Word Mode: Convert all text lines on the current page to editable textboxes
async function convertAllTextToEditable() {
  if (!state.pdfDoc || !fabricCanvas) {
    showToast('请先打开 PDF 或图片文件', 'error');
    return;
  }

  showToast('正在识别当前页文字，生成可编辑文本框...', 'info');

  let lines = state.pageTextLines[state.currentPage];
  if (!lines || lines.length === 0) {
    const page = await state.pdfDoc.getPage(state.currentPage);
    const viewport = page.getViewport({ scale: state.baseScale });
    lines = await extractPageTextLines(page, viewport);
    state.pageTextLines[state.currentPage] = lines;
  }

  // Filter for lines with visible ink
  const visibleCheck = (lines || []).filter(l => samplePdfColors(l.left, l.top, l.width, l.height).hasVisibleInk);

  if (!lines || visibleCheck.length === 0) {
    showToast('检测到当前页为扫描图片，正在自动启动智能 OCR 文字识别...', 'info');
    await runOcrOnCurrentPage('eng');
    lines = state.pageTextLines[state.currentPage] || [];
    if (lines.length === 0) {
      return;
    }
  }

  let count = 0;
  beginHistoryBatch(state.currentPage);
  try {
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
  } finally {
    endHistoryBatch(state.currentPage);
  }

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

    // Measure local background variance (scan paper grain vs digital flat fill)
    let bgVarSum = 0, bgVarCnt = 0;
    for (let i = 0; i < imgData.length; i += stride) {
      if (imgData[i + 3] < 80) continue;
      const d = (Math.abs(imgData[i] - bg.r) + Math.abs(imgData[i + 1] - bg.g) + Math.abs(imgData[i + 2] - bg.b)) / 3;
      if (d <= 14) {
        bgVarSum += d * d;
        bgVarCnt++;
      }
    }
    const bgStdDev = bgVarCnt > 2 ? Math.sqrt(bgVarSum / bgVarCnt) : 0;
    const isScannedBg = (bgStdDev >= 1.15 || Boolean(state.isScannedPage[state.currentPage]) || state.isImageSource);

    // Snap to pure neutral white ONLY if digital flat white (never snap off-white/warm/gray scanned paper!)
    const isPureNeutralWhite = (bg.r >= 249 && bg.g >= 249 && bg.b >= 249 &&
                                Math.abs(bg.r - bg.g) <= 3 &&
                                Math.abs(bg.r - bg.b) <= 3 &&
                                Math.abs(bg.g - bg.b) <= 3);
    if ((bg.r >= 253 && bg.g >= 253 && bg.b >= 253) || (isPureNeutralWhite && !isScannedBg)) {
      bg = { r: 255, g: 255, b: 255 };
    }

    // 2. Interior contrast sampling for text ink color (prefer core ink pixels dist > 65 so anti-aliased scan fringes don't wash out text)
    let textR = 0, textG = 0, textB = 0, textCount = 0;
    let coreR = 0, coreG = 0, coreB = 0, coreCount = 0;
    let totalSampled = 0;
    for (let i = 0; i < imgData.length; i += stride) {
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];
      const a = imgData[i + 3];
      if (a < 80) continue;
      totalSampled++;

      const dist = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
      if (dist > 45) { // Distinct contrast from background
        textR += r;
        textG += g;
        textB += b;
        textCount++;
        if (dist > 70) {
          coreR += r;
          coreG += g;
          coreB += b;
          coreCount++;
        }
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
    if (coreCount >= 2) {
      text = {
        r: Math.round(coreR / coreCount),
        g: Math.round(coreG / coreCount),
        b: Math.round(coreB / coreCount),
      };
    } else if (textCount > 0) {
      text = {
        r: Math.round(textR / textCount),
        g: Math.round(textG / textCount),
        b: Math.round(textB / textCount),
      };
    }

    // Verify text contrast against background
    const bgBrightness = (bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000;
    const textBrightness = (text.r * 299 + text.g * 587 + text.b * 114) / 1000;
    if (bgBrightness > 140 && textBrightness > 110) {
      text = { r: 24, g: 30, b: 42 }; // Force dark ink on light background
    } else if (bgBrightness <= 140 && textBrightness < 140) {
      text = { r: 255, g: 255, b: 255 }; // Force white ink on dark background
    }

    const inkDensity = totalSampled > 0 ? (textCount / totalSampled) : 0;

    // Bulletproof hex formatter: clamps to [0, 255] and pads 2 digits (zero bit-shift overflow risk)
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v || 0)));
    const toHex = (c) => `#${clamp(c.r).toString(16).padStart(2, '0')}${clamp(c.g).toString(16).padStart(2, '0')}${clamp(c.b).toString(16).padStart(2, '0')}`;

    return {
      bgColor: toHex(bg),
      textColor: toHex(text),
      hasVisibleInk: textCount > 0,
      isScannedBg,
      isBoldInk: inkDensity > 0.25,
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

      if (elements.selectFontFamily) {
        const ff = (activeObj.fontFamily || '').toLowerCase();
        if (ff.includes('monospace') || ff.includes('courier') || ff.includes('consolas')) {
          elements.selectFontFamily.value = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        } else if (ff.includes('serif') && !ff.includes('sans-serif')) {
          elements.selectFontFamily.value = 'Georgia, Cambria, "Times New Roman", Times, serif';
        } else if (ff.includes('arial') || ff.includes('helvetica')) {
          elements.selectFontFamily.value = 'Arial, Helvetica, sans-serif';
        } else {
          elements.selectFontFamily.value = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
        }
      }

      elements.labelFontSize.textContent = Math.round(activeObj.fontSize || 16);
      elements.inputTextColor.value = activeObj.fill || '#111827';
      elements.btnTextBold.className = (activeObj.fontWeight === 'bold')
        ? 'w-6 h-6 rounded bg-blue-600 text-white flex items-center justify-center font-bold text-xs'
        : 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 flex items-center justify-center font-bold text-xs';
      if (elements.btnTextItalic) {
        elements.btnTextItalic.className = (activeObj.fontStyle === 'italic')
          ? 'w-6 h-6 rounded bg-blue-600 text-white flex items-center justify-center italic font-serif text-xs'
          : 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 flex items-center justify-center italic font-serif text-xs';
      }

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

      if (elements.btnToggleScanBlend) {
        const isBlended = Boolean(activeObj.data?.scanBlend || activeObj.shadow);
        elements.btnToggleScanBlend.className = isBlended
          ? 'px-1.5 h-6 rounded bg-amber-600 text-white text-[10px] font-medium flex items-center gap-1 transition shadow-inner'
          : 'px-1.5 h-6 rounded bg-slate-800 hover:bg-slate-700 text-amber-300 text-[10px] font-medium flex items-center gap-1 transition border border-slate-700';
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
      // --- Strategy A: Direct Overlay onto Original Vector Pages (and clean reconstruction for rotated pages) ---
      for (let p = 1; p <= state.totalPages; p++) {
        showExportProgress(true, `正在合成第 ${p} / ${state.totalPages} 页修改...`);
        const pdfPage = originalDoc.getPage(p - 1);
        const pageRot = (((pdfPage.getRotation && pdfPage.getRotation().angle) || 0) % 360 + 360) % 360;
        const overlayPngUrl = await generatePageOverlayPng(p);

        if (pageRot !== 0 && overlayPngUrl) {
          // For rotated pages (intrinsic /Rotate or user-rotated via rotateCurrentPage90),
          // rebuild into an upright normalized page so overlays match PDF.js coordinates 1:1.
          const composite = await renderDecryptedPageComposite(p);
          const embeddedComposite = await originalDoc.embedPng(composite.dataUrl);
          originalDoc.removePage(p - 1);
          const uprightPage = originalDoc.insertPage(p - 1, [composite.widthPt, composite.heightPt]);
          uprightPage.drawImage(embeddedComposite, {
            x: 0,
            y: 0,
            width: composite.widthPt,
            height: composite.heightPt,
          });
        } else if (overlayPngUrl) {
          const embeddedImage = await originalDoc.embedPng(overlayPngUrl);
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

// Generates transparent overlay PNG for a single page (with seamless paper texture patches for masks)
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

  // Render base PDF page onto an offscreen canvas so seamless masks on any page (1, 2, ...) have exact paper texture
  let basePdfCanvas = (pageNum === state.currentPage && elements.pdfCanvas && elements.pdfCanvas.width > 0)
    ? elements.pdfCanvas
    : null;
  if (!basePdfCanvas) {
    basePdfCanvas = document.createElement('canvas');
    basePdfCanvas.width = baseViewport.width;
    basePdfCanvas.height = baseViewport.height;
    const bCtx = basePdfCanvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: bCtx, viewport: baseViewport }).promise;
  }

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
      prepareSeamlessMasksForCanvas(staticCanvas, basePdfCanvas, 1.0);
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
  const ctx = offscreen.getContext('2d', { willReadFrequently: true });

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
        prepareSeamlessMasksForCanvas(staticCanvas, offscreen, scaleFactor);
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
  // File Upload Handlers (Supports both PDF files and Scanned Images / Photos)
  const MAX_FILE_BYTES = 80 * 1024 * 1024; // 80 MB safe browser memory guard
  const handleFile = async (file) => {
    if (!file) return;
    if (file.size === 0) {
      showToast('所选文件为空（0 字节），请重新选择', 'error');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast('文件超过 80MB，可能导致移动端内存不足，请压缩后重试', 'error');
      return;
    }

    const isPdf = (file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    const isImage = (file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(file.name));

    if (!isPdf && !isImage) {
      showToast('请选择有效的 PDF 文件或扫描图片 (.jpg/.png/.webp)', 'error');
      return;
    }

    if (isImage) {
      await openScannedImageAsPdf(file);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => showToast('读取文件失败，请检查文件权限后重试', 'error');
    reader.onload = (e) => {
      openPdfFile(e.target.result, file.name, '', null, false);
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

  // Pagination & Quick Page Jump
  elements.btnPrevPage.addEventListener('click', () => {
    if (state.currentPage > 1) renderPage(state.currentPage - 1);
  });
  elements.btnNextPage.addEventListener('click', () => {
    if (state.currentPage < state.totalPages) renderPage(state.currentPage + 1);
  });
  if (elements.btnPageJump) {
    elements.btnPageJump.addEventListener('click', () => {
      if (!state.pdfDoc || state.totalPages <= 1) return;
      const input = prompt(`跳转到指定页码 (1 - ${state.totalPages})：`, String(state.currentPage));
      if (!input) return;
      const target = parseInt(input.trim(), 10);
      if (Number.isFinite(target) && target >= 1 && target <= state.totalPages) {
        if (target !== state.currentPage) renderPage(target);
      } else {
        showToast(`请输入 1 到 ${state.totalPages} 之间的有效页码`, 'error');
      }
    });
  }

  // Mode Switch
  elements.btnModeBrowse.addEventListener('click', () => setMode('browse'));
  if (elements.btnModeSelect) {
    elements.btnModeSelect.addEventListener('click', () => setMode('select'));
  }
  elements.btnModeEdit.addEventListener('click', () => setMode('edit'));

  // Rotate Page 90° CW
  if (elements.btnRotatePage) {
    elements.btnRotatePage.addEventListener('click', () => rotateCurrentPage90());
  }
  if (elements.btnScanRotate) {
    elements.btnScanRotate.addEventListener('click', () => rotateCurrentPage90());
  }

  // Quick Zoom HUD
  elements.btnZoomIn.addEventListener('click', () => setZoom(state.currentZoom + 0.25));
  elements.btnZoomOut.addEventListener('click', () => setZoom(state.currentZoom - 0.25));
  elements.btnZoomReset.addEventListener('click', () => setZoom(1.0));
  elements.btnZoomFit.addEventListener('click', () => fitToScreenWidth());
  elements.btnZoom200.addEventListener('click', () => setZoom(2.0));

  // Word Mode, Scanned OCR & Direct Edit Buttons
  if (elements.btnOcrPage) {
    elements.btnOcrPage.addEventListener('click', () => runOcrOnCurrentPage('eng', true));
  }
  if (elements.toolOcrPage) {
    elements.toolOcrPage.addEventListener('click', () => runOcrOnCurrentPage('eng', true));
  }
  if (elements.btnOcrFastEng) {
    elements.btnOcrFastEng.addEventListener('click', () => runOcrOnCurrentPage('eng', true));
  }
  if (elements.btnOcrChiEng) {
    elements.btnOcrChiEng.addEventListener('click', () => runOcrOnCurrentPage('chi_sim+eng', true));
  }
  if (elements.btnCloseScanBanner) {
    elements.btnCloseScanBanner.addEventListener('click', () => {
      elements.scanDetectedBanner.classList.add('hidden');
    });
  }
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
  if (elements.toolSelect) {
    elements.toolSelect.addEventListener('click', () => setTool('select'));
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

  // Undo Button (Real per-page snapshot stack)
  elements.btnUndo.addEventListener('click', () => {
    undoLastAction();
  });

  // Global Ctrl+Z / Cmd+Z Undo shortcut
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      const activeObj = fabricCanvas?.getActiveObject();
      if (activeObj && activeObj.isEditing) return; // Keep native text cursor undo while typing
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      e.preventDefault();
      undoLastAction();
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
  if (elements.selectFontFamily) {
    elements.selectFontFamily.addEventListener('change', (e) => {
      const obj = fabricCanvas?.getActiveObject();
      if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
        obj.set('fontFamily', e.target.value);
        updateTextDimensionsAndMask(obj);
        showToast('已切换字体样式', 'info');
      }
    });
  }
  elements.btnFontMinus.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fontSize', Math.max(10, (obj.fontSize || 16) - 2));
      elements.labelFontSize.textContent = Math.round(obj.fontSize);
      updateTextDimensionsAndMask(obj);
    }
  });
  elements.btnFontPlus.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
      obj.set('fontSize', Math.min(72, (obj.fontSize || 16) + 2));
      elements.labelFontSize.textContent = Math.round(obj.fontSize);
      updateTextDimensionsAndMask(obj);
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
      updateTextDimensionsAndMask(obj);
      showToast(isBold ? '已取消加粗' : '已设置为加粗', 'info');
    }
  });
  if (elements.btnTextItalic) {
    elements.btnTextItalic.addEventListener('click', () => {
      const obj = fabricCanvas?.getActiveObject();
      if (obj && (obj.type === 'textbox' || obj.type === 'i-text')) {
        const isItalic = (obj.fontStyle === 'italic');
        const targetStyle = isItalic ? 'normal' : 'italic';
        obj.set('fontStyle', targetStyle);
        if (obj.isEditing && obj.selectionStart !== obj.selectionEnd) {
          obj.setSelectionStyles({ fontStyle: targetStyle });
        }
        updatePropertyBar();
        fabricCanvas.requestRenderAll();
        saveCurrentPageState(state.currentPage);
        showToast(isItalic ? '已取消斜体' : '已设置为斜体', 'info');
      }
    });
  }
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
          mask._patchCanvas = null;
          if (mask.data) {
            mask.data.bgColor = e.target.value;
            mask.data.customSolidColor = true;
          }
          fabricCanvas.requestRenderAll();
          saveCurrentPageState(state.currentPage);
        }
      }
    });
  }
  if (elements.btnRestoreSeamlessMask) {
    elements.btnRestoreSeamlessMask.addEventListener('click', () => {
      const activeObj = fabricCanvas?.getActiveObject();
      if (activeObj && activeObj.data?.linkedMaskId) {
        const mask = fabricCanvas.getObjects().find(o => o.data?.id === activeObj.data.linkedMaskId);
        if (mask) {
          const sampled = samplePdfColors(mask.left, mask.top, mask.width, mask.height);
          mask.set('fill', sampled.bgColor);
          if (mask.data) {
            mask.data.bgColor = sampled.bgColor;
            mask.data.customSolidColor = false;
          }
          buildMaskSeamlessPatch(mask, elements.pdfCanvas, 1.0);
          if (elements.inputTextBgColor) elements.inputTextBgColor.value = sampled.bgColor;
          fabricCanvas.requestRenderAll();
          saveCurrentPageState(state.currentPage);
          showToast('已恢复无痕纸张底纹修复！', 'success');
        }
      }
    });
  }
  if (elements.btnToggleScanBlend) {
    elements.btnToggleScanBlend.addEventListener('click', () => {
      const activeObj = fabricCanvas?.getActiveObject();
      if (activeObj && (activeObj.type === 'textbox' || activeObj.type === 'i-text')) {
        const nextBlend = !Boolean(activeObj.data?.scanBlend || activeObj.shadow);
        applyScanInkBlend(activeObj, nextBlend);
        updatePropertyBar();
        fabricCanvas.requestRenderAll();
        saveCurrentPageState(state.currentPage);
        showToast(nextBlend ? '已开启扫描件墨迹柔化，边缘更自然！' : '已切换为高清锐利文字', 'info');
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

  // Mask / Privacy Redaction Color Swatches
  const applyMaskSolidColor = (color) => {
    const obj = fabricCanvas?.getActiveObject();
    if (!obj) return;
    obj.set('fill', color);
    obj._patchCanvas = null;
    if (!obj.data) obj.data = {};
    obj.data.bgColor = color;
    obj.data.customSolidColor = true;
    fabricCanvas.requestRenderAll();
    saveCurrentPageState(state.currentPage);
  };
  elements.inputMaskColor.addEventListener('input', (e) => applyMaskSolidColor(e.target.value));
  document.querySelectorAll('.mask-color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      elements.inputMaskColor.value = color;
      applyMaskSolidColor(color);
      if (color === '#000000') {
        showToast('已切换为隐私涂黑打码模式', 'info');
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

  // Delete Selected Object(s) (Supports single object and multi-object activeSelection)
  elements.btnDeleteSelected.addEventListener('click', () => {
    const obj = fabricCanvas?.getActiveObject();
    if (!obj) return;

    const targets = (obj.type === 'activeSelection' && typeof obj.getObjects === 'function')
      ? [...obj.getObjects()]
      : [obj];

    fabricCanvas.discardActiveObject();
    targets.forEach(item => {
      if (item.data?.linkedMaskId) {
        const mask = fabricCanvas.getObjects().find(o => o.data?.id === item.data.linkedMaskId);
        if (mask) fabricCanvas.remove(mask);
      }
      fabricCanvas.remove(item);
    });

    saveCurrentPageState(state.currentPage);
    updatePropertyBar();
    fabricCanvas.requestRenderAll();
    showToast(targets.length > 1 ? `已删除选中的 ${targets.length} 个元素` : '已删除选中元素', 'info');
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
  elements.btnRescanInReplace?.addEventListener('click', async () => {
    await runOcrOnCurrentPage('eng', true);
    renderReplaceDetectedChips();
    updateReplacePreview();
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
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchTextLine(text, findStr, exact) {
  if (!text || !findStr) return false;
  const t = String(text).trim();
  const f = String(findStr).trim();
  if (exact) {
    return t.toLowerCase() === f.toLowerCase();
  }
  return t.toLowerCase().includes(f.toLowerCase());
}

function replaceTextContent(text, findStr, replaceStr, exact) {
  if (!text || !findStr) return text;
  if (exact) return replaceStr;
  if (text.includes(findStr)) {
    return text.replaceAll(findStr, replaceStr);
  }
  const re = new RegExp(escapeRegExp(findStr), 'gi');
  return text.replace(re, replaceStr);
}

// Render clickable chips of recognized tokens/numbers on current page inside Batch Replace modal
function renderReplaceDetectedChips() {
  if (!elements.replaceDetectedChipsContainer || !elements.replaceDetectedChips) return;

  const tokenSet = new Set();
  const addCandidate = (raw) => {
    if (!raw) return;
    const clean = String(raw).trim();
    if (clean.length >= 2 && clean.length <= 32) {
      tokenSet.add(clean);
    }
    // Also add space-separated sub-tokens that look like IDs, dates, numbers, or names
    if (clean.includes(' ')) {
      clean.split(/\s+/).forEach(part => {
        const p = part.replace(/^[,.;:()]+|[,.;:()]+$/g, '');
        if (p.length >= 2 && p.length <= 24) tokenSet.add(p);
      });
    }
  };

  if (fabricCanvas) {
    fabricCanvas.getObjects().forEach(obj => {
      if (obj.data?.isText && obj.text) addCandidate(obj.text);
    });
  }

  const lines = state.pageTextLines[state.currentPage] || [];
  lines.forEach(l => addCandidate(l.text));

  const tokens = Array.from(tokenSet);
  if (tokens.length === 0) {
    if (state.isScannedPage[state.currentPage]) {
      elements.replaceDetectedChipsContainer.classList.remove('hidden');
      if (elements.replaceChipsTitle) {
        elements.replaceChipsTitle.textContent = '当前页为扫描图像，点击右侧「重新OCR识字」即可提取文字：';
      }
      elements.replaceDetectedChips.innerHTML = '';
    } else {
      elements.replaceDetectedChipsContainer.classList.add('hidden');
    }
    return;
  }

  // Prioritize numeric values, dates, and longer tokens first
  tokens.sort((a, b) => {
    const aHasDigit = /\d/.test(a) ? 1 : 0;
    const bHasDigit = /\d/.test(b) ? 1 : 0;
    if (aHasDigit !== bHasDigit) return bHasDigit - aHasDigit;
    return b.length - a.length;
  });

  elements.replaceDetectedChipsContainer.classList.remove('hidden');
  if (elements.replaceChipsTitle) {
    elements.replaceChipsTitle.textContent = `当前页已识别文字 (${tokens.length} 项，点击直接填入查找框)：`;
  }

  elements.replaceDetectedChips.innerHTML = '';
  tokens.slice(0, 36).forEach(tok => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isIdOrNum = /\d/.test(tok);
    btn.className = isIdOrNum
      ? 'px-2 py-0.5 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-mono text-[11px] font-semibold transition truncate max-w-[180px]'
      : 'px-2 py-0.5 rounded bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 text-[11px] transition truncate max-w-[160px]';
    btn.textContent = tok;
    btn.title = `点击查找: ${tok}`;
    btn.addEventListener('click', () => {
      elements.inputReplaceFind.value = tok;
      elements.btnClearReplaceFind.classList.remove('hidden');
      updateReplacePreview();
      elements.inputReplaceTarget.focus();
    });
    elements.replaceDetectedChips.appendChild(btn);
  });
}

async function openBatchReplaceModal(prefillFind = null) {
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
  } else if (!elements.inputReplaceFind.value) {
    elements.btnClearReplaceFind.classList.add('hidden');
  }

  elements.modalBatchReplace.classList.remove('hidden');
  renderReplaceDetectedChips();
  await updateReplacePreview();

  // If current page is a scanned image/PDF with <= 2 extracted lines, auto-run general local OCR
  const curLines = state.pageTextLines[state.currentPage] || [];
  if (state.isScannedPage[state.currentPage] && curLines.length <= 2 && !isRunningOcr) {
    if (elements.replaceDetectedChipsContainer) {
      elements.replaceDetectedChipsContainer.classList.remove('hidden');
    }
    if (elements.replaceChipsTitle) {
      elements.replaceChipsTitle.textContent = '⏳ 检测到当前页为扫描图像，正在自动运行本地 OCR 识别文字...';
    }
    await runOcrOnCurrentPage('eng', true, true);
    renderReplaceDetectedChips();
    await updateReplacePreview();
  }

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
          if (matchTextLine(obj.text, findStr, exact)) {
            matchCount++;
            if (previewItems.length < 5) {
              previewItems.push(`第 ${p} 页 (已编辑): "${obj.text.substring(0, 35)}"`);
            }
          }
        }
      }
    } else if (state.pageStates[p]?.objects) {
      for (const obj of state.pageStates[p].objects) {
        if (obj.data?.isText && obj.text) {
          if (matchTextLine(obj.text, findStr, exact)) {
            matchCount++;
            if (previewItems.length < 5) {
              previewItems.push(`第 ${p} 页 (已编辑): "${obj.text.substring(0, 35)}"`);
            }
          }
        }
      }
    }

    // 2. Lazily extract text lines for unvisited pages so Page 2+ matches are always discovered!
    let lines = state.pageTextLines[p];
    if ((!lines || lines.length === 0) && state.pdfDoc && !state.isScannedPage[p]) {
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
      if (matchTextLine(l.text, findStr, exact)) {
        matchCount++;
        if (previewItems.length < 5) {
          previewItems.push(`第 ${p} 页: "${l.text.substring(0, 35)}"`);
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
      beginHistoryBatch(state.currentPage);
      try {
        const activeObjs = fabricCanvas.getObjects();
        const convertedLineIds = new Set();

        // Step A: Replace inside active Fabric Textboxes
        activeObjs.forEach(obj => {
          if (obj.data?.isText && obj.text) {
            if (obj.data.lineId) convertedLineIds.add(obj.data.lineId);
            if (matchTextLine(obj.text, findStr, exact)) {
              const nextText = replaceTextContent(obj.text, findStr, replaceStr, exact);
              if (nextText !== obj.text) {
                obj.set('text', nextText);
                updateTextDimensionsAndMask(obj);
                totalReplaced++;
              }
            }
          }
        });

        // Step B: Replace unconverted PDF/OCR text lines on current page
        let currentLines = state.pageTextLines[state.currentPage];
        if ((!currentLines || currentLines.length === 0) && !state.isScannedPage[state.currentPage]) {
          const page = await state.pdfDoc.getPage(state.currentPage);
          const viewport = page.getViewport({ scale: state.baseScale });
          currentLines = await extractPageTextLines(page, viewport);
          state.pageTextLines[state.currentPage] = currentLines;
        }
        currentLines = currentLines || [];

        currentLines.forEach(line => {
          if (convertedLineIds.has(line.id)) return;
          if (matchTextLine(line.text, findStr, exact)) {
            const sampled = samplePdfColors(line.left, line.top, line.width, line.height);
            if (!sampled.hasVisibleInk && !line.isOcr) return;
            const nextText = replaceTextContent(line.text, findStr, replaceStr, exact);
            const tb = convertLineToTextbox(line, false);
            if (tb) {
              tb.set('text', nextText);
              updateTextDimensionsAndMask(tb);
              totalReplaced++;
            }
          }
        });
      } finally {
        endHistoryBatch(state.currentPage);
      }

      fabricCanvas.requestRenderAll();
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

        const hasExistingMatches = pObjects.some(obj => obj.data?.isText && obj.text && matchTextLine(obj.text, findStr, exact));
        const hasUnconvertedMatches = pLines.some(line => !pConvertedLineIds.has(line.id) && matchTextLine(line.text, findStr, exact));

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
            if (matchTextLine(obj.text, findStr, exact)) {
              const nextText = replaceTextContent(obj.text, findStr, replaceStr, exact);
              if (nextText !== obj.text) {
                obj.text = nextText;
                obj.styles = Array.isArray(obj.styles) ? obj.styles : [];
                const measuredW = measureTextLineWidth(nextText, obj.fontSize || 16, obj.fontWeight || 'normal', obj.fontFamily, obj.charSpacing || 0);
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
          if (matchTextLine(line.text, findStr, exact)) {
            const lineColors = samplePdfColors(line.left, line.top, line.width, line.height, pCanvas);
            if (!lineColors.hasVisibleInk && !line.isOcr) return;

            const nextText = replaceTextContent(line.text, findStr, replaceStr, exact);
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

// ==========================================
// 16. Scanned Image Upload, Page Rotation & Deep OCR Engine (扫描件识别 & 无痕改字)
// ==========================================
async function rotateCurrentPage90() {
  if (!state.pdfDoc || !state.pdfData) {
    showToast('请先打开 PDF 文件', 'error');
    return;
  }
  try {
    showExportProgress(true, '正在旋转当前页面 90°...');
    const pageNum = state.currentPage;
    const pdfDoc = await PDFLib.PDFDocument.load(state.pdfData.slice(0), { ignoreEncryption: true });
    const page = pdfDoc.getPage(pageNum - 1);
    const currentRot = page.getRotation().angle || 0;
    const nextRot = (currentRot + 90) % 360;
    page.setRotation(PDFLib.degrees(nextRot));

    const newBytes = await pdfDoc.save();
    state.pdfData = newBytes.buffer;

    // Clear old coordinates on this rotated page
    delete state.pageTextLines[pageNum];
    delete state.pageStates[pageNum];
    if (fabricCanvas) fabricCanvas.clear();

    const loadingTask = pdfjsLib.getDocument({ data: state.pdfData.slice(0) });
    state.pdfDoc = await loadingTask.promise;

    await renderPage(pageNum);
    showExportProgress(false);
    showToast('已将当前页面顺时针旋转 90°！', 'success');

    if (state.isScannedPage[pageNum]) {
      await runOcrOnCurrentPage('eng', true);
    }
  } catch (err) {
    showExportProgress(false);
    console.error('rotateCurrentPage90 error:', err);
    showToast('旋转页面失败: ' + err.message, 'error');
  }
}

async function openScannedImageAsPdf(file) {
  try {
    showExportProgress(true, '正在加载扫描图片并构建高清页面...');
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });

    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('解码图片失败'));
      image.src = dataUrl;
    });

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = img.naturalWidth || img.width;
    tempCanvas.height = img.naturalHeight || img.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.fillStyle = '#ffffff';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tCtx.drawImage(img, 0, 0);

    const jpgDataUrl = tempCanvas.toDataURL('image/jpeg', 0.96);
    const pdfDoc = await PDFLib.PDFDocument.create();
    const embeddedJpg = await pdfDoc.embedJpg(jpgDataUrl);

    const pageWidthPt = 612; // Standard Letter width in pt
    const pageHeightPt = Math.max(200, Math.round((tempCanvas.height / tempCanvas.width) * pageWidthPt));
    const page = pdfDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(embeddedJpg, {
      x: 0,
      y: 0,
      width: pageWidthPt,
      height: pageHeightPt,
    });

    const pdfBytes = await pdfDoc.save();
    showExportProgress(false);

    const displayFileName = file.name.replace(/\.(jpe?g|png|webp|bmp)$/i, '') + '.pdf';
    await openPdfFile(pdfBytes.buffer, displayFileName, '', null, true);
    showToast('扫描图片已加载！可点顶部「扫描件识别」或用「框选无痕改字」直接改', 'success');
  } catch (err) {
    showExportProgress(false);
    console.error('openScannedImageAsPdf error:', err);
    showToast('加载图片失败: ' + err.message, 'error');
  }
}

// Trim stray surrounding whitespace and punctuation artifacts on general OCR tokens
function cleanOcrToken(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^[“"‘'«»~`]+|[”"’'«»~`]+$/g, '');
}

// Cluster word items in a given reading space into lines
function clusterOcrWordsIntoLines(wordItems) {
  const sorted = [...wordItems].sort((a, b) => {
    if (Math.abs(a.vy - b.vy) > Math.max(6, Math.min(a.height, b.height) * 0.45)) {
      return a.vy - b.vy;
    }
    return a.left - b.left;
  });

  const clusteredLines = [];
  let current = null;

  for (const item of sorted) {
    if (!current) {
      current = { ...item, text: item.str };
      continue;
    }
    const sameBaseline = Math.abs(current.vy - item.vy) <= Math.max(6, item.height * 0.48);
    const xGap = item.left - (current.left + current.width);
    const sameSize = Math.abs(current.canvasFontSize - item.canvasFontSize) <= 5;
    const isClose = (xGap >= -6 && xGap <= Math.min(22, item.height * 1.35));

    if (sameBaseline && sameSize && isClose) {
      const isCjk = /[\u4e00-\u9fa5]/.test(current.text.slice(-1)) && /[\u4e00-\u9fa5]/.test(item.str[0]);
      const sep = (xGap > 1 && !isCjk) ? ' ' : '';
      current.text += sep + item.str;
      current.top = Math.min(current.top, item.top);
      const bottom = Math.max(current.top + current.height, item.top + item.height);
      current.width = (item.left + item.width) - current.left;
      current.height = bottom - current.top;
      current.canvasFontSize = Math.round((current.canvasFontSize + item.canvasFontSize) / 2);
    } else {
      clusteredLines.push(current);
      current = { ...item, text: item.str };
    }
  }
  if (current) clusteredLines.push(current);
  return clusteredLines;
}

let isRunningOcr = false;
async function runOcrOnCurrentPage(lang = 'eng', forceRescan = false, silentModal = false) {
  if (!state.pdfDoc || !fabricCanvas) {
    if (!silentModal) showToast('请先打开 PDF 或扫描图片', 'error');
    return [];
  }
  if (isRunningOcr) return state.pageTextLines[state.currentPage] || [];

  const pageNum = state.currentPage;
  if (!forceRescan && state.pageTextLines[pageNum] && state.pageTextLines[pageNum].length > 3) {
    return state.pageTextLines[pageNum];
  }

  if (typeof Tesseract === 'undefined') {
    if (!silentModal) showToast('OCR 识别组件正在加载，请稍候重试，或直接使用底部「框选改字」', 'warning');
    return [];
  }

  isRunningOcr = true;
  const langLabel = lang.includes('chi') ? '中英混合' : '英文/数字文档';
  if (!silentModal) {
    showExportProgress(true, `正在启动智能 OCR (${langLabel}) 识别第 ${pageNum} 页...`);
  }

  try {
    // Render current page at high-resolution 2.0x scale for strong general OCR accuracy
    const page = await state.pdfDoc.getPage(pageNum);
    const ocrScale = 2.0;
    const ocrViewport = page.getViewport({ scale: ocrScale });
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width = ocrViewport.width;
    ocrCanvas.height = ocrViewport.height;
    const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ocrCtx, viewport: ocrViewport }).promise;

    const coordRatio = state.baseScale / ocrScale; // Maps 2.0x OCR coords cleanly back to 1.5x canvas coords
    const baseW = elements.pdfCanvas.width;
    const baseH = elements.pdfCanvas.height;

    const extractWords = (tessResult, ratio, minConf = 28) => {
      const out = [];
      for (const w of (tessResult?.data?.words || [])) {
        const cleanStr = cleanOcrToken(w.text);
        if (!cleanStr) continue;
        const conf = w.confidence !== undefined ? w.confidence : 50;
        if (conf < minConf) continue;
        const bw = (w.bbox.x1 - w.bbox.x0) * ratio;
        const bh = (w.bbox.y1 - w.bbox.y0) * ratio;
        if (bw < 4 || bh < 5 || bh > 130) continue;
        const left = w.bbox.x0 * ratio;
        const top = w.bbox.y0 * ratio;
        out.push({
          str: cleanStr,
          left,
          top,
          width: bw,
          height: bh,
          vy: top + bh * 0.85,
          canvasFontSize: Math.max(9, Math.min(48, Math.round(bh * 0.94))),
          conf,
          isOcr: true,
        });
      }
      return out;
    };

    // Pass 1: Crisp 2.0x upright document recognition
    const res0 = await Tesseract.recognize(ocrCanvas, lang, {
      logger: (m) => {
        if (!silentModal && m && m.status && m.status.includes('recognizing')) {
          const pct = typeof m.progress === 'number' ? Math.round(m.progress * 100) : 0;
          showExportProgress(true, `正在识别图中文字与排版坐标... ${pct}%`);
        }
      },
    });
    const uprightWords = extractWords(res0, coordRatio, 28);
    let finalLines = [];

    // Pass 2: General +90 deg CW fallback ONLY when upright yields very few tokens (e.g. sideways landscape table/scan)
    if (uprightWords.length < 4) {
      const rot90Canvas = document.createElement('canvas');
      rot90Canvas.width = ocrCanvas.height;
      rot90Canvas.height = ocrCanvas.width;
      const rCtx = rot90Canvas.getContext('2d', { willReadFrequently: true });
      rCtx.translate(rot90Canvas.width, 0);
      rCtx.rotate(Math.PI / 2);
      rCtx.drawImage(ocrCanvas, 0, 0);
      rCtx.setTransform(1, 0, 0, 1, 0, 0);

      const resRot = await Tesseract.recognize(rot90Canvas, lang);
      const rotWords = extractWords(resRot, coordRatio, 35);

      if (rotWords.length > uprightWords.length) {
        const rotClustered = clusterOcrWordsIntoLines(rotWords);
        rotClustered.forEach((rLine, idx) => {
          const rx0 = rLine.left;
          const ry0 = rLine.top;
          const rx1 = rLine.left + rLine.width;
          const ry1 = rLine.top + rLine.height;

          const boxLeft = Math.max(0, Math.round(ry0));
          const boxTop = Math.max(0, Math.round(baseH - rx1));
          const boxWidth = Math.max(8, Math.round(ry1 - ry0));
          const boxHeight = Math.max(10, Math.round(rx1 - rx0));
          const fontSize = Math.max(10, Math.min(44, Math.round(boxWidth * 0.90)));

          finalLines.push({
            id: `ocr_rot_p${pageNum}_${idx}`,
            text: rLine.text,
            str: rLine.text,
            left: boxLeft,
            top: boxTop,
            width: boxWidth,
            height: boxHeight,
            textLeft: boxLeft,
            textTop: Math.round(baseH - rx0),
            angle: -90,
            canvasFontSize: fontSize,
            pdfFontSize: Math.round(fontSize / state.baseScale),
            isBold: false,
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            isOcr: true,
          });
        });
      }
    }

    // Refine upright OCR lines using pixel ink bounds
    if (finalLines.length === 0 && uprightWords.length > 0) {
      const clusteredLines = clusterOcrWordsIntoLines(uprightWords);
      clusteredLines.forEach((line, idx) => {
        const colors = samplePdfColors(line.left, line.top, line.width, line.height);
        if (!colors.hasVisibleInk) return;
        const inkBounds = detectInkBoundsInBox(line.left, line.top, line.width, line.height, colors.bgColor);
        const refinedTop = inkBounds ? inkBounds.inkTop : line.top;
        const refinedHeight = inkBounds ? Math.max(8, inkBounds.inkHeight) : line.height;
        const refinedFontSize = Math.max(9, Math.min(48, Math.round(refinedHeight * 1.0)));

        finalLines.push({
          id: `ocr_p${pageNum}_${idx}`,
          text: line.text,
          str: line.text,
          left: inkBounds ? inkBounds.inkLeft : line.left,
          top: refinedTop,
          width: inkBounds ? Math.max(line.width, inkBounds.inkWidth) : line.width,
          height: refinedHeight,
          angle: 0,
          canvasFontSize: refinedFontSize,
          pdfFontSize: Math.round(refinedFontSize / state.baseScale),
          isBold: inkBounds ? inkBounds.isBold : Boolean(colors.isBoldInk),
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          isOcr: true,
        });
      });
    }

    state.pageTextLines[pageNum] = finalLines;
    state.isScannedPage[pageNum] = true;

    if (elements.scanDetectedBanner) {
      elements.scanDetectedBanner.classList.add('hidden');
    }

    if (!silentModal) {
      showExportProgress(false);
      setTool('tap-edit');
      if (finalLines.length > 0) {
        showToast(`✨ 识别完成！共定位 ${finalLines.length} 处文字，直接点击即可编辑或一键替换！`, 'success');
        if (window.confetti) {
          window.confetti({ particleCount: 45, spread: 65, origin: { y: 0.75 } });
        }
      } else {
        showToast('未识别出清晰文字，请尝试点击「旋转」转正或使用底部「框选改字」', 'warning');
      }
    }
    return finalLines;
  } catch (err) {
    if (!silentModal) showExportProgress(false);
    console.error('OCR error:', err);
    if (!silentModal) showToast('OCR 识别失败: ' + err.message + '，可使用底部「框选改字」', 'error');
    return [];
  } finally {
    isRunningOcr = false;
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
window.runOcrOnCurrentPage = runOcrOnCurrentPage;
window.rotateCurrentPage90 = rotateCurrentPage90;
window.buildMaskSeamlessPatch = buildMaskSeamlessPatch;
window.renderReplaceDetectedChips = renderReplaceDetectedChips;
window.undoLastAction = undoLastAction;

// Initialize Application
function initApp() {
  setupEventListeners();
  initSignatureBoard();
  setupTouchAndPan();
  checkPendingDraftOnStartup();

  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled async error:', e.reason);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
