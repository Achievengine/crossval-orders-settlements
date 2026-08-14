import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Cloudflare.Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}