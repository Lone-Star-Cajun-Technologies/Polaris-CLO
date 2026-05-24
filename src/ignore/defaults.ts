export const DEFAULT_EXCLUSIONS: string[] = [
  // Package managers
  "node_modules/",
  ".pnpm-store/",
  "vendor/",
  "Pods/",

  // Build artifacts
  "build/",
  "dist/",
  ".build/",
  "DerivedData/",
  "*.xcarchive",

  // Language-specific caches
  ".dart_tool/",
  ".pub-cache/",
  "__pycache__/",
  "*.pyc",
  ".gradle/",

  // IDE / editor
  ".idea/",
  ".vscode/",
  "*.xcworkspace",

  // Secrets (always enforced, cannot be negated)
  "*.pem",
  "*.key",
  "*.env",
  ".env.*",
  "credentials.json",

  // VCS
  ".git/",
];

export const SECRET_PATTERNS: string[] = [
  "*.pem",
  "*.key",
  "*.env",
  ".env.*",
  "credentials.json",
];
