import {
  createBrowserRouter,
  isRouteErrorResponse,
  RouterProvider,
  type RouteObject,
  useRouteError,
} from "react-router-dom";
import App from "./App";
import { appRouteChildren, validateRouteEncoding } from "./lib/app-routes";

export function RouteErrorFallback() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "The application route failed to render.";
  return <div role="alert">{message}</div>;
}

export const appRouterRoutes = [
  {
    id: "app-shell",
    path: "/",
    Component: App,
    ErrorBoundary: RouteErrorFallback,
    loader: validateRouteEncoding,
    children: appRouteChildren,
  },
] satisfies RouteObject[];

const router = createBrowserRouter(appRouterRoutes);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
