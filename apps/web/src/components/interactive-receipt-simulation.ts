import { getLocale } from "../i18n/language";
import { t } from "../i18n/translate";
import {
  isReceiptSettled,
  nextReceiptReleaseFrame,
  nextReceiptSettledFrame,
  shouldSimulateReceiptFrame,
  whenReceiptFontsReady,
} from "../lib/interactive-receipt-frame-policy";

export interface ReceiptPayload {
  id: string;
  title: string;
  agent: string;
  updatedAt: number;
  subtitle: string;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  totalCost: number;
  items: ReceiptLineItem[];
}

export interface ReceiptLineItem {
  label: string;
  count: number;
}

interface Particle {
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  fixedX: number | null;
  fixedY: number | null;
}

interface Constraint {
  a: number;
  b: number;
  length: number;
  stiffness: number;
}

interface SheetMetrics {
  receiptWidth: number;
  receiptHeight: number;
  startX: number;
  startY: number;
}

function metricsChanged(a: SheetMetrics | null, b: SheetMetrics) {
  if (!a) return true;
  return (
    Math.abs(a.receiptWidth - b.receiptWidth) > 0.5 ||
    Math.abs(a.receiptHeight - b.receiptHeight) > 0.5 ||
    Math.abs(a.startX - b.startX) > 0.5 ||
    Math.abs(a.startY - b.startY) > 0.5
  );
}

interface PointerState {
  id: number | null;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  grabbedIndex: number | null;
}

const COLUMNS = 18;
const ROWS = 42;
const SOLVER_ITERATIONS = 5;
const RECEIPT_WIDTH = 270;
const RECEIPT_HEIGHT = 500;
const TEXTURE_SCALE = 2;
const RECEIPT_GRAIN_ALPHA = 0.035;

/** A canvas cannot resolve `var()`, so every colour the receipt paints is read from the
 *  theme tokens once per repaint and passed down explicitly. Mirrors the palette bridge in
 *  `session-detail/session-message-timeline.tsx`. */
interface ReceiptPalette {
  paperTop: string;
  paperBottom: string;
  ink: string;
  inkMuted: string;
  line: string;
  shadow: string;
}

function readReceiptPalette(root: HTMLElement): ReceiptPalette {
  const styles = window.getComputedStyle(root);
  // An unresolved token would leave the previous fillStyle in place, so every read falls
  // back to a CSS colour keyword rather than to an empty string.
  const read = (token: string, fallback: string) =>
    styles.getPropertyValue(token).trim() || fallback;
  return {
    paperTop: read("--console-surface", "white"),
    paperBottom: read("--console-surface-sunken", "whitesmoke"),
    ink: read("--console-text", "black"),
    inkMuted: read("--console-text-secondary", "dimgray"),
    line: read("--console-border-strong", "silver"),
    shadow: read("--scrim", "gray"),
  };
}

function readReceiptMonoFamily(root: HTMLElement): string {
  return window.getComputedStyle(root).getPropertyValue("--font-mono").trim() || "monospace";
}

function formatCount(value?: number) {
  return Math.round(value ?? 0).toLocaleString(getLocale());
}

function formatMoney(value?: number) {
  return `$${(value ?? 0).toFixed(4)}`;
}

function formatDate(value: number) {
  return new Date(value).toLocaleString(getLocale(), {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed: number) {
  let state = seed || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function drawMonoLine(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  y: number,
  width: number,
) {
  const left = label.toUpperCase();
  const right = value.toUpperCase();
  ctx.fillText(left, 18, y);
  ctx.fillText(right, width - 18 - ctx.measureText(right).width, y);
}

function fitText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 1 && ctx.measureText(`${text}...`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
}

function wrapTitle(
  ctx: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
  maxLines: number,
) {
  const words = value.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(fitText(ctx, word, maxWidth));
      current = "";
    }
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length > 0 && lines.length === maxLines) {
    lines[lines.length - 1] = fitText(ctx, lines[lines.length - 1] ?? "", maxWidth);
  }

  return lines.slice(0, maxLines);
}

function drawTexture(payload: ReceiptPayload, palette: ReceiptPalette, monoFamily: string) {
  const texture = document.createElement("canvas");
  texture.width = RECEIPT_WIDTH * TEXTURE_SCALE;
  texture.height = RECEIPT_HEIGHT * TEXTURE_SCALE;

  const ctx = texture.getContext("2d");
  if (!ctx) return texture;

  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);
  const font = (spec: string) => `${spec} ${monoFamily}`;

  const paper = ctx.createLinearGradient(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);
  paper.addColorStop(0, palette.paperTop);
  paper.addColorStop(1, palette.paperBottom);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);

  const random = createRandom(hashString(payload.id));
  ctx.fillStyle = palette.ink;
  for (let i = 0; i < 1200; i += 1) {
    ctx.globalAlpha = RECEIPT_GRAIN_ALPHA * (0.12 + random() * 0.14);
    ctx.fillRect(random() * RECEIPT_WIDTH, random() * RECEIPT_HEIGHT, 0.7, 0.7);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = palette.ink;
  ctx.font = font("700 18px");
  ctx.textAlign = "center";
  ctx.fillText("CODESESH MART", RECEIPT_WIDTH / 2, 34);
  ctx.fillStyle = palette.inkMuted;
  ctx.font = font("11px");
  ctx.fillText(
    fitText(ctx, payload.subtitle.toUpperCase(), RECEIPT_WIDTH - 36),
    RECEIPT_WIDTH / 2,
    51,
  );

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(18, 66);
  ctx.lineTo(RECEIPT_WIDTH - 18, 66);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = "left";
  ctx.fillStyle = palette.ink;
  ctx.font = font("11px");
  drawMonoLine(ctx, t("Agent"), payload.agent, 88, RECEIPT_WIDTH);
  drawMonoLine(ctx, t("Updated"), formatDate(payload.updatedAt), 104, RECEIPT_WIDTH);
  drawMonoLine(ctx, t("Session"), `#${payload.id.slice(0, 8)}`, 120, RECEIPT_WIDTH);

  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(18, 140);
  ctx.lineTo(RECEIPT_WIDTH - 18, 140);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = font("700 12px");
  ctx.fillText(t("SESSION TOC RECEIPT LIST"), 18, 163);
  ctx.font = font("11px");

  let y = 185;
  for (const item of payload.items) {
    const count = formatCount(item.count);
    ctx.fillText(fitText(ctx, item.label, 168), 18, y);
    ctx.fillText(count, RECEIPT_WIDTH - 18 - ctx.measureText(count).width, y);
    y += 17;
  }

  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(18, y + 5);
  ctx.lineTo(RECEIPT_WIDTH - 18, y + 5);
  ctx.stroke();

  y += 26;
  drawMonoLine(ctx, t("Input tokens"), formatCount(payload.inputTokens), y, RECEIPT_WIDTH);
  y += 16;
  drawMonoLine(ctx, t("Output tokens"), formatCount(payload.outputTokens), y, RECEIPT_WIDTH);
  y += 16;
  drawMonoLine(ctx, t("Messages"), formatCount(payload.messageCount), y, RECEIPT_WIDTH);
  y += 22;

  ctx.font = font("700 13px");
  drawMonoLine(ctx, t("TOTAL COST"), formatMoney(payload.totalCost), y, RECEIPT_WIDTH);

  ctx.strokeStyle = palette.line;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(18, y + 18);
  ctx.lineTo(RECEIPT_WIDTH - 18, y + 18);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = font("10px");
  ctx.textAlign = "center";
  ctx.fillStyle = palette.inkMuted;
  const titleLines = wrapTitle(ctx, payload.title, RECEIPT_WIDTH - 36, 2);
  titleLines.forEach((line, index) => {
    ctx.fillText(line, RECEIPT_WIDTH / 2, y + 38 + index * 13);
  });

  return texture;
}

function particleIndex(row: number, column: number) {
  return row * COLUMNS + column;
}

function createSheet(metrics: SheetMetrics) {
  const { receiptWidth, receiptHeight, startX, startY } = metrics;
  const spacingX = receiptWidth / (COLUMNS - 1);
  const spacingY = receiptHeight / (ROWS - 1);
  const particles: Particle[] = [];
  const constraints: Constraint[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const x = startX + column * spacingX;
      const y = startY + row * spacingY;
      particles.push({
        x,
        y,
        oldX: x,
        oldY: y,
        fixedX: row === 0 ? x : null,
        fixedY: row === 0 ? y : null,
      });
    }
  }

  const addConstraint = (a: number, b: number, stiffness: number) => {
    const first = particles[a];
    const second = particles[b];
    if (!first || !second) return;
    constraints.push({
      a,
      b,
      length: Math.hypot(second.x - first.x, second.y - first.y),
      stiffness,
    });
  };

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const current = particleIndex(row, column);
      if (column < COLUMNS - 1) addConstraint(current, particleIndex(row, column + 1), 0.98);
      if (row < ROWS - 1) addConstraint(current, particleIndex(row + 1, column), 0.92);
      if (row < ROWS - 1 && column < COLUMNS - 1) {
        addConstraint(current, particleIndex(row + 1, column + 1), 0.46);
        addConstraint(particleIndex(row + 1, column), particleIndex(row, column + 1), 0.46);
      }
      if (column < COLUMNS - 2) addConstraint(current, particleIndex(row, column + 2), 0.35);
      if (row < ROWS - 2) addConstraint(current, particleIndex(row + 2, column), 0.28);
    }
  }

  return { particles, constraints, receiptWidth, receiptHeight };
}

function setTopRowPins(particles: Particle[], metrics: SheetMetrics) {
  const spacingX = metrics.receiptWidth / (COLUMNS - 1);
  for (let column = 0; column < COLUMNS; column += 1) {
    const particle = particles[column];
    if (!particle) continue;
    particle.fixedX = metrics.startX + column * spacingX;
    particle.fixedY = metrics.startY;
  }
}

function pinTopRow(particles: Particle[]) {
  for (let column = 0; column < COLUMNS; column += 1) {
    const particle = particles[column];
    if (!particle || particle.fixedX == null || particle.fixedY == null) continue;
    particle.x = particle.fixedX;
    particle.y = particle.fixedY;
    particle.oldX = particle.fixedX;
    particle.oldY = particle.fixedY;
  }
}

function solveConstraint(particles: Particle[], constraint: Constraint) {
  const first = particles[constraint.a];
  const second = particles[constraint.b];
  if (!first || !second) return;

  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.0001) return;

  const difference = ((distance - constraint.length) / distance) * constraint.stiffness;
  const firstFixed = first.fixedX != null && first.fixedY != null;
  const secondFixed = second.fixedX != null && second.fixedY != null;
  const firstWeight = firstFixed ? 0 : secondFixed ? 1 : 0.5;
  const secondWeight = secondFixed ? 0 : firstFixed ? 1 : 0.5;
  const offsetX = dx * difference;
  const offsetY = dy * difference;

  if (!firstFixed) {
    first.x += offsetX * firstWeight;
    first.y += offsetY * firstWeight;
  }
  if (!secondFixed) {
    second.x -= offsetX * secondWeight;
    second.y -= offsetY * secondWeight;
  }
}

function drawMappedCell(
  ctx: CanvasRenderingContext2D,
  texture: HTMLCanvasElement,
  palette: ReceiptPalette,
  particles: Particle[],
  row: number,
  column: number,
) {
  const topLeft = particles[particleIndex(row, column)];
  const topRight = particles[particleIndex(row, column + 1)];
  const bottomLeft = particles[particleIndex(row + 1, column)];
  const bottomRight = particles[particleIndex(row + 1, column + 1)];
  if (!topLeft || !topRight || !bottomLeft || !bottomRight) return;

  const sourceX = (column / (COLUMNS - 1)) * texture.width;
  const sourceY = (row / (ROWS - 1)) * texture.height;
  const sourceW = texture.width / (COLUMNS - 1);
  const sourceH = texture.height / (ROWS - 1);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topLeft.x, topLeft.y);
  ctx.lineTo(topRight.x, topRight.y);
  ctx.lineTo(bottomRight.x, bottomRight.y);
  ctx.lineTo(bottomLeft.x, bottomLeft.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(
    (topRight.x - topLeft.x) / sourceW,
    (topRight.y - topLeft.y) / sourceW,
    (bottomLeft.x - topLeft.x) / sourceH,
    (bottomLeft.y - topLeft.y) / sourceH,
    topLeft.x,
    topLeft.y,
  );
  ctx.drawImage(
    texture,
    sourceX,
    sourceY,
    sourceW + 1,
    sourceH + 1,
    0,
    0,
    sourceW + 1,
    sourceH + 1,
  );
  ctx.restore();

  const horizontalAngle = Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x);
  const verticalStretch =
    Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y) / (RECEIPT_HEIGHT / (ROWS - 1));
  const shade = Math.sin(horizontalAngle) * 0.08 + (verticalStretch - 1) * 0.16;
  if (Math.abs(shade) < 0.01) return;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(topLeft.x, topLeft.y);
  ctx.lineTo(topRight.x, topRight.y);
  ctx.lineTo(bottomRight.x, bottomRight.y);
  ctx.lineTo(bottomLeft.x, bottomLeft.y);
  ctx.closePath();
  ctx.globalAlpha = Math.abs(shade);
  // A fold lightens toward the paper's brightest tone and darkens toward the scrim. Ink
  // cannot serve as the dark side: in the dark theme it is the near-white text colour and
  // would brighten the fold instead.
  ctx.fillStyle = shade > 0 ? palette.paperTop : palette.shadow;
  ctx.fill();
  ctx.restore();
}

function findGrabTarget(particles: Particle[], x: number, y: number) {
  let bestIndex: number | null = null;
  let bestDistance = 44;

  for (let i = COLUMNS; i < particles.length; i += 1) {
    const particle = particles[i];
    if (!particle) continue;
    const distance = Math.hypot(particle.x - x, particle.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function measureSheetMovement(particles: Particle[]) {
  let maxMovement = 0;
  for (let i = COLUMNS; i < particles.length; i += 1) {
    const particle = particles[i];
    if (!particle) continue;
    maxMovement = Math.max(
      maxMovement,
      Math.hypot(particle.x - particle.oldX, particle.y - particle.oldY),
    );
  }
  return maxMovement;
}

export interface InteractiveReceiptSimulation {
  updatePayload: (payload: ReceiptPayload) => void;
  destroy: () => void;
}

interface InteractiveReceiptSimulationOptions {
  canvas: HTMLCanvasElement;
  anchor: HTMLDivElement;
  hitSurface: HTMLDivElement;
  payload: ReceiptPayload;
  minWidthQuery: string;
}

export function createInteractiveReceiptSimulation({
  canvas,
  anchor,
  hitSurface,
  payload,
  minWidthQuery,
}: InteractiveReceiptSimulationOptions): InteractiveReceiptSimulation | null {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;

  let currentPayload = payload;

  const pointer: PointerState = {
    id: null,
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    vx: 0,
    vy: 0,
    grabbedIndex: null,
  };
  let paper: { texture: HTMLCanvasElement; palette: ReceiptPalette } | null = null;
  let disposed = false;
  let animationFrame = 0;
  let width = 0;
  let height = 0;
  let sheet = createSheet({
    receiptWidth: RECEIPT_WIDTH,
    receiptHeight: RECEIPT_HEIGHT,
    startX: 0,
    startY: 32,
  });
  let startedAt = performance.now();
  let lastMetrics: SheetMetrics | null = null;
  let stableFrames = 0;
  let settledFrames = 0;
  let releaseFrames = 0;
  let lastSimulationTime = 0;
  let isVisible = false;
  let running = false;
  const desktopMedia = window.matchMedia(minWidthQuery);
  const reducedMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");

  const shouldRun = () =>
    paper != null && desktopMedia.matches && document.visibilityState === "visible";

  const repaintPaper = () => {
    const palette = readReceiptPalette(anchor);
    paper = {
      texture: drawTexture(currentPayload, palette, readReceiptMonoFamily(anchor)),
      palette,
    };
  };

  const getSheetMetrics = (): SheetMetrics => {
    const rect = anchor.getBoundingClientRect();
    const anchorWidth = Math.max(280, rect.width || 320);
    const receiptWidth = Math.min(RECEIPT_WIDTH, anchorWidth - 34);
    const receiptHeight = Math.min(RECEIPT_HEIGHT, Math.max(320, height - 42));
    return {
      receiptWidth,
      receiptHeight,
      startX: (anchorWidth - receiptWidth) / 2,
      startY: 32,
    };
  };

  const setVisible = (visible: boolean) => {
    if (isVisible === visible) return;
    isVisible = visible;
    canvas.style.visibility = visible ? "visible" : "hidden";
    hitSurface.style.visibility = visible && !reducedMotionMedia.matches ? "visible" : "hidden";
  };

  const stopLoop = () => {
    running = false;
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    setVisible(false);
  };

  const resetSheet = (metrics: SheetMetrics, time = performance.now()) => {
    sheet = createSheet(metrics);
    lastMetrics = metrics;
    startedAt = time;
  };

  const resize = () => {
    const ratio = window.devicePixelRatio || 1;
    const rect = anchor.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    stableFrames = 0;
    settledFrames = 0;
    releaseFrames = 0;
    lastSimulationTime = 0;
    setVisible(false);
    resetSheet(getSheetMetrics());
    if (shouldRun()) startLoop();
  };

  const startLoop = () => {
    if (running || !shouldRun()) return;
    running = true;
    animationFrame = window.requestAnimationFrame(tick);
  };

  const syncLoopState = () => {
    if (shouldRun()) {
      resize();
    } else {
      stopLoop();
    }
  };

  const getPoint = (event: PointerEvent) => {
    const rect = anchor.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || reducedMotionMedia.matches) return;
    const point = getPoint(event);
    const target = findGrabTarget(sheet.particles, point.x, point.y);
    if (target == null) return;
    event.preventDefault();
    hitSurface.setPointerCapture(event.pointerId);
    pointer.id = event.pointerId;
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.prevX = point.x;
    pointer.prevY = point.y;
    pointer.vx = 0;
    pointer.vy = 0;
    pointer.grabbedIndex = target;
    settledFrames = 0;
    releaseFrames = 0;
    startLoop();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (pointer.id !== event.pointerId) return;
    const point = getPoint(event);
    pointer.vx = point.x - pointer.prevX;
    pointer.vy = point.y - pointer.prevY;
    pointer.prevX = point.x;
    pointer.prevY = point.y;
    pointer.x = point.x;
    pointer.y = point.y;
  };

  const releasePointer = (event: PointerEvent) => {
    if (pointer.id !== event.pointerId) return;
    const grabbed = pointer.grabbedIndex == null ? null : sheet.particles[pointer.grabbedIndex];
    if (grabbed) {
      grabbed.oldX = grabbed.x - pointer.vx * 0.9;
      grabbed.oldY = grabbed.y - pointer.vy * 0.9;
    }
    pointer.id = null;
    pointer.grabbedIndex = null;
  };

  const integrate = (time: number) => {
    const elapsed = (time - startedAt) / 1000;
    for (let i = COLUMNS; i < sheet.particles.length; i += 1) {
      const particle = sheet.particles[i];
      if (!particle) continue;
      const velocityX = (particle.x - particle.oldX) * 0.985;
      const velocityY = (particle.y - particle.oldY) * 0.985;
      particle.oldX = particle.x;
      particle.oldY = particle.y;
      particle.x += velocityX + Math.sin(elapsed * 1.7 + i * 0.19) * 0.018;
      particle.y += velocityY + 0.22;
    }

    const grabbed = pointer.grabbedIndex == null ? null : sheet.particles[pointer.grabbedIndex];
    if (grabbed) {
      grabbed.x += (pointer.x - grabbed.x) * 0.72;
      grabbed.y += (pointer.y - grabbed.y) * 0.72;
    }
  };

  const constrain = () => {
    for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
      pinTopRow(sheet.particles);
      for (const constraint of sheet.constraints) {
        solveConstraint(sheet.particles, constraint);
      }
    }
    pinTopRow(sheet.particles);
  };

  const updateHitSurface = () => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const particle of sheet.particles) {
      minX = Math.min(minX, particle.x);
      minY = Math.min(minY, particle.y);
      maxX = Math.max(maxX, particle.x);
      maxY = Math.max(maxY, particle.y);
    }

    const padding = 20;
    hitSurface.style.transform = `translate3d(${minX - padding}px, ${minY - padding}px, 0)`;
    hitSurface.style.width = `${maxX - minX + padding * 2}px`;
    hitSurface.style.height = `${maxY - minY + padding * 2}px`;
  };

  const drawShadow = (palette: ReceiptPalette) => {
    const first = sheet.particles[0];
    const topRight = sheet.particles[COLUMNS - 1];
    const bottomRight = sheet.particles[ROWS * COLUMNS - 1];
    const bottomLeft = sheet.particles[(ROWS - 1) * COLUMNS];
    if (!first || !topRight || !bottomRight || !bottomLeft) return;

    ctx.save();
    ctx.shadowColor = palette.shadow;
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = palette.shadow;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    ctx.lineTo(topRight.x, topRight.y);
    ctx.lineTo(bottomRight.x, bottomRight.y);
    ctx.lineTo(bottomLeft.x, bottomLeft.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawRail = (palette: ReceiptPalette) => {
    const left = sheet.particles[0];
    const right = sheet.particles[COLUMNS - 1];
    if (!left || !right) return;

    ctx.save();
    ctx.strokeStyle = palette.ink;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(left.x - 10, left.y - 3);
    ctx.lineTo(right.x + 10, right.y - 3);
    ctx.stroke();

    ctx.strokeStyle = palette.paperTop;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left.x - 8, left.y - 5);
    ctx.lineTo(right.x + 8, right.y - 5);
    ctx.stroke();
    ctx.restore();
  };

  const draw = () => {
    if (!paper) return;
    ctx.clearRect(0, 0, width, height);
    drawShadow(paper.palette);

    for (let row = 0; row < ROWS - 1; row += 1) {
      for (let column = 0; column < COLUMNS - 1; column += 1) {
        drawMappedCell(ctx, paper.texture, paper.palette, sheet.particles, row, column);
      }
    }

    drawRail(paper.palette);
    updateHitSurface();
  };

  const tick = (time: number) => {
    if (!running) return;
    if (!shouldRun()) {
      stopLoop();
      return;
    }
    if (!shouldSimulateReceiptFrame(time, lastSimulationTime)) {
      animationFrame = window.requestAnimationFrame(tick);
      return;
    }
    lastSimulationTime = time;

    const metrics = getSheetMetrics();
    const changed = metricsChanged(lastMetrics, metrics);
    if (changed && pointer.id == null) {
      stableFrames = 0;
      setVisible(false);
      resetSheet(metrics, time);
    } else {
      stableFrames += 1;
      lastMetrics = metrics;
    }

    setTopRowPins(sheet.particles, metrics);
    if (!reducedMotionMedia.matches) {
      integrate(time);
      constrain();
    }
    draw();
    const isDragging = pointer.id != null;
    settledFrames = nextReceiptSettledFrame(
      isDragging,
      measureSheetMovement(sheet.particles),
      settledFrames,
    );
    releaseFrames = nextReceiptReleaseFrame(isDragging, releaseFrames);
    const isReducedMotion = reducedMotionMedia.matches;
    if (isReducedMotion || stableFrames >= 2) setVisible(true);
    if (isReducedMotion || isReceiptSettled(stableFrames, settledFrames, releaseFrames)) {
      if (!isReducedMotion) {
        resetSheet(metrics, time);
        draw();
      }
      running = false;
      animationFrame = 0;
      return;
    }
    animationFrame = window.requestAnimationFrame(tick);
  };

  setVisible(false);
  // The texture is laid out with ctx.measureText, so painting it before the mono webfont
  // loads would bake the fallback face's metrics into the sheet. shouldRun() keeps the
  // canvas hidden and the loop idle until the texture exists.
  void whenReceiptFontsReady().then(() => {
    if (disposed) return;
    repaintPaper();
    syncLoopState();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(anchor);
  // The palette resolves once per texture build; toggling .dark on <html> changes the
  // resolved tokens without resizing the canvas, so it must trigger its own repaint.
  const themeObserver = new MutationObserver(() => {
    repaintPaper();
    draw();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  desktopMedia.addEventListener("change", syncLoopState);
  reducedMotionMedia.addEventListener("change", syncLoopState);
  document.addEventListener("visibilitychange", syncLoopState);
  window.addEventListener("resize", syncLoopState);
  hitSurface.addEventListener("pointerdown", onPointerDown);
  hitSurface.addEventListener("pointermove", onPointerMove);
  hitSurface.addEventListener("pointerup", releasePointer);
  hitSurface.addEventListener("pointercancel", releasePointer);
  return {
    updatePayload(nextPayload) {
      currentPayload = nextPayload;
      if (disposed || !paper) return;
      repaintPaper();
      draw();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      stopLoop();
      observer.disconnect();
      themeObserver.disconnect();
      desktopMedia.removeEventListener("change", syncLoopState);
      reducedMotionMedia.removeEventListener("change", syncLoopState);
      document.removeEventListener("visibilitychange", syncLoopState);
      window.removeEventListener("resize", syncLoopState);
      hitSurface.removeEventListener("pointerdown", onPointerDown);
      hitSurface.removeEventListener("pointermove", onPointerMove);
      hitSurface.removeEventListener("pointerup", releasePointer);
      hitSurface.removeEventListener("pointercancel", releasePointer);
    },
  };
}
