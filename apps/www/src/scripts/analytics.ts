declare global {
  interface Window {
    umami?: {
      track: (name: string, data: Record<string, string>) => Promise<unknown> | void;
    };
  }
}

export async function trackEvent(name: string, data: Record<string, string> = {}) {
  try {
    await window.umami?.track(name, {
      ...data,
      locale: document.documentElement.lang,
    });
  } catch {
    // A blocked analytics request must not interrupt the visitor's action.
  }
}

export function trackOutboundLinks() {
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link) return;

    const url = new URL(link.href);
    if (url.hostname !== "github.com") return;

    if (url.pathname === "/xingkaixin/codesesh" && !url.hash) {
      void trackEvent("github-click");
    } else if (
      url.pathname === "/xingkaixin/codesesh/releases" ||
      url.pathname.startsWith("/xingkaixin/codesesh/releases/")
    ) {
      void trackEvent("download-click");
    }
  });
}
