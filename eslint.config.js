import globals from 'globals'
export default [
  { linterOptions: { reportUnusedDisableDirectives: 'off' }, ignores: ['node_modules/**', 'dist/**', 'src/wasm/**', 'test-results/**', 'playwright-report/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.browser },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'constructor-super': 'error', 'getter-return': 'error' },
  },
  { files: ['**/*.test.js', 'scripts/**/*.mjs', '*.config.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } } },
]
