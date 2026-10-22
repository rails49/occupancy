// The mechanical half of ui/CLAUDE.md § Coding standards.
import tseslint from 'typescript-eslint';

const TAG = /^rr-[a-z0-9]+(-[a-z0-9]+)*$/;

// An element file names its tag rr-<noun>[-<qualifier>] and declares it in
// HTMLElementTagNameMap.
const elementFile = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const tags = [];
    let declared = false;
    return {
      'Decorator > CallExpression[callee.name="customElement"]'(node) {
        const [arg] = node.arguments;
        if (arg?.type !== 'Literal') return;
        tags.push(node);
        if (!TAG.test(arg.value)) {
          context.report({ node, message: `Element tag '${arg.value}' is not rr-<noun>[-<qualifier>].` });
        }
      },
      'TSInterfaceDeclaration[id.name="HTMLElementTagNameMap"]'() {
        declared = true;
      },
      'Program:exit'() {
        if (!declared) {
          for (const node of tags) {
            context.report({ node, message: 'An element file ends with a HTMLElementTagNameMap declaration.' });
          }
        }
      },
    };
  },
};

export default [
  {
    files: ['ui/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      ui: { rules: { 'element-file': elementFile } },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'ui/element-file': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TaggedTemplateExpression[tag.name=/^(html|svg)$/] TemplateElement[value.raw=/style="(?!--|$)/]',
          message: 'Styles belong in static styles. An inline style= sets custom properties only.',
        },
      ],
    },
  },
];
