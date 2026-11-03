import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as Bindings } from "../src/env";

declare global {
  // `env` from `cloudflare:test` is typed as `Cloudflare.Env`; merge the
  // worker bindings plus the test-only TEST_MIGRATIONS binding into it.
  namespace Cloudflare {
    interface Env extends Bindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
