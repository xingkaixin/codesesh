import { useEffect, useRef, type RefObject } from "react";

export type CanvasFrameDemand = "active" | "idle" | "stop";

type FrameHandler = (time: number) => CanvasFrameDemand;

interface FrameLoopApi {
  requestFrame: () => void;
  setFrameHandler: (handler: FrameHandler | null) => void;
}

interface FrameLoopController {
  api: FrameLoopApi;
  setEnabled: (enabled: boolean) => void;
}

const IDLE_FRAME_DELAY_MS = 1000 / 20;

function createFrameLoopController(): FrameLoopController {
  let enabled = false;
  let frameHandler: FrameHandler | null = null;
  let animationFrame = 0;
  let idleTimer = 0;

  const stop = () => {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    if (idleTimer) window.clearTimeout(idleTimer);
    animationFrame = 0;
    idleTimer = 0;
  };

  const requestFrame = () => {
    if (!enabled || frameHandler === null || animationFrame) return;
    if (idleTimer) {
      window.clearTimeout(idleTimer);
      idleTimer = 0;
    }
    animationFrame = requestAnimationFrame(runFrame);
  };

  const scheduleIdleFrame = () => {
    if (!enabled || frameHandler === null || idleTimer || animationFrame) return;
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      requestFrame();
    }, IDLE_FRAME_DELAY_MS);
  };

  function runFrame(time: number) {
    animationFrame = 0;
    if (!enabled || frameHandler === null) return;

    const demand = frameHandler(time);
    if (demand === "active") requestFrame();
    else if (demand === "idle") scheduleIdleFrame();
  }

  return {
    api: {
      requestFrame,
      setFrameHandler: (handler) => {
        frameHandler = handler;
        if (handler === null) stop();
        else requestFrame();
      },
    },
    setEnabled: (nextEnabled) => {
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      if (enabled) requestFrame();
      else stop();
    },
  };
}

export function useCanvasFrameLoop(
  targetRef: RefObject<Element | null>,
  reducedMotion: boolean,
): FrameLoopApi {
  const controllerRef = useRef<FrameLoopController | null>(null);
  if (controllerRef.current === null) controllerRef.current = createFrameLoopController();
  const controller = controllerRef.current;

  useEffect(() => {
    const target = targetRef.current;
    if (!target || reducedMotion) {
      controller.setEnabled(false);
      return;
    }

    let inViewport = true;
    let pageVisible = document.visibilityState === "visible";
    const sync = () => controller.setEnabled(inViewport && pageVisible);
    const onVisibilityChange = () => {
      pageVisible = document.visibilityState === "visible";
      sync();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            inViewport = entry?.isIntersecting ?? false;
            sync();
          });

    observer?.observe(target);
    document.addEventListener("visibilitychange", onVisibilityChange);
    sync();

    return () => {
      controller.setEnabled(false);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [controller, reducedMotion, targetRef]);

  return controller.api;
}
