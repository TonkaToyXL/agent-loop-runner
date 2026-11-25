import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// macOS ships bash 3.2, which reads a non-ASCII character right after $NAME (e.g. "$DIR…")
// as part of the variable name and fails under `set -u`. Always write ${NAME} there.
describe("setup scripts (macOS bash 3.2)", () => {
  const dir = join(process.cwd(), "scripts");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
    it(`${file}: no $VAR directly followed by a non-ASCII character`, () => {
      const lines = readFileSync(join(dir, file), "utf8").split("\n");
      const bad = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line))
        .map(({ line, n }) => `${n}: ${line.trim()}`);
      expect(bad).toEqual([]);
    });
  }
});
