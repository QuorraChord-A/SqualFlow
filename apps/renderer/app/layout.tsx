import type { Metadata } from 'next';
import '@xyflow/react/dist/style.css';
import './globals.css';
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: 'SquadFlow - AI Squad Orchestration',
  description: 'AgentSDK-based AI Squad Orchestration Platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        {/* Resolve the saved theme preference before first paint to prevent a theme flash. */}
        <script dangerouslySetInnerHTML={{
          __html: `(function(){try{var p=localStorage.getItem('squadflow-theme')||'system';var v=['system','dark','light','dark-emerald'];if(v.indexOf(p)<0)p='system';var t=p==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;var e=document.documentElement;e.dataset.theme=t;e.dataset.themePreference=p;e.classList.toggle('dark',t!=='light')}catch(e){}})()`
        }} />
      </head>
      <body className="h-screen w-screen overflow-hidden">
        <TooltipProvider delay={300}>
          {children}
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
