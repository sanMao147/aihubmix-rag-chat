import { Document } from "@langchain/core/documents";
import { executeQuery } from "./neo4j-connection";
import { CATEGORY_MAPPING } from "./config";

/**
 * 图数据准备模块
 * 从 Neo4j 读取 Recipe/Ingredient/CookingStep 节点，构建完整菜谱文档并分块
 */

export interface GraphNode {
  id: string;
  type: "Recipe" | "Ingredient" | "CookingStep" | "Category";
  name: string;
  properties: Record<string, unknown>;
}

export interface GraphRecipeData {
  nodeId: string;
  name: string;
  difficulty: string;
  category: string;
  relativePath: string;
  ingredients: string[];
  steps: string[];
}

export interface GraphDataPreparationApi {
  loadGraphData(): Promise<GraphRecipeData[]>;
  buildRecipeDocuments(recipes: GraphRecipeData[]): Document[];
  chunkDocuments(recipes: GraphRecipeData[]): Document[];
  getStatistics(): { recipes: number; ingredients: number; steps: number; documents: number; chunks: number };
}

export function createGraphDataPreparation(): GraphDataPreparationApi {
  let recipes: GraphRecipeData[] = [];
  let documents: Document[] = [];
  let chunks: Document[] = [];

  async function loadGraphData(): Promise<GraphRecipeData[]> {
    const result = await executeQuery(`
      MATCH (r:Recipe)
      OPTIONAL MATCH (r)-[:REQUIRES]->(i:Ingredient)
      OPTIONAL MATCH (r)-[:CONTAINS_STEP]->(s:CookingStep)
      OPTIONAL MATCH (r)-[:BELONGS_TO_CATEGORY]->(c:Category)
      RETURN r.nodeId AS nodeId, r.name AS name, r.difficulty AS difficulty, r.category AS category, r.relativePath AS relativePath,
             collect(DISTINCT i.name) AS ingredients, collect(DISTINCT s.description) AS steps, c.name AS categoryName
      LIMIT 1000
    `);

    if (!result) {
      console.warn("[GraphDataPreparation] 无法从 Neo4j 加载数据");
      return [];
    }

    recipes = result.records.map((rec) => {
      return {
        nodeId: String(rec.get("nodeId")),
        name: String(rec.get("name")),
        difficulty: String(rec.get("difficulty")),
        category: String(rec.get("category") ?? rec.get("categoryName")),
        relativePath: String(rec.get("relativePath")),
        ingredients: (rec.get("ingredients") as string[]) || [],
        steps: (rec.get("steps") as string[]) || [],
      };
    });

    console.log(`[GraphDataPreparation] 从 Neo4j 加载 ${recipes.length} 道食谱`);
    return recipes;
  }

  function buildRecipeDocuments(recipeData: GraphRecipeData[]): Document[] {
    documents = recipeData.map((recipe) => {
      const content = buildRecipeText(recipe);
      return new Document({
        pageContent: content,
        metadata: {
          source: recipe.relativePath,
          parent_id: recipe.nodeId,
          doc_type: "parent",
          category: recipe.category,
          dish_name: recipe.name,
          difficulty: recipe.difficulty,
        },
      });
    });

    return documents;
  }

  function buildRecipeText(recipe: GraphRecipeData): string {
    const ingredientLines = recipe.ingredients.length > 0
      ? recipe.ingredients.map((i) => `- ${i}`).join("\n")
      : "- 暂无食材信息";

    const stepLines = recipe.steps.length > 0
      ? recipe.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "1. 暂无步骤信息";

    return `# ${recipe.name}的做法

预估烹饪难度：${recipe.difficulty}

## 必备原料和工具

${ingredientLines}

## 操作

${stepLines}
`;
  }

  function chunkDocuments(recipeData: GraphRecipeData[]): Document[] {
    const allChunks: Document[] = [];

    for (const recipe of recipeData) {
      const text = buildRecipeText(recipe);
      const recipeChunks = simpleMarkdownChunk(text, recipe);
      allChunks.push(...recipeChunks);
    }

    chunks = allChunks;
    console.log(`[GraphDataPreparation] 图数据分块完成，共 ${chunks.length} 个 chunk`);
    return chunks;
  }

  function simpleMarkdownChunk(text: string, recipe: GraphRecipeData): Document[] {
    const lines = text.split("\n");
    const headerRegex = /^(#{1,3})\s+(.+)$/;
    const chunks: Document[] = [];

    const headerStack: Array<{ level: number; text: string }> = [];
    let currentLines: string[] = [];
    let hasContent = false;

    const flushChunk = () => {
      if (currentLines.length > 0 && hasContent) {
        const pageContent = currentLines.join("\n").trim();
        if (pageContent) {
          const headerPath = headerStack.map((h) => h.text).join(" > ");
          chunks.push(new Document({
            pageContent,
            metadata: {
              source: recipe.relativePath,
              parent_id: recipe.nodeId,
              doc_type: "child",
              category: recipe.category,
              dish_name: recipe.name,
              difficulty: recipe.difficulty,
              header_path: headerPath || undefined,
            },
          }));
        }
      }
      currentLines = [];
      hasContent = false;
    };

    for (const line of lines) {
      const match = line.match(headerRegex);
      if (match) {
        flushChunk();
        const level = match[1].length;
        const text = match[2].trim();
        while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= level) {
          headerStack.pop();
        }
        headerStack.push({ level, text });
        currentLines.push(line);
        hasContent = true;
      } else {
        currentLines.push(line);
        if (line.trim()) hasContent = true;
      }
    }
    flushChunk();

    if (chunks.length === 0) {
      chunks.push(new Document({
        pageContent: text,
        metadata: {
          source: recipe.relativePath,
          parent_id: recipe.nodeId,
          doc_type: "child",
          category: recipe.category,
          dish_name: recipe.name,
          difficulty: recipe.difficulty,
        },
      }));
    }

    return chunks;
  }

  function getStatistics() {
    const ingredientCount = new Set(recipes.flatMap((r) => r.ingredients)).size;
    const stepCount = recipes.reduce((sum, r) => sum + r.steps.length, 0);
    return {
      recipes: recipes.length,
      ingredients: ingredientCount,
      steps: stepCount,
      documents: documents.length,
      chunks: chunks.length,
    };
  }

  return {
    loadGraphData,
    buildRecipeDocuments,
    chunkDocuments,
    getStatistics,
  };
}

/**
 * 根据相对路径反向查找 category 目录名
 */
export function resolveCategoryFromPath(relativePath: string): string {
  const parts = relativePath.split("/");
  for (const part of parts) {
    if (CATEGORY_MAPPING[part]) {
      return CATEGORY_MAPPING[part];
    }
  }
  return "其他";
}
