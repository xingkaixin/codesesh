const REMOTE_ACCESS_QUERY_PARAM = "access_token";
const REMOTE_ACCESS_STORAGE_KEY = "codesesh:remote-access-token";

interface BrowserAccessEnvironment {
  readonly location: Pick<Location, "href" | "origin">;
  readonly history: Pick<History, "state" | "replaceState">;
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem">;
}

export interface RemoteAccess {
  readonly hasCredentials: boolean;
  authorize(init?: RequestInit): RequestInit;
  eventUrl(path: string): string;
}

function createRemoteAccess(token: string | null, origin: string): RemoteAccess {
  return Object.freeze({
    hasCredentials: token !== null,
    authorize(init: RequestInit = {}): RequestInit {
      if (!token) return init;
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return { ...init, headers };
    },
    eventUrl(path: string): string {
      if (!token) return path;
      const url = new URL(path, origin);
      url.searchParams.set(REMOTE_ACCESS_QUERY_PARAM, token);
      return `${url.pathname}${url.search}`;
    },
  });
}

export function resolveRemoteAccess(
  browser: BrowserAccessEnvironment | undefined = typeof window === "undefined"
    ? undefined
    : window,
): RemoteAccess {
  if (!browser) return createRemoteAccess(null, "http://localhost");

  const url = new URL(browser.location.href);
  const urlToken = url.searchParams.get(REMOTE_ACCESS_QUERY_PARAM);
  if (urlToken) {
    try {
      browser.sessionStorage.setItem(REMOTE_ACCESS_STORAGE_KEY, urlToken);
    } catch {}
    url.searchParams.delete(REMOTE_ACCESS_QUERY_PARAM);
    browser.history.replaceState(
      browser.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    return createRemoteAccess(urlToken, browser.location.origin);
  }

  let storedToken: string | null = null;
  try {
    storedToken = browser.sessionStorage.getItem(REMOTE_ACCESS_STORAGE_KEY);
  } catch {}
  return createRemoteAccess(storedToken, browser.location.origin);
}
