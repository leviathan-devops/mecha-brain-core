// shell.ts — THE TOOL SHELL (extracted from
// extension/jarvis-manager.ts + the GI textResult pattern). LAWS:
//   FUNCTIONS-ONLY entry — a non-function export is SILENTLY dropped at load.
//   CONTENT-BLOCK RESULTS — the host renders tool results by iterating
//     result.content; a bare payload throws in the renderer (measured,
//     extension fix #5).
//   REQUIRED-FIELD GUARD — the host may pre-pass call-id strings; the guard
//     declines them safely and the real typed call follows (measured).
//   SECRETS LAW — payloads carry labels/ids only; key material never enters
//     tool results (grep-tested in the battery).

export type ContentBlock = { type: "text"; text: string };

export type ToolResult = { content: ContentBlock[] };

export function textResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export type ToolDef<TArgs> = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: TArgs) => Promise<ToolResult>;
};

export type ToolRegistrar = {
  registerTool: <TArgs>(tool: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (args: TArgs) => Promise<ToolResult>;
  }) => void;
};

/** Wrap + register one tool. The host calls execute with validated args;
 *  the wrapper guarantees the content-block envelope. */
export function registerToolDef<TArgs>(
  pi: ToolRegistrar,
  def: { name: string; description: string; parameters: unknown; execute: (args: TArgs) => Promise<unknown> },
): string {
  pi.registerTool<TArgs>({
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (args: TArgs) => textResult(await def.execute(args)),
  });
  return def.name;
}

/** Required-field guard: declines host pre-pass invocations that arrive
 *  without the required string fields. */
export function requireFields(
  args: unknown,
  fields: string[],
): { ok: true } | { ok: false; error: string } {
  if (!args || typeof args !== "object") {
    return { ok: false, error: `required fields missing: ${fields.join(", ")}` };
  }
  const rec = args as Record<string, unknown>;
  const missing = fields.filter((f) => {
    const v = rec[f];
    return v === undefined || v === null || (typeof v === "string" && v.trim().length === 0);
  });
  if (missing.length > 0) {
    return { ok: false, error: `required fields missing: ${missing.join(", ")}` };
  }
  return { ok: true };
}

/** Secrets law, grep-tested: a result must not carry key-shaped material. */
export function resultIsSecretFree(text: string): boolean {
  return !/sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);
}
