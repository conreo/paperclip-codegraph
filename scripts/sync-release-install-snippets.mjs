/**
 * Put a standard install snippet into every GitHub release body.
 *
 * Two problems with what is there:
 *
 *  - some releases carry an `## Upgrading` section with the install line buried at
 *    the bottom, invisible until you scroll to it;
 *  - others have no install line at all, so learning how to install *that* version
 *    means going back to the README and hoping it mentions pinning.
 *
 * Each body gets one `## Install` block at the top, pinned to that release's own
 * version, and any pre-existing `## Upgrading` section is dropped — its content is
 * the install line plus a note about reloading, and the note is already part of the
 * release's own prose.
 *
 * Idempotent by construction: the block is stripped before it is re-added, so
 * running it twice produces the same body. Verified with `--check` before writing.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REPO = "conreo/paperclip-codegraph";
const PLUGIN = "paperclip-codegraph";
const CHECK_ONLY = process.argv.includes("--check");

const snippetFor = (version) => `## Install

\`\`\`bash
npm install -g @colbymchenry/codegraph@1.6.0   # the CodeGraph CLI, if you do not have it
paperclipai plugin install ${PLUGIN}@${version}
\`\`\`

Pin the version: Paperclip stores a caret range against what was installed, and for a
\`0.x\` version a caret does not cross a minor release, so a bare \`plugin install\` is a
no-op once the next minor is out.

The plugin installs **disabled**. Nothing changes for any agent until an organization
turns it on, in **Settings → Plugins → CodeGraph**.

`;

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * The same transformation both ways, so `--check` tests the real thing.
 *
 * The strip is anchored on the snippet's own closing sentence rather than on a
 * lookahead. A lookahead was the first attempt and it was subtly wrong: the
 * non-greedy body matched *inside* the block, leaving the snippet's tail text in
 * place, which produced two different results on the second pass. Anchoring on a
 * line this function itself wrote cannot drift.
 */
function stripInstall(body) {
  const start = body.indexOf("## Install\n");
  if (start === -1) return body;

  // Anchor on this snippet's own closing sentence. A section-boundary approach was
  // tried twice and was wrong both times for the same reason: `## Install` is
  // followed by prose, not immediately by another heading, so "the next `##`" lands
  // *inside* the block and leaves its tail behind. Anchoring on a line this function
  // itself wrote cannot land in the wrong place.
  const anchor = "turns it on, in **Settings → Plugins → CodeGraph**.";
  const anchorAt = body.indexOf(anchor, start);
  if (anchorAt !== -1) {
    return body.slice(0, start) + body.slice(anchorAt + anchor.length).replace(/^\n+/, "");
  }

  // A hand-written Install section (v0.1.0) closes on different words. Drop the
  // heading and its code block only — never to the next heading, which would take
  // the following section with it.
  const fenceStart = body.indexOf("```", start);
  if (fenceStart !== -1) {
    const fenceEnd = body.indexOf("```", fenceStart + 3);
    if (fenceEnd !== -1) {
      return body.slice(0, start) + body.slice(fenceEnd + 3).replace(/^\n+/, "");
    }
  }
  return body;
}

function rebuild(body, version) {
  let next = stripInstall(body);
  next = next.replace(/\n## Upgrading\n[\s\S]*?(?=\n## |\s*$)/, "\n");
  next = next.replace(/\n{3,}/g, "\n\n").trim();

  const headingEnd = next.indexOf("\n");
  if (headingEnd === -1) return `${next}\n\n${snippetFor(version)}`.trimEnd() + "\n";
  const rest = next.slice(headingEnd + 1).replace(/^\n+/, "");
  return `${next.slice(0, headingEnd + 1)}\n${snippetFor(version)}${rest}`.trimEnd() + "\n";
}

const listRaw = gh(["release", "list", "--repo", REPO, "--limit", "100", "--json", "tagName"]);
const tags = JSON.parse(listRaw)
  .map((row) => row.tagName)
  .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  .sort((a, b) => {
    const pa = a.slice(1).split(".").map(Number);
    const pb = b.slice(1).split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });

console.log(`${tags.length} releases${CHECK_ONLY ? " (check only)" : ""}\n`);

const problems = [];
let written = 0;
let current = 0;

for (const tag of tags) {
  const version = tag.slice(1);
  const body = gh(["release", "view", tag, "--repo", REPO, "--json", "body", "-q", ".body"]);
  const rebuilt = rebuild(body, version);

  // The check that matters: applying it again must not change anything.
  if (rebuild(rebuilt, version) !== rebuilt) {
    problems.push(`${tag}: NOT idempotent`);
    continue;
  }
  if (!rebuilt.startsWith("# ")) {
    problems.push(`${tag}: does not start with a heading`);
    continue;
  }
  const installs = rebuilt.match(/^## Install$/gm)?.length ?? 0;
  if (installs !== 1) {
    problems.push(`${tag}: ${installs} Install sections (expected exactly 1)`);
    continue;
  }
  if (!rebuilt.includes(`${PLUGIN}@${version}`)) {
    problems.push(`${tag}: install line is not pinned to ${version}`);
    continue;
  }

  // GitHub normalises the body on write (it returns one more trailing newline than
  // it was given). Comparing raw strings therefore never converges: every run would
  // see a one-byte difference and rewrite all 22 releases to say the same thing.
  // Compare and write the normalised form instead.
  const normalise = (text) => text.trimEnd() + "\n";
  if (normalise(rebuilt) === normalise(body)) {
    current += 1;
    continue;
  }

  if (CHECK_ONLY) {
    console.log(`  would update ${tag}`);
    continue;
  }

  const file = `/home/rimko/projects/paperclip-codegraph/.toolchain/release-${version}.md`;
  writeFileSync(file, normalise(rebuilt));
  gh(["release", "edit", tag, "--repo", REPO, "--notes-file", file]);
  written += 1;
  console.log(`  updated ${tag}`);
}

console.log(`\n${written} updated, ${current} already current`);
if (problems.length > 0) {
  console.log(`\nPROBLEMS (nothing written for these):`);
  for (const problem of problems) console.log(`  ${problem}`);
  process.exitCode = 1;
}
