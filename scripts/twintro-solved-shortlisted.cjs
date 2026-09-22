/**
 * Report: among shortlisted teams (isShortlisted === true), how many have at
 * least ONE member who solved the twintro challenge
 * (User.twintroChallengeSolved === true).
 *
 * Team members are User uids in team.teamMembers[].uid; the solved flag lives
 * on the User document, so this joins teams -> users by uid.
 *
 * Usage:
 *   node --env-file=.env.local scripts/twintro-solved-shortlisted.cjs           # summary count
 *   node --env-file=.env.local scripts/twintro-solved-shortlisted.cjs --list    # per-team breakdown
 */

const mongoose = require("mongoose");

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "";

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

async function main() {
  const list = process.argv.includes("--list");

  await mongoose.connect(MONGODB_URI);

  try {
    const teams = await Team.find(
      { isShortlisted: true },
      { teamCode: 1, teamName: 1, teamMembers: 1 }
    ).lean();

    // Collect every member uid across shortlisted teams, then fetch which of
    // those users solved twintro in one query.
    const allUids = [
      ...new Set(
        teams.flatMap((t) =>
          (t.teamMembers || []).map((m) => m && m.uid).filter(Boolean)
        )
      ),
    ];

    const solvedUsers = await User.find(
      { uid: { $in: allUids }, twintroChallengeSolved: true },
      { uid: 1 }
    ).lean();
    const solvedUidSet = new Set(solvedUsers.map((u) => u.uid));

    let withSolver = 0;
    let withoutSolver = 0;
    const breakdown = [];

    for (const t of teams) {
      const uids = (t.teamMembers || []).map((m) => m && m.uid).filter(Boolean);
      const solvers = uids.filter((uid) => solvedUidSet.has(uid));
      const hasSolver = solvers.length > 0;
      if (hasSolver) withSolver += 1;
      else withoutSolver += 1;
      breakdown.push({
        teamCode: t.teamCode,
        teamName: t.teamName || "",
        memberCount: uids.length,
        solverCount: solvers.length,
        hasSolver,
      });
    }

    if (list) {
      breakdown
        .sort((a, b) => Number(a.hasSolver) - Number(b.hasSolver))
        .forEach((b) => {
          console.log(
            `${b.hasSolver ? "✓" : "✗"} ${b.teamCode} (${b.teamName}) — ` +
            `${b.solverCount}/${b.memberCount} member(s) solved twintro`
          );
        });
      console.log("");
    }

    console.log(`Shortlisted teams:                 ${teams.length}`);
    console.log(`  with >=1 twintro solver:         ${withSolver}`);
    console.log(`  with no twintro solver:          ${withoutSolver}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
