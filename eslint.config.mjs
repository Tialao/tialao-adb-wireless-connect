// Configuration ESLint plate.
//
// Deux règles portent une garantie du projet, pas un goût :
//  - no-restricted-syntax interdit child_process.exec/execSync : c'est ce qui garantit
//    qu'aucune commande adb n'est construite par concaténation de chaînes ;
//  - no-console interdit toute écriture directe sur stdout hors du CLI : c'est ce qui
//    garantit qu'en mode --json, stdout ne contient QUE du JSON.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Globals Node, pour les fichiers JavaScript non typés (scripts de build, bin). */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

/** Globals du webview : DOM, plus l'API injectée par VS Code. */
const webviewGlobals = {
  window: 'readonly',
  document: 'readonly',
  setTimeout: 'readonly',
  acquireVsCodeApi: 'readonly',
  HTMLElement: 'readonly',
  HTMLStyleElement: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '.scratch/**',
      'packages/core/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='exec']",
          message: 'child_process.exec est interdit : utiliser execFile via packages/core/src/adb.ts.',
        },
        {
          selector: "CallExpression[callee.name='execSync']",
          message: 'child_process.execSync est interdit : utiliser execFile via packages/core/src/adb.ts.',
        },
      ],
    },
  },
  {
    // Seul le CLI écrit sur la sortie standard.
    files: ['packages/core/src/cli.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.mjs', 'packages/core/bin/*.mjs', 'scripts/**/*.js'],
    languageOptions: { globals: nodeGlobals, sourceType: 'module' },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['packages/vscode/media/*.js'],
    languageOptions: { globals: webviewGlobals, sourceType: 'script' },
  },
  {
    files: ['packages/core/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
