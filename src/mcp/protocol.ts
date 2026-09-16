/**
 * Minimal MCP stdio transport framing.
 *
 * CodeGraph's MCP server speaks JSON-RPC 2.0 over stdio with newline-delimited
 * messages (the MCP stdio transport), and negotiates protocol version
 * `2024-11-05` (`dist/mcp/session.js`). It does NOT use LSP-style
 * `Content-Length` headers, so framing is a line split plus a bounded buffer.
 *
 * This module is intentionally dependency-free and side-effect-free: it is pure
 * enough to unit-test without spawning anything.
 */

export const JSONRPC_VERSION = "2.0" as const;

/** Protocol version CodeGraph answers with, per `dist/mcp/session.js`. */
export const MCP_PROTOCOL_VERSION = "2024-11-05" as const;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["jsonrpc"] !== JSONRPC_VERSION) return false;
  if (!("id" in candidate)) return false;
  return "result" in candidate || "error" in candidate;
}

export function isFailure(value: JsonRpcResponse): value is JsonRpcFailure {
  return "error" in value;
}

/** MCP text content block, the only content shape CodeGraph emits. */
export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpToolCallResult {
  content?: McpTextContent[];
  isError?: boolean;
  /** Upstream may attach structured content in future protocol revisions. */
  structuredContent?: unknown;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * Incremental newline-delimited JSON decoder.
 *
 * Feed it raw stdout chunks; it returns whatever complete JSON values it could
 * parse and retains the trailing partial line. A line that fails to parse is
 * reported through `onMalformed` rather than thrown, because a single noisy log
 * line on stdout must not kill an in-flight agent call.
 */
export class LineDelimitedJsonDecoder {
  private buffer = "";

  constructor(private readonly onMalformed?: (line: string) => void) {}

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const values: unknown[] = [];

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          values.push(JSON.parse(line));
        } catch {
          this.onMalformed?.(line);
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }

    return values;
  }

  /** Bytes held back because no terminating newline has arrived yet. */
  get pendingChars(): number {
    return this.buffer.length;
  }
}

/** Encode one JSON-RPC message for the stdio transport. */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Extract the single text payload from a `tools/call` result.
 *
 * CodeGraph returns one `text` block; if a future version returns several they
 * are joined with a blank line so nothing is silently dropped.
 */
export function extractText(result: McpToolCallResult): string {
  const blocks = result.content;
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  return blocks
    .filter(
      (block): block is McpTextContent =>
        typeof block === "object" &&
        block !== null &&
        (block as McpTextContent).type === "text" &&
        typeof (block as McpTextContent).text === "string",
    )
    .map((block) => block.text)
    .join("\n\n");
}
