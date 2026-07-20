import {
  createBrowserRouter,
  isRouteErrorResponse,
  RouterProvider,
  useRouteError,
} from "react-router-dom";
import App from "./App";
import { appRouteChildren, validateRouteEncoding } from "./lib/app-routes";

function RouteErrorFallback() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "The application route failed to render.";
  return <div role="alert">{message}</div>;
}

const router = createBrowserRouter([
  {
    id: "app-shell",
    path: "/",
    Component: App,
    ErrorBoundary: RouteErrorFallback,
    loader: validateRouteEncoding,
    children: appRouteChildren,
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
