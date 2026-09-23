import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeFileToolPathParam } from "./agent-tools.params.js";
import { normalizeFileReferencePrefix } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { resolveLocalPathToCwd } from "./sessions/tools/path-utils.js";

export function isWriteNoProgressOutcome(details: Record<string, unknown>): boolean {
  // The built-in no-op result echoes the requested path in display text.
  // Its structured `changed: false` flag is the semantic no-progress contract.
  return details.changed === false;
}

function extractWritePath(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const rawPath = Reflect.get(params, "path");
  return typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined;
}

function hashResolvedPath(path: string): string {
  return createHash("sha256").update(stableStringify({ path })).digest("hex");
}

export function hashWriteMutationTarget(
  toolName: string,
  params: unknown,
  cwd?: string,
): string | undefined {
  if (toolName !== "write") {
    return undefined;
  }
  const rawPath = extractWritePath(params);
  if (rawPath === undefined) {
    return undefined;
  }
  const path = cwd ? resolveLocalPathToCwd(rawPath, cwd) : rawPath;
  return hashResolvedPath(path);
}

export type WriteMutationTargetSandbox = {
  root: string;
  bridge: SandboxFsBridge;
};

/**
 * Compute the churn-streak target hash with the same resolution chain as the
 * active write backend. Sandboxed sessions resolve through the bridge's
 * container namespace (mirroring wrapSandboxFileToolPath), so remote-only
 * literal `@` files hash distinctly from their stripped counterparts. Falls
 * back to host cwd resolution when no sandbox is active or bridge resolution
 * fails; admission must never break on hashing.
 *
 * ponytail: skips the writer's file://-URL conversion (resolveContainerPathCandidate);
 * distinct file URLs already hash distinctly. Add it if URL-vs-plain parity ever matters.
 */
export async function computeWriteMutationTargetHash(params: {
  toolName: string;
  toolParams: unknown;
  cwd?: string;
  sandbox?: WriteMutationTargetSandbox;
}): Promise<string | undefined> {
  if (params.toolName !== "write") {
    return undefined;
  }
  const rawPath = extractWritePath(params.toolParams);
  if (rawPath === undefined) {
    return undefined;
  }
  if (params.sandbox) {
    try {
      const normalized = await normalizeFileToolPathParam(
        rawPath,
        params.sandbox.root,
        params.sandbox.bridge,
      );
      if (normalized === "") {
        return undefined;
      }
      // Mirror the writer's container-candidate selection: consume one @ prefix
      // while escaping literal @@ names (normalizeFileReferencePrefix).
      const candidate = normalizeFileReferencePrefix(normalized);
      const resolved = params.sandbox.bridge.resolvePath({
        filePath: candidate,
        cwd: params.sandbox.root,
      });
      return hashResolvedPath(resolved.containerPath);
    } catch {
      // Bridge resolution must never break admission; hash on the host chain.
    }
  }
  return hashWriteMutationTarget(params.toolName, params.toolParams, params.cwd);
}
