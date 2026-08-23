import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// The lint gate covers the TypeScript sources only. build.mjs and this config are
// plain Node ESM that tsconfig.json does not include, so type-aware rules cannot
// run on them – scoping the block keeps `eslint .` and `eslint src/` identical.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'build.mjs', 'eslint.config.js'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
