import type { RAGConfig } from "./config";
import { createDataPreparation, getSupportedCategories, getSupportedDifficulties } from "./data-preparation";
import { createLLMEngine } from "./generation";
import { createIndexBuilder } from "./index-construction";
import { createRetrievalEngine } from "./retrieval";
import type {
  ChunkDocument,
  ChunkMetadata,
  RAGSystem,
  RouteType,
  SourceDoc,
} from "./types";
import { createLogger } from "../utils";

const log = createLogger("RAGSystem");

/**
 * RAG 系统主工厂函数（对应原 Python main.py RecipeRAGSystem）。
 *
 * 这是 lib/rag 的总编排层，负责把四个模块串起来：
 * 1. data-preparation：读取 Markdown、补元数据、分块。
 * 2. index-construction：构建或加载向量索引。
 * 3. retrieval：执行混合检索和过滤。
 * 4. generation：查询路由、查询重写、流式回答。
 */
export function createRAGSystem(config: RAGConfig): RAGSystem {
  let dataModule: ReturnType<typeof createDataPreparation> | null = null;
  let indexModule: ReturnType<typeof createIndexBuilder> | null = null;
  let retrievalModule: ReturnType<typeof createRetrievalEngine> | null = null;
  let generationModule: ReturnType<typeof createLLMEngine> | null = null;
  let initialized = false;

  /**
   * 初始化各个模块。
   *
   * 这里只创建对象和 LLM/Embedding 客户端，不读取菜谱、不调用 Embedding API。
   * 真正耗时的知识库构建放在 buildKnowledgeBase 中。
   */
  function initializeSystem(): void {
    log.info("正在初始化 RAG 系统...");

    dataModule = createDataPreparation(config.dataPath);
    indexModule = createIndexBuilder(
      config.embeddingModel,
      config.indexSavePath,
      config.embeddingApiKey,
      config.embeddingBaseURL
    );
    generationModule = createLLMEngine(
      config.llmModel,
      config.temperature,
      config.maxTokens,
      config.apiKey,
      config.baseURL
    );

    initialized = true;
    log.info("系统初始化完成");
  }

  /**
   * 构建知识库。
   *
   * 优先加载本地缓存索引；如果缓存不存在、加载失败或 forceRebuild=true，
   * 则重新读取菜谱、分块、向量化并保存索引。
   * 缓存命中时，直接从索引恢复 chunks，跳过冗余的文档加载和分块 I/O。
   */
  async function buildKnowledgeBase(
    forceRebuild: boolean = false
  ): Promise<void> {
    if (!initialized || !dataModule || !indexModule) {
      throw new Error("请先调用 initializeSystem()");
    }

    log.info("正在构建知识库...");

    let vectorstore: Awaited<ReturnType<typeof indexModule.loadIndex>> = null;
    if (!forceRebuild) {
      vectorstore = await indexModule.loadIndex();
    }

    let chunks: ChunkDocument[];

    if (vectorstore) {
      // 缓存命中：优先使用从索引恢复的 chunks
      const cachedChunks = indexModule.getCachedChunks();
      if (cachedChunks.length > 0) {
        chunks = cachedChunks;
        log.info(
          `使用缓存的 ${chunks.length} 个 chunks，跳过文档加载和分块`
        );
      } else {
        // 兼容旧版索引（无 chunks 缓存），回退到读取文档
        log.info("旧版索引无 chunks 缓存，回退到文档加载...");
        dataModule.loadDocuments();
        chunks = dataModule.chunkDocuments();
      }
    } else {
      log.info("未找到已保存的索引，开始构建新索引...");
      dataModule.loadDocuments();
      chunks = dataModule.chunkDocuments();
      if (forceRebuild || config.autoBuildVectorIndex) {
        try {
          vectorstore = await indexModule.buildVectorIndex(chunks);
          await indexModule.saveIndex(vectorstore);
        } catch (error) {
          log.warn(
            "向量索引构建失败，已降级为 BM25 检索。请检查 Embedding API Key / Base URL / 模型配置。",
            error
          );
          vectorstore = null;
        }
      } else {
        log.info("已跳过自动向量索引构建，使用 BM25 检索快速启动知识库");
      }
    }

    retrievalModule = createRetrievalEngine(vectorstore, chunks);

    // 统计信息在缓存命中时仍可通过 dataModule 获取（如果 loadDocuments 未被调用则可能为空）
    const stats = indexModule.getCachedChunks().length > 0
      ? {
          total_documents: 0,
          total_chunks: indexModule.getCachedChunks().length,
          categories: {} as Record<string, number>,
          difficulties: {} as Record<string, number>,
          avg_chunk_size: 0,
        }
      : dataModule.getStatistics();
    log.info("知识库统计:", stats);
    log.info("知识库构建完成");
  }

  /**
   * 回答用户问题（流式）。
   *
   * 完整链路：
   * 1. LLM 判断问题类型。
   * 2. 非列表问题进行查询重写。
   * 3. 从问题中提取分类/难度过滤条件。
   * 4. 混合检索 child chunks。
   * 5. 回溯 parent 文档给 LLM 生成答案。
   * 6. 返回 sources 和 AsyncGenerator，route handler 负责转成 SSE。
   */
  async function askQuestion(
    question: string,
    history: Array<{ role: string; content: string }> = []
  ): Promise<{
    sources: SourceDoc[];
    routeType: RouteType;
    stream: AsyncGenerator<string>;
  }> {
    if (!retrievalModule || !generationModule || !dataModule) {
      throw new Error("请先构建知识库");
    }

    log.info(`用户问题: ${question}`);

    const routeType = await resolveRouteType(question);
    log.info(`查询类型: ${routeType}`);

    let rewrittenQuery = question;
    if (routeType === "general") {
      log.info("智能分析查询...");
      try {
        rewrittenQuery = await generationModule.queryRewrite(question);
      } catch (error) {
        log.warn("查询重写失败，使用原始问题继续检索。", error);
      }
    }

    const filters = extractFiltersFromQuery(question);
    let relevantChunks: ChunkDocument[];

    if (Object.keys(filters).length > 0) {
      log.info("应用过滤条件:", filters);
      relevantChunks = await retrievalModule.metadataFilteredSearch(
        rewrittenQuery,
        filters,
        config.topK
      );
    } else {
      relevantChunks = await retrievalModule.hybridSearch(
        rewrittenQuery,
        config.topK
      );
    }

    log.info(`找到 ${relevantChunks.length} 个相关文档块`);

    if (relevantChunks.length === 0) {
      return {
        sources: [],
        routeType,
        stream: (async function* () {
          yield "抱歉，没有找到相关的食谱信息。请尝试其他菜品名称或关键词。";
        })(),
      };
    }

    const relevantDocs = dataModule.getParentDocuments(relevantChunks);
    const sources = buildUniqueSources(relevantChunks);
    const stream = buildAnswerStream(
      routeType,
      question,
      relevantDocs,
      history
    );

    return { sources, routeType, stream };
  }

  /**
   * 从用户问题中提取元数据过滤条件。
   *
   * 例如“推荐简单素菜”会提取 category=素菜、difficulty=简单。
   * 难度按长度降序匹配，避免“非常简单”被提前识别成“简单”。
   */
  function extractFiltersFromQuery(
    query: string
  ): Partial<Record<keyof ChunkMetadata, string>> {
    const filters: Partial<Record<keyof ChunkMetadata, string>> = {};

    for (const cat of getSupportedCategories()) {
      if (query.includes(cat)) {
        filters.category = cat;
        break;
      }
    }

    const difficultyKeywords = getSupportedDifficulties().sort(
      (a, b) => b.length - a.length
    );
    for (const diff of difficultyKeywords) {
      if (query.includes(diff)) {
        filters.difficulty = diff;
        break;
      }
    }

    return filters;
  }

  async function resolveRouteType(query: string): Promise<RouteType> {
    const localRoute = inferRouteType(query);
    if (localRoute !== "general") {
      return localRoute;
    }

    if (!generationModule) {
      return "general";
    }

    try {
      return await generationModule.queryRouter(query);
    } catch (error) {
      log.warn("查询分类失败，已降级为 general。", error);
      return "general";
    }
  }

  function inferRouteType(query: string): RouteType {
    const detailKeywords = [
      "怎么做",
      "做法",
      "步骤",
      "食材",
      "需要什么",
      "制作",
      "如何",
      "教我",
      "菜谱",
    ];
    if (detailKeywords.some((keyword) => query.includes(keyword))) {
      return "detail";
    }

    const listKeywords = [
      "推荐",
      "有什么",
      "哪些",
      "几个",
      "列表",
      "菜品",
      "想吃",
      "吃什么",
    ];
    if (listKeywords.some((keyword) => query.includes(keyword))) {
      return "list";
    }

    return "general";
  }

  /** 把检索到的 chunks 转换成前端展示用的来源列表，并按菜品名去重。 */
  function buildUniqueSources(chunks: ChunkDocument[]): SourceDoc[] {
    const sources: SourceDoc[] = chunks.map((chunk) => ({
      dish_name: chunk.metadata.dish_name || "未知菜品",
      category: chunk.metadata.category || "未知",
      difficulty: chunk.metadata.difficulty || "未知",
      rrf_score: chunk.metadata.rrf_score || 0,
      source: chunk.metadata.source || "",
    }));

    return sources.filter(
      (source, index, arr) =>
        arr.findIndex((item) => item.dish_name === source.dish_name) === index
    );
  }

  /** 根据路由类型选择合适的回答生成方式。 */
  function buildAnswerStream(
    routeType: RouteType,
    question: string,
    relevantDocs: ChunkDocument[],
    history: Array<{ role: string; content: string }>
  ): AsyncGenerator<string> {
    if (!generationModule) {
      throw new Error("生成模块未初始化");
    }

    if (routeType === "list") {
      const result = generationModule.generateListAnswer(question, relevantDocs);
      return (async function* () {
        yield result.content;
      })();
    }

    if (routeType === "detail") {
      return generationModule.generateStepByStepAnswerStream(
        question,
        relevantDocs,
        history
      );
    }

    return generationModule.generateBasicAnswerStream(
      question,
      relevantDocs,
      history
    );
  }

  /** 获取知识库统计信息；未初始化时返回 null。 */
  function getStats() {
    if (!dataModule) {
      return null;
    }
    return dataModule.getStatistics();
  }

  /** 判断系统是否已经初始化并完成知识库构建。 */
  function isReady(): boolean {
    return initialized && retrievalModule !== null && generationModule !== null;
  }

  return {
    initializeSystem,
    buildKnowledgeBase,
    askQuestion,
    getStats,
    isReady,
  };
}
