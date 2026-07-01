'use client';

import CodeMirror, { EditorView } from '@uiw/react-codemirror';
import { loadLanguage, type LanguageName } from '@uiw/codemirror-extensions-langs';

/** File extension → CodeMirror language (only names known to exist in the langs
 *  bundle; .js/.ts map to the jsx/tsx supersets). Unknown → plain text. */
const EXT_LANG: Record<string, LanguageName> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  js: 'jsx',
  jsx: 'jsx',
  mjs: 'jsx',
  cjs: 'jsx',
  ts: 'tsx',
  tsx: 'tsx',
  py: 'python',
  json: 'json',
  json5: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  html: 'html',
  htm: 'html',
  css: 'css',
  go: 'go',
  sql: 'sql',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  java: 'java',
};

function languageExtension(filename?: string) {
  const ext = filename?.split('.').pop()?.toLowerCase();
  const name = ext ? EXT_LANG[ext] : undefined;
  return name ? loadLanguage(name) : null;
}

/**
 * Raw source / code editor (CodeMirror 6 via @uiw/react-codemirror). The "code"
 * side of the large editor's rendered↔source toggle. Fully controlled. Lazy-
 * loaded so the CodeMirror + language grammars stay out of the main bundle.
 */
export default function CodeEditor({
  value,
  onChange,
  filename,
}: {
  value: string;
  onChange: (value: string) => void;
  filename?: string;
}) {
  const lang = languageExtension(filename);
  const extensions = [EditorView.lineWrapping, ...(lang ? [lang] : [])];
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="dark"
      height="100%"
      style={{ height: '100%', fontSize: 13 }}
      basicSetup={{ lineNumbers: true, highlightActiveLine: true, foldGutter: true }}
    />
  );
}
