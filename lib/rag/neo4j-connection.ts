import neo4j, { type Driver, type Session } from "neo4j-driver";

/**
 * Neo4j 连接配置
 */
export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  database: string;
}

/**
 * Neo4j 查询结果记录包装器，统一 record.get() 的类型安全访问
 */
export interface SafeRecord {
  get(key: string): unknown;
}

let sharedDriver: Driver | null = null;

/**
 * 从环境变量读取 Neo4j 配置
 */
export function loadNeo4jConfig(): Neo4jConfig | null {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  const database = process.env.NEO4J_DATABASE || "neo4j";

  if (!uri || !user || !password) {
    console.log("[Neo4jConnection] 未配置 NEO4J_URI/USER/PASSWORD，图数据库不可用");
    return null;
  }

  return { uri, user, password, database };
}

/**
 * 初始化 Neo4j driver（单例）
 * 连接失败时返回 null，上层据此降级
 */
export function initNeo4jDriver(config: Neo4jConfig): Driver | null {
  if (sharedDriver) {
    return sharedDriver;
  }

  try {
    const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
    sharedDriver = driver;
    console.log("[Neo4jConnection] Neo4j driver 已初始化");
    return driver;
  } catch (error) {
    console.error("[Neo4jConnection] 初始化 Neo4j driver 失败:", error);
    return null;
  }
}

/**
 * 获取当前已初始化的 driver（可能为 null）
 */
export function getNeo4jDriver(): Driver | null {
  return sharedDriver;
}

/**
 * 执行参数化 Cypher 查询
 * 返回 QueryResult 或 null（连接不可用时）
 */
export async function executeQuery(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<{ records: SafeRecord[] } | null> {
  const driver = sharedDriver;
  if (!driver) {
    console.warn("[Neo4jConnection] 无法执行查询，driver 未初始化");
    return null;
  }

  const config = loadNeo4jConfig();
  const database = config?.database || "neo4j";
  let session: Session | null = null;

  try {
    session = driver.session({ database });
    const result = await session.run(cypher, params);
    return result as { records: SafeRecord[] };
  } catch (error) {
    console.error("[Neo4jConnection] Cypher 执行失败:", error);
    return null;
  } finally {
    if (session) {
      await session.close();
    }
  }
}

/**
 * 关闭全局 driver
 */
export async function closeNeo4jDriver(): Promise<void> {
  if (sharedDriver) {
    await sharedDriver.close();
    sharedDriver = null;
    console.log("[Neo4jConnection] Neo4j driver 已关闭");
  }
}

/**
 * 测试 Neo4j 连接是否可用
 */
export async function testNeo4jConnection(): Promise<boolean> {
  const result = await executeQuery("RETURN 1 AS n");
  return result !== null;
}
