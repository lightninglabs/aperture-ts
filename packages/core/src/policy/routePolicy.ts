/**
 * Route matching: resolve an incoming request to a RouteDefinition.
 */

import type { RouteDefinition } from "../types.js";

/**
 * Match an incoming request against a list of route definitions.
 * First match wins; returns null if no route matches.
 */
export function matchRoute(
  request: Request,
  routes: RouteDefinition[],
): RouteDefinition | null {
  const url = new URL(request.url);

  for (const route of routes) {
    if (matchRouteDefinition(request, url, route)) {
      return route;
    }
  }

  return null;
}

function matchRouteDefinition(
  request: Request,
  url: URL,
  route: RouteDefinition,
): boolean {
  const { match } = route;

  // Host match: exact or wildcard (*.example.com).
  if (match.host) {
    if (match.host.startsWith("*.")) {
      const suffix = match.host.slice(1); // ".example.com"
      if (!url.hostname.endsWith(suffix) && url.hostname !== match.host.slice(2)) {
        return false;
      }
    } else if (url.hostname !== match.host) {
      return false;
    }
  }

  // Path prefix match.
  if (match.pathPrefix && !url.pathname.startsWith(match.pathPrefix)) {
    return false;
  }

  // Method match.
  if (match.method?.length && !match.method.includes(request.method)) {
    return false;
  }

  // Content-type prefix match.
  if (match.contentTypePrefix?.length) {
    const contentType = request.headers.get("content-type") ?? "";
    const matched = match.contentTypePrefix.some((prefix) =>
      contentType.startsWith(prefix),
    );
    if (!matched) return false;
  }

  return true;
}
