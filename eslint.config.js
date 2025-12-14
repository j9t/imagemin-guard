export default [
  {
    ignores: [
    	'media/',
    	'node_modules/**'
		]
  },
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
      'no-undef': 'error', // Catch undefined vars
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      eqeqeq: ['warn', 'smart'],
      curly: ['warn', 'multi-line']
    }
  }
]