module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname
  },
  plugins: ['@typescript-eslint', 'import', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'plugin:prettier/recommended'
  ],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.eslint.json'
      }
    }
  },
  rules: {
    'prettier/prettier': 'error',
    // Off deliberately. The Gateway is built around interfaces whose methods
    // return promises (AgentAdapter, ISandbox, ISandboxManager, GatewayCore),
    // and an implementation that happens to be synchronous still has to be
    // declared `async` to satisfy the contract. This rule flags every one of
    // those as an error while catching no real defect. The rules that do catch
    // the genuine hazard — a promise nobody waits on — are
    // no-floating-promises and no-misused-promises, both enabled below.
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
    ],
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true }
      }
    ],
    'import/no-cycle': 'error',
    'import/no-unresolved': 'error',
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }]
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.js', '*.config.js']
};
