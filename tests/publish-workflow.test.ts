import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);

describe("publish workflow", () => {
  it("isolates npm OIDC from repository build and verification code", () => {
    const workflow = readFileSync(
      join(REPO, ".github/workflows/publish.yml"),
      "utf8",
    );
    const prepareJob = workflow
      .split("\n  prepare:\n")[1]
      ?.split("\n  publish:\n")[0];
    const publishJob = workflow
      .split("\n  publish:\n")[1]
      ?.split("\n  verify:\n")[0];
    const verifyJob = workflow
      .split("\n  verify:\n")[1]
      ?.split("\n  tag-and-release:\n")[0];
    const releaseJob = workflow.split("\n  tag-and-release:\n")[1];
    if (
      prepareJob === undefined ||
      publishJob === undefined ||
      verifyJob === undefined ||
      releaseJob === undefined
    ) {
      throw new Error("Missing release workflow job");
    }

    expect(prepareJob).toContain(
      `if: \${{ github.repository == 'baranovxyz/agent-canonical' && github.ref == 'refs/heads/main' }}`,
    );
    expect(prepareJob).not.toContain("id-token: write");
    expect(prepareJob).toContain("pnpm install --no-frozen-lockfile");
    expect(prepareJob).toContain("pnpm build");
    expect(prepareJob).toContain("pnpm test:artifact");
    expect(prepareJob).toContain("pnpm pack --pack-destination pack");
    expect(prepareJob).toContain("publishConfig exports");
    expect(prepareJob).toContain('exportsJson.includes("./src")');
    expect(prepareJob).toContain('exportsJson.includes("./dist")');
    expect(prepareJob).toContain("actions/upload-artifact@");
    expect(prepareJob).toContain("path: agent-canonical-release.tgz");

    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("environment: npm");
    expect(publishJob).toContain("actions: read");
    expect(publishJob).not.toContain("contents: read");
    expect(publishJob).not.toContain("contents: write");
    expect(publishJob).not.toContain("actions/checkout@");
    expect(publishJob).not.toContain("pnpm ");
    expect(publishJob).not.toContain("test:artifact");
    expect(publishJob).not.toContain("npm view");
    expect(publishJob).not.toContain('import { z } from "zod"');
    expect(publishJob).toContain("npm install -g npm@11.17.0 --ignore-scripts");
    expect(publishJob).toContain("actions/download-artifact@");
    expect(publishJob).toContain(
      "downloaded release candidate integrity mismatch",
    );
    expect(publishJob).toContain(
      "release-artifact/agent-canonical-release.tgz",
    );
    expect(publishJob).not.toContain("needs.prepare.outputs.filename");
    expect(publishJob).not.toContain("npm@latest");

    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toContain("environment: npm");
    expect(verifyJob).toContain("actions/download-artifact@");
    expect(verifyJob).toContain("zod@4.4.3");
    expect(verifyJob).toContain('import { z } from "zod"');
    expect(verifyJob).toContain("dist.attestations.url");
    expect(verifyJob).toContain("https://slsa.dev/provenance/v1");
    expect(verifyJob).toContain("process.env.EXPECTED_SHA");

    const actionRefs = [...workflow.matchAll(/uses: [^@\s]+@([^\s#]+)/gu)].map(
      (match) => match[1],
    );
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((ref) => /^[0-9a-f]{40}$/u.test(ref ?? ""))).toBe(
      true,
    );
    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);

    expect(workflow).toContain(
      "Tag $TAG already points at $REMOTE_SHA, expected $GITHUB_SHA",
    );
    expect(workflow).toContain('git tag "$TAG" "$GITHUB_SHA"');
    expect(releaseJob).toContain("needs.verify.result == 'success'");
    expect(workflow.indexOf("- name: Tag preflight")).toBeLessThan(
      workflow.indexOf("- name: Publish (dry run)"),
    );
    expect(workflow).toContain(
      `npm publish "$ARTIFACT" --provenance --access public --ignore-scripts --tag \${{ needs.prepare.outputs.tag }} --dry-run`,
    );
    expect(workflow).toContain(
      `npm publish "$ARTIFACT" --provenance --access public --ignore-scripts --tag \${{ needs.prepare.outputs.tag }}\n`,
    );
    expect(workflow).not.toContain(
      "run: npm publish --provenance --access public",
    );
    expect(workflow).not.toContain("run: pnpm publish");
    expect(workflow).toContain("finalize-only");
    expect(workflow).toContain("id: availability");
    expect(workflow).toContain(
      'echo "already_published=true" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      'echo "already_published=false" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      "needs.prepare.outputs.already_published != 'true'",
    );
    expect(workflow).toContain(
      "already published; dry-run requires an unpublished version",
    );
    expect(workflow).toContain(
      "skipping publish and requiring exact integrity + provenance verification",
    );
    expect(workflow).toContain(
      'PUBLISHED_INTEGRITY=$(npm view "$PACKAGE" dist.integrity 2>"$RUNNER_TEMP/integrity.err")',
    );
    expect(workflow).toContain("for ATTEMPT in 1 2 3 4 5 6");
    expect(workflow).toContain(
      "registry metadata did not become available after 6 attempts",
    );
    expect(workflow).toContain(
      "SLSA provenance attestation was unavailable after 6 attempts",
    );
    expect(workflow).toContain(
      'workflow.path !== ".github/workflows/publish.yml"',
    );
    expect(workflow).not.toContain(
      'workflow.path !== "/.github/workflows/publish.yml"',
    );
    expect(workflow).toContain("grep -q 'E404'");
    expect(workflow).toContain(
      "Could not determine whether $PACKAGE already exists",
    );
    expect(workflow).not.toContain(
      '|| echo "Release already exists for $TAG, skipping"',
    );
  });
});
