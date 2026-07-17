import { describe, expect, it } from "vitest";
import {
  RECEIPT_FRAME_INTERVAL_MS,
  RECEIPT_MAX_RELEASE_FRAMES,
  RECEIPT_MOTION_EPSILON_PX,
  RECEIPT_SETTLED_FRAME_COUNT,
  isReceiptSettled,
  nextReceiptReleaseFrame,
  nextReceiptSettledFrame,
  shouldSimulateReceiptFrame,
} from "./interactive-receipt-frame-policy";

describe("interactive receipt frame policy", () => {
  it("caps simulation work at 60 frames per second", () => {
    expect(shouldSimulateReceiptFrame(8, 1)).toBe(false);
    expect(shouldSimulateReceiptFrame(RECEIPT_FRAME_INTERVAL_MS + 1, 1)).toBe(true);
  });

  it("requires consecutive low-motion frames after dragging", () => {
    expect(nextReceiptSettledFrame(true, 0, 5)).toBe(0);
    expect(nextReceiptSettledFrame(false, RECEIPT_MOTION_EPSILON_PX + 0.01, 5)).toBe(0);
    expect(nextReceiptSettledFrame(false, RECEIPT_MOTION_EPSILON_PX, 5)).toBe(6);
    expect(nextReceiptReleaseFrame(true, 20)).toBe(0);
    expect(nextReceiptReleaseFrame(false, 20)).toBe(21);
  });

  it("stops only after layout and motion have settled", () => {
    expect(isReceiptSettled(1, RECEIPT_SETTLED_FRAME_COUNT, 1)).toBe(false);
    expect(isReceiptSettled(2, RECEIPT_SETTLED_FRAME_COUNT - 1, 1)).toBe(false);
    expect(isReceiptSettled(2, RECEIPT_SETTLED_FRAME_COUNT, 1)).toBe(true);
  });

  it("uses a bounded fallback without treating the current pose as rest", () => {
    expect(isReceiptSettled(2, 0, RECEIPT_MAX_RELEASE_FRAMES - 1)).toBe(false);
    expect(isReceiptSettled(2, 0, RECEIPT_MAX_RELEASE_FRAMES)).toBe(true);
  });
});
