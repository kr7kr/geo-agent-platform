import { getRawDb } from "@/db/index";
import { createCaseRepository } from "@/lib/agent/case-library";
import type { CaseFeedback } from "@/lib/agent/case-library";
import type { Decision } from "@/lib/agent/types";

const DECISIONS: Decision[] = ["RESOLVED", "COARSE", "ABSTAIN", "NEED_CLARIFICATION"];

function repository() {
  return createCaseRepository(getRawDb());
}

function validDecision(value: string | null): Decision | undefined {
  return value && DECISIONS.includes(value as Decision) ? value as Decision : undefined;
}

function validFeedback(value: string | null): CaseFeedback | undefined {
  return value === "positive" || value === "negative" ? value : undefined;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const store = repository();
    const id = url.searchParams.get("id")?.trim();
    if (id) {
      const record = await store.get(id);
      return record
        ? Response.json({ case: record, storage: store.storage })
        : Response.json({ error: "案例不存在。" }, { status: 404 });
    }
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const cases = await store.list({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number(url.searchParams.get("offset") ?? 0),
      decision: validDecision(url.searchParams.get("decision")),
      feedback: validFeedback(url.searchParams.get("feedback")),
      search: url.searchParams.get("search")?.trim() || undefined,
    });
    const metrics = await store.metrics();
    return Response.json({ cases, metrics, storage: store.storage });
  } catch {
    return Response.json({ error: "案例库暂时不可用。" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 12_000) return Response.json({ error: "请求内容过大。" }, { status: 413 });
    const payload = await request.json() as {
      caseId?: unknown;
      feedback?: unknown;
      note?: unknown;
      expectedDecision?: unknown;
      expectedEntity?: unknown;
    };
    const caseId = typeof payload.caseId === "string" ? payload.caseId.trim() : "";
    if (!caseId) return Response.json({ error: "缺少 caseId。" }, { status: 400 });
    const store = repository();
    let record = await store.get(caseId);
    if (!record) return Response.json({ error: "案例不存在。" }, { status: 404 });
    if (typeof payload.feedback === "string") {
      const feedback = validFeedback(payload.feedback);
      if (!feedback) return Response.json({ error: "feedback 必须是 positive 或 negative。" }, { status: 400 });
      record = await store.setFeedback(caseId, feedback, typeof payload.note === "string" ? payload.note : undefined);
    }
    if (payload.expectedDecision !== undefined) {
      const expected = payload.expectedDecision === null ? null : validDecision(String(payload.expectedDecision));
      if (payload.expectedDecision !== null && !expected) return Response.json({ error: "expectedDecision 无效。" }, { status: 400 });
      record = await store.setAnnotation(caseId, expected ?? null, typeof payload.expectedEntity === "string" ? payload.expectedEntity : null);
    }
    return Response.json({ case: record, metrics: await store.metrics(), storage: store.storage });
  } catch {
    return Response.json({ error: "案例反馈保存失败。" }, { status: 503 });
  }
}
