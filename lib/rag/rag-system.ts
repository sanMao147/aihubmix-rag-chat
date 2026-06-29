import type { RAGConfig } from "./config";
import type {
  ChunkDocument,
  SourceDoc,
  RouteType,
  ChatMessage,
} from "./types";
import { DataPreparationModule } from "./data-preparation";
import { IndexConstructionModule } from "./index-construction";
import { RetrievalOptimizationModule } from "./retrieval";
import { GenerationIntegrationModule } from "./generation";

/**
 * RAG 系统主类（对应原 Python main.py RecipeRAGSystem）
 * 串联：数据准备 → 索引构建 → 检索优化 → 生成集成
 */
export class RecipeRAGSystem {
  private config: RAGConfig;
  private dataModule: DataPreparationModule | null = null;
  private indexModule: IndexConstructionModule | null = null;
  private retrievalModule: RetrievalOptimizationModule | null = null;
  private generationModule: GenerationIntegrationModule | null = null;
  private initialized = false;

  constructor(config: RAGConfig) {
    this.config = config;
  }

  /**
   * 初始化所有模块
   */
  initializeSystem(): void {
    console.log("[RAGSystem] 正在初始化 RAG 系统...");

    this.dataModule = new DataPreparationModule(this.config.dataPath);

    this.indexModule = new IndexConstructionModule(
      this.config.embeddingModel,
      this.config.indexSavePath,
      this.config.apiKey,
      this.config.baseURL
    );

    this.generationModule = new GenerationIntegrationModule(
      this.config.llmModel,
      this.config.temperature,
      this.config.maxTokens,
      this.config.apiKey,
      this.config.baseURL
    );

    this.initialized = true;
    console.log("[RAGSystem] 系统初始化完成");
  }

  /**
   * 构建知识库
   * 对应原 Python build_knowledge_base
   */
  async buildKnowledgeBase(forceRebuild: boolean = false): Promise<void> {
    if (!this.initialized || !this.dataModule || !this.indexModule) {
      throw new Error("请先调用 initializeSystem()");
    }

    console.log("[RAGSystem] 正在构建知识库...");

    let vectorstore = null;

    // 1. 尝试加载已保存的索引（非强制重建时）
    if (!forceRebuild) {
      vectorstore = await this.indexModule.loadIndex();
    }

    if (vectorstore) {
      console.log("[RAGSystem] 成功加载已保存的向量索引");
      // 仍需加载文档和分块用于检索模块
      this.dataModule.loadDocuments();
      const chunks = this.dataModule.chunkDocuments();

      // 重建检索器
      this.retrievalModule = new RetrievalOptimizationModule(
        vectorstore,
        chunks
      );
    } else {
      console.log("[RAGSystem] 未找到已保存的索引，开始构建新索引...");

      // 2. 加载文档
      this.dataModule.loadDocuments();

      // 3. 文本分块
      const chunks = this.dataModule.chunkDocuments();

      // 4. 构建向量索引
      vectorstore = await this.indexModule.buildVectorIndex(chunks);

      // 5. 保存索引
      await this.indexModule.saveIndex();

      // 6. 初始化检索模块
      this.retrievalModule = new RetrievalOptimizationModule(
        vectorstore,
        chunks
      );
    }

    // 7. 显示统计信息
    const stats = this.dataModule.getStatistics();
    console.log("[RAGSystem] 知识库统计:", stats);
    console.log("[RAGSystem] 知识库构建完成");
  }

  /**
   * 回答用户问题（流式）
   * 对应原 Python ask_question
   *
   * @returns 包含来源文档和流式回答生成器的对象
   */
  async askQuestion(
    question: string,
    history: Array<{ role: string; content: string }> = []
  ): Promise<{
    sources: SourceDoc[];
    routeType: RouteType;
    stream: AsyncGenerator<string>;
  }> {
    if (
      !this.retrievalModule ||
      !this.generationModule ||
      !this.dataModule
    ) {
      throw new Error("请先构建知识库");
    }

    console.log(`[RAGSystem] 用户问题: ${question}`);

    // 1. 查询路由
    const routeType = await this.generationModule.queryRouter(question);
    console.log(`[RAGSystem] 查询类型: ${routeType}`);

    // 2. 智能查询重写（根据路由类型）
    let rewrittenQuery = question;
    if (routeType !== "list") {
      console.log("[RAGSystem] 智能分析查询...");
      rewrittenQuery = await this.generationModule.queryRewrite(question);
    }

    // 3. 检索相关子块（自动应用元数据过滤）
    const filters = this.extractFiltersFromQuery(question);
    let relevantChunks: ChunkDocument[];

    if (Object.keys(filters).length > 0) {
      console.log("[RAGSystem] 应用过滤条件:", filters);
      relevantChunks = await this.retrievalModule.metadataFilteredSearch(
        rewrittenQuery,
        filters,
        this.config.topK
      );
    } else {
      relevantChunks = await this.retrievalModule.hybridSearch(
        rewrittenQuery,
        this.config.topK
      );
    }

    console.log(
      `[RAGSystem] 找到 ${relevantChunks.length} 个相关文档块`
    );

    // 4. 检查是否找到相关内容
    if (relevantChunks.length === 0) {
      return {
        sources: [],
        routeType,
        stream: (async function* () {
          yield "抱歉，没有找到相关的食谱信息。请尝试其他菜品名称或关键词。";
        })(),
      };
    }

    // 5. 获取父文档
    const relevantDocs = this.dataModule.getParentDocuments(relevantChunks);

    // 6. 构建来源文档信息
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

    // 7. 根据路由类型选择回答方式
    let stream: AsyncGenerator<string>;

    if (routeType === "list") {
      // 列表查询：直接返回菜品名称列表
      const result = this.generationModule.generateListAnswer(
        question,
        relevantDocs
      );
      stream = (async function* () {
        yield result.content;
      })();
    } else if (routeType === "detail") {
      // 详细查询：分步指导模式
      stream = this.generationModule.generateStepByStepAnswerStream(
        question,
        relevantDocs,
        history
      );
    } else {
      // 一般查询：基础回答模式
      stream = this.generationModule.generateBasicAnswerStream(
        question,
        relevantDocs,
        history
      );
    }

    return { sources: uniqueSources, routeType, stream };
  }

  /**
   * 从用户问题中提取元数据过滤条件
   * 对应原 Python _extract_filters_from_query
   */
  private extractFiltersFromQuery(query: string): Record<string, string> {
    const filters: Record<string, string> = {};

    // 分类关键词
    const categoryKeywords = DataPreparationModule.getSupportedCategories();
    for (const cat of categoryKeywords) {
      if (query.includes(cat)) {
        filters.category = cat;
        break;
      }
    }

    // 难度关键词（按长度降序匹配，避免"简单"匹配到"非常简单"）
    const difficultyKeywords = DataPreparationModule
      .getSupportedDifficulties()
      .sort((a, b) => b.length - a.length);
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
  getStats() {
    if (!this.dataModule) {
      return null;
    }
    return this.dataModule.getStatistics();
  }

  /**
   * 检查知识库是否已就绪
   */
  isReady(): boolean {
    return (
      this.initialized &&
      this.retrievalModule !== null &&
      this.generationModule !== null
    );
  }
}
