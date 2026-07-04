'use client';

import { useCallback, useEffect, useState } from 'react';

/** How the fleet is partitioned into labelled sections. */
export type GroupBy = 'none' | 'group' | 'status';
/** Order of cards within each section. */
export type SortBy = 'name' | 'created' | 'status';

export interface FleetLayout {
  groupBy: GroupBy;
  setGroupBy: (v: GroupBy) => void;
  sortBy: SortBy;
  setSortBy: (v: SortBy) => void;
  /** Agent ids pinned "always on top" (surfaced in a Pinned section). */
  pinned: Set<string>;
  isPinned: (id: string) => boolean;
  togglePin: (id: string) => void;
  /** Section keys the user has collapsed (all sections expand by default). */
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  /** True once localStorage has been read (first paint uses defaults). */
  hydrated: boolean;
}

const KEY = 'swarm.fleet.layout.v1';
const GROUP_BYS: GroupBy[] = ['none', 'group', 'status'];
const SORT_BYS: SortBy[] = ['name', 'created', 'status'];

interface Persisted {
  groupBy: GroupBy;
  sortBy: SortBy;
  pinned: string[];
  collapsed: string[];
}

function load(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      groupBy: GROUP_BYS.includes(p.groupBy as GroupBy) ? p.groupBy : undefined,
      sortBy: SORT_BYS.includes(p.sortBy as SortBy) ? p.sortBy : undefined,
      pinned: Array.isArray(p.pinned) ? p.pinned.filter((x) => typeof x === 'string') : undefined,
      collapsed: Array.isArray(p.collapsed)
        ? p.collapsed.filter((x) => typeof x === 'string')
        : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Fleet dashboard layout preferences (grouping, sorting, pinned agents,
 * collapsed sections), persisted to localStorage — client-only, per browser.
 * Defaults render on the server / first paint; the stored values are applied
 * once mounted (see `hydrated`) so SSR and the client agree on the first render.
 */
export function useFleetLayout(): FleetLayout {
  const [groupBy, setGroupByState] = useState<GroupBy>('none');
  const [sortBy, setSortByState] = useState<SortBy>('name');
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Read persisted prefs once on mount (localStorage is client-only).
  useEffect(() => {
    const p = load();
    if (p.groupBy) setGroupByState(p.groupBy);
    if (p.sortBy) setSortByState(p.sortBy);
    if (p.pinned) setPinned(new Set(p.pinned));
    if (p.collapsed) setCollapsed(new Set(p.collapsed));
    setHydrated(true);
  }, []);

  // Persist on any change (only after hydration, so we don't clobber storage
  // with the defaults before we've read it).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          groupBy,
          sortBy,
          pinned: [...pinned],
          collapsed: [...collapsed],
        } satisfies Persisted),
      );
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [hydrated, groupBy, sortBy, pinned, collapsed]);

  const togglePin = useCallback((id: string) => {
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return {
    groupBy,
    setGroupBy: setGroupByState,
    sortBy,
    setSortBy: setSortByState,
    pinned,
    isPinned: useCallback((id: string) => pinned.has(id), [pinned]),
    togglePin,
    isCollapsed: useCallback((key: string) => collapsed.has(key), [collapsed]),
    toggleCollapsed,
    hydrated,
  };
}
