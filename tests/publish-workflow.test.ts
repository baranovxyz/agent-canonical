import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);

describe("publish workflow", () => {
  it("guards the publish job before executing repository code", () => {
    const workflow = readFileSync(
      join(REPO, ".github/workflows/publish.yml"),
      "utf8",
    );
    const publishJob = workflow
      .split("\n  publish:\n")[1]
      ?.split("\n  tag-and-release:\n")[0];
    if (publishJob === undefined) throw new Error("Missing publish job");

    expect(publishJob).toContain(
      `if: \${{ github.repository == 'baranovxyz/agent-canonical' && github.ref == 'refs/heads/main' }}`,
    );
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).toContain("environment: npm");
    expect(publishJob).toContain("runs-on: ubuntu-latest");
    expect(publishJob).toContain("version: 11.4.0");
    expect(publishJob).toContain("node-version: 24");
    expect(publishJob).toContain("registry-url: https://registry.npmjs.org");
    expect(publishJob).toContain("npm >= 11.5.1");
    expect(publishJob).toContain(
      "run: pnpm publish --access public --no-git-checks --tag",
    );
    expect(publishJob).not.toContain("contents: write");
    expect(publishJob).not.toMatch(/^\s*NODE_AUTH_TOKEN:/mu);
    expect(publishJob).not.toMatch(/\bNODE_AUTH_TOKEN\s*=/u);
    expect(publishJob).not.toContain("Branch guard");
  });

  it("fails closed when tag or release metadata cannot be created safely", () => {
    const workflow = readFileSync(
      join(REPO, ".github/workflows/publish.yml"),
      "utf8",
    );
    const releaseJob = workflow.split("\n  tag-and-release:\n")[1];
    if (releaseJob === undefined)
      throw new Error("Missing tag-and-release job");

    expect(releaseJob).toContain("contents: write");
    expect(releaseJob).toContain('REMOTE_SHA" != "$GITHUB_SHA"');
    expect(releaseJob).toContain('git tag "$TAG" "$GITHUB_SHA"');
    expect(releaseJob).toContain('gh release view "$TAG"');
    expect(releaseJob).toContain('gh release create "$TAG"');
    expect(releaseJob).not.toContain("|| echo");
  });
});
