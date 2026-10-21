import { resolveGeographicText } from "@/lib/agent/graph";
import { getRawDb } from "@/db/index";
import { createCaseRepository } from "@/lib/agent/case-library";

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 12_000) {
      return Response.json({ error: "请求内容过大。" }, { status: 413 });
    }
    let payload: { text?: unknown };
    try {
      payload = (await request.json()) as { text?: unknown };
    } catch {
      return Response.json({ error: "请求体必须是合法 JSON。" }, { status: 400 });
    }
    if (typeof payload.text !== "string" || !payload.text.trim()) {
      return Response.json({ error: "请输入需要空间化的中文地理文本。" }, { status: 400 });
    }
    if (payload.text.length > 2000) {
      return Response.json({ error: "第一版单次输入最多支持 2000 个字符。" }, { status: 400 });
    }
    const result = await resolveGeographicText(payload.text);
    try {
      await createCaseRepository(getRawDb()).upsert(result);
    } catch {
      // A persistence outage must not hide an otherwise valid spatial result.
    }
    return Response.json({ ...result, caseId: result.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 运行失败";
    return Response.json({ error: message }, { status: 500 });
  }
}
