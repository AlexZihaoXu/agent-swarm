'use client';

import {
  Button,
  Description,
  Dropdown,
  Header,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
  toast,
} from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LuCopy,
  LuDownload,
  LuEllipsisVertical,
  LuFile,
  LuFileArchive,
  LuFileText,
  LuFolder,
  LuFolderOpen,
  LuFolderPlus,
  LuHouse,
  LuPencil,
  LuSearch,
  LuTrash2,
  LuUpload,
} from 'react-icons/lu';
import {
  agentFileDownloadUrl,
  agentFolderZipUrl,
  deleteAgentFile,
  listAgentFiles,
  mkdirAgentFile,
  readAgentFile,
  renameAgentFile,
  uploadAgentFile,
  writeAgentFile,
  type DirView,
  type FileEntry,
} from '@/lib/gateway';

/** The path the agent itself sees for its home, used by "Copy path". */
const AGENT_HOME = '/home/agent';

/** Extensions we open in the built-in text editor; everything else downloads. */
const TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonc',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sh',
  'bash',
  'fish',
  'zsh',
  'csv',
  'tsv',
  'log',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'html',
  'htm',
  'css',
  'scss',
  'xml',
  'svg',
  'sql',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'go',
  'rs',
  'rb',
  'java',
  'php',
  'lua',
  'gitignore',
  'dockerfile',
  'makefile',
  'text',
]);
const NAMELESS_TEXT = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  '.gitignore',
  '.env',
]);
function isText(name: string): boolean {
  const lower = name.toLowerCase();
  if (NAMELESS_TEXT.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  return dot >= 0 && TEXT_EXT.has(lower.slice(dot + 1));
}

function fmtSize(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * Per-agent file explorer (Finder-style): browse the agent's home, upload /
 * download, make folders, rename, delete, and edit text files inline.
 */
export function FileExplorer({
  agentId,
  agentName,
  isOpen,
  onOpenChange,
}: {
  agentId: string;
  agentName: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [cwd, setCwd] = useState('');
  const [view, setView] = useState<DirView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ path: string; content: string; dirty: boolean } | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null); // entry name being renamed
  const [renameValue, setRenameValue] = useState('');
  const [newFolder, setNewFolder] = useState<string | null>(null); // null = not creating
  const [query, setQuery] = useState(''); // in-folder filter
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(
    (path: string) => {
      setLoading(true);
      listAgentFiles(agentId, path)
        .then((v) => {
          setView(v);
          setCwd(v.path);
        })
        .catch((e) => toast.warning(e instanceof Error ? e.message : 'Failed to list folder.'))
        .finally(() => setLoading(false));
    },
    [agentId],
  );

  // Open to Desktop by default (the agent's visible workspace); fall back to the
  // home root for agents that don't have a Desktop folder.
  const openDefault = useCallback(() => {
    setLoading(true);
    listAgentFiles(agentId, 'Desktop')
      .then((v) => {
        setView(v);
        setCwd(v.path);
        setLoading(false);
      })
      .catch(() => load(''));
  }, [agentId, load]);

  useEffect(() => {
    if (isOpen) {
      setEditing(null);
      setRenaming(null);
      setNewFolder(null);
      setQuery('');
      openDefault();
    }
  }, [isOpen, openDefault]);

  // Reset the filter whenever we change folders.
  useEffect(() => setQuery(''), [cwd]);

  const copyPath = (name: string) => {
    const full = `${AGENT_HOME}/${join(cwd, name)}`;
    navigator.clipboard
      .writeText(full)
      .then(() => toast.success('Path copied.'))
      .catch(() => toast.warning('Could not copy to clipboard.'));
  };
  const startRename = (name: string) => {
    setRenaming(name);
    setRenameValue(name);
  };
  const removeEntry = (e: FileEntry) => {
    if (confirm(`Delete "${e.name}"${e.dir ? ' and its contents' : ''}?`))
      void run(() => deleteAgentFile(agentId, join(cwd, e.name)));
  };

  // Right-click context-menu actions, keyed by Dropdown.Item id.
  const onMenuAction = (key: string, e: FileEntry) => {
    setMenu(null);
    const rel = join(cwd, e.name);
    if (key === 'open') openEntry(e);
    else if (key === 'download')
      window.location.href = e.dir
        ? agentFolderZipUrl(agentId, rel)
        : agentFileDownloadUrl(agentId, rel);
    else if (key === 'copy') copyPath(e.name);
    else if (key === 'rename') startRename(e.name);
    else if (key === 'delete') removeEntry(e);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      load(cwd);
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const openEntry = (e: FileEntry) => {
    if (e.dir) return load(join(cwd, e.name));
    if (isText(e.name)) {
      const path = join(cwd, e.name);
      readAgentFile(agentId, path)
        .then(({ content }) => setEditing({ path, content, dirty: false }))
        .catch((err) => toast.warning(err instanceof Error ? err.message : 'Failed to open file.'));
    } else {
      window.location.href = agentFileDownloadUrl(agentId, join(cwd, e.name));
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) await uploadAgentFile(agentId, cwd, f);
      toast.success(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}.`);
      load(cwd);
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const segments = cwd ? cwd.split('/') : [];
  const q = query.trim().toLowerCase();
  const entries = q
    ? (view?.entries ?? []).filter((e) => e.name.toLowerCase().includes(q))
    : (view?.entries ?? []);

  return (
    <Modal>
      <Modal.Backdrop isOpen={isOpen} onOpenChange={(o) => !o && onOpenChange(false)}>
        <Modal.Container placement="center">
          <Modal.Dialog className="flex h-[80vh] max-h-[88vh] flex-col sm:max-w-[760px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Files — {agentName}</Modal.Heading>
            </Modal.Header>
            <Modal.Body
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
              onContextMenu={(e) => e.preventDefault()}
            >
              {editing ? (
                <EditorPane
                  agentId={agentId}
                  editing={editing}
                  setEditing={setEditing}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <>
                  {/* Toolbar: breadcrumb + actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-muted flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
                      <button
                        className="hover:text-foreground flex items-center gap-1 rounded px-1.5 py-0.5"
                        onClick={() => load('')}
                      >
                        <LuHouse className="size-4" /> home
                      </button>
                      {segments.map((seg, i) => (
                        <span key={i} className="flex items-center gap-1">
                          <span className="text-muted/50">/</span>
                          <button
                            className="hover:text-foreground max-w-[10rem] truncate rounded px-1 py-0.5"
                            onClick={() => load(segments.slice(0, i + 1).join('/'))}
                          >
                            {seg}
                          </button>
                        </span>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="gap-1.5"
                      isDisabled={busy}
                      onPress={() => fileInput.current?.click()}
                    >
                      <LuUpload className="size-4" /> Upload
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      className="gap-1.5"
                      isDisabled={busy}
                      onPress={() => setNewFolder('')}
                    >
                      <LuFolderPlus className="size-4" /> New folder
                    </Button>
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => void onUpload(e.target.files)}
                    />
                  </div>

                  {newFolder !== null && (
                    <div className="border-separator flex items-center gap-2 rounded-lg border border-dashed p-2">
                      <LuFolder className="text-muted size-4 shrink-0" />
                      <Input
                        autoFocus
                        placeholder="folder name"
                        value={newFolder}
                        onChange={(e) => setNewFolder(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newFolder.trim()) {
                            void run(() => mkdirAgentFile(agentId, join(cwd, newFolder.trim())));
                            setNewFolder(null);
                          } else if (e.key === 'Escape') setNewFolder(null);
                        }}
                      />
                      <Button
                        size="sm"
                        isDisabled={busy || !newFolder.trim()}
                        onPress={() => {
                          void run(() => mkdirAgentFile(agentId, join(cwd, newFolder.trim())));
                          setNewFolder(null);
                        }}
                      >
                        Create
                      </Button>
                      <Button size="sm" variant="tertiary" onPress={() => setNewFolder(null)}>
                        Cancel
                      </Button>
                    </div>
                  )}

                  {/* Search within the current folder */}
                  <div className="relative w-full">
                    <LuSearch className="text-muted pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2" />
                    <Input
                      placeholder="Search this folder…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                      className="w-full pl-8"
                    />
                  </div>

                  {/* Listing */}
                  <div className="border-separator min-h-0 flex-1 overflow-y-auto rounded-lg border">
                    {loading ? (
                      <p className="text-muted p-6 text-center text-sm">Loading…</p>
                    ) : view && view.entries.length === 0 ? (
                      <p className="text-muted p-6 text-center text-sm">Empty folder.</p>
                    ) : entries.length === 0 ? (
                      <p className="text-muted p-6 text-center text-sm">No matches.</p>
                    ) : (
                      <ul className="divide-separator divide-y">
                        {entries.map((e) => (
                          <li
                            key={e.name}
                            className="hover:bg-surface-secondary/50 group flex items-center gap-3 px-3 py-2"
                            onContextMenu={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
                            }}
                          >
                            <span className="text-muted shrink-0">
                              {e.dir ? (
                                <LuFolder className="size-4 text-accent" />
                              ) : isText(e.name) ? (
                                <LuFileText className="size-4" />
                              ) : (
                                <LuFile className="size-4" />
                              )}
                            </span>
                            {renaming === e.name ? (
                              <Input
                                autoFocus
                                className="flex-1"
                                value={renameValue}
                                onChange={(ev) => setRenameValue(ev.target.value)}
                                onKeyDown={(ev) => {
                                  if (
                                    ev.key === 'Enter' &&
                                    renameValue.trim() &&
                                    renameValue !== e.name
                                  ) {
                                    void run(() =>
                                      renameAgentFile(
                                        agentId,
                                        join(cwd, e.name),
                                        join(cwd, renameValue.trim()),
                                      ),
                                    );
                                    setRenaming(null);
                                  } else if (ev.key === 'Escape') setRenaming(null);
                                }}
                                onBlur={() => setRenaming(null)}
                              />
                            ) : (
                              <button
                                className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                                onClick={() => openEntry(e)}
                                title={e.name}
                              >
                                {e.name}
                              </button>
                            )}
                            <span className="text-muted hidden w-20 shrink-0 text-right text-xs tabular-nums sm:block">
                              {e.dir ? '—' : fmtSize(e.size)}
                            </span>
                            <span className="text-muted hidden w-28 shrink-0 text-right text-xs sm:block">
                              {fmtDate(e.mtime)}
                            </span>
                            {/* Per-row actions menu. The ⋮ button is always shown
                                on touch (no hover / no right-click) and revealed on
                                hover for pointer devices; right-click opens it too. */}
                            <button
                              aria-label={`Actions for ${e.name}`}
                              title="Actions"
                              className="text-muted hover:text-foreground shrink-0 rounded p-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                const r = ev.currentTarget.getBoundingClientRect();
                                setMenu({ x: r.right, y: r.bottom, entry: e });
                              }}
                            >
                              <LuEllipsisVertical className="size-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Right-click context menu (anchored to an invisible element
                      at the cursor, mirroring the agent-card menu). */}
                  <Dropdown isOpen={menu !== null} onOpenChange={(o) => !o && setMenu(null)}>
                    <Button
                      aria-hidden="true"
                      excludeFromTabOrder
                      style={{
                        position: 'fixed',
                        left: menu?.x ?? 0,
                        top: menu?.y ?? 0,
                        width: 0,
                        height: 0,
                        minHeight: 0,
                        padding: 0,
                        opacity: 0,
                        pointerEvents: 'none',
                      }}
                    />
                    {menu && (
                      <Dropdown.Popover>
                        <Dropdown.Menu onAction={(key) => onMenuAction(String(key), menu.entry)}>
                          <Dropdown.Section>
                            <Header>{menu.entry.dir ? 'Folder' : 'File'}</Header>
                            <Dropdown.Item id="open" textValue="Open">
                              <div className="flex items-center justify-center">
                                {menu.entry.dir ? (
                                  <LuFolderOpen className="text-muted size-4 shrink-0" />
                                ) : (
                                  <LuFileText className="text-muted size-4 shrink-0" />
                                )}
                              </div>
                              <div className="flex flex-col">
                                <Label>{menu.entry.dir ? 'Open' : 'Open / edit'}</Label>
                                <Description>
                                  {menu.entry.dir ? 'Browse this folder' : 'Edit or download'}
                                </Description>
                              </div>
                            </Dropdown.Item>
                            <Dropdown.Item id="download" textValue="Download">
                              <div className="flex items-center justify-center">
                                {menu.entry.dir ? (
                                  <LuFileArchive className="text-muted size-4 shrink-0" />
                                ) : (
                                  <LuDownload className="text-muted size-4 shrink-0" />
                                )}
                              </div>
                              <div className="flex flex-col">
                                <Label>{menu.entry.dir ? 'Download as .zip' : 'Download'}</Label>
                                <Description>
                                  {menu.entry.dir ? 'Zip the folder' : 'Save to your computer'}
                                </Description>
                              </div>
                            </Dropdown.Item>
                            <Dropdown.Item id="copy" textValue="Copy path">
                              <div className="flex items-center justify-center">
                                <LuCopy className="text-muted size-4 shrink-0" />
                              </div>
                              <div className="flex flex-col">
                                <Label>Copy path</Label>
                                <Description>The agent&apos;s filesystem path</Description>
                              </div>
                            </Dropdown.Item>
                            <Dropdown.Item id="rename" textValue="Rename">
                              <div className="flex items-center justify-center">
                                <LuPencil className="text-muted size-4 shrink-0" />
                              </div>
                              <div className="flex flex-col">
                                <Label>Rename</Label>
                              </div>
                            </Dropdown.Item>
                          </Dropdown.Section>
                          <Dropdown.Section>
                            <Header>Danger zone</Header>
                            <Dropdown.Item id="delete" textValue="Delete" variant="danger">
                              <div className="flex items-center justify-center">
                                <LuTrash2 className="text-danger size-4 shrink-0" />
                              </div>
                              <div className="flex flex-col">
                                <Label>Delete</Label>
                                <Description>
                                  {menu.entry.dir ? 'Remove folder + contents' : 'Remove this file'}
                                </Description>
                              </div>
                            </Dropdown.Item>
                          </Dropdown.Section>
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    )}
                  </Dropdown>
                </>
              )}
            </Modal.Body>
            {!editing && (
              <Modal.Footer>
                <Button slot="close" variant="tertiary">
                  Close
                </Button>
              </Modal.Footer>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** Inline text editor for a single file. */
function EditorPane({
  agentId,
  editing,
  setEditing,
  onClose,
}: {
  agentId: string;
  editing: { path: string; content: string; dirty: boolean };
  setEditing: (e: { path: string; content: string; dirty: boolean } | null) => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const name = editing.path.split('/').pop() ?? editing.path;
  const save = async () => {
    setSaving(true);
    try {
      await writeAgentFile(agentId, editing.path, editing.content);
      setEditing({ ...editing, dirty: false });
      toast.success('Saved.');
    } catch (e) {
      toast.warning(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <LuFileText className="text-muted size-4" />
          <span className="font-mono">{name}</span>
          {editing.dirty && <span className="text-warning text-xs">• unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={agentFileDownloadUrl(agentId, editing.path)}
            className="text-muted hover:text-foreground rounded p-1"
            aria-label="Download"
          >
            <LuDownload className="size-4" />
          </a>
          <Button size="sm" isDisabled={saving || !editing.dirty} onPress={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() => {
              if (!editing.dirty || confirm('Discard unsaved changes?')) onClose();
            }}
          >
            Back
          </Button>
        </div>
      </div>
      <TextField
        className="flex min-h-0 flex-1"
        value={editing.content}
        onChange={(v) => setEditing({ ...editing, content: v, dirty: true })}
        aria-label={`Edit ${name}`}
      >
        <Label className="sr-only">{name}</Label>
        <TextArea className="h-full min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed" />
      </TextField>
    </div>
  );
}
