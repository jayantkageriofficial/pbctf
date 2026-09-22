/**
 * Read-only admin script: export every member of every SHORTLISTED team to a
 * CSV, irrespective of their RSVP response.
 *
 * Columns:
 *   Team Code, Team Name, Name, Phone, Email, RSVP Status
 *
 * Shortlisted teams are those with isShortlisted === true (the flag the admin
 * panel / shortlist-accepted-teams.cjs sets). Rows are emitted per team in
 * teamMembers[] order with the Team Lead first, then other members — same as
 * export-rsvp-confirmed-members.cjs. "RSVP Status" is looked up from
 * team.memberRSVPs[] by uid ("confirmed" / "declined"), or "pending" when the
 * member has no RSVP entry yet.
 *
 * Usage:
 *   node --env-file=.env.local scripts/export-shortlisted-members.cjs > shortlisted-members.csv
 *   node --env-file=.env.local scripts/export-shortlisted-members.cjs --out shortlisted-members.csv
 */

const fs = require("fs");
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
    const teams = await Team.find(
      { isShortlisted: true },
      { teamCode: 1, teamName: 1, teamMembers: 1, memberRSVPs: 1 }
    ).lean();

    // Flatten to one row per member, in teamMembers[] order with the Team
    // Lead first — same ordering as export-rsvp-confirmed-members.cjs.
    const rows = teams.flatMap((t) => {
      const rsvpByUid = new Map(
        (t.memberRSVPs || []).filter(Boolean).map((r) => [r.uid, r])
      );
      return (t.teamMembers || []).map((m, i) => {
        const rsvp = rsvpByUid.get(m.uid);
        return {
          uid: m.uid,
          name: m.name || "",
          teamCode: t.teamCode || "",
          teamName: t.teamName || "",
          rsvpStatus: (rsvp && rsvp.rsvpStatus) || "pending",
          rank: m.role === "Team Lead" ? -1 : i,
        };
      });
    });

    // Join with users for name + contact details.
    const users = await User.find(
      { uid: { $in: rows.map((r) => r.uid) } },
      { uid: 1, name: 1, phone: 1, email: 1 }
    ).lean();
    const userByUid = new Map(users.map((u) => [u.uid, u]));

    rows.sort(
      (a, b) => a.teamCode.localeCompare(b.teamCode) || a.rank - b.rank
    );

    const header = ["Team Code", "Team Name", "Name", "Phone", "Email", "RSVP Status"];
    const lines = [csvRow(header)];
    let missingUsers = 0;

    for (const r of rows) {
      const user = userByUid.get(r.uid);
      if (!user) missingUsers++;
      lines.push(
        csvRow([
          r.teamCode,
          r.teamName,
          (user && user.name) || r.name,
          (user && user.phone) || "",
          (user && user.email) || "",
          r.rsvpStatus,
        ])
      );
    }

    const csv = lines.join("\n") + "\n";

    if (outPath) {
      fs.writeFileSync(outPath, csv);
      console.error(
        `Wrote ${rows.length} member(s) from ${teams.length} shortlisted team(s) to ${outPath}`
      );
    } else {
      process.stdout.write(csv);
      console.error(
        `\nExported ${rows.length} member(s) from ${teams.length} shortlisted team(s)`
      );
    }
    if (missingUsers > 0) {
      console.error(
        `Warning: ${missingUsers} member(s) had no matching User doc (blank phone/email).`
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
