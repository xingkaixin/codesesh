export const RECEIPT_FRAME_INTERVAL_MS = 1000 / 60;
export const RECEIPT_IDLE_SETTLE_FRAMES = 36;

export function shouldSimulateReceiptFrame(time: number, lastFrameTime: number): boolean {
  return lastFrameTime === 0 || time - lastFrameTime >= RECEIPT_FRAME_INTERVAL_MS - 1;
}

export function nextReceiptIdleFrame(isDragging: boolean, idleFrames: number): number {
  return isDragging ? 0 : idleFrames + 1;
}

export function isReceiptSettled(stableFrames: number, idleFrames: number): boolean {
  return stableFrames >= 2 && idleFrames >= RECEIPT_IDLE_SETTLE_FRAMES;
}
