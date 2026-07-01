import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import type { Document } from "@langchain/core/documents";
import { executeQuery } from "./neo4j-connection";
import type { GraphNode, GraphRelation } from "./graph-indexing";
import type { GraphIndexApi } from "./graph-indexing";
import type { ChunkDocument, ChunkMetadata } from "./types";

/**
 * 图 RAG 检索模块
 * 实现查询意图理解、多跳图遍历、子图提取、图结构推理与自适应查询规划
 */

export type GraphQueryType = "entity_relation" | "multi_hop" | "subgraph" | "path_finding" | "clustering";

export interface GraphQuery {
  queryType: GraphQueryType;
  sourceEntities: string[];
  targetEntities: string[];
  relationTypes: string[];
  maxDepth: number;
  maxNodes: number;
  constraints: Record<string, unknown>;
}

export interface GraphPath {
  nodes: GraphNode[];
  relationships: GraphRelation[];
  length: number;
  score: number;
}

export interface KnowledgeSubgraph {
  nodes: GraphNode[];
  relations: GraphRelation[];
  density: number;
  reasoning: string;
}

export interface GraphRAGRetrievalApi {
  initialize(): Promise<void>;
  graphRagSearch(query: string, topK?: number): Promise<ChunkDocument[]>;
  close(): void;
}

export function createGraphRAGRetrieval(
  llmModel: string,
  temperature: number,
  maxTokens: number,
  apiKey: string,
  baseURL: string,
  graphIndex: GraphIndexApi
): GraphRAGRetrievalApi {
  const llm = new ChatOpenAI({
    model: llmModel,
    temperature,
    maxTokens,
    apiKey,
    configuration: { baseURL },
    streaming: false,
  });

  let initialized = false;

  async function initialize(): Promise<void> {
    await graphIndex.initialize();
    initialized = true;
    console.log("[GraphRAGRetrieval] 图 RAG 检索模块初始化完成");
  }

  /**
   * 查询意图理解：将自然语言问题映射为图查询意图
   */
  async function understandGraphQuery(query: string): Promise<GraphQuery> {
    const prompt = ChatPromptTemplate.fromTemplate(`你是一位图数据库查询分析专家。请分析用户的食谱相关问题，提取图查询意图。

请返回严格的 JSON 格式，不要包含任何其他解释文字：
{{
  "queryType": "entity_relation|multi_hop|subgraph|path_finding|clustering",
  "sourceEntities": ["实体1", "实体2"],
  "targetEntities": ["目标实体1"],
  "relationTypes": ["REQUIRES", "CONTAINS_STEP", "BELONGS_TO_CATEGORY"],
  "maxDepth": 2,
  "maxNodes": 20,
  "constraints": {{}}
}}

查询类型说明：
- entity_relation: 查询实体之间的关系（如"可乐鸡翅需要什么食材"）
- multi_hop: 多跳关系探索（如"含可乐和鸡翅的菜有哪些共同食材"）
- subgraph: 子图查询（如"地三鲜的完整制作流程和相关食材"）
- path_finding: 路径发现（如"从鸡翅到可乐鸡翅的制作路径"）
- clustering: 聚类/分类查询（如"有哪些简单的荤菜"）

实体关系类型：
- REQUIRES: 菜谱需要某种食材
- CONTAINS_STEP: 菜谱包含某个步骤
- BELONGS_TO_CATEGORY: 菜谱属于某个分类

用户问题: {query}

图查询意图 JSON:`);

    try {
      const chain = prompt.pipe(llm).pipe(new StringOutputParser());
      const result = await chain.invoke({ query });
      const parsed = JSON.parse(result.trim()) as GraphQuery;
      return validateGraphQuery(parsed);
    } catch (error) {
      console.warn("[GraphRAGRetrieval] LLM 查询意图理解失败，降级到规则分析:", error);
      return ruleBasedQueryUnderstanding(query);
    }
  }

  function validateGraphQuery(query: GraphQuery): GraphQuery {
    return {
      queryType: ["entity_relation", "multi_hop", "subgraph", "path_finding", "clustering"].includes(query.queryType)
        ? query.queryType
        : "subgraph",
      sourceEntities: Array.isArray(query.sourceEntities) ? query.sourceEntities : [],
      targetEntities: Array.isArray(query.targetEntities) ? query.targetEntities : [],
      relationTypes: Array.isArray(query.relationTypes) ? query.relationTypes : [],
      maxDepth: Math.min(Math.max(query.maxDepth || 2, 1), 4),
      maxNodes: Math.min(Math.max(query.maxNodes || 20, 5), 50),
      constraints: query.constraints || {},
    };
  }

  function ruleBasedQueryUnderstanding(query: string): GraphQuery {
    const lower = query.toLowerCase();
    const entities: string[] = [];
    // 简单提取中文连续名词作为候选实体
    const matches = lower.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const m of matches) {
      if (!["怎么", "做法", "步骤", "食材", "推荐", "介绍", "什么", "有哪些"].includes(m)) {
        entities.push(m);
      }
    }

    let queryType: GraphQueryType = "subgraph";
    if (lower.includes("共同") || lower.includes("相似") || lower.includes("一起")) {
      queryType = "multi_hop";
    } else if (lower.includes("分类") || lower.includes("有哪些") || lower.includes("推荐")) {
      queryType = "clustering";
    } else if (lower.includes("路径") || lower.includes("从")) {
      queryType = "path_finding";
    } else if (lower.includes("食材") || lower.includes("需要") || lower.includes("用")) {
      queryType = "entity_relation";
    }

    return {
      queryType,
      sourceEntities: entities.slice(0, 3),
      targetEntities: [],
      relationTypes: ["REQUIRES", "CONTAINS_STEP", "BELONGS_TO_CATEGORY"],
      maxDepth: 2,
      maxNodes: 20,
      constraints: {},
    };
  }

  /**
   * 多跳图遍历
   */
  async function multiHopTraversal(graphQuery: GraphQuery): Promise<GraphPath[]> {
    const sources = graphQuery.sourceEntities.filter((e) => e.length > 0);
    if (sources.length === 0) return [];

    const result = await executeQuery(
      `
      UNWIND $sources AS sourceName
      MATCH path = (source)-[*1..$maxDepth]-(target)
      WHERE source.name CONTAINS sourceName OR source.name = sourceName
      WITH path, source, target, length(path) AS pathLen
      RETURN source, target, pathLen, relationships(path) AS rels, nodes(path) AS nodes
      LIMIT $limit
      `,
      { sources, maxDepth: graphQuery.maxDepth, limit: 20 }
    );

    if (!result) return [];

    const paths: GraphPath[] = [];
    for (const rec of result.records) {
      const nodes = rec.get("nodes") as GraphNode[];
      const rels = rec.get("rels") as GraphRelation[];
      const pathLen = Number(rec.get("pathLen"));
      const score = 1.0 / (pathLen + 1) + nodes.length * 0.05;
      paths.push({ nodes, relationships: rels, length: pathLen, score });
    }

    return paths;
  }

  /**
   * 子图提取：提取源实体 N 跳内的子图
   */
  async function extractKnowledgeSubgraph(graphQuery: GraphQuery): Promise<KnowledgeSubgraph> {
    const sources = graphQuery.sourceEntities.filter((e) => e.length > 0);
    if (sources.length === 0) {
      return { nodes: [], relations: [], density: 0, reasoning: "" };
    }

    const result = await executeQuery(
      `
      UNWIND $sources AS sourceName
      MATCH (source)-[*1..$maxDepth]-(neighbor)
      WHERE source.name CONTAINS sourceName OR source.name = sourceName
      RETURN source, neighbor, relationships(path) AS rels, nodes(path) AS nodes
      LIMIT $limit
      `,
      { sources, maxDepth: graphQuery.maxDepth, limit: graphQuery.maxNodes }
    );

    if (!result) {
      return { nodes: [], relations: [], density: 0, reasoning: "" };
    }

    const nodeMap = new Map<string, GraphNode>();
    const relationMap = new Map<string, GraphRelation>();

    for (const rec of result.records) {
      const nodes = rec.get("nodes") as GraphNode[];
      const rels = rec.get("rels") as GraphRelation[];
      for (const node of nodes) {
        nodeMap.set(node.id, node);
      }
      for (const rel of rels) {
        relationMap.set(rel.signature || `${rel.type}:${rel.source.id}:${rel.target.id}`, rel);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const relations = Array.from(relationMap.values());
    const density = nodes.length > 1 ? relations.length / (nodes.length * (nodes.length - 1)) : 0;

    return {
      nodes,
      relations,
      density,
      reasoning: `从实体 "${sources.join(", ")}" 提取了 ${nodes.length} 个节点和 ${relations.length} 条关系的子图。`,
    };
  }

  /**
   * 图结构推理
   */
  function graphStructureReasoning(subgraph: KnowledgeSubgraph): string {
    if (subgraph.nodes.length === 0) return "未找到相关图结构信息。";

    const recipeNodes = subgraph.nodes.filter((n) => n.type === "Recipe");
    const ingredientNodes = subgraph.nodes.filter((n) => n.type === "Ingredient");
    const stepNodes = subgraph.nodes.filter((n) => n.type === "CookingStep");

    const parts: string[] = [];
    if (recipeNodes.length > 0) {
      parts.push(`涉及菜谱：${recipeNodes.map((n) => n.name).join(", ")}`);
    }
    if (ingredientNodes.length > 0) {
      parts.push(`关键食材：${ingredientNodes.map((n) => n.name).join(", ")}`);
    }
    if (stepNodes.length > 0) {
      parts.push(`制作步骤：${stepNodes.map((n) => n.name).join("；")}`);
    }

    return parts.join("\n");
  }

  /**
   * 自适应查询规划
   */
  async function adaptiveQueryPlanning(query: string): Promise<GraphQuery> {
    const graphQuery = await understandGraphQuery(query);

    if (graphQuery.queryType === "entity_relation") {
      graphQuery.maxDepth = 1;
      graphQuery.maxNodes = 10;
    } else if (graphQuery.queryType === "multi_hop") {
      graphQuery.maxDepth = 2;
      graphQuery.maxNodes = 20;
    } else if (graphQuery.queryType === "subgraph") {
      graphQuery.maxDepth = 2;
      graphQuery.maxNodes = 30;
    } else if (graphQuery.queryType === "path_finding") {
      graphQuery.maxDepth = 3;
      graphQuery.maxNodes = 20;
    }

    return graphQuery;
  }

  /**
   * 主搜索接口
   */
  async function graphRagSearch(query: string, topK: number = 5): Promise<ChunkDocument[]> {
    if (!initialized) {
      console.warn("[GraphRAGRetrieval] 模块未初始化，跳过图 RAG 检索");
      return [];
    }

    console.log(`[GraphRAGRetrieval] 开始图 RAG 检索: "${query}"`);
    const graphQuery = await adaptiveQueryPlanning(query);
    console.log(`[GraphRAGRetrieval] 图查询类型: ${graphQuery.queryType}, 源实体: ${graphQuery.sourceEntities.join(", ") || "无"}`);

    let docs: ChunkDocument[] = [];

    if (graphQuery.queryType === "multi_hop" || graphQuery.queryType === "path_finding") {
      const paths = await multiHopTraversal(graphQuery);
      docs = pathsToDocuments(paths, query);
    } else if (graphQuery.queryType === "subgraph") {
      const subgraph = await extractKnowledgeSubgraph(graphQuery);
      const reasoningText = graphStructureReasoning(subgraph);
      docs = subgraphToDocuments(subgraph, reasoningText, query);
    } else {
      // entity_relation 或 clustering：先查实体相关菜谱
      const recipes = await findRelatedRecipes(graphQuery);
      docs = recipesToDocuments(recipes, query);
    }

    // 按相关性分数排序并截断
    docs.sort((a, b) => (b.metadata.rrf_score || 0) - (a.metadata.rrf_score || 0));
    return docs.slice(0, topK);
  }

  async function findRelatedRecipes(graphQuery: GraphQuery): Promise<Array<{ name: string; category: string; difficulty: string; relativePath: string; ingredients: string[]; steps: string[] }>> {
    const sources = graphQuery.sourceEntities.filter((e) => e.length > 0);
    if (sources.length === 0) return [];

    const result = await executeQuery(
      `
      UNWIND $sources AS sourceName
      MATCH (r:Recipe)
      WHERE r.name CONTAINS sourceName
      OPTIONAL MATCH (r)-[:REQUIRES]->(i:Ingredient)
      OPTIONAL MATCH (r)-[:CONTAINS_STEP]->(s:CookingStep)
      RETURN r.nodeId AS nodeId, r.name AS name, r.difficulty AS difficulty, r.category AS category, r.relativePath AS relativePath,
             collect(DISTINCT i.name) AS ingredients, collect(DISTINCT s.description) AS steps
      LIMIT $limit
      `,
      { sources, limit: graphQuery.maxNodes }
    );

    if (!result) return [];

    return result.records.map((rec) => {
      return {
        name: String(rec.get("name")),
        category: String(rec.get("category")),
        difficulty: String(rec.get("difficulty")),
        relativePath: String(rec.get("relativePath")),
        ingredients: (rec.get("ingredients") as string[]) || [],
        steps: (rec.get("steps") as string[]) || [],
      };
    });
  }

  function pathsToDocuments(paths: GraphPath[], query: string): ChunkDocument[] {
    return paths.map((path, index) => {
      const recipeNodes = path.nodes.filter((n) => n.type === "Recipe");
      const recipeName = recipeNodes.length > 0 ? recipeNodes[0].name : "未知菜谱";
      const content = path.nodes.map((n) => `${n.type}: ${n.name}`).join("\n");

      const doc: ChunkDocument = {
        pageContent: `图关系路径:\n${content}\n\n查询: ${query}`,
        metadata: {
          source: "",
          parent_id: "",
          doc_type: "child",
          category: "",
          dish_name: recipeName,
          difficulty: "",
          rrf_score: path.score,
          search_method: "graph_rag",
          retrieval_level: "path",
          path_length: path.length,
        } as ChunkMetadata,
      };
      return doc;
    });
  }

  function subgraphToDocuments(subgraph: KnowledgeSubgraph, reasoningText: string, query: string): ChunkDocument[] {
    if (subgraph.nodes.length === 0) return [];

    const recipeNodes = subgraph.nodes.filter((n) => n.type === "Recipe");
    const recipeName = recipeNodes.length > 0 ? recipeNodes[0].name : "相关菜谱";

    const nodeTexts = subgraph.nodes.map((n) => `${n.type}: ${n.name}`);
    const relationTexts = subgraph.relations.map((r) => `${r.source.name} -[${r.type}]-> ${r.target.name}`);

    const content = `子图结构:\n${nodeTexts.join("\n")}\n\n关系:\n${relationTexts.join("\n")}\n\n推理:\n${reasoningText}`;

    return [{
      pageContent: `${content}\n\n查询: ${query}`,
      metadata: {
        source: "",
        parent_id: "",
        doc_type: "child",
        category: "",
        dish_name: recipeName,
        difficulty: "",
        rrf_score: 1.0 + subgraph.density * 10,
        search_method: "graph_rag",
        retrieval_level: "subgraph",
      } as ChunkMetadata,
    }];
  }

  function recipesToDocuments(recipes: Array<{ name: string; category: string; difficulty: string; relativePath: string; ingredients: string[]; steps: string[] }>, query: string): ChunkDocument[] {
    return recipes.map((recipe) => {
      const ingredientLines = recipe.ingredients.map((i) => `- ${i}`).join("\n");
      const stepLines = recipe.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
      const content = `# ${recipe.name}的做法\n\n预估烹饪难度：${recipe.difficulty}\n\n## 必备原料和工具\n\n${ingredientLines}\n\n## 操作\n\n${stepLines}`;

      return {
        pageContent: `${content}\n\n查询: ${query}`,
        metadata: {
          source: recipe.relativePath,
          parent_id: "",
          doc_type: "child",
          category: recipe.category,
          dish_name: recipe.name,
          difficulty: recipe.difficulty,
          rrf_score: 1.0,
          search_method: "graph_rag",
          retrieval_level: "entity",
        } as ChunkMetadata,
      };
    });
  }

  function close(): void {
    initialized = false;
  }

  return {
    initialize,
    graphRagSearch,
    close,
  };
}
