# 尝尝咸淡 · RAG 食谱助手

基于 Next.js 16 + LangChain.js 1.x 的智能食谱问答系统，采用 RAG（检索增强生成）架构，通过 AIHubMix 兼容 OpenAI 接口调用大模型。

## ✨ 功能特性

- **智能食谱问答**：支持菜品推荐、详细做法、食材查询等多种问法
- **混合检索**：向量检索 + BM25 关键词检索，RRF 算法重排，支持分类/难度过滤
- **查询路由与重写**：LLM 自动判断查询类型并智能重写，提升检索效果
- **流式输出**：打字机式逐字输出，实时显示 AI 回复
- **来源引用**：每条回复展示参考的菜品来源（名称、分类、难度、相关性）
- **多轮对话**：保留历史上下文，支持追问
- **对话历史管理**：侧边栏管理多个会话，支持新建/切换/删除/清空
- **Markdown 渲染**：支持标题、列表、代码块、表格等完整语法
- **明亮毛玻璃主题**：OpenAI 经典聊天页面风格 + Glassmorphism 设计

## 🛠️ 技术栈

| 技术 | 版本 | 说明 |
|------|------|------|
| Next.js | 16.2.x | App Router + Turbopack |
| React | 19.2 | 最新 React |
| TypeScript | 5.x | 类型安全 |
| Tailwind CSS | v4 | CSS-first 配置 |
| LangChain.js | 1.x | RAG 框架 |
| @langchain/openai | 1.x | ChatOpenAI + OpenAIEmbeddings |
| @langchain/community | 1.x | BM25Retriever |
| MemoryVectorStore | - | 零依赖内存向量库 |

## 📦 安装与配置

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env.local`，填入你的 AIHubMix API Key：

```bash
cp .env.example .env.local
```

```env
# AIHubMix API 配置（在 https://aihubmix.com 申请）
AIHUBMIX_API_KEY=your-api-key-here
AIHUBMIX_BASE_URL=https://aihubmix.com/v1

# 模型配置
CHAT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small

# RAG 配置
TOP_K=3
TEMPERATURE=0.1
MAX_TOKENS=2048
```

### 3. 启动开发服务器

```bash
npm run dev
```

访问 [http://localhost:3000](http://localhost:3000)

首次访问时会自动构建知识库（需调用 Embedding API 对 323 道菜谱进行向量化，约 30-60 秒），之后会从 `.data/vector-store.json` 缓存加载。

## 🏗️ 项目结构

```
├── app/
│   ├── api/
│   │   ├── chat/route.ts          # 流式聊天 SSE 接口
│   │   └── knowledge-base/route.ts # 知识库管理接口
│   ├── globals.css                # Tailwind v4 + 毛玻璃样式
│   ├── layout.tsx                 # 根布局
│   └── page.tsx                   # 聊天主页
├── components/
│   ├── chat/                      # 聊天组件
│   └── ui/                        # 通用 UI 组件
├── lib/
│   ├── rag/                       # RAG 核心模块
│   │   ├── config.ts              # 配置
│   │   ├── types.ts               # 类型定义
│   │   ├── data-preparation.ts    # 数据准备（分块、元数据）
│   │   ├── index-construction.ts  # 索引构建（MemoryVectorStore）
│   │   ├── retrieval.ts           # 混合检索 + RRF 重排
│   │   ├── generation.ts          # LLM 生成（路由、重写、流式）
│   │   ├── rag-system.ts          # 主编排
│   │   └── rag-instance.ts        # 单例管理
│   ├── store/chat-store.ts        # 对话历史管理
│   └── utils.ts                   # 工具函数
├── data/dishes/                   # 323 个食谱 Markdown
└── .env.local                     # 环境变量
```

## 🔌 接口可扩展性

系统通过环境变量配置 API，可无缝切换到其他兼容 OpenAI 的接口：

- 修改 `AIHUBMIX_BASE_URL` 指向其他服务
- 修改 `CHAT_MODEL` 和 `EMBEDDING_MODEL` 为目标服务支持的模型

兼容的服务包括：OpenAI 官方、AIHubMix、Moonshot、DeepSeek、硅基流动等。

## 📝 使用示例

- "推荐几个简单的素菜" → 列表推荐
- "可乐鸡翅怎么做" → 详细分步指导
- "有什么汤品" → 分类列表
- "红烧肉的食材有哪些" → 食材信息

## 📄 License

MIT
