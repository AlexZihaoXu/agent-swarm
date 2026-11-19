/**
 * Whitelist sanitizer for the terminal-prompt HTML an agent's runtime renders
 * (xterm's serializeAsHTML: <pre>/<div>/<span> with inline colour styles).
 *
 * That HTML comes from inside the agent container, which the agent controls
 * (it is root there), and it is injected into the dashboard's own origin. Raw,
 * an `<img onerror>` in it would run as the operator. Only the layout tags the
 * serializer emits survive, with no attributes except a `style` that cannot
 * load anything; everything else is reduced to its text.
 */
const TAGS = new Set(['PRE', 'DIV', 'SPAN', 'B', 'I', 'U', 'STRONG', 'EM', 'BR']);
/** CSS that could fetch a resource or reach outside the box. */
const UNSAFE_CSS = /url\s*\(|image-set|@import|expression|behavior|-moz-binding|\\/i;

function clean(node: Node, doc: Document): Node {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return doc.createTextNode('');
  const el = node as Element;
  if (!TAGS.has(el.tagName)) return doc.createTextNode(el.textContent ?? '');
  const out = doc.createElement(el.tagName.toLowerCase());
  const style = el.getAttribute('style');
  if (style && !UNSAFE_CSS.test(style)) out.setAttribute('style', style);
  for (const child of Array.from(el.childNodes)) out.appendChild(clean(child, doc));
  return out;
}

export function sanitizePromptHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = doc.createElement('div');
  for (const child of Array.from(doc.body.childNodes)) out.appendChild(clean(child, doc));
  return out.innerHTML;
}
