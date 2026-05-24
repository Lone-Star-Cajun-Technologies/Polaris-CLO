import fs from 'fs';
import path from 'path';
import type { PolarisConfig } from './schema';

const CONFIG_FILENAME = 'polaris.config.json';

export function loadConfig(cwd: string = process.cwd()): PolarisConfig {
  const configPath = path.join(cwd, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return {};
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read ${configPath}: ${(err as Error).message}`);
  }

  try {
    return JSON.parse(raw) as PolarisConfig;
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
}

export function findConfigPath(cwd: string = process.cwd()): string | null {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  return fs.existsSync(configPath) ? configPath : null;
}
