/**
 * Admin script: promote borderline teams that made the final cut to "accepted".
 *
 * Reads the final selection CSV (selected-300.csv) — the same columns the app's
 * export produces plus a "Tier" column — picks every row whose Tier is
 * borderline, and for each of those teams pushes an "accepted" evaluation with
 * comment "selected-300.csv".
 *
 * Why push an evaluation instead of editing a field:
 *   A Team has no single "tier" — its tier is the BEST tier across its
 *   evaluations[] (strongly_accepted > accepted > borderline > rejected), which
 *   is exactly how export-members.cjs / tier-stats.cjs read it. Adding one
 *   "accepted" evaluation raises the team's best tier to accepted while leaving
 *   the original evaluators' borderline reviews intact as an audit trail.
 *
 * This mirrors POST /api/evaluator/evaluate (route.ts): $pull this evaluator's
 * prior evaluation, then $push the new one, and set isEvaluated = true. Because
 * it keys on a fixed synthetic evaluatorId, the script is idempotent — re-runs
 * replace the same entry instead of stacking duplicates.
 *
 * Usage:
 *   node --env-file=.env.local scripts/promote-borderline-selected.cjs            # apply
 *   node --env-file=.env.local scripts/promote-borderline-selected.cjs --dry-run  # preview only
 *   node --env-file=.env.local scripts/promote-borderline-selected.cjs --file other.csv
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "";

// Identity stamped on the evaluation we add. Fixed so re-runs are idempotent.
const SELECTION_EVALUATOR_ID = "final-selection-300";
const SELECTION_EVALUATOR_NAME = "Final Selection (300)";
const SELECTION_TIER = "accepted";
const SELECTION_COMMENT = "selected-300.csv";

const TIERS = ["strongly_accepted", "accepted", "borderline", "rejected"];
const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

const Team =
  mongoose.models.Team ||
  mongoose.model(
    "Team",
    new mongoose.Schema({}, { strict: false, autoIndex: false }),
    "teams"
  );

// Best (highest) tier a team currently has, or null if never evaluated.
function bestTierOf(team) {
  const evals = Array.isArray(team.evaluations) ? team.evaluations : [];
  let bestRank = Infinity;
  let bestTier = null;
  for (const ev of evals) {
    const tier = ev && ev.tier;
    if (!(tier in TIER_RANK)) continue;
    if (TIER_RANK[tier] < bestRank) {
      bestRank = TIER_RANK[tier];
      bestTier = tier;
    }
  }
  return bestTier;
}

// Minimal RFC-4180 CSV line parser (handles quoted fields with embedded commas).
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const fileIdx = process.argv.indexOf("--file");
  const csvPath =
    fileIdx !== -1
      ? process.argv[fileIdx + 1]
      : path.join(__dirname, "..", "selected-300.csv");

  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));

  // Borderline rows only; unique by Team Code.
  const codesFromCsv = new Map(); // teamCode -> teamName (for logging)
  for (const row of rows) {
    const tier = (row["Tier"] || "").toLowerCase();
    const code = row["Team Code"];
    if (tier.startsWith("borderline") && code) {
      codesFromCsv.set(code, row["Team Name"] || "");
    }
  }

  const codes = [...codesFromCsv.keys()];
  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Found ${codes.length} borderline team(s) in ${path.basename(csvPath)}.`
  );
  if (codes.length === 0) return;

  await mongoose.connect(MONGODB_URI);

  try {
    const teams = await Team.find(
      { teamCode: { $in: codes } },
      { teamCode: 1, teamName: 1, evaluations: 1 }
    ).lean();
    const teamByCode = new Map(teams.map((t) => [t.teamCode, t]));

    const missing = codes.filter((c) => !teamByCode.has(c));
    if (missing.length) {
      console.warn(
        `\nWARNING: ${missing.length} team code(s) from CSV not found in DB:`
      );
      for (const c of missing) console.warn(`  - ${c} (${codesFromCsv.get(c)})`);
    }

    let promoted = 0;
    let alreadyDone = 0;

    for (const code of codes) {
      const team = teamByCode.get(code);
      if (!team) continue;

      const before = bestTierOf(team) || "unevaluated";
      const already = (team.evaluations || []).some(
        (e) => e.evaluatorId === SELECTION_EVALUATOR_ID && e.tier === SELECTION_TIER
      );

      if (already) {
        alreadyDone++;
        console.log(`= ${code} (${team.teamName}) — already promoted, skipping`);
        continue;
      }

      console.log(
        `${dryRun ? "~" : "+"} ${code} (${team.teamName}) — best tier "${before}" -> "${SELECTION_TIER}"`
      );

      if (dryRun) continue;

      // Replace any prior entry from this synthetic evaluator, then add fresh.
      await Team.updateOne(
        { teamCode: code },
        { $pull: { evaluations: { evaluatorId: SELECTION_EVALUATOR_ID } } }
      );
      await Team.updateOne(
        { teamCode: code },
        {
          $push: {
            evaluations: {
              evaluatorId: SELECTION_EVALUATOR_ID,
              name: SELECTION_EVALUATOR_NAME,
              tier: SELECTION_TIER,
              comment: SELECTION_COMMENT,
              createdAt: new Date(),
            },
          },
          $set: { isEvaluated: true },
        }
      );
      promoted++;
    }

    console.log(
      `\n${dryRun ? "[DRY RUN] Would promote" : "Promoted"} ${dryRun ? codes.length - alreadyDone - missing.length : promoted} team(s); ` +
      `${alreadyDone} already promoted; ${missing.length} missing.`
    );
    if (dryRun) console.log("No changes written (--dry-run).");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
