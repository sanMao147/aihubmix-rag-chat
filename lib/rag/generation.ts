import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import type { ChunkDocument, LLMEngineApi, RouteType } from "./types";
import { createLogger } from "../utils";

const log = createLogger("Generation");

/**
 * 生成集成模块（对应原 Python generation_integration.py）。
 *
 * 它负责所有“需要大模型理解或生成”的步骤：
 * - queryRouter：判断用户是要列表、详细做法还是一般问答。
 * - queryRewrite：把模糊问题改写成更适合检索的查询。
 * - generateListAnswer：推荐类问题直接拼列表，不额外调用 LLM。
 * - generate*Stream：把检索上下文和历史对话交给 LLM，流式生成回答。
 */
export function createLLMEngine(
  modelName: string,
  temperature: number,
  maxTokens: number,
  apiKey: string,
  baseURL: string
): LLMEngineApi {
  const llm = new ChatOpenAI({
    model: modelName,
    temperature,
    maxTokens,
    apiKey,
    configuration: { baseURL },
    streaming: true,
  });
  log.info(`LLM 初始化完成: ${modelName}`);

  /**
   * 查询路由。
   *
   * 路由结果决定后续生成策略：
   * - list：用户要推荐或列表，直接输出菜名列表。
   * - detail：用户要做法、步骤、食材，走分步指导 Prompt。
   * - general：其他问题，走普通问答 Prompt。
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

    if (result.includes("list")) return "list";
    if (result.includes("detail")) return "detail";
    return "general";
  }

  /**
   * 智能查询重写。
   *
   * RAG 检索依赖 query 与知识库文本的语义匹配。过短或过口语的问题可能召回不稳，
   * 所以这里让 LLM 在保留原意的前提下补充“家常菜谱、制作方法”等检索友好词。
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
      log.info(`查询已重写: '${query}' → '${response}'`);
    }

    return response;
  }

  /**
   * 生成列表式回答。
   *
   * 推荐类问题不需要 LLM 再生成长文本，直接从检索到的父文档中提取菜名即可。
   * 这样速度更快，也能减少模型自由发挥。
   */
  function generateListAnswer(
    _query: string,
    contextDocs: ChunkDocument[]
  ): { content: string; isList: true } {
    if (contextDocs.length === 0) {
      return { content: "抱歉，没有找到相关的菜品信息。", isList: true };
    }

    const dishNames: string[] = [];
    for (const doc of contextDocs) {
      const name = doc.metadata.dish_name || "未知菜品";
      if (!dishNames.includes(name)) {
        dishNames.push(name);
      }
    }

    if (dishNames.length === 1) {
      return { content: `为您推荐：${dishNames[0]}`, isList: true };
    }

    const visibleNames = dishNames.slice(0, 3);
    const content =
      `为您推荐以下菜品：\n` +
      visibleNames.map((name, i) => `${i + 1}. ${name}`).join("\n") +
      (dishNames.length > 3
        ? `\n\n还有其他 ${dishNames.length - 3} 道菜品可供选择。`
        : "");

    return { content, isList: true };
  }

  /** 基础回答：适合技巧、概念、食材等一般问题。 */
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
    const stream = await chain.stream({ question: query, context });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  /** 分步骤回答：适合“怎么做、步骤、需要什么食材”这类详细制作问题。 */
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
    const stream = await chain.stream({ question: query, context });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  /**
   * 构建 LLM 上下文字符串。
   *
   * 把多个候选父文档合并为一段带元数据的文本，并用 maxLength 控制长度，
   * 防止把过多菜谱塞进 Prompt 导致 token 超限。
   */
  function buildContext(
    docs: ChunkDocument[],
    maxLength: number = 4000
  ): string {
    if (docs.length === 0) {
      return "暂无相关食谱信息。";
    }

    const contextParts: string[] = [];
    let currentLength = 0;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      let metadataInfo = `【食谱 ${i + 1}】`;

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
    return contextParts.join(divider);
  }

  /**
   * 构建多轮对话历史。
   *
   * route handler 会传入最近若干轮消息；这里转换成 Prompt 中更自然的中文角色标签。
   */
  function buildHistory(
    history: Array<{ role: string; content: string }>
  ): string {
    if (history.length === 0) {
      return "";
    }

    const lines = history.map((msg) => {
      const role = msg.role === "user" ? "用户" : "助手";
      return `${role}: ${msg.content}`;
    });

    return `对话历史:\n${lines.join("\n")}\n`;
  }

  return {
    queryRouter,
    queryRewrite,
    generateListAnswer,
    generateBasicAnswerStream,
    generateStepByStepAnswerStream,
  };
}
