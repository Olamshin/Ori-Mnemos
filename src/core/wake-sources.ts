/**
 * Wake source manifest: the budget ladder is the law; the sources are configuration.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';

export type WakeSource = {
  path: string;
  role: 'identity' | 'goals' | 'due' | 'activity' | 'custom';
  cap: number;
  mode: 'head' | 'tail' | 'fovea' | 'due-scan';
};

export function loadWakeSources(config: { wake?: { sources?: WakeSource[] } }): WakeSource[] {
  const src = config.wake?.sources;
  if (Array.isArray(src) && src.length > 0) return src;
  return [
    { path: 'self/identity.md', role: 'identity', cap: 1, mode: 'head' },
    { path: 'self/goals.md', role: 'goals', cap: 8, mode: 'head' },
    { path: 'ops/reminders.md', role: 'due', cap: 6, mode: 'due-scan' },
    { path: 'ops/today.md', role: 'activity', cap: 10, mode: 'tail' }
  ];
}

export async function assembleWakeInputs(
  vaultRoot: string,
  sources: WakeSource[]
): Promise<{
  identity: string;
  goals: string;
  reminders: string;
  daily: string;
  activity: string[];
  warmNotes: Array<{ title: string; decayed: number }>;
  vaultStats: { noteCount: number; inboxCount: number };
  notices: string[];
}> {
  const result = {
    identity: '',
    goals: '',
    reminders: '',
    daily: '',
    activity: [] as string[],
    warmNotes: [] as Array<{ title: string; decayed: number }>,
    vaultStats: { noteCount: 0, inboxCount: 0 },
    notices: [] as string[]
  };

  for (const src of sources) {
    const filePath = path.join(vaultRoot, src.path);
    let content = '';
    try {
      const buf = await fsp.readFile(filePath, 'utf8');
      content = buf;
    } catch {
      content = '';
    }

    // Vault files carry YAML frontmatter. Strip it here, once, for every role:
    // otherwise the delimiters become the briefing (`---` is the first
    // non-heading line of identity.md, and it also passes the "starts with -"
    // bullet test), and frontmatter list items (`project:\n  - cli`) read as
    // reminders. Uses the shared parser so CRLF files and body lines starting
    // `----` behave the same here as everywhere else in the codebase.
    const body = parseFrontmatter(content).body;

    switch (src.role) {
      case 'identity':
        result.identity = body;
        break;
      case 'goals':
        result.goals = body;
        break;
      case 'due':
        result.reminders = body;
        break;
      case 'activity': {
        const lines = body.split(/\r?\n/).filter(l => l.trim() !== '');
        // `tail` suits an append-only log; `head` suits a single-day state file
        // whose TOP section carries the substance (e.g. "## Completed Today").
        if (src.mode === 'tail') {
          result.activity = lines.slice(-src.cap);
        } else if (src.mode === 'head') {
          result.activity = lines.slice(0, src.cap);
        }
        break;
      }
    }
  }

  async function countMd(dir: string): Promise<number> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isFile() && e.name.endsWith('.md')).length;
    } catch {
      return 0;
    }
  }

  const notesDir = path.join(vaultRoot, 'notes');
  const inboxDir = path.join(vaultRoot, 'inbox');
  result.vaultStats.noteCount = await countMd(notesDir);
  result.vaultStats.inboxCount = await countMd(inboxDir);

  return result;
}
