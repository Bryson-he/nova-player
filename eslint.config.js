const js = require('@eslint/js');
const globals = require('globals');

const unused = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }];

module.exports = [
  { ignores: ['dist/**', 'docs/**', 'node_modules/**', 'src/renderer/vendor/**', 'src/main/generated/**'] },
  js.configs.recommended,
  {
    files: ['src/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-unused-vars': unused },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, Hls: 'readonly' } },
    rules: { 'no-unused-vars': unused },
  },
  {
    files: ['src/renderer/js/trusted-types.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['test/**/*.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
    rules: { 'no-unused-vars': unused },
  },
];
