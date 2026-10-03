/**
 * ZCAC Phase 13 — 协议帧解析(纯函数,独立可测)。
 *
 * ZCode Protocol v1 over NDJSON:
 *   请求  {id, method, params}
 *   响应  {id, result} | {id, error}
 *   通知  {method, params}
 */

export interface ProtocolRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface ProtocolResponse {
  id: number | string;
  result?: unknown;
  error?: { code: number | string; message: string };
}

export interface ProtocolNotification {
  method: string;
  params?: unknown;
}

export type ProtocolFrame = ProtocolResponse | ProtocolNotification;

/** 编码一帧 NDJSON(含换行)。请求与响应都可编码。 */
export function encodeFrame(frame: ProtocolRequest | ProtocolResponse): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 从流缓冲中解析完整帧(NDJSON 按行分割;不完整行保留在缓冲)。
 * 返回解析出的响应/通知 + 剩余缓冲。
 */
export function decodeFrames(buffer: string): {
  frames: ProtocolFrame[];
  rest: string;
} {
  const frames: ProtocolFrame[] = [];
  let rest = buffer;
  let newlineIndex: number;
  while ((newlineIndex = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, newlineIndex).trim();
    rest = rest.slice(newlineIndex + 1);
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as ProtocolFrame;
      frames.push(parsed);
    } catch {
      // 非 JSON 行(子进程日志污染):跳过,不中断流
    }
  }
  return { frames, rest };
}

/**
 * 判定一个响应是否是成功的 rpc 结果(供 session/create 等取值)。
 */
export function rpcResult(frame: ProtocolFrame): unknown {
  if ("result" in frame) return frame.result;
  return undefined;
}

/** 从事件载荷尽力提取回合最终文本;失败返回空串。 */
export function extractTurnResponse(payload: unknown): string {
  try {
    const text = JSON.stringify(payload);
    const textMatches = text.match(/"type":"text","text":"((?:[^"\\]|\\.)*)"/g);
    if (textMatches && textMatches.length > 0) {
      const last = textMatches[textMatches.length - 1]!;
      const inner = last.slice('"type":"text","text":"'.length, -1);
      return JSON.parse(`"${inner}"`) as string;
    }
    return "";
  } catch {
    return "";
  }
}
