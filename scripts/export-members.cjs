/**
 * Read-only admin script: export every team member to a CSV.
 *
 * Columns:
 *   Name, Email, Phone, Discord, Resume, GitHub, LinkedIn, Organisation,
 *   Warmup Flag, Twintro Flag, Team Code, Team Name, Evaluation
 *
 * Member identity lives on the User doc (keyed by `uid`); a Team only stores
 * its members' uids. So we load all users into a uid -> user map, then walk
 * every team's `teamMembers[]` and emit one row per member.
 *
 * "Evaluation" is the team's BEST tier across all its evaluations
 *   (strongly_accepted > accepted > borderline > rejected), or "unevaluated".
 * Warmup Flag  = User.hasSolvedChallenge      (Yes/No)
 * Twintro Flag = User.twintroChallengeSolved  (Yes/No)
 *
 * Usage:
 *   node --env-file=.env.local scripts/export-members.cjs > members.csv
 *   node --env-file=.env.local scripts/export-members.cjs --out members.csv
 */

const fs = require("fs");
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

// Best (highest) tier a team received, or null if never evaluated.
function bestTierOf(team) {
  const evals = Array.isArray(team.evaluations) ? team.evaluations : [];
  let bestRank = Infinity;
  let bestTier = null;
  for (const ev of evals) {
    const tier = ev && ev.tier;
    if (!(tier in TIER_RANK)) continue; // skip unknown/legacy tiers
    if (TIER_RANK[tier] < bestRank) {
      bestRank = TIER_RANK[tier];
      bestTier = tier;
    }
  }
  return bestTier;
}

// RFC-4180 CSV escaping: wrap in quotes and double any embedded quotes.
function csvCell(value) {
  const s = value === undefined || value === null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx !== -1 ? process.argv[outIdx + 1] : null;

  await mongoose.connect(MONGODB_URI);

  try {
    const users = await User.find(
      {},
      {
        uid: 1,
        name: 1,
        email: 1,
        phone: 1,
        discord_username: 1,
        resume_link: 1,
        github_link: 1,
        linkedin_link: 1,
        organisation: 1,
        hasSolvedChallenge: 1,
        twintroChallengeSolved: 1,
      }
    ).lean();

    const userByUid = new Map(users.map((u) => [u.uid, u]));

    const teams = await Team.find(
      {},
      { teamCode: 1, teamName: 1, teamMembers: 1, evaluations: 1 }
    ).lean();

    // Order by evaluation tier (strongly_accepted > accepted > borderline >
    // rejected, unevaluated last), then alphabetically by team name within tier.
    const tierSortRank = (team) => {
      const tier = bestTierOf(team);
      return tier === null ? TIERS.length : TIER_RANK[tier];
    };
    teams.sort((a, b) => {
      const diff = tierSortRank(a) - tierSortRank(b);
      if (diff !== 0) return diff;
      return (a.teamName || "").localeCompare(b.teamName || "");
    });

    const header = [
      "Name",
      "Email",
      "Phone",
      "Discord",
      "Resume",
      "GitHub",
      "LinkedIn",
      "Organisation",
      "Warmup Flag",
      "Twintro Flag",
      "Team Code",
      "Team Name",
      "Evaluation",
    ];

    const lines = [csvRow(header)];
    let memberRows = 0;
    let missingUsers = 0;

    for (const team of teams) {
      const tier = bestTierOf(team) || "unevaluated";
      const members = Array.isArray(team.teamMembers) ? team.teamMembers : [];

      for (const member of members) {
        const user = userByUid.get(member.uid);
        if (!user) {
          missingUsers++;
        }
        lines.push(
          csvRow([
            (user && user.name) || "",
            (user && user.email) || "",
            (user && user.phone) || "",
            (user && user.discord_username) || "",
            (user && user.resume_link) || "",
            (user && user.github_link) || "",
            (user && user.linkedin_link) || "",
            (user && user.organisation) || "",
            user && user.hasSolvedChallenge ? "Yes" : "No",
            user && user.twintroChallengeSolved ? "Yes" : "No",
            team.teamCode || "",
            team.teamName || "",
            tier,
          ])
        );
        memberRows++;
      }
    }

    const csv = lines.join("\n") + "\n";

    if (outPath) {
      fs.writeFileSync(outPath, csv);
      console.error(
        `Wrote ${memberRows} member rows from ${teams.length} teams to ${outPath}`
      );
    } else {
      process.stdout.write(csv);
      console.error(
        `\nExported ${memberRows} member rows from ${teams.length} teams`
      );
    }
    if (missingUsers > 0) {
      console.error(
        `Warning: ${missingUsers} team member(s) had no matching User doc (blank name/links).`
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
