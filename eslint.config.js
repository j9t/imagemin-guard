import js from '@eslint/js';

export default [
  {
    ignores: [
      'media/',
      'node_modules/**'
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly'
      }
    },
    rules: {
      'no-console': 'off', // CLI tool—allow console
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      curly: ['warn', 'multi-line']
    }
  }
]