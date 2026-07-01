import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { join } from "path";
import { getInitializedRAGSystem, resetRAGSystem } from "@/lib/rag/rag-instance";
import { loadConfig } from "@/lib/rag/config";

// 知识库管理接口需要动态执行
export const dynamic = "force-dynamic";

/**
 * GET: 获取知识库状态和统计信息
 */
export async function GET() {
  try {
    const config = loadConfig();
    const indexPath = join(process.cwd(), config.indexSavePath);
    const hadIndex = existsSync(indexPath);

    const ragSystem = await getInitializedRAGSystem();
    const stats = ragSystem.getStats();
    const indexExists = existsSync(indexPath);

    return NextResponse.json({
      ready: ragSystem.isReady(),
      indexExists,
      message: hadIndex ? "知识库已就绪" : "知识库已构建",
      stats,
    });
  } catch (error) {
    console.error("[API /knowledge-base GET] 错误:", error);
    return NextResponse.json(
      {
        ready: false,
        error: error instanceof Error ? error.message : "获取状态失败",
      },
      { status: 500 }
    );
  }
}

/**
 * POST: 构建或重建知识库
 * 请求体: { rebuild?: boolean }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const rebuild = body?.rebuild === true;

    if (rebuild) {
      // 重置实例，强制重建
      resetRAGSystem();
    }

    const ragSystem = await getInitializedRAGSystem();

    // 如果需要重建且实例已就绪，重新构建
    if (rebuild && ragSystem.isReady()) {
      resetRAGSystem();
      const freshSystem = await getInitializedRAGSystem();
      const stats = freshSystem.getStats();
      return NextResponse.json({
        success: true,
        message: "知识库已重建",
        stats,
      });
    }

    const stats = ragSystem.getStats();
    return NextResponse.json({
      success: true,
      message: rebuild ? "知识库已构建" : "知识库已就绪",
      stats,
    });
  } catch (error) {
    console.error("[API /knowledge-base POST] 错误:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "构建知识库失败",
      },
      { status: 500 }
    );
  }
}
