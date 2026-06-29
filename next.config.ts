import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 将 LangChain 相关包标记为外部依赖，避免 Turbopack 打包问题
  serverExternalPackages: [
    "langchain",
    "@langchain/core",
    "@langchain/openai",
    "@langchain/community",
  ],
  // 允许 Turbopack 处理这些包
  turbopack: {
    rules: {
      "*.node": {
        loaders: ["@vercel/turbopack-next/node-loader"],
      },
    },
  },
};

export default nextConfig;
