export type SessionAnchorScrollBehavior = "auto" | "smooth";

export type SessionAnchorScrollHandler = (
  anchorId: string,
  behavior: SessionAnchorScrollBehavior,
) => void;

export function getActivationScrollBehavior(eventDetail: number): SessionAnchorScrollBehavior {
  return eventDetail === 0 ? "auto" : "smooth";
}

export function resolveReducedMotionScrollBehavior(
  behavior: SessionAnchorScrollBehavior,
  prefersReducedMotion: boolean,
): SessionAnchorScrollBehavior {
  return behavior === "smooth" && prefersReducedMotion ? "auto" : behavior;
}
