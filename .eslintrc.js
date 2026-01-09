/* eslint-env node */

module.exports = {
  overrides: [
    {
      files: ['*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 'latest',
        project: `${__dirname}/tsconfig.json`
      },
      rules: {
        'max-lines-per-function': ['error', { max: 660, skipBlankLines: true }],
        'max-depth': ['error', 6],
        complexity: ['error', 20]
      }
    }
  ]
};
