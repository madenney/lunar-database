/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  transformIgnorePatterns: [
    "node_modules/(?!uuid/)"
  ],
  transform: {
    "^.+\\.tsx?$": "ts-jest",
    "^.+\\.jsx?$": ["ts-jest", { tsconfig: { allowJs: true } }],
  },
};
