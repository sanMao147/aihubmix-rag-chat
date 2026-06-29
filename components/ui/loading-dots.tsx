/**
 * 加载动画组件：三点跳动
 */
export function LoadingDots({ className }: { className?: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${className || ""}`}>
      <span className="loading-dot inline-block h-2 w-2 rounded-full bg-indigo-500" />
      <span className="loading-dot inline-block h-2 w-2 rounded-full bg-violet-500" />
      <span className="loading-dot inline-block h-2 w-2 rounded-full bg-pink-500" />
    </div>
  );
}
