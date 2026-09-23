/** A small path router: literal segments and `:name` parameters, nothing else. */

export type RouteContext<T> = T & { params: Record<string, string> };

export type Route<T> = {
  method: string;
  pattern: string;
  /** Requires a signed-in user. */
  auth?: boolean;
  handler: (context: RouteContext<T>) => unknown | Promise<unknown>;
};

export function matchRoute<T>(
  routes: Route<T>[],
  method: string,
  path: string,
): { route: Route<T>; params: Record<string, string> } | { route: null; pathExists: boolean } {
  const segments = path.split("/").filter(Boolean);
  let pathExists = false;
  for (const route of routes) {
    const patternSegments = route.pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const pattern = patternSegments[index] as string;
      const segment = segments[index] as string;
      if (pattern.startsWith(":")) {
        params[pattern.slice(1)] = segment;
        continue;
      }
      if (pattern !== segment) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    pathExists = true;
    if (route.method === method) return { route, params };
  }
  return { route: null, pathExists };
}
