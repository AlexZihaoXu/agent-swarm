'use client';

import { Button, Tag, TagGroup, type Key } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { httpOrigin, wsOrigin } from '@/lib/gateway';

interface Session {
  name: string;
  title: string;
}

/**
 * Live multi-session terminal for one agent. Talks the same protocol as the
 * in-container supervisor (JSON {type:'data'|'resize'} up, raw pty bytes down),
 * but through the gateway proxy at /a/:id/terminal/ — so the dashboard never
 * needs a direct route to the container.
 */
export function TerminalPanel({ agentId }: { agentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeRef = useRef<string | null>(null);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const httpBase = `${httpOrigin()}/a/${agentId}/terminal/`;
  const wsBase = `${wsOrigin()}/a/${agentId}/terminal/`;

  const listSessions = useCallback(async (): Promise<Session[]> => {
    const r = await fetch(`${httpBase}api/sessions`);
    return (await r.json()) as Session[];
  }, [httpBase]);

  const attach = useCallback(
    (name: string) => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      activeRef.current = name;
      setActive(name);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      term.reset();
      fit.fit();
      const url =
        `${wsBase}ws?session=${encodeURIComponent(name)}` + `&cols=${term.cols}&rows=${term.rows}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => term.focus();
      ws.onmessage = (e: MessageEvent) => term.write(e.data as string);
    },
    [wsBase],
  );

  const refresh = useCallback(async () => {
    const s = await listSessions();
    setSessions(s);
    if (!s.find((x) => x.name === activeRef.current) && s[0]) attach(s[0].name);
  }, [listSessions, attach]);

  const newSession = useCallback(async () => {
    const r = await fetch(`${httpBase}api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { name } = (await r.json()) as { name: string };
    await refresh();
    attach(name);
  }, [httpBase, refresh, attach]);

  const closeSession = useCallback(
    async (name: string) => {
      await fetch(`${httpBase}api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await refresh();
    },
    [httpBase, refresh],
  );

  // Initialise xterm once (dynamic import keeps it out of SSR).
  useEffect(() => {
    let disposed = false;
    let onResize: (() => void) | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !containerRef.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        scrollback: 10000,
        theme: { background: '#16130e' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      term.onData((d: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data: d }));
      });
      termRef.current = term;
      fitRef.current = fit;

      let rt: ReturnType<typeof setTimeout>;
      onResize = () => {
        clearTimeout(rt);
        rt = setTimeout(() => {
          fit.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        }, 150);
      };
      window.addEventListener('resize', onResize);

      const s = await listSessions();
      setSessions(s);
      if (s[0]) attach(s[0].name);
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener('resize', onResize);
      wsRef.current?.close();
      termRef.current?.dispose();
    };
    // Run once on mount; attach/listSessions are stable for a given agent.
  }, []);

  const onSelect = (keys: 'all' | Set<Key>) => {
    if (keys === 'all') return;
    const next = [...keys][0];
    if (next != null && String(next) !== active) attach(String(next));
  };
  const onRemove = (keys: Set<Key>) => {
    for (const k of keys) void closeSession(String(k));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-separator flex items-center gap-2 border-b px-3 py-2">
        <TagGroup
          aria-label="Terminal sessions"
          selectionMode="single"
          selectedKeys={active ? new Set([active]) : new Set()}
          onSelectionChange={onSelect}
          onRemove={onRemove}
        >
          <TagGroup.List>
            {sessions.map((s) => (
              <Tag key={s.name} id={s.name} textValue={s.name}>
                {s.name}
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
        <Button className="ml-auto" size="sm" variant="secondary" onPress={newSession}>
          + New
        </Button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 p-2" style={{ background: '#16130e' }} />
    </div>
  );
}
