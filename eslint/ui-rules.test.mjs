import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from './ui-rules.mjs';

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const map = tag => `declare global { interface HTMLElementTagNameMap { '${tag}': X } }`;

tester.run('element-tag', plugin.rules['element-tag'], {
  valid: [
    `@customElement('rr-thing') class X {} ${map('rr-thing')}`,
    `@customElement('rr-thing-bar') class X {} ${map('rr-thing-bar')}`,
    `customElements.define('rr-thing', X); ${map('rr-thing')}`,
  ],
  invalid: [
    { code: `@customElement('my-thing') class X {} ${map('my-thing')}`, errors: 1 },
    { code: `@customElement('rr-thing') class X {}`, errors: 1 },
    { code: `@customElement('rr-thing') class X {} ${map('rr-other')}`, errors: 1 },
    { code: `@customElement(\`rr-Thing\`) class X {} ${map('rr-Thing')}`, errors: 1 },
    { code: `@customElement(TAG) class X {}`, errors: 1 },
    { code: `customElements.define('foo-bar', X); ${map('foo-bar')}`, errors: 1 },
  ],
});

tester.run('inline-style', plugin.rules['inline-style'], {
  valid: [
    'html`<p style="--k:${v}"></p>`',
    'html`<p style="--a:1; --b:${v};"></p>`',
    'svg`<g style="${ink(v)}"></g>`',
    'html`<p class="a"></p>`',
    'css`p { style: none }`',
  ],
  invalid: [
    { code: 'html`<p style="width:${w}%"></p>`', errors: 1 },
    { code: "html`<p style='color:red'></p>`", errors: 1 },
    { code: 'html`<p style = "color:red"></p>`', errors: 1 },
    { code: 'html`<p style="--a:${v}; color:red"></p>`', errors: 1 },
    { code: 'html`<p style=${styleMap(s)}></p>`', errors: 1 },
    { code: 'svg`<g style="fill:red"></g>`', errors: 1 },
    { code: 'lit.html`<p style="color:red"></p>`', errors: 1 },
  ],
});
