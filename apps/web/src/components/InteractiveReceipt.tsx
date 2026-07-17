import { useLayoutEffect, useMemo, useRef } from "react";
import type { SessionData } from "../lib/api";
import { getSessionDisplayTitle } from "../lib/session-title";
import {
  isReceiptSettled,
  nextReceiptReleaseFrame,
  nextReceiptSettledFrame,
  shouldSimulateReceiptFrame,
} from "../lib/interactive-receipt-frame-policy";
import { SMART_TAG_LABELS } from "./SmartTagChips";
import type { SessionDetailToc } from "./session-detail/toc";

interface InteractiveReceiptProps {
  session: SessionData;
  toc: SessionDetailToc;
  minWidthQuery?: string;
}

interface ReceiptPayload {
  id: string;
  title: string;
  agent: string;
  updatedAt: number;
  tags?: SessionData["smart_tags"];
  stats: SessionData["stats"];
  items: ReceiptLineItem[];
}

interface ReceiptLineItem {
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

function formatCount(value?: number) {
  return Math.round(value ?? 0).toLocaleString("en-US");
}

function formatMoney(value?: number) {
  return `$${(value ?? 0).toFixed(4)}`;
}

function formatDate(value: number) {
  return new Date(value).toLocaleString("en-US", {
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

function buildReceiptItems(toc: SessionDetailToc): ReceiptLineItem[] {
  const maxItems = 9;
  const baseItems: ReceiptLineItem[] = [
    { label: "User", count: toc.counts.user },
    { label: "Agent Responses", count: toc.counts.agent_message },
    { label: "Thinking", count: toc.counts.thinking },
    { label: "Plans", count: toc.counts.plan },
    { label: "Tools", count: toc.counts.tools_all },
  ].filter((item) => item.count > 0);
  const toolItems = toc.tools.map((tool) => ({ label: tool.label, count: tool.count }));
  const toolSlots = Math.max(0, maxItems - baseItems.length);
  const visibleToolItems =
    toolItems.length > toolSlots ? toolItems.slice(0, Math.max(0, toolSlots - 1)) : toolItems;
  const hiddenToolCount = toolItems
    .slice(visibleToolItems.length)
    .reduce((total, item) => total + item.count, 0);

  if (hiddenToolCount > 0) {
    visibleToolItems.push({ label: "Other tools", count: hiddenToolCount });
  }

  return [...baseItems, ...visibleToolItems].slice(0, maxItems);
}

function formatReceiptSubtitle(tags?: SessionData["smart_tags"]) {
  if (!tags || tags.length === 0) return "SESSION ACTIVITY RECEIPT";
  return tags.map((tag) => SMART_TAG_LABELS[tag]).join(" / ");
}

function createReceiptPayload(session: SessionData, toc: SessionDetailToc): ReceiptPayload {
  const agent = session.slug?.split("/")[0] || "codesesh";
  return {
    id: session.id,
    title: getSessionDisplayTitle(session) || "Untitled session",
    agent,
    updatedAt: session.time_updated ?? session.time_created,
    tags: session.smart_tags,
    stats: session.stats,
    items: buildReceiptItems(toc),
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

function drawTexture(payload: ReceiptPayload) {
  const texture = document.createElement("canvas");
  texture.width = RECEIPT_WIDTH * TEXTURE_SCALE;
  texture.height = RECEIPT_HEIGHT * TEXTURE_SCALE;

  const ctx = texture.getContext("2d");
  if (!ctx) return texture;

  ctx.scale(TEXTURE_SCALE, TEXTURE_SCALE);

  const paper = ctx.createLinearGradient(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);
  paper.addColorStop(0, "#ffffff");
  paper.addColorStop(0.55, "#fafaf6");
  paper.addColorStop(1, "#f2f2ec");
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, RECEIPT_WIDTH, RECEIPT_HEIGHT);

  const random = createRandom(hashString(payload.id));
  ctx.fillStyle = "rgba(0, 0, 0, 0.035)";
  for (let i = 0; i < 1200; i += 1) {
    ctx.globalAlpha = 0.12 + random() * 0.14;
    ctx.fillRect(random() * RECEIPT_WIDTH, random() * RECEIPT_HEIGHT, 0.7, 0.7);
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
  ctx.font = "700 18px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillText("CODESESH MART", RECEIPT_WIDTH / 2, 34);
  ctx.font = "11px 'Courier New', monospace";
  ctx.fillText(
    fitText(ctx, formatReceiptSubtitle(payload.tags).toUpperCase(), RECEIPT_WIDTH - 36),
    RECEIPT_WIDTH / 2,
    51,
  );

  ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(18, 66);
  ctx.lineTo(RECEIPT_WIDTH - 18, 66);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(0, 0, 0, 0.74)";
  ctx.font = "11px 'Courier New', monospace";
  drawMonoLine(ctx, "Agent", payload.agent, 88, RECEIPT_WIDTH);
  drawMonoLine(ctx, "Updated", formatDate(payload.updatedAt), 104, RECEIPT_WIDTH);
  drawMonoLine(ctx, "Session", `#${payload.id.slice(0, 8)}`, 120, RECEIPT_WIDTH);

  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(18, 140);
  ctx.lineTo(RECEIPT_WIDTH - 18, 140);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "700 12px 'Courier New', monospace";
  ctx.fillText("SESSION TOC RECEIPT LIST", 18, 163);
  ctx.font = "11px 'Courier New', monospace";

  let y = 185;
  for (const item of payload.items) {
    const count = formatCount(item.count);
    ctx.fillText(fitText(ctx, item.label, 168), 18, y);
    ctx.fillText(count, RECEIPT_WIDTH - 18 - ctx.measureText(count).width, y);
    y += 17;
  }

  ctx.strokeStyle = "rgba(0, 0, 0, 0.62)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(18, y + 5);
  ctx.lineTo(RECEIPT_WIDTH - 18, y + 5);
  ctx.stroke();

  y += 26;
  drawMonoLine(
    ctx,
    "Input tokens",
    formatCount(payload.stats.total_input_tokens),
    y,
    RECEIPT_WIDTH,
  );
  y += 16;
  drawMonoLine(
    ctx,
    "Output tokens",
    formatCount(payload.stats.total_output_tokens),
    y,
    RECEIPT_WIDTH,
  );
  y += 16;
  drawMonoLine(ctx, "Messages", formatCount(payload.stats.message_count), y, RECEIPT_WIDTH);
  y += 22;

  ctx.font = "700 13px 'Courier New', monospace";
  drawMonoLine(ctx, "TOTAL COST", formatMoney(payload.stats.total_cost), y, RECEIPT_WIDTH);

  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(18, y + 18);
  ctx.lineTo(RECEIPT_WIDTH - 18, y + 18);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = "10px 'Courier New', monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
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
  ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
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

export function InteractiveReceipt({
  session,
  toc,
  minWidthQuery = "(min-width: 1025px)",
}: InteractiveReceiptProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const hitSurfaceRef = useRef<HTMLDivElement | null>(null);
  const payload = useMemo(() => createReceiptPayload(session, toc), [session, toc]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const anchor = anchorRef.current;
    const hitSurface = hitSurfaceRef.current;
    if (!canvas || !anchor || !hitSurface) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

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
    const texture = drawTexture(payload);
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

    const shouldRun = () => desktopMedia.matches && document.visibilityState === "visible";

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

    const drawShadow = () => {
      const first = sheet.particles[0];
      const topRight = sheet.particles[COLUMNS - 1];
      const bottomRight = sheet.particles[ROWS * COLUMNS - 1];
      const bottomLeft = sheet.particles[(ROWS - 1) * COLUMNS];
      if (!first || !topRight || !bottomRight || !bottomLeft) return;

      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.24)";
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 16;
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(topRight.x, topRight.y);
      ctx.lineTo(bottomRight.x, bottomRight.y);
      ctx.lineTo(bottomLeft.x, bottomLeft.y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    const drawRail = () => {
      const left = sheet.particles[0];
      const right = sheet.particles[COLUMNS - 1];
      if (!left || !right) return;

      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.72)";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(left.x - 10, left.y - 3);
      ctx.lineTo(right.x + 10, right.y - 3);
      ctx.stroke();

      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left.x - 8, left.y - 5);
      ctx.lineTo(right.x + 8, right.y - 5);
      ctx.stroke();
      ctx.restore();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      drawShadow();

      for (let row = 0; row < ROWS - 1; row += 1) {
        for (let column = 0; column < COLUMNS - 1; column += 1) {
          drawMappedCell(ctx, texture, sheet.particles, row, column);
        }
      }

      drawRail();
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
    if (shouldRun()) resize();
    const observer = new ResizeObserver(resize);
    observer.observe(anchor);
    desktopMedia.addEventListener("change", syncLoopState);
    reducedMotionMedia.addEventListener("change", syncLoopState);
    document.addEventListener("visibilitychange", syncLoopState);
    window.addEventListener("resize", syncLoopState);
    hitSurface.addEventListener("pointerdown", onPointerDown);
    hitSurface.addEventListener("pointermove", onPointerMove);
    hitSurface.addEventListener("pointerup", releasePointer);
    hitSurface.addEventListener("pointercancel", releasePointer);
    startLoop();

    return () => {
      stopLoop();
      observer.disconnect();
      desktopMedia.removeEventListener("change", syncLoopState);
      reducedMotionMedia.removeEventListener("change", syncLoopState);
      document.removeEventListener("visibilitychange", syncLoopState);
      window.removeEventListener("resize", syncLoopState);
      hitSurface.removeEventListener("pointerdown", onPointerDown);
      hitSurface.removeEventListener("pointermove", onPointerMove);
      hitSurface.removeEventListener("pointerup", releasePointer);
      hitSurface.removeEventListener("pointercancel", releasePointer);
    };
  }, [minWidthQuery, payload]);

  return (
    <div ref={anchorRef} className="relative h-[calc(100dvh-5.5rem)] min-h-[420px]">
      <canvas
        ref={canvasRef}
        className="invisible pointer-events-none absolute inset-0 z-[61] block h-full w-full touch-none"
        aria-hidden="true"
      />
      <div
        ref={hitSurfaceRef}
        className="invisible absolute left-0 top-0 z-[62] cursor-grab touch-none active:cursor-grabbing"
        aria-label="Interactive thermal receipt with Verlet paper simulation"
      />
    </div>
  );
}
