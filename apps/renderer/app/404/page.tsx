import Link from 'next/link';

export default function NotFoundPage() {
  return (
    <div className="h-screen flex flex-col items-center justify-center bg-background">
      <h1 className="text-6xl font-bold text-muted-foreground/30 mb-4">404</h1>
      <p className="text-muted-foreground text-lg mb-2">Flow 不存在</p>
      <p className="text-muted-foreground text-sm mb-6">该 SquadFlow 可能已被删除或链接错误</p>
      <Link
        href="/"
        className="px-4 py-2 bg-primary/10 border border-primary/30 text-primary rounded-lg text-sm hover:bg-primary/20 transition-colors"
      >
        返回首页
      </Link>
    </div>
  );
}
