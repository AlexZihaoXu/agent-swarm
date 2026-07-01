'use client';

import { Button, Modal, Tooltip } from '@heroui/react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LuCode, LuEye, LuSave } from 'react-icons/lu';
import type { MilkdownApi } from './editors/MilkdownEditor';

// Lazy-loaded (ssr:false) so ProseMirror/CodeMirror + grammars never ship in the
// initial bundle — they load the first time someone opens the large editor.
const MilkdownEditor = dynamic(() => import('./editors/MilkdownEditor'), {
  ssr: false,
  loading: () => <EditorLoading />,
});
const CodeEditor = dynamic(() => import('./editors/CodeEditor'), {
  ssr: false,
  loading: () => <EditorLoading />,
});

function EditorLoading() {
  return (
    <div className="text-muted flex h-full items-center justify-center text-sm">
      Loading editor…
    </div>
  );
}

const MD_RE = /\.(md|markdown|mdx)$/i;
export const isMarkdownFile = (name?: string) => !!name && MD_RE.test(name);

/**
 * A big modal editor for a chunk of text. For markdown (a `.md*` filename, or
 * `markdown` forced) it opens in Milkdown's WYSIWYG mode and Ctrl/Cmd+/ toggles
 * to a raw CodeMirror source view (and back); non-markdown opens straight in the
 * code editor with syntax highlighting. Ctrl/Cmd+S saves. Content is preserved
 * across the toggle. On Save it hands the current text back via `onSave`.
 */
export function LargeEditorModal({
  isOpen,
  onOpenChange,
  title,
  value,
  onSave,
  filename,
  markdown,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: string;
  onSave: (value: string) => void;
  /** Filename, used for language detection + the markdown check. */
  filename?: string;
  /** Force markdown mode for content with no filename (guidance, descriptions). */
  markdown?: boolean;
}) {
  const mdCapable = markdown ?? isMarkdownFile(filename);
  const [mode, setMode] = useState<'rendered' | 'code'>('code');
  const [text, setText] = useState(value);
  const milkdownApi = useRef<MilkdownApi | null>(null);

  // (Re)seed each time it opens: latest incoming value, and the natural mode.
  useEffect(() => {
    if (!isOpen) return;
    setText(value);
    setMode(mdCapable ? 'rendered' : 'code');
  }, [isOpen, value, mdCapable]);

  // Pull the current content out of the active editor. CodeMirror is controlled
  // (so `text` is already current); Milkdown is imperative, so read it live.
  const flush = useCallback((): string => {
    if (mode === 'rendered' && milkdownApi.current) {
      const md = milkdownApi.current.getMarkdown();
      setText(md);
      return md;
    }
    return text;
  }, [mode, text]);

  const toggle = useCallback(() => {
    if (!mdCapable) return;
    flush();
    setMode((m) => (m === 'rendered' ? 'code' : 'rendered'));
  }, [mdCapable, flush]);

  const save = useCallback(() => {
    onSave(flush());
    onOpenChange(false);
  }, [flush, onSave, onOpenChange]);

  // Shortcuts: Ctrl/Cmd+/ toggle rendered↔source, Ctrl/Cmd+S save. Capture phase
  // so we win over the editors' own key handling.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '/') {
        e.preventDefault();
        toggle();
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, toggle, save]);

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside">
        <Modal.Dialog className="flex h-[88dvh] w-[min(1100px,94vw)] max-w-none flex-col sm:max-w-none">
          <Modal.CloseTrigger />
          <Modal.Header>
            <div className="flex w-full items-center gap-3 pr-8">
              <Modal.Heading className="min-w-0 flex-1 truncate">{title}</Modal.Heading>
              {mdCapable && (
                <Tooltip>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0 gap-1.5"
                    onPress={toggle}
                  >
                    {mode === 'rendered' ? (
                      <LuCode className="size-4" />
                    ) : (
                      <LuEye className="size-4" />
                    )}
                    {mode === 'rendered' ? 'Source' : 'Preview'}
                  </Button>
                  <Tooltip.Content>Toggle rendered / source (⌘/ or Ctrl+/)</Tooltip.Content>
                </Tooltip>
              )}
            </div>
          </Modal.Header>
          <Modal.Body className="min-h-0 flex-1 overflow-hidden p-0">
            {mode === 'rendered' && mdCapable ? (
              <MilkdownEditor defaultValue={text} apiRef={milkdownApi} />
            ) : (
              <CodeEditor
                value={text}
                onChange={setText}
                filename={filename ?? (markdown ? 'note.md' : undefined)}
              />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="tertiary">
              Cancel
            </Button>
            <Button className="gap-1.5" onPress={save}>
              <LuSave className="size-4" />
              Save
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
