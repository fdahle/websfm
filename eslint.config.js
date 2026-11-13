import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
export default [
  // Alone in its object, so the patterns are ignored everywhere (generated wasm glue included).
  { ignores: ['node_modules/**', 'dist/**', 'src/wasm/**', 'test-results/**', 'playwright-report/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'constructor-super': 'error',
      'getter-return': 'error',
      // An import or a binding nothing reads is usually a leftover, sometimes a bug (a
      // shadowed name: usePipeline's cancel once called itself). Arguments and caught
      // errors are exempt (signatures), and `_name` marks one kept on purpose.
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // src/core/ is pure (AGENTS.md): no Vue, Pinia, stores, OPFS or other browser I/O, so it
  // runs in a worker and in Node tests alike. I/O a core module cannot do without goes
  // through core/coreIo.js (installed by utils/installCoreIo.js) or a parameter; code
  // that decodes or draws (canvases) lives in src/utils/.
  {
    files: ['src/core/**/*.js'],
    ignores: ['src/core/**/*.test.js', 'src/core/**/*.testutil.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/utils/**', '**/stores/**', '**/composables/**', '**/components/**', 'vue', 'pinia'] },
      ],
      'no-restricted-globals': [
        'error',
        'fetch',
        'document',
        'window',
        'localStorage',
        'sessionStorage',
        'caches',
        'indexedDB',
        'OffscreenCanvas',
        'createImageBitmap',
        'XMLHttpRequest',
      ],
    },
  },
  // Single-file components: the plugin's essential set (errors, not style; Prettier
  // formats), plus the same unused-binding check as the plain scripts.
  ...pluginVue.configs['flat/essential'].map((c) => ({ ...c, files: ['**/*.vue'] })),
  {
    files: ['**/*.vue'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': [
        'error',
        { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // A style rule against names that could become HTML elements; Icon, Ribbon,
      // Sidebar and the test Harness clash with none.
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['**/*.test.js', 'scripts/**/*.mjs', '*.config.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
