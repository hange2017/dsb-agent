import * as esbuild from "esbuild";

// Independent build for the DSBAgent benchmark CLI (headless entry).
// Output goes to dist-benchmark/ so it never ships inside the extension package.
await esbuild.build({
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  entryPoints: ["benchmark/cli.ts"],
  outfile: "dist-benchmark/cli.js",
  platform: "node",
  format: "cjs",
  external: ["vscode", "@vscode/ripgrep", "better-sqlite3"],
});

console.log("benchmark CLI built -> dist-benchmark/cli.js");
