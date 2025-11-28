module.exports = {
  // For any TypeScript files, run type check on all packages
  "*.{ts,tsx}": () => "pnpm run type-check",

  // Format all staged files
  "*.{ts,tsx,js,jsx,json,md}": "prettier --write",
};
