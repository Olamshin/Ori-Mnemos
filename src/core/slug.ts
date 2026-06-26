/**
 * Slug helpers — the single source of truth for turning a human title into the
 * filename-stable identity used as a note's node id in the link graph.
 *
 * Notes are stored as `<slug>.md`, so a note's graph identity is its slug.
 * Wikilinks, however, are authored against the *display title*
 * (`[[Vikunja GTD Workflow Conventions]]`), an alias (`[[Title|shown text]]`),
 * or a heading ref (`[[Title#Section]]`). `normalizeLinkTarget` collapses all of
 * these to the same slug so the graph's incoming/outgoing maps actually line up
 * with note identities (otherwise every linked note looks like an orphan).
 */

/** Convert a title to its filename slug. Must match the on-disk naming in add.ts. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Resolve the raw text inside `[[...]]` to a note slug.
 * Strips an alias (`|shown text`) and a heading/block ref (`#Section`) first,
 * then slugifies. Returns "" for links with no resolvable target (e.g. a bare
 * `[[#Section]]` self-heading link), which callers should skip.
 */
export function normalizeLinkTarget(raw: string): string {
  const beforeAlias = raw.split("|", 1)[0];
  const beforeHeading = beforeAlias.split("#", 1)[0];
  return slugify(beforeHeading);
}
