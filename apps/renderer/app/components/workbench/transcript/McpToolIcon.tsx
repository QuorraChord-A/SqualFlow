import { useEffect, useState } from "react";
import styles from "./transcript.module.css";
import type { ToolPresentation } from "./types";

type McpToolIconProps = {
  presentation: ToolPresentation;
  size?: number;
};

function isSafeIconSource(src: string): boolean {
  return /^(?:https?:|data:image\/)/iu.test(src);
}

function FallbackMcpIcon({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      className={styles.mcpIcon}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
    >
      <rect x="1.25" y="1.25" width="15.5" height="15.5" rx="4.5" fill="currentColor" opacity="0.14" />
      <path
        d="M5 6.25h3.25v3.25H5V6.25Zm4.75 0H13v3.25H9.75V6.25ZM5 10.5h3.25v1.25H5V10.5Zm4.75 0H13v1.25H9.75V10.5Z"
        fill="currentColor"
      />
      <path d="M8.25 9.5h1.5v3h-1.5v-3Z" fill="currentColor" opacity="0.72" />
    </svg>
  );
}

export default function McpToolIcon({ presentation, size = 18 }: McpToolIconProps) {
  const candidates = [
    ...(presentation.mcp?.icons ?? []),
    ...(presentation.mcp?.serverIcons ?? []),
  ].filter((icon) => isSafeIconSource(icon.src));
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const icon = candidates.find((candidate) => candidate.src !== failedSource);

  useEffect(() => {
    setFailedSource(null);
  }, [presentation.mcp?.server, presentation.mcp?.tool]);

  if (!icon) return <FallbackMcpIcon size={size} />;

  return (
    <img
      src={icon.src}
      alt=""
      className={styles.mcpIcon}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailedSource(icon.src)}
    />
  );
}
