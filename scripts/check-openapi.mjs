// OpenAPI drift check: the set of /api/* routes handled in server.mjs must match
// the /api/* paths documented in openapi.yaml. Fails the build if they diverge,
// so a forgotten spec update turns CI red. (No framework/annotations to auto-gen
// from — the spec is hand-maintained, and this guards it.)
import { readFileSync } from "node:fs";

const server = readFileSync("server.mjs", "utf8");
const spec = readFileSync("openapi.yaml", "utf8");

// routes the server handles: `u.pathname === "/api/..."`
const serverRoutes = new Set(
  [...server.matchAll(/u\.pathname\s*===\s*"(\/api\/[^"]+)"/g)].map((m) => m[1])
);
// paths documented in the spec: top-level `  /api/...:` keys under paths:
const specRoutes = new Set(
  [...spec.matchAll(/^\s{2}(\/api\/[^\s:]+):/gm)].map((m) => m[1])
);

const missingInSpec = [...serverRoutes].filter((r) => !specRoutes.has(r)).sort();
const extraInSpec = [...specRoutes].filter((r) => !serverRoutes.has(r)).sort();

if (missingInSpec.length || extraInSpec.length) {
  console.error("OpenAPI drift detected — openapi.yaml is out of sync with server.mjs:");
  if (missingInSpec.length) console.error("  handled by the server but NOT documented:", missingInSpec.join(", "));
  if (extraInSpec.length) console.error("  documented but NOT handled by the server:", extraInSpec.join(", "));
  console.error("Fix: update openapi.yaml to match the /api routes, then commit.");
  process.exit(1);
}

console.log(`OpenAPI in sync — ${serverRoutes.size} /api routes documented.`);
