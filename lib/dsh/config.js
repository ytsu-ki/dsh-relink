// Plugin settings. The host validates `Config` before activation; local setup-script settings
// are merged on first memory use, and problems there disable memory instead of the plugin.
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, isAbsolute } from 'node:path'

export const Config = z.object({
  database: z.string().default(''),
  projectRoot: z.string(),
  ttlDays: z.number().step(1).min(1).max(365).default(30),
  recallLimit: z.number().step(1).min(1).max(6).default(3),
  recallChars: z.number().step(1).min(1000).max(12000).default(6000),
  maxWorkers: z.number().step(1).min(1).max(2).default(2),
  repeatThreshold: z.number().step(1).min(2).max(10).default(3),
  checkpointSteps: z.number().step(1).min(10).max(100).default(20),
  longOutputTokens: z.number().step(1).min(1000).max(32000).default(4000),
  knowledgeRoot: z.string(),
  // Accepted for compatibility; the plugin no longer starts Basic Memory.
  basicMemoryCommand: z.string(),
  basicMemoryConfig: z.string(),
  knowledgeProject: z.string(),
  betterleaksCommand: z.string(),
  incrementalIndex: z.boolean().default(true),
})

/** Keys the setup scripts may write to the local settings file. */
export const LOCAL_KEYS = ['projectRoot', 'knowledgeRoot', 'basicMemoryCommand', 'basicMemoryConfig', 'knowledgeProject', 'betterleaksCommand']

// Storage paths keep the plugin's original name (dsh-memory-team) so existing settings and
// databases are found after the rename to dsh-relink.
export const localSettingsPath = (home = homedir()) => resolve(home, '.local/share/dsh-memory-team/settings.json')
export const dataRoot = (env = process.env, home = homedir()) => env.DSH_PROFILE_DIR || env.DSH_HOME || resolve(home, '.dsh')

/**
 * Resolve memory settings: host input wins over local setup settings.
 * Returns { settings, problems, sources } and never throws.
 */
export async function resolveMemorySettings(input, { home = homedir(), env = process.env, read = readFile } = {}) {
  const problems = [], sources = {}
  let local = {}
  try {
    const parsed = JSON.parse(await read(localSettingsPath(home), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    local = Object.fromEntries(Object.entries(parsed).filter(([key]) => LOCAL_KEYS.includes(key)))
  } catch (error) {
    if (error.code !== 'ENOENT') problems.push('local settings file is not valid JSON')
  }
  const merged = { ...local }
  for (const [key, value] of Object.entries(input)) if (value !== undefined) merged[key] = value
  for (const key of LOCAL_KEYS) sources[key] = Object.hasOwn(input, key) && input[key] !== undefined ? 'plugin' : Object.hasOwn(local, key) ? 'local-settings' : 'default'
  let settings
  try { settings = Config(merged) }
  catch (error) { problems.push(`invalid setting (${String(error.message).split('\n')[1]?.trim() ?? 'schema'})`); settings = Config(input) }
  for (const key of ['knowledgeRoot', 'basicMemoryCommand', 'basicMemoryConfig', 'knowledgeProject', 'betterleaksCommand', 'projectRoot']) settings[key] ??= ''
  for (const key of ['projectRoot', 'knowledgeRoot', 'basicMemoryConfig', 'knowledgeProject', 'betterleaksCommand', 'database']) {
    if (settings[key] && !isAbsolute(settings[key])) problems.push(`${key} must be an absolute path`)
  }
  const root = dataRoot(env, home)
  settings.database ||= resolve(root, 'data', 'dsh-memory-team.sqlite')
  // Historical name: history, trash, locks and derived catalogs live here.
  settings.basicMemoryConfig ||= resolve(root, 'data', 'basic-memory')
  return { settings, problems, sources }
}
