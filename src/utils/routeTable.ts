export interface Route {
  path: string;    // prefix, e.g. "/api/v1/users"
  target: string;  // e.g. "http://katisha-user-service:3001"
  auth: boolean;
}

let routes: Route[] = [];

export const routeTable = {
  set: (r: Route[]) => { routes = r; },
  get: (): Route[]  => routes,
  match: (reqPath: string): Route | undefined =>
    routes.find((r) => reqPath === r.path || reqPath.startsWith(r.path + '/')),
};
