import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { RunnablePassthrough } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import type { ChunkDocument, RouteType, ChatMessage } from "./types";

/**
 * 生成集成模块（对应原 Python generation_integration.py）
 * 负责：LLM 集成、查询路由/重写、基础/分步/列表回答、流式输出
 */
export class GenerationIntegrationModule {
  private llm: ChatOpenAI;

  constructor(
    modelName: string,
    temperature: number,
    maxTokens: number,
    apiKey: string,
    baseURL: string
  ) {
    this.llm = new ChatOpenAI({
      model: modelName,
      temperature,
      maxTokens,
      apiKey,
      configuration: { baseURL },
      streaming: true,
    });
    console.log(`[Generation] LLM 初始化完成: ${modelName}`);
  }

  /**
   * 查询路由 - 根据查询类型选择不同的处理方式
   * 返回: 'list' | 'detail' | 'general'
   */
  async queryRouter(query: string): Promise<RouteType> {
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

    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
    const result = (await chain.invoke({ query })).trim().toLowerCase();

    if (result.includes("list")) return "list";
    if (result.includes("detail")) return "detail";
    return "general";
  }

  /**
   * 智能查询重写 - 让大模型判断是否需要重写查询
   */
  async queryRewrite(query: string): Promise<string> {
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

    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());
    const response = (await chain.invoke({ query })).trim();

    if (response !== query) {
      console.log(`[Generation] 查询已重写: '${query}' → '${response}'`);
    }

    return response;
  }

  /**
   * 生成列表式回答 - 适用于推荐类查询
   */
  generateListAnswer(
    query: string,
    contextDocs: ChunkDocument[]
  ): { content: string; isList: true } {
    if (contextDocs.length === 0) {
      return { content: "抱歉，没有找到相关的菜品信息。", isList: true };
    }

    // 提取菜品名称（去重）
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
   * 生成基础回答 - 流式输出
   * 对应原 Python generate_basic_answer_stream
   */
  async *generateBasicAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history: Array<{ role: string; content: string }> = []
  ): AsyncGenerator<string> {
    const context = this.buildContext(contextDocs);
    const historyText = this.buildHistory(history);

    const prompt = ChatPromptTemplate.fromTemplate(`你是一位专业的烹饪助手。请根据以下食谱信息回答用户的问题。

${historyText}

用户问题: {question}

相关食谱信息:
{context}

请提供详细、实用的回答。如果信息不足，请诚实说明。

回答:`);

    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());

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
  async *generateStepByStepAnswerStream(
    query: string,
    contextDocs: ChunkDocument[],
    history: Array<{ role: string; content: string }> = []
  ): AsyncGenerator<string> {
    const context = this.buildContext(contextDocs);
    const historyText = this.buildHistory(history);

    const prompt = ChatPromptTemplate.fromTemplate(`你是一位专业的烹饪导师。请根据食谱信息，为用户提供详细的分步骤指导。

${historyText}

用户问题: {question}

相关食谱信息:
{context}

请灵活组织回答，建议包含以下部分（可根据实际内容调整）：

## 🥘 菜品介绍
[简要介绍菜品特点和难度]

## 🛒 所需食材
[列出主要食材和用量]

## 👨‍🍳 制作步骤
[详细的分步骤说明，每步包含具体操作和大概所需时间]

## 💡 制作技巧
[仅在有实用技巧时包含。优先使用原文中的实用技巧，如果原文的"附加内容"与烹饪无关或为空，可以基于制作步骤总结关键要点，或者完全省略此部分]

注意：
- 根据实际内容灵活调整结构
- 不要强行填充无关内容或重复制作步骤中的信息
- 重点突出实用性和可操作性
- 如果没有额外的技巧要分享，可以省略制作技巧部分

回答:`);

    const chain = prompt.pipe(this.llm).pipe(new StringOutputParser());

    const stream = await chain.stream({
      question: query,
      context,
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }

  /**
   * 构建上下文字符串
   * 对应原 Python _build_context
   */
  private buildContext(docs: ChunkDocument[], maxLength: number = 2000): string {
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
    return divider + contextParts.join(divider);
  }

  /**
   * 构建对话历史文本
   */
  private buildHistory(
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
}
