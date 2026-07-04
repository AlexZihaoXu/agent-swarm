'use client';

import { ListBox, Select } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, type ReactNode } from 'react';
import { LuChevronDown, LuLayoutGrid, LuArrowDownWideNarrow } from 'react-icons/lu';
import type { Agent, Group } from '@/lib/gateway';
import { AgentCard } from './AgentCard';
import { useFleetLayout, type GroupBy, type SortBy } from '@/lib/useFleetLayout';

/** Shared ease-out-expo curve — matches the rest of the dashboard. */
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const GROUP_OPTS: { key: GroupBy; label: string }[] = [
  { key: 'none', label: 'None' },
  { key: 'group', label: 'Group' },
  { key: 'status', label: 'Status' },
];
const SORT_OPTS: { key: SortBy; label: string }[] = [
  { key: 'name', label: 'Name (A→Z)' },
  { key: 'created', label: 'Recently created' },
  { key: 'status', label: 'Status' },
];

interface Section {
  key: string;
  label: string;
  agents: Agent[];
  /** A single, unlabelled section (groupBy=none, nothing pinned) → flat grid. */
  plain?: boolean;
}

const displayName = (a: Agent) => a.username || a.id;

function sortAgents(list: Agent[], sortBy: SortBy): Agent[] {
  const byName = (a: Agent, b: Agent) =>
    displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' });
  const copy = [...list];
  if (sortBy === 'created') copy.sort((a, b) => b.createdAt - a.createdAt || byName(a, b));
  else if (sortBy === 'status')
    copy.sort((a, b) => {
      const rank = (x: Agent) => (x.status === 'running' ? 0 : 1);
      return rank(a) - rank(b) || byName(a, b);
    });
  else copy.sort(byName);
  return copy;
}

function buildSections(
  agents: Agent[],
  groups: Group[],
  groupBy: GroupBy,
  pinned: Set<string>,
  sortBy: SortBy,
): Section[] {
  const sort = (l: Agent[]) => sortAgents(l, sortBy);
  const pinnedAgents = agents.filter((a) => pinned.has(a.id));
  const rest = agents.filter((a) => !pinned.has(a.id));
  const sections: Section[] = [];

  if (pinnedAgents.length)
    sections.push({ key: '__pinned__', label: 'Pinned', agents: sort(pinnedAgents) });

  if (groupBy === 'group') {
    const known = new Set(groups.map((g) => g.id));
    for (const g of [...groups].sort((a, b) => a.name.localeCompare(b.name))) {
      const members = rest.filter((a) => (a.groups ?? []).includes(g.id));
      if (members.length)
        sections.push({ key: `group:${g.id}`, label: g.name, agents: sort(members) });
    }
    // Anything not in a still-existing group falls under Ungrouped.
    const ungrouped = rest.filter((a) => !(a.groups ?? []).some((gid) => known.has(gid)));
    if (ungrouped.length)
      sections.push({ key: 'group:__ungrouped__', label: 'Ungrouped', agents: sort(ungrouped) });
  } else if (groupBy === 'status') {
    const running = rest.filter((a) => a.status === 'running');
    const stopped = rest.filter((a) => a.status !== 'running');
    if (running.length)
      sections.push({ key: 'status:running', label: 'Running', agents: sort(running) });
    if (stopped.length)
      sections.push({ key: 'status:stopped', label: 'Stopped', agents: sort(stopped) });
  } else {
    if (rest.length)
      sections.push({ key: '__all__', label: 'Agents', agents: sort(rest), plain: true });
  }
  return sections;
}

/** A compact inline picker for the control bar. */
function LayoutSelect<T extends string>({
  icon,
  label,
  value,
  options,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(v) => onChange(String(v) as T)}
      className="w-auto min-w-0"
    >
      {/* pl-2.5 only — the built-in `pe-7` reserves room for the absolutely-
          positioned indicator; a px-* utility would override it and the arrow
          would overlap the value. */}
      <Select.Trigger className="h-8 gap-1.5 pl-2.5 text-sm">
        <span className="text-muted flex items-center gap-1.5">
          {icon}
          <span className="hidden sm:inline">{label}</span>
        </span>
        <Select.Value className="flex-none font-medium" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="min-w-40">
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.key} id={o.key} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * The agent fleet, arranged into labelled, collapsible sections. Group by
 * group/status (or none), sort within each section, and pin agents to a
 * "Pinned" section that always sits on top. All preferences persist locally
 * (see useFleetLayout). Transitions are animated with framer-motion.
 */
export function FleetView({
  agents,
  groups,
  onChanged,
  taken,
}: {
  agents: Agent[];
  groups: Group[];
  onChanged: () => void;
  taken: string[];
}) {
  const layout = useFleetLayout();
  const { groupBy, sortBy, pinned, isPinned, togglePin, isCollapsed, toggleCollapsed } = layout;

  const sections = useMemo(
    () => buildSections(agents, groups, groupBy, pinned, sortBy),
    [agents, groups, groupBy, pinned, sortBy],
  );

  const flat = sections.length === 1 && sections[0]?.plain;

  const cardGrid = (list: Agent[]) => (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <AnimatePresence mode="popLayout">
        {list.map((a, i) => (
          <motion.div
            key={a.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.4, ease: EASE, delay: Math.min(i, 8) * 0.05 }}
          >
            <AgentCard
              agent={a}
              onChanged={onChanged}
              taken={taken}
              pinned={isPinned(a.id)}
              onTogglePin={() => togglePin(a.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Control bar */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <LayoutSelect
          icon={<LuLayoutGrid className="size-3.5" />}
          label="Group by"
          value={groupBy}
          options={GROUP_OPTS}
          onChange={layout.setGroupBy}
        />
        <LayoutSelect
          icon={<LuArrowDownWideNarrow className="size-3.5" />}
          label="Sort by"
          value={sortBy}
          options={SORT_OPTS}
          onChange={layout.setSortBy}
        />
      </div>

      {flat ? (
        cardGrid(sections[0]!.agents)
      ) : (
        <motion.div layout className="space-y-6">
          <AnimatePresence initial={false}>
            {sections.map((s) => {
              const collapsed = isCollapsed(s.key);
              return (
                <motion.section
                  key={s.key}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.3, ease: EASE }}
                >
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(s.key)}
                    aria-expanded={!collapsed}
                    className="group text-foreground mb-3 flex w-full items-center gap-2 text-left"
                  >
                    <LuChevronDown
                      className={`text-muted size-4 shrink-0 transition-transform duration-300 ${
                        collapsed ? '-rotate-90' : ''
                      }`}
                    />
                    <span className="text-sm font-semibold tracking-tight">{s.label}</span>
                    <span className="text-muted bg-surface-secondary rounded-full px-2 py-0.5 text-xs tabular-nums">
                      {s.agents.length}
                    </span>
                    <span className="border-separator ml-1 h-px flex-1 border-t" />
                  </button>
                  {/* grid-rows 1fr↔0fr collapses smoothly and sizes to content. */}
                  <div
                    className={`grid transition-[grid-template-rows] duration-300 ease-out ${
                      collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'
                    }`}
                  >
                    <div className="overflow-hidden">{cardGrid(s.agents)}</div>
                  </div>
                </motion.section>
              );
            })}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
