import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Env } from "../env";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

export function getDb(env: Env): Db {
  return drizzle(env.DB, { schema });
}

export { schema };
