import { describe, expect, it } from "vitest";
import {
  RECEIPT_FRAME_INTERVAL_MS,
  isReceiptSettled,
  nextReceiptIdleFrame,
  shouldSimulateReceiptFrame,
} from "./interactive-receipt-frame-policy";

describe("interactive receipt frame policy", () => {
  it("caps simulation work at 60 frames per second", () => {
    expect(shouldSimulateReceiptFrame(8, 1)).toBe(false);
    expect(shouldSimulateReceiptFrame(RECEIPT_FRAME_INTERVAL_MS + 1, 1)).toBe(true);
  });

  it("resets idle settling while dragging", () => {
    expect(nextReceiptIdleFrame(true, 20)).toBe(0);
    expect(nextReceiptIdleFrame(false, 20)).toBe(21);
  });

  it("stops only after layout and motion have settled", () => {
    expect(isReceiptSettled(1, 36)).toBe(false);
    expect(isReceiptSettled(2, 35)).toBe(false);
    expect(isReceiptSettled(2, 36)).toBe(true);
  });
});
