import esbuild from "esbuild";
import process from "node:process";

const isWatch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  target: "es2018",
  sourcemap: isWatch ? "inline" : false,
  external: ["obsidian"],
  banner: {
    js: "'use strict';"
  }
});

if (isWatch) {
  console.log("Watching for changes...");
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
  console.log("Build complete.");
}
