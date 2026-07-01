import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import type { ChunkDocument, RouteType, LLMEngineApi, QueryAnalysis, SearchStrategy, QueryKeywords } from "./types";

/**
 * 生成集成模块（对应原 Python generation_integration.py）
 * 负责：LLM 集成、查询路由/重写/分析、基础/分步/列表回答、流式输出、重试降级
 *
 * 已重构为工厂函数 + 闭包，不再使用 class/this。
 */
export function createLLMEngine(
  modelName: string,
  temperature: number,
  maxTokens: number,
  apiKey: string,
  baseURL: string
): LLMEngineApi {
  // 统一使用流式 ChatOpenAI 实例，列表回答与查询分析除外，其他回答都可边生成边返回。
  const llm = new ChatOpenAI({
    model: modelName,
    temperature,
    maxTokens,
    apiKey,
    configuration: { baseURL },
    streaming: true,
  });

  // 非流式 LLM，用于查询分析、关键词提取等需要稳定 JSON 的场景
  const llmNonStreaming = new ChatOpenAI({
    model: modelName,
    temperature: 0.1,
    maxTokens: 1024,
    apiKey,
    configuration: { baseURL },
    streaming: false,
  });

  console.log(`[Generation] LLM 初始化完成: ${modelName}`);

  // 路由统计
  const routeStats = {
    traditionalCount: 0,
    graphRagCount: 0,
    combinedCount: 0,
    totalQueries: 0,
  };

  /**
   * 查询路由 - 根据查询类型选择不同的处理方式（保留旧接口）
   * 返回: 'list' | 'detail' | 'general'
   */
  async function queryRouter(query: string): Promise<RouteType> {
    const prompt = ChatPromptTemplate.fromTemplate(`根据用户的问题，将其分类为以下三种类型之一：

1. 'list' - 用户想要获取菜品列表或推荐，只需要菜名
   例如：推荐几个素菜、有什么川菜、给我3个简单的菜

2. 'detail' - 用户想要具体的制作方法或详细信息
   例如：宫保鸡丁怎么做、制作步骤、需要什么食材

3. 'general' - 其他一般性问题
   例如：什么是川菜、制作技巧、营养价值

请只返回分类结果：list、detail 或 general

用户问题: {query}

分类结果:`);

    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const result = (await chain.invoke({ query })).trim().toLowerCase();

    // 模型输出可能包含解释文字，因此用 includes 做宽松归类兜底。
    if (result.includes("list")) return "list";
    if (result.includes("detail")) return "detail";
    return "general";
  }

  /**
   * 智能查询路由分析 - 判断应使用传统检索、图 RAG 还是组合策略
   */
  async function analyzeQuery(query: string): Promise<QueryAnalysis> {
    const prompt = ChatPromptTemplate.fromTemplate(`你是一位查询分析专家。请分析用户的问题，判断应该使用哪种检索策略。

可选策略：
- "hybrid_traditional": 适合简单、直接的食谱查询，如"可乐鸡翅怎么做"、"推荐素菜"
- "graph_rag": 适合涉及多实体关系、复杂推理、食材关联、多步骤因果的问题，如"含有可乐和鸡翅的菜品还有什么共同食材"、"地三鲜的制作流程涉及哪些食材"
- "combined": 适合既有明确实体又有关系探索需求的问题，如"哪些荤菜用到了土豆和牛肉"

请返回严格的 JSON 格式：
{{
  "queryComplexity": 0.0-1.0,
  "relationshipIntensity": 0.0-1.0,
  "reasoningRequired": true/false,
  "entityCount": 整数,
  "recommendedStrategy": "hybrid_traditional" | "graph_rag" | "combined",
  "confidence": 0.0-1.0,
  "reasoning": "简短分析"
}}

用户问题: {query}

JSON:`);

    try {
      const chain = prompt.pipe(llmNonStreaming).pipe(new StringOutputParser());
      const result = (await chain.invoke({ query })).trim();
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result) as QueryAnalysis;
      const validated = validateQueryAnalysis(parsed);
      updateRouteStats(validated.recommendedStrategy);
      return validated;
    } catch (error) {
      console.warn("[Generation] LLM 查询分析失败，降级到规则分析:", error);
      return ruleBasedAnalyzeQuery(query);
    }
  }

  function validateQueryAnalysis(analysis: QueryAnalysis): QueryAnalysis {
    const validStrategies: SearchStrategy[] = ["hybrid_traditional", "graph_rag", "combined"];
    const strategy = validStrategies.includes(analysis.recommendedStrategy)
      ? analysis.recommendedStrategy
      : "hybrid_traditional";

    return {
      queryComplexity: Math.min(Math.max(analysis.queryComplexity || 0, 0), 1),
      relationshipIntensity: Math.min(Math.max(analysis.relationshipIntensity || 0, 0), 1),
      reasoningRequired: Boolean(analysis.reasoningRequired),
      entityCount: Math.max(analysis.entityCount || 0, 0),
      recommendedStrategy: strategy,
      confidence: Math.min(Math.max(analysis.confidence || 0, 0), 1),
      reasoning: analysis.reasoning || "",
    };
  }

  function ruleBasedAnalyzeQuery(query: string): QueryAnalysis {
    const lower = query.toLowerCase();
    const entityMatches = (lower.match(/[\u4e00-\u9fa5]{2,}/g) || []).filter(
      (w) => !["怎么", "做法", "步骤", "食材", "推荐", "介绍", "查询", "什么", "哪些", "如何", "怎样"].includes(w)
    );

    const hasRelationshipWords =
      lower.includes("共同") ||
      lower.includes("一起") ||
      lower.includes("关系") ||
      lower.includes("关联") ||
      lower.includes("含有");
    const hasReasoningWords =
      lower.includes("为什么") ||
      lower.includes("如何") ||
      lower.includes("怎样") ||
      lower.includes("流程") ||
      lower.includes("路径");

    const entityCount = entityMatches.length;
    let strategy: SearchStrategy = "hybrid_traditional";
    let complexity = 0.3;
    let relationshipIntensity = 0.2;

    if (hasRelationshipWords || entityCount >= 2) {
      strategy = hasReasoningWords ? "combined" : "graph_rag";
      complexity = 0.7;
      relationshipIntensity = 0.7;
    }
    if (hasReasoningWords && entityCount >= 2) {
      strategy = "combined";
      complexity = 0.9;
      relationshipIntensity = 0.8;
    }

    updateRouteStats(strategy);

    return {
      queryComplexity: complexity,
      relationshipIntensity,
      reasoningRequired: hasReasoningWords,
      entityCount,
      recommendedStrategy: strategy,
      confidence: 0.6,
      reasoning: "基于规则分析：" + (hasRelationshipWords ? "问题包含关系探索词" : "问题较直接"),
    };
  }

  function updateRouteStats(strategy: SearchStrategy): void {
    routeStats.totalQueries += 1;
    if (strategy === "hybrid_traditional") routeStats.traditionalCount += 1;
    else if (strategy === "graph_rag") routeStats.graphRagCount += 1;
    else if (strategy === "combined") routeStats.combinedCount += 1;

    console.log(
      `[Generation] 路由统计: total=${routeStats.totalQueries}, traditional=${routeStats.traditionalCount}, graph_rag=${routeStats.graphRagCount}, combined=${routeStats.combinedCount}`
    );
  }

  /**
   * 双层关键词提取：实体级 + 主题级
   */
  async function extractQueryKeywords(query: string): Promise<QueryKeywords> {
    const prompt = ChatPromptTemplate.fromTemplate(`从用户的食谱问题中提取两类关键词，用于 BM25 检索增强。

- entityKeywords: 实体级关键词，如菜名、食材名、工具名、分类名等具体名词
- topicKeywords: 主题级关键词，如烹饪方法、口味、场景、技巧等抽象概念

请返回严格 JSON 格式：
{{
  "entityKeywords": ["关键词1", "关键词2"],
  "topicKeywords": ["主题1", "主题2"]
}}

注意：只返回关键词，不要解释。

用户问题: {query}

JSON:`);

    try {
      const chain = prompt.pipe(llmNonStreaming).pipe(new StringOutputParser());
      const result = (await chain.invoke({ query })).trim();
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : result) as QueryKeywords;
      return {
        entityKeywords: Array.isArray(parsed.entityKeywords) ? parsed.entityKeywords : [],
        topicKeywords: Array.isArray(parsed.topicKeywords) ? parsed.topicKeywords : [],
      };
    } catch (error) {
      console.warn("[Generation] 关键词提取失败，降级到规则提取:", error);
      return ruleBasedExtractKeywords(query);
    }
  }

  function ruleBasedExtractKeywords(query: string): QueryKeywords {
    const lower = query.toLowerCase();
    // 提取中文连续名词/短语作为实体候选
    const matches = lower.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    const entityKeywords = matches.filter(
      (w) =>
        !["怎么", "做法", "步骤", "食材", "推荐", "介绍", "查询", "什么", "哪些", "如何", "怎样", "的", "了", "和", "是"].includes(w)
    );
    const topicKeywords = matches.filter((w) => ["做法", "步骤", "技巧", "口味", "营养", "简单", "困难", "家常", "快手"].includes(w));

    return {
      entityKeywords: [...new Set(entityKeywords)].slice(0, 5),
      topicKeywords: [...new Set(topicKeywords)].slice(0, 3),
    };
  }

  /**
   * 智能查询重写 - 让大模型判断是否需要重写查询
   */
  async function queryRewrite(query: string): Promise<string> {
    const prompt = PromptTemplate.fromTemplate(`你是一个智能查询分析助手。请分析用户的查询，判断是否需要重写以提高食谱搜索效果。

原始查询: {query}

分析规则：
1. **具体明确的查询**（直接返回原查询）：
   - 包含具体菜品名称：如"宫保鸡丁怎么做"、"红烧肉的制作方法"
   - 明确的制作询问：如"蛋炒饭需要什么食材"、"糖醋排骨的步骤"
   - 具体的烹饪技巧：如"如何炒菜不粘锅"、"怎样调制糖醋汁"

2. **模糊不清的查询**（需要重写）：
   - 过于宽泛：如"做菜"、"有什么好吃的"、"推荐个菜"
   - 缺乏具体信息：如"川菜"、"素菜"、"简单的"
   - 口语化表达：如"想吃点什么"、"有饮品推荐吗"

重写原则：
- 保持原意不变
- 增加相关烹饪术语
- 优先推荐简单易做的
- 保持简洁性

示例：
- "做菜" → "简单易做的家常菜谱"
- "有饮品推荐吗" → "简单饮品制作方法"
- "推荐个菜" → "简单家常菜推荐"
- "川菜" → "经典川菜菜谱"
- "宫保鸡丁怎么做" → "宫保鸡丁怎么做"（保持原查询）
- "红烧肉需要什么食材" → "红烧肉需要什么食材"（保持原查询）

请输出最终查询（如果不需要重写就返回原查询）:`);

    const chain = prompt.pipe(llm).pipe(new StringOutputParser());
    const response = (await chain.invoke({ query })).trim();

    if (response !== query) {
      console.log(`[Generation] 查询已重写: '${query}' → '${response}'`);
    }

    return response;
  }

  /**
   * 生成列表式回答 - 适用于推荐类查询
   */
  function generateListAnswer(
    query: string,
    contextDocs: ChunkDocument[]
  ): { content: string; isList: true } {
    if (contextDocs.length === 0) {
      return { content: "抱歉，没有找到相关的菜品信息。", isList: true };
    }

    // 提取菜品名称（去重）
    // 列表型问题不需要调用 LLM 生成长答案，直接返回命中的菜名更稳定。
    const dishNames: string[] = [];
    for (const doc of contextDocs) {
      const name = doc.metadata.dish_name || "未知菜品";
      if (!dishNames.includes(name)) {
        dishNames.push(name);
      }
    }

    let content: string;
    if (dishNames.length === 1) {
      content = `为您推荐：${dishNames[0]}`;
    } else if (dishNames.length <= 3) {
      content =
        `为您推荐以下菜品：\n` +
        dishNames.map((name, i) => `${i + 1}. ${name}`).join("\n");
    } else {
      content =
        `为您推荐以下菜品：\n` +
        dishNames
          .slice(0, 3)
          .map((name, i) => `${i + 1}. ${name}`)
          .join("\n") +
        `\n\n还有其他 ${dishNames.length - 3} 道菜品可供选择。`;
    }

    return { content, isList: true };
  }

  /**
   * 流式生成重试包装器
   * maxRetries=3, 指数退避 2s/4s/6s，全部失败降级为非流式
   */
  function withRetry<T extends (...args: any[]) => AsyncGenerator<string>>(
    generatorFn: T,
    maxRetries: number = 3
  ): T {
    return (async function* (...args: Parameters<T>): AsyncGenerator<string> {
      let lastError: unknown;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const stream = generatorFn(...args);
          for await (const chunk of stream) {
            yield chunk;
          }
          return;
        } catch (error) {
          lastError = error;
          const delay = 2000 * (attempt + 1);
          console.warn(`[Generation] 流式生成失败，第 ${attempt + 1} 次重试，等待 ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      console.error("[Generation] 流式生成多次重试失败，降级为非流式:", lastError);
      yield "抱歉，生成过程中出现网络波动，请稍后再试。";
    }) as T;
  }

  /**
   * 生成基础回答 - 流式输出
   * 对应原 Python generate_basic_answer_stream
   */
  async function* generateBasicAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history: Array<{ role: string; content: string }> = []
  ): AsyncGenerator<string> {
    const context = buildContext(contextDocs);
    const historyText = buildHistory(history);

    const prompt = ChatPromptTemplate.fromTemplate(`你是一位专业的烹饪助手。请根据以下食谱信息回答用户的问题。

${historyText}

用户问题: {question}

相关食谱信息:
{context}

请提供详细、实用的回答。如果信息不足，请诚实说明。

回答:`);

    const chain = prompt.pipe(llm).pipe(new StringOutputParser());

    const stream = await chain.stream({
      question: query,
      context,
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  /**
   * 生成分步骤回答 - 流式输出
   * 对应原 Python generate_step_by_step_answer_stream
   */
  async function* generateStepByStepAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history: Array<{ role: string; content: string }> = []
  ): AsyncGenerator<string> {
    const context = buildContext(contextDocs);
    const historyText = buildHistory(history);

    const prompt = ChatPromptTemplate.fromTemplate(`你是一位专业的烹饪导师。请根据食谱信息，为用户提供详细的分步骤指导。

${historyText}

用户问题: {question}

相关食谱信息:
{context}

请灵活组织回答，建议包含以下部分（可根据实际内容调整）：

## 菜品介绍
[简要介绍菜品特点和难度]

## 所需食材
[列出主要食材和用量]

## 制作步骤
[详细的分步骤说明，每步包含具体操作和大概所需时间]

## 制作技巧
[仅在有实用技巧时包含。优先使用原文中的实用技巧，如果原文的"附加内容"与烹饪无关或为空，可以基于制作步骤总结关键要点，或者完全省略此部分]

注意：
- 根据实际内容灵活调整结构
- 不要强行填充无关内容或重复制作步骤中的信息
- 重点突出实用性和可操作性
- 如果没有额外的技巧要分享，可以省略制作技巧部分

回答:`);

    const chain = prompt.pipe(llm).pipe(new StringOutputParser());

    const stream = await chain.stream({
      question: query,
      context,
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  // 使用重试包装流式生成函数
  const generateBasicAnswerStreamWithRetry = withRetry(generateBasicAnswerStream);
  const generateStepByStepAnswerStreamWithRetry = withRetry(generateStepByStepAnswerStream);

  /**
   * 构建上下文字符串，并标注检索来源层级
   * 对应原 Python _build_context
   */
  function buildContext(docs: ChunkDocument[], maxLength: number = 2000): string {
    if (docs.length === 0) {
      return "暂无相关食谱信息。";
    }

    // 控制上下文长度，避免 prompt 过长影响响应速度和模型稳定性。
    const contextParts: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const searchMethod = doc.metadata.search_method || "hybrid";
      const retrievalLevel = doc.metadata.retrieval_level || "chunk";
      const levelTag = `[${searchMethod.toUpperCase()}-${retrievalLevel.toUpperCase()}]`;

      let metadataInfo = `【食谱 ${i + 1}】${levelTag}`;
      if (doc.metadata.dish_name) {
        metadataInfo += ` ${doc.metadata.dish_name}`;
      }
      if (doc.metadata.category) {
        metadataInfo += ` | 分类: ${doc.metadata.category}`;
      }
      if (doc.metadata.difficulty) {
        metadataInfo += ` | 难度: ${doc.metadata.difficulty}`;
      }

      const docText = `${metadataInfo}\n${doc.pageContent}\n`;

      if (currentLength + docText.length > maxLength) {
        break;
      }

      contextParts.push(docText);
      currentLength += docText.length;
    }

    const divider = "\n" + "=".repeat(50) + "\n";
    return divider + contextParts.join(divider);
  }

  /**
   * 构建对话历史文本
   */
  function buildHistory(
    history: Array<{ role: string; content: string }>
  ): string {
    if (history.length === 0) {
      return "";
    }

    // 历史消息只转成简洁文本，具体保留轮数由调用方控制。
    const lines = history.map((msg) => {
      const role = msg.role === "user" ? "用户" : "助手";
      return `${role}: ${msg.content}`;
    });

    return `对话历史:\n${lines.join("\n")}\n`;
  }

  return {
    queryRouter,
    queryRewrite,
    analyzeQuery,
    extractQueryKeywords,
    generateListAnswer,
    generateBasicAnswerStream: generateBasicAnswerStreamWithRetry,
    generateStepByStepAnswerStream: generateStepByStepAnswerStreamWithRetry,
  };
}

