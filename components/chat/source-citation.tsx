"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, UtensilsCrossed } from "lucide-react";
import type { SourceDoc } from "@/lib/rag/types";
import { GlassCard } from "@/components/ui/glass-card";

/**
 * 参考来源折叠卡片
 * 展示检索到的菜品名称、分类、难度、相关性分数
 */
export function SourceCitation({ sources }: { sources: SourceDoc[] }) {
  const [expanded, setExpanded] = useState(false);

  if (sources.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-indigo-500"
      >
        <UtensilsCrossed className="h-3.5 w-3.5" />
        <span>参考来源（{sources.length}）</span>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 flex flex-wrap gap-2">
          {sources.map((source, i) => (
            <GlassCard
              key={i}
              variant="subtle"
              className="flex items-center gap-2 px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium text-slate-700">
                  {source.dish_name}
                </span>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>{source.category}</span>
                  <span>·</span>
                  <span>{source.difficulty}</span>
                  {source.rrf_score > 0 && (
                    <>
                      <span>·</span>
                      <span>
                        相关性 {(source.rrf_score * 100).toFixed(1)}%
                      </span>
                    </>
                  )}
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </div>
  );
}
