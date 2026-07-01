'use client';

import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
import { useEffect, useRef, type MutableRefObject } from 'react';

export interface MilkdownApi {
  /** Serialize the current document back to markdown. */
  getMarkdown: () => string;
}

/**
 * WYSIWYG markdown editor (Milkdown's Crepe). It's imperative — created once on
 * mount with `defaultValue` — so the parent reads the current markdown through
 * `apiRef` rather than a controlled `value`. We use a plain ref *prop* (not a
 * React ref) because next/dynamic, which lazy-loads this editor, doesn't forward
 * refs. Lazy-loaded so ProseMirror + the theme CSS stay out of the main bundle.
 */
export default function MilkdownEditor({
  defaultValue,
  apiRef,
}: {
  defaultValue: string;
  apiRef: MutableRefObject<MilkdownApi | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let crepe: Crepe | null = new Crepe({ root: host, defaultValue });
    apiRef.current = { getMarkdown: () => crepe?.getMarkdown() ?? defaultValue };
    void crepe.create().catch(() => {});
    return () => {
      apiRef.current = null;
      const c = crepe;
      crepe = null;
      void c?.destroy().catch(() => {});
    };
    // Created once with the initial value; the parent recreates it (via a fresh
    // mount) whenever it switches back from source mode with new content.
  }, []);
  return <div ref={hostRef} className="milkdown-host h-full overflow-auto" />;
}
