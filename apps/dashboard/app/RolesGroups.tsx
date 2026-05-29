'use client';

import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  Input,
  Label,
  TextArea,
  TextField,
  toast,
} from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { LuPencil, LuPlus, LuTrash2, LuX } from 'react-icons/lu';
import type { Capability, CapabilityInfo, Role } from '@/lib/gateway';

/**
 * CRUD card for a global registry (roles or groups) — list with inline edit +
 * delete, and an add/edit form. Used on the Settings page; both registries share
 * the same {name, description} shape.
 */
export function RegistryCard({
  title,
  description,
  noun,
  list,
  onCreate,
  onUpdate,
  onDelete,
  capabilities,
}: {
  title: string;
  description: string;
  noun: string; // e.g. "role" / "group"
  list: () => Promise<Role[]>;
  onCreate: (name: string, desc: string, permissions?: Capability[]) => Promise<unknown>;
  onUpdate: (
    id: string,
    patch: { name?: string; description?: string; permissions?: Capability[] },
  ) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** If given, the editor shows permission toggles (roles grant capabilities;
   *  groups don't, so groups omit this). */
  capabilities?: CapabilityInfo[];
}) {
  const [items, setItems] = useState<Role[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // id, or '' = new
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [perms, setPerms] = useState<Capability[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    list()
      .then(setItems)
      .catch(() => setItems((i) => i ?? []));
  }, [list]);
  useEffect(() => reload(), [reload]);

  const resetForm = () => {
    setEditing(null);
    setName('');
    setDesc('');
    setPerms([]);
  };
  const startNew = () => {
    setEditing('');
    setName('');
    setDesc('');
    setPerms([]);
  };
  const startEdit = (r: Role) => {
    setEditing(r.id);
    setName(r.name);
    setDesc(r.description);
    setPerms(r.permissions ?? []);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      if (!name.trim()) return;
      const permsArg = capabilities ? perms : undefined;
      if (editing) await onUpdate(editing, { name, description: desc, permissions: permsArg });
      else await onCreate(name, desc, permsArg);
      resetForm();
    });

  return (
    <Card>
      <Card.Header>
        <Card.Title>{title}</Card.Title>
        <Card.Description>{description}</Card.Description>
      </Card.Header>
      <Card.Content className="mt-2 space-y-2">
        <AnimatePresence initial={false}>
          {items?.map((r) => (
            <motion.div
              key={r.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="border-separator flex items-start gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.name}</div>
                <div className="text-muted text-xs whitespace-pre-wrap">
                  {r.description || <span className="italic">no description</span>}
                </div>
                {capabilities && r.permissions && r.permissions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.permissions.map((k) => (
                      <Chip key={k} size="sm" variant="soft" color="warning">
                        {capabilities.find((c) => c.key === k)?.label ?? k}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
              <button
                aria-label={`Edit ${r.name}`}
                className="text-muted hover:text-foreground focus-visible:ring-accent shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => startEdit(r)}
              >
                <LuPencil className="size-4" />
              </button>
              <button
                aria-label={`Delete ${r.name}`}
                className="text-muted hover:text-danger focus-visible:ring-accent shrink-0 rounded focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => void run(() => onDelete(r.id))}
              >
                <LuTrash2 className="size-4" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>

        {items && items.length === 0 && editing === null && (
          <p className="text-muted text-sm">No {noun}s yet.</p>
        )}

        {editing !== null ? (
          <div className="border-separator space-y-2 rounded-lg border border-dashed p-3">
            <TextField value={name} onChange={setName} isRequired>
              <Label className="text-xs">Name</Label>
              <Input placeholder={`${noun} name`} autoFocus />
            </TextField>
            <TextField value={desc} onChange={setDesc}>
              <Label className="text-xs">Description</Label>
              <TextArea rows={3} placeholder={`What this ${noun} is for…`} />
            </TextField>
            {capabilities && capabilities.length > 0 && (
              <CheckboxGroup
                className="gap-2"
                value={perms}
                onChange={(v) => setPerms(v as Capability[])}
              >
                <Label className="text-xs">Special permissions</Label>
                {capabilities.map((c) => (
                  <Checkbox key={c.key} value={c.key}>
                    <Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control>
                    <Checkbox.Content>
                      <Label className="text-sm">{c.label}</Label>
                      <Description className="text-xs">{c.description}</Description>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </CheckboxGroup>
            )}
            <div className="flex gap-2">
              <Button size="sm" isDisabled={busy || !name.trim()} onPress={submit}>
                {editing ? 'Save' : 'Add'}
              </Button>
              <Button size="sm" variant="tertiary" isDisabled={busy} onPress={resetForm}>
                <LuX className="size-4" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onPress={startNew} className="gap-1.5">
            <LuPlus className="size-4" /> Add {noun}
          </Button>
        )}
      </Card.Content>
    </Card>
  );
}

/** Toggleable-chip multi-select for assigning roles/groups to an agent. */
export function RegistrySelect({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  options: Role[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {options.length === 0 ? (
        <p className="text-muted text-xs">{hint}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = value.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                title={o.description}
                onClick={() => toggle(o.id)}
                className={`focus-visible:ring-accent rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none ${
                  on
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-separator text-muted hover:text-foreground'
                }`}
              >
                {o.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
