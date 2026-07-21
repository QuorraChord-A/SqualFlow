'use client';

import { useEffect, useRef, useState } from 'react';

const REVEAL_INTERVAL_MS = 72;

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Reveals a server-updated Flow name without changing its accessible label. */
export function useFlowNameReveal(name: string) {
  const [displayName, setDisplayName] = useState(name);
  const previousName = useRef(name);

  useEffect(() => {
    if (name === previousName.current) return;
    previousName.current = name;

    const parts = graphemes(name);
    if (parts.length <= 1 || prefersReducedMotion()) {
      setDisplayName(name);
      return;
    }

    let visibleCount = 1;
    setDisplayName(parts[0] ?? '');
    const timer = window.setInterval(() => {
      visibleCount += 1;
      setDisplayName(parts.slice(0, visibleCount).join(''));
      if (visibleCount >= parts.length) window.clearInterval(timer);
    }, REVEAL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [name]);

  return displayName;
}
