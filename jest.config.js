/** @type {import('jest').Config} */
module.exports = {
  displayName: "sdk",
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/*.spec.ts"],
  testTimeout: 10000,
  forceExit: true,
  moduleNameMapper: {
    "^@queuedash-pro/(.*)$": "<rootDir>/../$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
        },
      },
    ],
  },
};
