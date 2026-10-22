// Local rules for ui/CLAUDE.md § Coding standards.

const TAG = /^rr-[a-z0-9]+(-[a-z0-9]+)*$/;
const HOLE = '\0';

function staticString(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

// Each element's tag is rr-<noun>[-<qualifier>] and is a key of the file's
// HTMLElementTagNameMap.
const elementTag = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const tags = [];
    const mapped = new Set();
    const element = (node, arg) => {
      const tag = staticString(arg);
      if (tag === null) {
        context.report({ node, message: 'Write the element tag as a string literal.' });
        return;
      }
      if (!TAG.test(tag)) context.report({ node, message: `Element tag '${tag}' is not rr-<noun>[-<qualifier>].` });
      tags.push({ node, tag });
    };
    return {
      'Decorator > CallExpression[callee.name="customElement"]'(node) {
        element(node, node.arguments[0]);
      },
      'CallExpression[callee.object.name="customElements"][callee.property.name="define"]'(node) {
        element(node, node.arguments[0]);
      },
      'TSInterfaceDeclaration[id.name="HTMLElementTagNameMap"] TSPropertySignature'(node) {
        const key = staticString(node.key);
        if (key !== null) mapped.add(key);
      },
      'Program:exit'() {
        for (const { node, tag } of tags) {
          if (!mapped.has(tag)) context.report({ node, message: `Declare '${tag}' in HTMLElementTagNameMap.` });
        }
      },
    };
  },
};

// A style attribute in an html`` or svg`` template sets custom properties
// only. A declaration written wholly as ${...} is not checked.
const inlineStyle = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        const tag = node.tag.type === 'MemberExpression' ? node.tag.property : node.tag;
        if (tag.type !== 'Identifier' || !['html', 'svg'].includes(tag.name)) return;
        const text = node.quasi.quasis.map(q => q.value.raw).join(HOLE);
        for (const m of text.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S))/g)) {
          const value = m[1] ?? m[2];
          const bad =
            value === undefined
              ? 'Quote the style attribute and set custom properties in it.'
              : value
                  .split(';')
                  .map(d => d.trim())
                  .some(d => d !== '' && d !== HOLE && !d.startsWith('--'))
                ? 'Styles belong in static styles. An inline style= sets custom properties only.'
                : null;
          if (bad) context.report({ node, message: bad });
        }
      },
    };
  },
};

export default { rules: { 'element-tag': elementTag, 'inline-style': inlineStyle } };
