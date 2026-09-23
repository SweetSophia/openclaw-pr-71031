import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import {
  computeWriteMutationTargetHash,
  hashWriteMutationTarget,
} from "./tool-loop-write-outcome.js";

const tempDirs: string[] = [];

/** Behaves like a workspace-mapped bridge: relative inputs resolve under cwd. */
function makeBridge(): SandboxFsBridge {
  return {
    resolvePath: ({ filePath, cwd }: { filePath: string; cwd?: string }) => {
      const base = cwd ?? "/workspace";
      const hostPath = isAbsolute(filePath) ? filePath : resolve(base, filePath);
      const rel = relative(base, hostPath);
      return {
        hostPath,
        relativePath: rel,
        containerPath: `/workspace/${rel}`,
      };
    },
  } as unknown as SandboxFsBridge;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("computeWriteMutationTargetHash", () => {
  it("matches the writer's reference-marker semantics: @name without a literal file joins plain name", async () => {
    const bridge = makeBridge();
    const sandbox = { root: "/workspace", bridge };
    // wrapSandboxFileToolPath consumes the @ reference marker when no literal
    // @-named file exists, so both inputs write the same container target and
    // must share the churn-streak hash.
    const atHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "@notes.md" },
      sandbox,
    });
    const plainHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "notes.md" },
      sandbox,
    });
    expect(atHash).toBe(plainHash);
    expect(atHash).toBeDefined();
  });

  it("keeps literal @@ names distinct like the writer's container candidate", async () => {
    const bridge = makeBridge();
    const sandbox = { root: "/workspace", bridge };
    // normalizeFileReferencePrefix escapes @@x as ./@x — a different container
    // target than plain x, so the hashes must differ.
    const escapedHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "@@notes.md" },
      sandbox,
    });
    const plainHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "notes.md" },
      sandbox,
    });
    expect(escapedHash).not.toBe(plainHash);
  });

  it("preserves @ names backed by a literal host file, unlike the stripped name", async () => {
    // A real temp workspace with a literal "@notes.md" keeps preserveAtPrefixedRelativePath
    // in the "./@notes.md" form, which the bridge maps to a distinct container path.
    const root = mkdtempSync(join(tmpdir(), "wot-hash-"));
    tempDirs.push(root);
    writeFileSync(join(root, "@notes.md"), "literal at file");
    const bridge = makeBridge();
    const sandbox = { root, bridge };
    const atHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "@notes.md" },
      sandbox,
    });
    const plainHash = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "notes.md" },
      sandbox,
    });
    expect(atHash).not.toBe(plainHash);
  });

  it("falls back to host resolution without a sandbox and on bridge failure", async () => {
    const hostOnly = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "notes.md" },
      cwd: "/tmp/proj",
    });
    expect(hostOnly).toBe(hashWriteMutationTarget("write", { path: "notes.md" }, "/tmp/proj"));
    const throwing = {
      resolvePath: () => {
        throw new Error("bridge down");
      },
    } as unknown as SandboxFsBridge;
    const fallback = await computeWriteMutationTargetHash({
      toolName: "write",
      toolParams: { path: "notes.md" },
      cwd: "/tmp/proj",
      sandbox: { root: "/workspace", bridge: throwing },
    });
    expect(fallback).toBe(hashWriteMutationTarget("write", { path: "notes.md" }, "/tmp/proj"));
  });

  it("returns undefined for non-write tools and missing paths", async () => {
    const bridge = makeBridge();
    const sandbox = { root: "/workspace", bridge };
    expect(
      await computeWriteMutationTargetHash({
        toolName: "edit",
        toolParams: { path: "notes.md" },
        sandbox,
      }),
    ).toBeUndefined();
    expect(
      await computeWriteMutationTargetHash({
        toolName: "write",
        toolParams: { path: "" },
        sandbox,
      }),
    ).toBeUndefined();
  });
});
