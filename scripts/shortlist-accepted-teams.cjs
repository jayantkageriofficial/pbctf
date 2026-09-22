/**
 * Admin script: shortlist every team whose BEST evaluation tier is
 * "strongly_accepted" or "accepted".
 *
 * A Team has no single "tier" — its tier is the BEST tier across its
 * evaluations[] (strongly_accepted > accepted > borderline > rejected), which
 * is exactly how tier-stats.cjs / promote-borderline-selected.cjs read it.
 * This picks the teams whose best tier lands in the accepted band and applies
 * the SAME writes the admin panel "Shortlist" toggle performs, i.e. the
 * PUT /api/admin/teams/:teamCode handler with { isShortlisted: true,
 * teamStatus: "shortlisted" }. For each team that means:
 *   1. isShortlisted = true
 *   2. shortlistedAt  = now         (only if not already set)
 *   3. teamStatus     = "shortlisted"
 *   4. push an admin evaluation tag { tier: "strongly_accepted", ... }
 *                                   (only if not already tagged)
 *   5. isEvaluated    = true
 *   6. evaluatedAt    = now         (only if not already set)
 *
 * Idempotent: the shortlistedAt / evaluatedAt / eval-tag writes are all
 * guarded, so re-running leaves already-shortlisted teams in the same state.
 *
 * Usage:
 *   node --env-file=.env.local scripts/shortlist-accepted-teams.cjs            # apply
 *   node --env-file=.env.local scripts/shortlist-accepted-teams.cjs --dry-run  # preview only
 */

const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "";

// Highest → lowest. Index = priority (lower is better).
const TIERS = ["strongly_accepted", "accepted", "borderline", "rejected"];
const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

// Best tiers that qualify a team for shortlisting.
const ACCEPTED_TIERS = new Set(["strongly_accepted", "accepted"]);

// Identity of the admin evaluation tag the panel pushes. The panel uses
// `admin:<uid>` of the signed-in admin; a script has no session, so use a
// stable synthetic id (overridable via ADMIN_UID) that stays idempotent.
const ADMIN_EVALUATOR_ID = `admin:${process.env.ADMIN_UID || "script"}`;
const ADMIN_EVALUATOR_NAME = process.env.ADMIN_NAME || "Admin";

const Team =
  mongoose.models.Team ||
  mongoose.model(
    "Team",
    new mongoose.Schema({}, { strict: false, autoIndex: false, timestamps: true }),
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

// Build the exact update the admin panel's PUT handler applies when
// shortlisting a team, honouring the same "only if not already set" guards.
function buildShortlistUpdate(team, now) {
  const $set = {
    isShortlisted: true,
    teamStatus: "shortlisted",
    isEvaluated: true,
  };
  if (!team.shortlistedAt) $set.shortlistedAt = now;
  if (!team.evaluatedAt) $set.evaluatedAt = now;

  const update = { $set };

  const alreadyTagged = (team.evaluations || []).some(
    (e) => e && e.evaluatorId === ADMIN_EVALUATOR_ID
  );
  if (!alreadyTagged) {
    update.$push = {
      evaluations: {
        evaluatorId: ADMIN_EVALUATOR_ID,
        name: ADMIN_EVALUATOR_NAME,
        tier: "strongly_accepted",
        comment: "Shortlisted via admin panel",
        createdAt: now,
      },
    };
  }

  return update;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  await mongoose.connect(MONGODB_URI);

  try {
    const teams = await Team.find(
      {},
      {
        teamCode: 1,
        teamName: 1,
        evaluations: 1,
        isShortlisted: 1,
        shortlistedAt: 1,
        evaluatedAt: 1,
      }
    ).lean();

    // Teams whose best tier is strongly_accepted or accepted.
    const qualifying = teams.filter((t) =>
      ACCEPTED_TIERS.has(bestTierOf(t))
    );

    const alreadyShortlisted = qualifying.filter((t) => t.isShortlisted);
    const toShortlist = qualifying.filter((t) => !t.isShortlisted);

    console.log(
      `${dryRun ? "[DRY RUN] " : ""}${qualifying.length} team(s) with best tier ` +
      `strongly_accepted/accepted (${alreadyShortlisted.length} already shortlisted, ` +
      `${toShortlist.length} newly shortlisted).`
    );

    for (const t of toShortlist) {
      console.log(
        `${dryRun ? "~" : "+"} ${t.teamCode} (${t.teamName || ""}) — best tier "${bestTierOf(t)}" -> shortlisted`
      );
    }

    if (dryRun) {
      console.log("\nNo changes written (--dry-run).");
      return;
    }

    if (qualifying.length === 0) {
      console.log("Nothing to update.");
      return;
    }

    // Apply the panel's full write to every qualifying team. The per-team
    // guards make re-runs on already-shortlisted teams a no-op in effect.
    const now = new Date();
    let modified = 0;
    for (const t of qualifying) {
      const res = await Team.updateOne(
        { teamCode: t.teamCode },
        buildShortlistUpdate(t, now)
      );
      if (res.modifiedCount > 0) modified += 1;
    }

    console.log(
      `\nApplied shortlist writes to ${qualifying.length} team(s) ` +
      `(${modified} document(s) modified, ${toShortlist.length} newly shortlisted).`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
