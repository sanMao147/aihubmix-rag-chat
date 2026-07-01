import type { RAGConfig } from "./config";
import type {
  ChunkDocument,
  SourceDoc,
  RouteType,
  RAGSystem,
  SearchStrategy,
} from "./types";
import { createDataPreparation, getSupportedCategories, getSupportedDifficulties } from "./data-preparation";
import { createIndexBuilder } from "./index-construction";
import { createRetrievalEngine } from "./retrieval";
import { createLLMEngine } from "./generation";
import { createGraphRAGRetrieval } from "./graph-rag-retrieval";
import { createGraphIndexing } from "./graph-indexing";
import { buildGraphFromMarkdown } from "./graph-data-import";
import { loadNeo4jConfig, initNeo4jDriver, testNeo4jConnection, closeNeo4jDriver } from "./neo4j-connection";
import { md5 } from "../utils";

/**
 * RAG 系统主工厂函数（对应原 Python main.py RecipeRAGSystem）
 * 串联：数据准备 → 索引构建 → 检索优化 → 图检索 → 生成集成
 *
 * 已重构为工厂函数 + 闭包，不再使用 class/this。
 */
export function createRAGSystem(config: RAGConfig): RAGSystem {
  // 各子模块延迟初始化，避免导入文件时就读取环境变量或构建索引。
  let dataModule: ReturnType<typeof createDataPreparation> | null = null;
  let indexModule: ReturnType<typeof createIndexBuilder> | null = null;
  let retrievalModule: ReturnType<typeof createRetrievalEngine> | null = null;
  let generationModule: ReturnType<typeof createLLMEngine> | null = null;

  // 图 RAG 模块
  let graphEnabled = false;
  let graphIndex: ReturnType<typeof createGraphIndexing> | null = null;
  let graphRetrieval: ReturnType<typeof createGraphRAGRetrieval> | null = null;

  let initialized = false;

  /**
   * 初始化所有模块
   */
  function initializeSystem(): void {
    console.log("[RAGSystem] 正在初始化 RAG 系统...");

    dataModule = createDataPreparation(config.dataPath);

    indexModule = createIndexBuilder(
      config.embeddingModel,
      config.indexSavePath,
      config.apiKey,
      config.baseURL
    );

    generationModule = createLLMEngine(
      config.llmModel,
      config.temperature,
      config.maxTokens,
      config.apiKey,
      config.baseURL
    );

    // 尝试初始化 Neo4j 图模块
    const neo4jConfig = loadNeo4jConfig();
    if (neo4jConfig) {
      const driver = initNeo4jDriver(neo4jConfig);
      if (driver) {
        graphIndex = createGraphIndexing();
        graphRetrieval = createGraphRAGRetrieval(
          config.llmModel,
          config.temperature,
          config.maxTokens,
          config.apiKey,
          config.baseURL,
          graphIndex
        );
        graphEnabled = true;
        console.log("[RAGSystem] 图 RAG 模块已启用");
      } else {
        console.log("[RAGSystem] Neo4j driver 初始化失败，图 RAG 降级禁用");
      }
    } else {
      console.log("[RAGSystem] 未配置 Neo4j 环境变量，图 RAG 已禁用，使用纯传统检索");
    }

    initialized = true;
    console.log("[RAGSystem] 系统初始化完成");
  }

  /**
   * 构建知识库
   * 对应原 Python build_knowledge_base
   */
  async function buildKnowledgeBase(forceRebuild: boolean = false): Promise<void> {
    if (!initialized || !dataModule || !indexModule) {
      throw new Error("请先调用 initializeSystem()");
    }

    console.log("[RAGSystem] 正在构建知识库...");

    let vectorstore = null;

    // 1. 尝试加载已保存的索引（非强制重建时）
    if (!forceRebuild) {
      vectorstore = await indexModule.loadIndex();
    }

    if (vectorstore) {
      console.log("[RAGSystem] 成功加载已保存的向量索引");
      dataModule.loadDocuments();
      const chunks = dataModule.chunkDocuments();

      // 重建检索器（含双层关键词能力）
      retrievalModule = createRetrievalEngine(vectorstore, chunks, {
        extractKeywords: generationModule?.extractQueryKeywords,
      });
    } else {
      console.log("[RAGSystem] 未找到已保存的索引，开始构建新索引...");

      // 2. 加载文档
      dataModule.loadDocuments();

      // 3. 文本分块
      const chunks = dataModule.chunkDocuments();

      // 4. 构建向量索引
      vectorstore = await indexModule.buildVectorIndex(chunks);

      // 5. 保存索引
      await indexModule.saveIndex(vectorstore);

      // 6. 初始化检索模块
      retrievalModule = createRetrievalEngine(vectorstore, chunks, {
        extractKeywords: generationModule?.extractQueryKeywords,
      });
    }

    // 7. 尝试构建图数据库
    if (graphEnabled) {
      try {
        const graphBuilt = await buildGraphFromMarkdown(config.dataPath);
        if (graphBuilt && graphIndex) {
          await graphIndex.initialize();
          if (graphRetrieval) {
            await graphRetrieval.initialize();
          }
          console.log("[RAGSystem] 图数据构建与索引初始化完成");
        }
      } catch (error) {
        console.warn("[RAGSystem] 图数据构建失败，图 RAG 降级禁用:", error);
        graphEnabled = false;
      }
    }

    // 8. 显示统计信息
    const stats = dataModule.getStatistics();
    console.log("[RAGSystem] 知识库统计:", stats);
    console.log("[RAGSystem] 知识库构建完成");
  }

  /**
   * 回答用户问题（流式）
   * 对应原 Python ask_question
   *
   * @returns 包含来源文档和流式回答生成器的对象
   */
  async function askQuestion(
    question: string,
    history: Array<{ role: string; content: string }> = []
  ): Promise<{
    sources: SourceDoc[];
    routeType: RouteType;
    stream: AsyncGenerator<string>;
  }> {
    if (
      !retrievalModule ||
      !generationModule ||
      !dataModule
    ) {
      throw new Error("请先构建知识库");
    }

    console.log(`[RAGSystem] 用户问题: ${question}`);

    // 1. 查询路由
    const routeType = await generationModule.queryRouter(question);
    console.log(`[RAGSystem] 查询类型: ${routeType}`);

    // 2. 智能查询分析（路由策略选择）
    let strategy: SearchStrategy = "hybrid_traditional";
    let queryAnalysisResult = null;
    if (graphEnabled) {
      try {
        queryAnalysisResult = await generationModule.analyzeQuery(question);
        strategy = queryAnalysisResult.recommendedStrategy;
        console.log(
          `[RAGSystem] 路由策略: ${strategy}, 复杂度: ${queryAnalysisResult.queryComplexity}, 置信度: ${queryAnalysisResult.confidence}`
        );
      } catch (error) {
        console.warn("[RAGSystem] 查询分析失败，降级到传统检索:", error);
        strategy = "hybrid_traditional";
      }
    }

    // 3. 智能查询重写
    let rewrittenQuery = question;
    if (routeType !== "list") {
      console.log("[RAGSystem] 智能分析查询...");
      rewrittenQuery = await generationModule.queryRewrite(question);
    }

    // 4. 根据策略执行检索
    let relevantChunks: ChunkDocument[];

    const filters = extractFiltersFromQuery(question);

    if (strategy === "graph_rag") {
      // 纯图 RAG 检索
      const graphDocs = graphRetrieval
        ? await graphRetrieval.graphRagSearch(rewrittenQuery, config.topK * 2)
        : [];
      if (graphDocs.length > 0) {
        relevantChunks = graphDocs.slice(0, config.topK);
        console.log(`[RAGSystem] 图 RAG 检索: ${relevantChunks.length} 个结果`);
      } else {
        // 图检索无结果，降级到传统检索
        console.log("[RAGSystem] 图 RAG 无结果，降级到传统检索");
        relevantChunks = await doTraditionalSearch(rewrittenQuery, filters, config.topK);
      }
    } else if (strategy === "combined") {
      // 组合检索：传统 + 图 RAG 并行
      const halfK = Math.max(1, Math.ceil(config.topK / 2));
      const [traditionalDocs, graphDocs] = await Promise.all([
        doTraditionalSearch(rewrittenQuery, filters, halfK),
        graphRetrieval ? graphRetrieval.graphRagSearch(rewrittenQuery, halfK) : Promise.resolve([]),
      ]);

      // Round-robin 交替合并去重
      const seenIds = new Set<string>();
      const combined: ChunkDocument[] = [];
      const maxLen = Math.max(traditionalDocs.length, graphDocs.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < traditionalDocs.length) {
          const dedupKey = traditionalDocs[i].metadata.parent_id || md5(traditionalDocs[i].pageContent);
          if (!seenIds.has(dedupKey)) {
            seenIds.add(dedupKey);
            combined.push(traditionalDocs[i]);
          }
        }
        if (i < graphDocs.length) {
          const dedupKey = graphDocs[i].metadata.parent_id || md5(graphDocs[i].pageContent);
          if (!seenIds.has(dedupKey)) {
            seenIds.add(dedupKey);
            combined.push(graphDocs[i]);
          }
        }
      }
      relevantChunks = combined.slice(0, config.topK);
      console.log(`[RAGSystem] 组合检索: 传统 ${traditionalDocs.length} + 图 ${graphDocs.length} → ${relevantChunks.length} 个结果`);
    } else {
      // 默认：传统混合检索
      relevantChunks = await doTraditionalSearch(rewrittenQuery, filters, config.topK);
    }

    console.log(`[RAGSystem] 找到 ${relevantChunks.length} 个相关文档块`);

    // 5. 检查是否找到相关内容
    if (relevantChunks.length === 0) {
      return {
        sources: [],
        routeType,
        stream: (async function* () {
          yield "抱歉，没有找到相关的食谱信息。请尝试其他菜品名称或关键词。";
        })(),
      };
    }

    // 6. 可配置父文档回填
    let relevantDocs: ChunkDocument[];
    if (config.enableParentDocRetrieval) {
      const topN = Math.min(config.parentDocTopN, relevantChunks.length);
      const topChunks = relevantChunks.slice(0, topN);
      const parentDocs = dataModule.getParentDocuments(topChunks, config.parentDocMaxChars);

      // 前 N 名用完整父文档替换 chunk，其余保持原样
      relevantDocs = [
        ...parentDocs,
        ...relevantChunks.slice(topN),
      ].slice(0, config.topK);
      console.log(`[RAGSystem] 父文档回填: 前 ${topN} 名替换为完整父文档`);
    } else {
      relevantDocs = dataModule.getParentDocuments(relevantChunks);
    }

    // 7. 构建来源文档信息
    const sources: SourceDoc[] = relevantChunks.map((chunk) => ({
      dish_name: chunk.metadata.dish_name || "未知菜品",
      category: chunk.metadata.category || "未知",
      difficulty: chunk.metadata.difficulty || "未知",
      rrf_score: chunk.metadata.rrf_score || 0,
      source: chunk.metadata.source || "",
    }));

    // 去重来源（按菜品名）
    const uniqueSources = sources.filter(
      (s, i, arr) => arr.findIndex((x) => x.dish_name === s.dish_name) === i
    );

    // 8. 根据路由类型选择回答方式
    let stream: AsyncGenerator<string>;

    if (routeType === "list") {
      const result = generationModule.generateListAnswer(question, relevantDocs);
      stream = (async function* () {
        yield result.content;
      })();
    } else if (routeType === "detail") {
      stream = generationModule.generateStepByStepAnswerStream(
        question,
        relevantDocs,
        history
      );
    } else {
      stream = generationModule.generateBasicAnswerStream(
        question,
        relevantDocs,
        history
      );
    }

    return { sources: uniqueSources, routeType, stream };
  }

  /**
   * 传统混合检索（带双层关键词增强）
   */
  async function doTraditionalSearch(
    query: string,
    filters: Record<string, string>,
    topK: number
  ): Promise<ChunkDocument[]> {
    if (!retrievalModule) return [];

    if (Object.keys(filters).length > 0) {
      console.log("[RAGSystem] 应用过滤条件:", filters);
      return retrievalModule.metadataFilteredSearch(query, filters, topK);
    }
    // 使用增强检索（双层关键词 + 向量 + BM25）
    return retrievalModule.enhancedSearch(query, topK);
  }

  /**
   * 从用户问题中提取元数据过滤条件
   * 对应原 Python _extract_filters_from_query
   */
  function extractFiltersFromQuery(query: string): Record<string, string> {
    const filters: Record<string, string> = {};

    const categoryKeywords = getSupportedCategories();
    for (const cat of categoryKeywords) {
      if (query.includes(cat)) {
        filters.category = cat;
        break;
      }
    }

    const difficultyKeywords = getSupportedDifficulties().sort((a, b) => b.length - a.length);
    for (const diff of difficultyKeywords) {
      if (query.includes(diff)) {
        filters.difficulty = diff;
        break;
      }
    }

    return filters;
  }

  /**
   * 获取知识库统计信息
   */
  function getStats() {
    if (!dataModule) {
      return null;
    }
    return dataModule.getStatistics();
  }

  /**
   * 检查知识库是否已就绪
   */
  function isReady(): boolean {
    return (
      initialized &&
      retrievalModule !== null &&
      generationModule !== null
    );
  }

  return {
    initializeSystem,
    buildKnowledgeBase,
    askQuestion,
    getStats,
    isReady,
  };
}

