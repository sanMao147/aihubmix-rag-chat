import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 毛玻璃卡片通用组件
 */
export function GlassCard({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "strong" | "subtle";
}) {
  const glassClass =
    variant === "strong"
      ? "glass-strong"
      : variant === "subtle"
        ? "glass-subtle"
        : "glass";

  return (
    <div className={cn(glassClass, "rounded-2xl shadow-lg", className)}>
      {children}
    </div>
  );
}
