const js = require('@eslint/js')
const globals = require('globals')
module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'public/textures/**'] },
  { files: ['**/*.cjs'], ...js.configs.recommended,
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: true }], 'no-control-regex': 'off' } },
  { files: ['src/**/*.cjs'],
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }] } },
  { files: ['public/**/*.js'], ...js.configs.recommended,
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, selectedBot: 'readonly', botUrl: 'readonly', botName: 'readonly', command: 'readonly', request: 'readonly', action: 'readonly', node: 'readonly', $: 'readonly' } },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': ['warn', { vars: 'local', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } },
  { files: ['public/app.js'], languageOptions: { globals: { selectedBot: 'off', botUrl: 'off', botName: 'off', command: 'off', request: 'off', action: 'off', node: 'off', $: 'off' } } },
]
