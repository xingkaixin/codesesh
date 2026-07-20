import type { LoaderFunctionArgs, RouteObject } from "react-router-dom";

export const APP_ROUTE_IDS = {
  agent: "agent",
  notFound: "not-found",
  project: "project",
  projects: "projects",
  root: "root",
  session: "session",
} as const;

export const appRouteChildren: RouteObject[] = [
  { index: true, id: APP_ROUTE_IDS.root },
  {
    path: "projects",
    children: [
      { index: true, id: APP_ROUTE_IDS.projects },
      { path: ":projectKind/:projectKey", id: APP_ROUTE_IDS.project },
    ],
  },
  {
    path: ":agentKey",
    id: APP_ROUTE_IDS.agent,
    children: [{ path: ":sessionSlug", id: APP_ROUTE_IDS.session }],
  },
  { path: "*", id: APP_ROUTE_IDS.notFound },
];

export function assertValidRouteEncoding(request: Request) {
  try {
    decodeURI(new URL(request.url).pathname);
  } catch {
    throw new Response("Malformed URL", { status: 400, statusText: "Bad Request" });
  }
}

export function validateRouteEncoding({ request }: LoaderFunctionArgs) {
  assertValidRouteEncoding(request);
  return null;
}
