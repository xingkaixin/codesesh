export const RECEIPT_FRAME_INTERVAL_MS = 1000 / 60;
export const RECEIPT_MOTION_EPSILON_PX = 0.12;
export const RECEIPT_SETTLED_FRAME_COUNT = 8;
export const RECEIPT_MAX_RELEASE_FRAMES = 300;

export function shouldSimulateReceiptFrame(time: number, lastFrameTime: number): boolean {
  return lastFrameTime === 0 || time - lastFrameTime >= RECEIPT_FRAME_INTERVAL_MS - 1;
}

export function nextReceiptSettledFrame(
  isDragging: boolean,
  maxMovement: number,
  settledFrames: number,
): number {
  return !isDragging && maxMovement <= RECEIPT_MOTION_EPSILON_PX ? settledFrames + 1 : 0;
}

export function nextReceiptReleaseFrame(isDragging: boolean, releaseFrames: number): number {
  return isDragging ? 0 : releaseFrames + 1;
}

export function isReceiptSettled(
  stableFrames: number,
  settledFrames: number,
  releaseFrames: number,
): boolean {
  return (
    stableFrames >= 2 &&
    (settledFrames >= RECEIPT_SETTLED_FRAME_COUNT || releaseFrames >= RECEIPT_MAX_RELEASE_FRAMES)
  );
}
