import { readFileSync } from "node:fs";

// package.json ships next to dist/, keeping both transports on one version.
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
