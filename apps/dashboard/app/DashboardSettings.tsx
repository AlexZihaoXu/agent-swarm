'use client';

import { Button, Dropdown, Header, Label, Separator } from '@heroui/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LuCheck } from 'react-icons/lu';
import { METRICS_RANGES } from '@/lib/gateway';

interface MenuOption {
  key: string;
  label: string;
  /** Optional subtle right-aligned hint (e.g., "12h"). */
  hint?: string;
}
interface MenuSection {
  key: string;
  heading: string;
  selectedKey?: string;
  items: MenuOption[];
}

/** Page-wide right-click settings for the dashboard's metric graphs. The
 *  provider owns the state and registers a single document-level contextmenu
 *  listener scoped to its wrapper ref — so right-click anywhere inside the
 *  dashboard (graphs, cards, padding, white space) opens the same menu.
 *
 *  The menu is suppressed when (a) a descendant already handled the
 *  right-click (e.preventDefault), or (b) the target is a text input /
 *  contenteditable surface where the browser's own menu is the right answer. */
export interface DashboardSettings {
  rangeKey: string;
  rangeHours: number;
  rangeLabel: string;
  tokensSortBy: 'tokens' | 'name';
  showCostLine: boolean;
  smoothResource: boolean;
}

const Ctx = createContext<DashboardSettings | null>(null);

export function useDashboardSettings(): DashboardSettings {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardSettings outside <DashboardSettingsProvider>');
  return v;
}

export function DashboardSettingsProvider({ children }: { children: ReactNode }) {
  const [rangeKey, setRangeKey] = useState<string>('12h');
  const [tokensSortBy, setTokensSortBy] = useState<'tokens' | 'name'>('tokens');
  const [showCostLine, setShowCostLine] = useState<boolean>(true);
  const [smoothResource, setSmoothResource] = useState<boolean>(true);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const range = METRICS_RANGES.find((r) => r.key === rangeKey) ?? METRICS_RANGES[0]!;

  // Document-level contextmenu so we also catch clicks on the surrounding
  // <main> padding / page background — the wrapper div alone wouldn't, since
  // those clicks target main (a parent of the wrapper).
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!rootRef.current?.contains(target)) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);
  const close = useCallback(() => setPos(null), []);

  const sections: MenuSection[] = [
    {
      key: 'range',
      heading: 'Time range',
      selectedKey: rangeKey,
      items: METRICS_RANGES.map((r) => ({ key: r.key, label: r.label, hint: r.key })),
    },
    {
      key: 'sort',
      heading: 'Tokens per agent',
      selectedKey: tokensSortBy,
      items: [
        { key: 'tokens', label: 'Sort by tokens (high→low)' },
        { key: 'name', label: 'Sort by name (A→Z)' },
      ],
    },
    {
      key: 'cost',
      heading: 'Tokens & cost',
      selectedKey: showCostLine ? 'on' : 'off',
      items: [
        { key: 'on', label: 'Show cost line' },
        { key: 'off', label: 'Hide cost line' },
      ],
    },
    {
      key: 'smooth',
      heading: 'Resource charts',
      selectedKey: smoothResource ? 'on' : 'off',
      items: [
        { key: 'on', label: 'Smooth lines (monotone)' },
        { key: 'off', label: 'Straight lines (linear)' },
      ],
    },
  ];

  const onSelect = (sk: string, ik: string) => {
    if (sk === 'range') setRangeKey(ik);
    else if (sk === 'sort') setTokensSortBy(ik === 'name' ? 'name' : 'tokens');
    else if (sk === 'cost') setShowCostLine(ik === 'on');
    else if (sk === 'smooth') setSmoothResource(ik === 'on');
  };

  // Flat id → {sectionKey, itemKey} lookup so a single onAction can decode
  // which group + value the user picked.
  const lookup = new Map<string, { sectionKey: string; itemKey: string }>();
  for (const s of sections) {
    for (const it of s.items)
      lookup.set(`${s.key}:${it.key}`, { sectionKey: s.key, itemKey: it.key });
  }

  const value: DashboardSettings = {
    rangeKey,
    rangeHours: range.hours,
    rangeLabel: range.label,
    tokensSortBy,
    showCostLine,
    smoothResource,
  };

  return (
    <Ctx.Provider value={value}>
      <div ref={rootRef} className="contents">
        {children}
      </div>
      <Dropdown isOpen={pos !== null} onOpenChange={(o) => !o && close()}>
        <Button
          aria-hidden="true"
          excludeFromTabOrder
          style={{
            position: 'fixed',
            left: pos?.x ?? 0,
            top: pos?.y ?? 0,
            width: 0,
            height: 0,
            minHeight: 0,
            padding: 0,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />
        <Dropdown.Popover placement="bottom end" className="min-w-52">
          <Dropdown.Menu
            onAction={(key) => {
              const hit = lookup.get(String(key));
              if (hit) onSelect(hit.sectionKey, hit.itemKey);
              close();
            }}
          >
            {sections.map((s, sIdx) => (
              <Dropdown.Section key={s.key}>
                {sIdx > 0 && <Separator />}
                <Header>{s.heading}</Header>
                {s.items.map((it) => {
                  const id = `${s.key}:${it.key}`;
                  const isSel = s.selectedKey === it.key;
                  return (
                    <Dropdown.Item id={id} key={id} textValue={it.label}>
                      <span className="flex w-4 items-center justify-center">
                        {isSel && <LuCheck className="text-accent size-4 shrink-0" />}
                      </span>
                      <Label>{it.label}</Label>
                      {it.hint && (
                        <span className="text-muted/70 ml-auto pl-2 text-[11px] tabular-nums">
                          {it.hint}
                        </span>
                      )}
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Section>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </Ctx.Provider>
  );
}
