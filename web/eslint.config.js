import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'
import tsParser from '@typescript-eslint/parser'

export default tseslint.config(
  // Workbench test file rules — prevent h.ctx and expect() bypass
  {
    files: ['src/workbench/testing/__tests__/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="h"][property.name="ctx"]',
          message: '禁止直接访问 h.ctx — 使用 harness 断言方法 (h.assertXxx / h.collect) 替代。如确需扩展 harness 能力，先在 harness.ts 中添加方法。',
        },
        {
          selector: 'CallExpression[callee.name="expect"]',
          message: '禁止使用 expect() — 使用 harness 断言 (h.assert / h.assertXxx) 替代',
        },
      ],
    },
  },
  // Workbench component rules — prevent direct provider bypass
  {
    files: ['src/workbench/components/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.name="useSceneContext"]',
          message: '禁止直接使用 useSceneContext() — 使用 useBContext() 并通过 bctx.scene 访问',
        },
        {
          selector: 'CallExpression[callee.name="useConnectionContext"]',
          message: '禁止直接使用 useConnectionContext() — 使用 useBContext() 并通过 bctx.connection 访问',
        },
      ],
    },
  },
)
