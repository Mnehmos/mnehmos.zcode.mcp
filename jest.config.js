/** Unit tests are the default. Integration tests spawn the real ZCode runtime and
 *  are opt-in behind ZCODE_MCP_IT=1, because they need an installed ZCode and they
 *  cost money if a model gets invoked. */
const integration = process.env.ZCODE_MCP_IT === '1';

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.test.json' }],
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  testPathIgnorePatterns: integration ? [] : ['<rootDir>/test/integration.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  // The runtime takes ~1.1 s to answer its first request; give slow spawns room.
  testTimeout: 60_000,
  forceExit: true,
};
