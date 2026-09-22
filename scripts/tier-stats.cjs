/**
 * Read-only admin script: report how many teams and participants fall into
 * each evaluation tier.
 *
 * Each Team holds an `evaluations[]` array (one entry per evaluator), and every
 * evaluation carries a `tier` of:
 *   strongly_accepted > accepted > borderline > rejected
 *
 * Because a team can be evaluated by more than one evaluator, "the team's tier"
 * is ambiguous. This script reports it three ways so nothing is hidden:
 *
 *   1. BY BEST TIER   — each evaluated team counted once, under the highest
 *                       tier any evaluator gave it. (Primary, non-overlapping.)
 *   2. RAW EVALUATIONS — every individual evaluation counted, regardless of
 *                       team. (A team with 3 evaluations contributes 3.)
 *   3. TEAMS WITH ANY  — teams that received AT LEAST ONE evaluation of a tier.
 *                       (Overlapping: a team can appear under several tiers.)
 *
 * "Participants" = sum of memberCount (falls back to teamMembers.length).
 * "Warmup" / "Twintro" = participants in that tier who solved the warmup flag
 *   (User.hasSolvedChallenge) / the twintro flag (User.twintroChallengeSolved).
 *
 * Usage:
 *   node --env-file=.env.local scripts/tier-stats.cjs
 */

const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "";

// Highest → lowest. Index = priority (lower is better).
const TIERS = ["strongly_accepted", "accepted", "borderline", "rejected"];
const TIER_RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]));

const Team =
  mongoose.models.Team ||
  mongoose.model(
    "Team",
    new mongoose.Schema({}, { strict: false, autoIndex: false }),
    "teams"
  );

const User =
  mongoose.models.User ||
  mongoose.model(
    "User",
    new mongoose.Schema({}, { strict: false, autoIndex: false }),
    "users"
  );

function memberCountOf(team) {
  if (typeof team.memberCount === "number" && team.memberCount > 0) {
    return team.memberCount;
  }
  return Array.isArray(team.teamMembers) ? team.teamMembers.length : 0;
}

function pad(str, width) {
  return String(str).padEnd(width);
}

// headers: ["Tier", "Teams", ...]. rows: [["strongly_accepted", 21, ...], ...].
// First column is the label; remaining numeric columns are summed into TOTAL.
const COL_WIDTHS = [22, 12, 14, 12, 12];

function printTable(title, headers, rows) {
  const width = headers.reduce((a, _h, i) => a + COL_WIDTHS[i], 0);
  console.log(`\n${title}`);
  console.log("─".repeat(width));
  console.log(headers.map((h, i) => pad(h, COL_WIDTHS[i])).join(""));
  console.log("─".repeat(width));

  const totals = headers.map(() => 0);
  const hasNum = headers.map(() => false);
  for (const row of rows) {
    console.log(row.map((cell, i) => pad(cell, COL_WIDTHS[i])).join(""));
    for (let i = 1; i < row.length; i++) {
      if (typeof row[i] === "number") {
        totals[i] += row[i];
        hasNum[i] = true;
      }
    }
  }
  console.log("─".repeat(width));
  console.log(
    ["TOTAL", ...totals.slice(1).map((t, i) => (hasNum[i + 1] ? t : "—"))]
      .map((cell, i) => pad(cell, COL_WIDTHS[i]))
      .join("")
  );
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  try {
    const teams = await Team.find(
      {},
      { teamCode: 1, memberCount: 1, teamMembers: 1, evaluations: 1 }
    ).lean();

    // Map each user's uid → { warmup, twintro } solve status.
    const users = await User.find(
      {},
      { uid: 1, hasSolvedChallenge: 1, twintroChallengeSolved: 1 }
    ).lean();
    const solveByUid = new Map(
      users.map((u) => [
        u.uid,
        {
          warmup: !!u.hasSolvedChallenge,
          twintro: !!u.twintroChallengeSolved,
        },
      ])
    );

    // Accumulators, keyed by tier.
    const zero = () => ({ teams: 0, participants: 0, warmup: 0, twintro: 0 });
    const byBest = Object.fromEntries(TIERS.map((t) => [t, zero()]));
    const byAny = Object.fromEntries(TIERS.map((t) => [t, zero()]));
    const rawEval = Object.fromEntries(TIERS.map((t) => [t, 0]));

    let unevaluatedTeams = 0;
    let unevaluatedParticipants = 0;
    let evaluatedTeams = 0;
    let evaluatedParticipants = 0;

    for (const team of teams) {
      const members = memberCountOf(team);
      const evals = Array.isArray(team.evaluations) ? team.evaluations : [];

      // Count warmup / twintro solvers among this team's members.
      let warmupSolvers = 0;
      let twintroSolvers = 0;
      for (const m of team.teamMembers || []) {
        const s = solveByUid.get(m && m.uid);
        if (s && s.warmup) warmupSolvers++;
        if (s && s.twintro) twintroSolvers++;
      }

      if (evals.length === 0) {
        unevaluatedTeams++;
        unevaluatedParticipants += members;
        continue;
      }

      evaluatedTeams++;
      evaluatedParticipants += members;

      // Raw: count every evaluation.
      const tiersSeen = new Set();
      let bestRank = Infinity;
      let bestTier = null;

      for (const ev of evals) {
        const tier = ev && ev.tier;
        if (!(tier in TIER_RANK)) continue; // skip unknown/legacy tiers
        rawEval[tier]++;
        tiersSeen.add(tier);
        if (TIER_RANK[tier] < bestRank) {
          bestRank = TIER_RANK[tier];
          bestTier = tier;
        }
      }

      // By best tier: count team once under its highest tier.
      if (bestTier) {
        byBest[bestTier].teams++;
        byBest[bestTier].participants += members;
        byBest[bestTier].warmup += warmupSolvers;
        byBest[bestTier].twintro += twintroSolvers;
      }

      // By any: count team under each distinct tier it received.
      for (const tier of tiersSeen) {
        byAny[tier].teams++;
        byAny[tier].participants += members;
        byAny[tier].warmup += warmupSolvers;
        byAny[tier].twintro += twintroSolvers;
      }
    }

    console.log(`Total teams:        ${teams.length}`);
    console.log(`Evaluated teams:    ${evaluatedTeams} (${evaluatedParticipants} participants)`);
    console.log(`Unevaluated teams:  ${unevaluatedTeams} (${unevaluatedParticipants} participants)`);

    printTable(
      "* BY BEST TIER (each evaluated team counted once, highest tier)",
      ["Tier", "Teams", "Participants", "Warmup", "Twintro"],
      TIERS.map((t) => [
        t,
        byBest[t].teams,
        byBest[t].participants,
        byBest[t].warmup,
        byBest[t].twintro,
      ])
    );

    // Handy roll-up: acceptance funnel.
    const accepted =
      byBest.strongly_accepted.teams + byBest.accepted.teams;
    const acceptedParts =
      byBest.strongly_accepted.participants + byBest.accepted.participants;
    console.log(
      `\nAccepted (best tier = accepted or strongly_accepted): ` +
      `${accepted} teams, ${acceptedParts} participants`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
