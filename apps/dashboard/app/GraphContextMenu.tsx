'use client';

import { Button, Dropdown, Header, Label, Separator } from '@heroui/react';
import { LuCheck } from 'react-icons/lu';
import { useCallback, useState, type ReactNode } from 'react';

/** A right-click context menu wrapper for dashboard graphs. Renders `children`
 *  inside a div that intercepts contextmenu events, and pops a HeroUI
 *  Dropdown at the cursor with the given option sections.
 *
 *  Pattern mirrors AgentCard: anchored to an invisible fixed-position button
 *  the menu opens against. Single shared component so every graph uses the
 *  same look and keyboard model.
 *
 *  Each `Section` carries a heading, a list of items, and the currently
 *  selected item key — the menu paints a check mark next to it. Picking an
 *  item calls onSelect with the section + item keys; the menu closes itself. */
export interface GraphContextOption {
  key: string;
  label: string;
  /** Optional subtle right-aligned hint (e.g., "12h", "default"). */
  hint?: string;
}

export interface GraphContextSection {
  /** Section heading shown above the items. */
  heading: string;
  /** Stable identifier so onSelect can disambiguate which group changed. */
  key: string;
  items: GraphContextOption[];
  /** The currently selected item key — gets a check mark. */
  selectedKey?: string;
}

export function GraphContextMenu({
  sections,
  onSelect,
  children,
  className,
}: {
  sections: GraphContextSection[];
  onSelect: (sectionKey: string, itemKey: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const open = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPos({ x: e.clientX, y: e.clientY });
  }, []);
  const close = useCallback(() => setPos(null), []);

  // Build a flat id → {sectionKey, itemKey} map so the single onAction can
  // look up which group + value the user picked.
  const lookup = new Map<string, { sectionKey: string; itemKey: string }>();
  for (const s of sections) {
    for (const it of s.items)
      lookup.set(`${s.key}:${it.key}`, { sectionKey: s.key, itemKey: it.key });
  }

  return (
    <>
      <div onContextMenu={open} className={className}>
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
        <Dropdown.Popover placement="bottom end" className="min-w-44">
          <Dropdown.Menu
            onAction={(key) => {
              const k = String(key);
              const hit = lookup.get(k);
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
    </>
  );
}
