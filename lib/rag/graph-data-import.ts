import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep, parse } from "path";
import { md5, getProjectRoot } from "../utils";
import { CATEGORY_MAPPING } from "./config";
import { executeQuery, loadNeo4jConfig, initNeo4jDriver } from "./neo4j-connection";

/**
 * 图数据导入模块
 * 负责解析 Markdown 食谱，提取 Recipe/Ingredient/CookingStep/Category 实体
 * 及 REQUIRES/CONTAINS_STEP/BELONGS_TO_CATEGORY 关系，并批量写入 Neo4j
 */

export interface ParsedRecipe {
  nodeId: string;
  name: string;
  difficulty: string;
  category: string;
  relativePath: string;
  ingredients: string[];
  steps: string[];
}

/**
 * 解析单个 Markdown 食谱文件，提取图结构信息
 */
export function parseMarkdownForGraph(filePath: string, dataRoot: string): ParsedRecipe | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    // 相对路径与 nodeId
    let relativePath: string;
    try {
      relativePath = relative(dataRoot, filePath).split(sep).join("/");
    } catch {
      relativePath = filePath.split(sep).join("/");
    }
    const nodeId = generateRecipeNodeId(relativePath);

    // 菜名：从 "# {菜名}的做法" 提取
    let name = parse(filePath).name;
    const titleMatch = content.match(/^#\s*(.+?)的做法/);
    if (titleMatch) {
      name = titleMatch[1].trim();
    }

    // 难度：按星数
    let difficulty = "未知";
    if (content.includes("★★★★★")) difficulty = "非常困难";
    else if (content.includes("★★★★")) difficulty = "困难";
    else if (content.includes("★★★")) difficulty = "中等";
    else if (content.includes("★★")) difficulty = "简单";
    else if (content.includes("★")) difficulty = "非常简单";

    // 分类：从路径匹配
    let category = "其他";
    const pathParts = filePath.split(sep);
    for (const [key, value] of Object.entries(CATEGORY_MAPPING)) {
      if (pathParts.includes(key)) {
        category = value;
        break;
      }
    }

    // 食材：从 "## 必备原料和工具" 下的列表提取
    const ingredients: string[] = [];
    let inIngredients = false;
    for (const line of lines) {
      if (/^##\s+必备原料和工具/.test(line)) {
        inIngredients = true;
        continue;
      }
      if (/^##\s+/.test(line) && !/^##\s+必备原料和工具/.test(line)) {
        if (inIngredients) break;
      }
      if (inIngredients) {
        const match = line.match(/^(?:[-*]|\d+\.\s*)\s*(.+)$/);
        if (match) {
          const item = match[1].trim();
          if (item) {
            // 简单清洗：去除用量、或、等描述，只保留核心食材名（取第一个词/短语）
            const cleaned = cleanIngredientName(item);
            if (cleaned && !ingredients.includes(cleaned)) {
              ingredients.push(cleaned);
            }
          }
        }
      }
    }

    // 步骤：从 "## 操作" 下的列表提取
    const steps: string[] = [];
    let inSteps = false;
    for (const line of lines) {
      if (/^##\s+操作/.test(line)) {
        inSteps = true;
        continue;
      }
      if (/^##\s+/.test(line) && !/^##\s+操作/.test(line)) {
        if (inSteps) break;
      }
      if (inSteps) {
        const match = line.match(/^(?:[-*]|\d+\.\s*)\s*(.+)$/);
        if (match) {
          const item = match[1].trim();
          if (item) {
            steps.push(item);
          }
        }
      }
    }

    return {
      nodeId,
      name,
      difficulty,
      category,
      relativePath,
      ingredients,
      steps,
    };
  } catch (error) {
    console.warn(`[GraphDataImport] 解析文件 ${filePath} 失败:`, error);
    return null;
  }
}

/**
 * 清洗食材名，去除用量和常见修饰词，保留核心食材
 */
function cleanIngredientName(raw: string): string {
  // 去除常见量词与数字单位后的描述
  let name = raw
    .replace(/\d+/g, " ")
    .replace(/[g克ml毫升l升\/～~\-，,、或]*/g, " ")
    .trim();

  // 取第一个有效词（通常为核心食材）
  const parts = name.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return raw.trim();

  // 如果原始项很短，直接保留
  if (raw.trim().length <= 6) return raw.trim();

  return parts[0];
}

/**
 * 生成确定性 recipe nodeId
 * 与 C9 约定一致：nodeId >= "200000000"
 */
export function generateRecipeNodeId(relativePath: string): string {
  const hash = md5(relativePath);
  const numeric = parseInt(hash.slice(0, 7), 16) % 100000000;
  return (200000000 + numeric).toString();
}

/**
 * 递归查找所有 Markdown 文件
 */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  const walk = (currentDir: string) => {
    const entries = readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = join(currentDir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  };

  walk(dir);
  return results;
}

/**
 * 从数据目录加载所有食谱并解析
 */
export function loadRecipesForGraph(dataPath: string): ParsedRecipe[] {
  const fullPath = join(getProjectRoot(), dataPath);
  const mdFiles = findMarkdownFiles(fullPath);

  const recipes: ParsedRecipe[] = [];
  for (const filePath of mdFiles) {
    const recipe = parseMarkdownForGraph(filePath, fullPath);
    if (recipe) {
      recipes.push(recipe);
    }
  }

  console.log(`[GraphDataImport] 解析完成，共 ${recipes.length} 道食谱`);
  return recipes;
}

/**
 * 确保图数据库所需约束和索引存在
 */
async function ensureGraphSchema(): Promise<void> {
  // 节点唯一约束/索引
  await executeQuery(`
    CREATE CONSTRAINT recipe_node_id IF NOT EXISTS
    FOR (r:Recipe) REQUIRE r.nodeId IS UNIQUE
  `);
  await executeQuery(`
    CREATE CONSTRAINT ingredient_name IF NOT EXISTS
    FOR (i:Ingredient) REQUIRE i.name IS UNIQUE
  `);
  await executeQuery(`
    CREATE CONSTRAINT category_name IF NOT EXISTS
    FOR (c:Category) REQUIRE c.name IS UNIQUE
  `);

  // 全文索引加速食材与步骤查询
  await executeQuery(`
    CREATE FULLTEXT INDEX ingredientFullText IF NOT EXISTS
    FOR (i:Ingredient) ON EACH [i.name]
  `);
  await executeQuery(`
    CREATE FULLTEXT INDEX recipeFullText IF NOT EXISTS
    FOR (r:Recipe) ON EACH [r.name, r.category]
  `);

  console.log("[GraphDataImport] 图 schema 约束/索引已确保");
}

/**
 * 将解析后的食谱批量写入 Neo4j
 * 使用 MERGE 保证幂等，batch 50
 */
export async function importRecipesToNeo4j(recipes: ParsedRecipe[]): Promise<void> {
  const batchSize = 50;
  const total = recipes.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = recipes.slice(i, i + batchSize);

    const params = {
      recipes: batch.map((r) => ({
        nodeId: r.nodeId,
        name: r.name,
        difficulty: r.difficulty,
        category: r.category,
        relativePath: r.relativePath,
      })),
    };

    // 批量写入 Recipe 节点与 Category 关系
    await executeQuery(
      `
      UNWIND $recipes AS recipe
      MERGE (r:Recipe {nodeId: recipe.nodeId})
      SET r.name = recipe.name, r.difficulty = recipe.difficulty, r.category = recipe.category, r.relativePath = recipe.relativePath
      MERGE (c:Category {name: recipe.category})
      MERGE (r)-[:BELONGS_TO_CATEGORY]->(c)
      `,
      params
    );
  }

  // 写入 Ingredient 与 REQUIRES 关系
  for (let i = 0; i < total; i += batchSize) {
    const batch = recipes.slice(i, i + batchSize);
    const ingredientParams = {
      pairs: batch.flatMap((r) =>
        r.ingredients.map((ing) => ({ recipeId: r.nodeId, ingredient: ing }))
      ),
    };

    await executeQuery(
      `
      UNWIND $pairs AS pair
      MERGE (i:Ingredient {name: pair.ingredient})
      MERGE (r:Recipe {nodeId: pair.recipeId})
      MERGE (r)-[:REQUIRES]->(i)
      `,
      ingredientParams
    );
  }

  // 写入 CookingStep 与 CONTAINS_STEP 关系
  for (let i = 0; i < total; i += batchSize) {
    const batch = recipes.slice(i, i + batchSize);
    const stepParams = {
      pairs: batch.flatMap((r) =>
        r.steps.map((step, idx) => ({
          recipeId: r.nodeId,
          stepNumber: idx + 1,
          description: step.slice(0, 500),
        }))
      ),
    };

    await executeQuery(
      `
      UNWIND $pairs AS pair
      MERGE (s:CookingStep {recipeId: pair.recipeId, stepNumber: pair.stepNumber})
      SET s.description = pair.description
      MERGE (r:Recipe {nodeId: pair.recipeId})
      MERGE (r)-[:CONTAINS_STEP]->(s)
      `,
      stepParams
    );
  }

  console.log(`[GraphDataImport] 成功导入 ${total} 道食谱到 Neo4j`);
}

/**
 * 清空图数据（重建时使用）
 */
export async function clearGraphData(): Promise<void> {
  await executeQuery(`
    MATCH (n)
    OPTIONAL MATCH (n)-[r]-()
    DELETE n, r
  `);
  console.log("[GraphDataImport] 图数据已清空");
}

/**
 * 主入口：从 Markdown 数据目录构建图数据库
 */
export async function buildGraphFromMarkdown(dataPath: string): Promise<boolean> {
  const config = loadNeo4jConfig();
  if (!config) {
    console.log("[GraphDataImport] 未配置 Neo4j，跳过图数据导入");
    return false;
  }

  const driver = initNeo4jDriver(config);
  if (!driver) {
    console.warn("[GraphDataImport] Neo4j driver 初始化失败，跳过图数据导入");
    return false;
  }

  console.log("[GraphDataImport] 开始构建图数据...");
  const recipes = loadRecipesForGraph(dataPath);
  if (recipes.length === 0) {
    console.warn("[GraphDataImport] 未找到可导入的食谱");
    return false;
  }

  await clearGraphData();
  await ensureGraphSchema();
  await importRecipesToNeo4j(recipes);

  console.log("[GraphDataImport] 图数据构建完成");
  return true;
}
