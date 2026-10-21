import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

/** Return the raw binding for prepared statements, or null during local runs
 * where no D1 binding has been configured yet. */
export function getRawDb(): D1Database | null {
  try {
    if (!Object.prototype.hasOwnProperty.call(env, "DB")) return null;
    const binding = env.DB;
    return binding && typeof binding.prepare === "function" ? binding : null;
  } catch {
    return null;
  }
}
