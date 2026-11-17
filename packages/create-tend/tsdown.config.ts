import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  platform: "node",
  // Old enough that an outdated Node can still run it, to be told which Node Tend needs.
  target: "node18",
  dts: false,
});
