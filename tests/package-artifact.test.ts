import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

const exportTargetSchema = z
  .object({
    types: z.string(),
    default: z.string(),
  })
  .strict();

const packedManifestSchema = z
  .object({
    name: z.literal("agent-canonical"),
    version: z.literal("0.1.4"),
    peerDependencies: z
      .object({
        zod: z.string(),
      })
      .passthrough(),
    exports: z.record(z.string(), exportTargetSchema),
  })
  .passthrough();

type ExportTarget = z.infer<typeof exportTargetSchema>;

const expectedExports: Record<string, ExportTarget> = {
  "./schemas": {
    types: "./dist/schemas/index.d.ts",
    default: "./dist/schemas/index.js",
  },
  "./dialects": {
    types: "./dist/dialects/index.d.ts",
    default: "./dist/dialects/index.js",
  },
  "./parsers": {
    types: "./dist/parsers/index.d.ts",
    default: "./dist/parsers/index.js",
  },
  "./parsers/claude-code": {
    types: "./dist/parsers/claude-code/index.d.ts",
    default: "./dist/parsers/claude-code/index.js",
  },
  "./parsers/codex": {
    types: "./dist/parsers/codex/index.d.ts",
    default: "./dist/parsers/codex/index.js",
  },
  "./parsers/opencode": {
    types: "./dist/parsers/opencode/index.d.ts",
    default: "./dist/parsers/opencode/index.js",
  },
  "./parsers/cursor": {
    types: "./dist/parsers/cursor/index.d.ts",
    default: "./dist/parsers/cursor/index.js",
  },
  "./parsers/gemini": {
    types: "./dist/parsers/gemini/index.d.ts",
    default: "./dist/parsers/gemini/index.js",
  },
  "./parsers/qwen": {
    types: "./dist/parsers/qwen/index.d.ts",
    default: "./dist/parsers/qwen/index.js",
  },
  "./parsers/kilo": {
    types: "./dist/parsers/kilo/index.d.ts",
    default: "./dist/parsers/kilo/index.js",
  },
  "./parsers/goose": {
    types: "./dist/parsers/goose/index.d.ts",
    default: "./dist/parsers/goose/index.js",
  },
  "./parsers/cline": {
    types: "./dist/parsers/cline/index.d.ts",
    default: "./dist/parsers/cline/index.js",
  },
};

let tempDir: string | undefined;
let extractedPackageDir: string;

async function readJsonValidated<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await readFile(path, "utf8");
  try {
    const parsed: unknown = JSON.parse(source);
    return schema.parse(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${detail}`, { cause: error });
  }
}

async function collectFiles(
  root: string,
  suffixes: string[],
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, suffixes)));
    } else if (
      entry.isFile() &&
      suffixes.some((suffix) => path.endsWith(suffix))
    ) {
      files.push(path);
    }
  }
  return files;
}

describe("published package artifact", () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agent-canonical-package-"));
    const extractDir = join(tempDir, "extract");

    await execFileAsync("pnpm", ["build"], { cwd: packageRoot });
    await execFileAsync("pnpm", ["pack", "--pack-destination", tempDir], {
      cwd: packageRoot,
    });
    const tarballs = (await readdir(tempDir)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    if (tarballs.length !== 1 || tarballs[0] === undefined) {
      throw new Error(`Expected one packed tarball, found ${tarballs.length}`);
    }
    const tarballPath = join(tempDir, tarballs[0]);
    await mkdir(extractDir);
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", extractDir]);
    extractedPackageDir = join(extractDir, "package");
  }, 30_000);

  afterAll(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("packs the exact public export map", async () => {
    const manifest = await readJsonValidated(
      join(extractedPackageDir, "package.json"),
      packedManifestSchema,
    );

    expect(Object.keys(manifest.exports).sort()).toEqual(
      Object.keys(expectedExports).sort(),
    );

    for (const [subpath, expected] of Object.entries(expectedExports)) {
      const actual = manifest.exports[subpath];
      expect(actual, `unexpected export target for ${subpath}`).toEqual(
        expected,
      );
      if (actual === undefined) continue;

      for (const target of [actual.types, actual.default]) {
        const targetPath = join(
          extractedPackageDir,
          target.replace(/^\.\//u, ""),
        );
        await expect(stat(targetPath)).resolves.toMatchObject({});
      }
    }

    const packedFiles = await collectFiles(extractedPackageDir, [""]);
    expect(
      packedFiles.some((path) =>
        relative(extractedPackageDir, path).startsWith(
          `src${String.fromCharCode(47)}`,
        ),
      ),
    ).toBe(false);
  });

  it("publishes a coherent Zod 4 peer and import contract", async () => {
    const manifest = await readJsonValidated(
      join(extractedPackageDir, "package.json"),
      packedManifestSchema,
    );
    expect(manifest.peerDependencies.zod).toBe("^4.4.3");

    const emittedFiles = await collectFiles(join(extractedPackageDir, "dist"), [
      ".js",
      ".d.ts",
    ]);
    const emittedSource = (
      await Promise.all(emittedFiles.map((path) => readFile(path, "utf8")))
    ).join("\n");

    expect(emittedSource).toMatch(/from\s+["']zod["']/u);
    expect(emittedSource).not.toMatch(/from\s+["']zod\//u);
  });

  it("documents the Gemini, Qwen, Kilo, Goose, and Cline parsers in the packed public docs", async () => {
    const [readme, changelog] = await Promise.all([
      readFile(join(extractedPackageDir, "README.md"), "utf8"),
      readFile(join(extractedPackageDir, "CHANGELOG.md"), "utf8"),
    ]);

    expect(readme).toContain("agent-canonical/parsers/<cli>");
    expect(readme).toMatch(/gemini/u);
    expect(readme).toMatch(/qwen/u);
    expect(readme).toMatch(/kilo/u);
    expect(readme).toMatch(/goose/u);
    expect(readme).toMatch(/cline/u);
    expect(changelog).toMatch(/Gemini\s+CLI/u);
    expect(changelog).toMatch(/Qwen\s+Code/u);
    expect(changelog).toMatch(/Kilo\s+Code/u);
    expect(changelog).toMatch(/Goose/u);
    expect(changelog).toMatch(/Cline/u);
  });
});
