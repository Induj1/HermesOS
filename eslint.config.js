// ESLint flat config — the single lint configuration for the whole workspace.
// Flat config has no cascade: this file is the only one that applies, so a
// package cannot quietly weaken the rules. Per-package exceptions go in the
// `files`-scoped blocks at the bottom, where they are visible in review.
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Flat config replaces .eslintignore. Anything generated or vendored.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '**/hermes-workspace/**',
      '**/.venv-sd/**',
      '**/assets/**',
    ],
  },

  js.configs.recommended,

  {
    // Type-aware linting, TypeScript sources only. These rule sets need real
    // type information, which is why they are scoped rather than global — the
    // parser would otherwise be asked to find a tsconfig for every .js file.
    files: ['**/*.ts'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // projectService finds the nearest tsconfig.json for each file on its
        // own, so adding a package never means editing this file.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unused variable is usually a mistake; a deliberately unused one is
      // named with a leading underscore to say so.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Enforce `import type { X }`. verbatimModuleSyntax in tsconfig.base.json
      // requires it; this reports it as a lint error with an autofix instead of
      // as a build failure.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },

  {
    // Config files and scripts at the root are plain JS and belong to no
    // package, so there is no tsconfig to type-check them against.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must stay last: turns off every stylistic rule that would fight Prettier.
  // Formatting is Prettier's job, correctness is ESLint's.
  prettier,
);
