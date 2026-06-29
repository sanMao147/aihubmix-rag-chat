import { getInitializedRAGSystem } from "@/lib/rag/rag-instance";
import type { ChatRequestBody, SSEEvent } from "@/lib/rag/types";

// 确保路由为动态（流式响应）
export const dynamic = "force-dynamic";

/**
 * 流式聊天 SSE 接口
 *
 * 请求体: { query: string, history: Array<{role, content}> }
 *
 * 响应: SSE 流
 * - event: sources  → 检索到的来源文档
 * - event: token     → 流式回答片段
 * - event: error     → 错误信息
 * - event: done      → 完成信号
 */
export async function POST(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "无效的请求体" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { query, history = [] } = body;

  if (!query || typeof query !== "string") {
    return new Response(JSON.stringify({ error: "query 不能为空" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 输入长度限制
  if (query.length > 2000) {
    return new Response(
      JSON.stringify({ error: "单条消息不能超过 2000 字符" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const encoder = new TextEncoder();

  const sendEvent = (event: SSEEvent): Uint8Array => {
    return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 获取 RAG 系统（自动初始化+构建知识库）
        const ragSystem = await getInitializedRAGSystem();

        // 调用 RAG 系统获取回答
        const { sources, stream: answerStream } = await ragSystem.askQuestion(
          query,
          history
        );

        // 1. 先发送来源文档
        controller.enqueue(
          sendEvent({ type: "sources", data: sources })
        );

        // 2. 逐字发送回答
        for await (const chunk of answerStream) {
          controller.enqueue(sendEvent({ type: "token", data: chunk }));
        }

        // 3. 发送完成信号
        controller.enqueue(sendEvent({ type: "done", data: "完成" }));
      } catch (error) {
        console.error("[API /chat] 错误:", error);
        const message =
          error instanceof Error ? error.message : "处理请求时出错";
        controller.enqueue(sendEvent({ type: "error", data: message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
