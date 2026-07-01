import { executeQuery } from "./neo4j-connection";

export interface GraphNode {
  id: string;
  type: "Recipe" | "Ingredient" | "CookingStep" | "Category";
  name: string;
  properties: Record<string, unknown>;
}

/**
 * 图索引模块
 * 构建实体与关系的键值对索引，支持快速按名称/主题查找
 */

export interface GraphRelation {
  type: string;
  source: GraphNode;
  target: GraphNode;
  signature: string;
  themes: string[];
}

export interface GraphIndexApi {
  initialize(): Promise<void>;
  getEntitiesByKey(key: string): GraphNode[];
  getRelationsByKey(key: string): GraphRelation[];
  getAllEntities(): Map<string, GraphNode[]>;
  getAllRelations(): Map<string, GraphRelation[]>;
}

// 关系类型 → 多个索引主题
const RELATION_INDEX_MAP: Record<string, string[]> = {
  REQUIRES: ["食材搭配", "烹饪原料"],
  CONTAINS_STEP: ["制作步骤", "烹饪过程"],
  BELONGS_TO_CATEGORY: ["菜品分类", "美食类别"],
};

export function createGraphIndexing(): GraphIndexApi {
  // 键 -> 实体列表（同名实体合并）
  const entityIndex = new Map<string, GraphNode[]>();
  // 键 -> 关系列表（同签名关系去重）
  const relationIndex = new Map<string, GraphRelation[]>();
  let initialized = false;

  async function initialize(): Promise<void> {
    entityIndex.clear();
    relationIndex.clear();

    const result = await executeQuery(`
      MATCH (n)-[r]->(m)
      WHERE n:Recipe OR n:Ingredient OR n:CookingStep OR n:Category
      RETURN n, r, m
      LIMIT 2000
    `);

    if (!result) {
      console.warn("[GraphIndexing] 无法从 Neo4j 加载图索引数据");
      return;
    }

    for (const rec of result.records) {
      const sourceNode = recordToGraphNode(rec.get("n"));
      const targetNode = recordToGraphNode(rec.get("m"));
      const rel = rec.get("r") as { type: string };
      const relType = rel.type;

      // 索引实体（按名称）
      indexEntity(sourceNode);
      indexEntity(targetNode);

      // 索引关系（按关系类型和全局主题）
      const themes = RELATION_INDEX_MAP[relType] || [relType];
      const relation: GraphRelation = {
        type: relType,
        source: sourceNode,
        target: targetNode,
        signature: `${relType}:${sourceNode.id}:${targetNode.id}`,
        themes,
      };

      for (const theme of themes) {
        indexRelation(theme, relation);
      }
      // 同时按关系类型索引
      indexRelation(relType, relation);
    }

    initialized = true;
    console.log(`[GraphIndexing] 图索引构建完成：${entityIndex.size} 个实体键, ${relationIndex.size} 个关系键`);
  }

  function recordToGraphNode(value: unknown): GraphNode {
    const node = value as { identity: { toString: () => string }; labels: string[]; properties: Record<string, unknown> };
    const labels = node.labels || [];
    const type = (labels[0] || "Unknown") as GraphNode["type"];
    const name = String(node.properties.name || node.properties.description || node.properties.nodeId || "");
    return {
      id: node.identity.toString(),
      type,
      name,
      properties: node.properties,
    };
  }

  function indexEntity(node: GraphNode): void {
    if (!node.name) return;
    const key = node.name.toLowerCase();
    const existing = entityIndex.get(key) || [];
    const merged = mergeById(existing, node);
    entityIndex.set(key, merged);
  }

  function mergeById(list: GraphNode[], node: GraphNode): GraphNode[] {
    if (list.some((n) => n.id === node.id)) return list;
    return [...list, node];
  }

  function indexRelation(key: string, relation: GraphRelation): void {
    const normalizedKey = key.toLowerCase();
    const existing = relationIndex.get(normalizedKey) || [];
    if (existing.some((r) => r.signature === relation.signature)) return;
    relationIndex.set(normalizedKey, [...existing, relation]);
  }

  function getEntitiesByKey(key: string): GraphNode[] {
    return entityIndex.get(key.toLowerCase()) || [];
  }

  function getRelationsByKey(key: string): GraphRelation[] {
    return relationIndex.get(key.toLowerCase()) || [];
  }

  function getAllEntities(): Map<string, GraphNode[]> {
    return new Map(entityIndex);
  }

  function getAllRelations(): Map<string, GraphRelation[]> {
    return new Map(relationIndex);
  }

  return {
    initialize,
    getEntitiesByKey,
    getRelationsByKey,
    getAllEntities,
    getAllRelations,
  };
}
