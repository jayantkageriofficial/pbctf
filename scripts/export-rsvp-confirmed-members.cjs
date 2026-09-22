/**
 * Read-only admin script: export every member who CONFIRMED the RSVP to a CSV.
 *
 * Columns:
 *   Team Code, Team Name, Name, idName, Phone, Email
 *
 * RSVP responses live in team.memberRSVPs[] ({ uid, name, rsvpStatus,
 * rsvpedAt }); this lists entries with rsvpStatus === "confirmed", joined with
 * users (by uid) for idName/phone/email.
 *
 * Usage:
 *   node --env-file=.env.local scripts/export-rsvp-confirmed-members.cjs > rsvp-confirmed.csv
 *   node --env-file=.env.local scripts/export-rsvp-confirmed-members.cjs --out rsvp-confirmed.csv
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
      { "memberRSVPs.rsvpStatus": "confirmed" },
      { teamCode: 1, teamName: 1, teamMembers: 1, memberRSVPs: 1 }
    ).lean();

    // Flatten to one row per confirmed member, in teamMembers[] order
    // (Team Lead first, then other members) — same as export-members.cjs.
    const confirmed = teams.flatMap((t) => {
      const memberRank = new Map(
        (t.teamMembers || []).map((m, i) => [
          m.uid,
          m.role === "Team Lead" ? -1 : i,
        ])
      );
      return (t.memberRSVPs || [])
        .filter((r) => r && r.rsvpStatus === "confirmed")
        .map((r) => ({
          uid: r.uid,
          name: r.name || "",
          teamCode: t.teamCode || "",
          teamName: t.teamName || "",
          rank: memberRank.has(r.uid) ? memberRank.get(r.uid) : Infinity,
        }));
    });

    // Join with users for idName + contact details.
    const users = await User.find(
      { uid: { $in: confirmed.map((c) => c.uid) } },
      { uid: 1, name: 1, idName: 1, phone: 1, email: 1 }
    ).lean();
    const userByUid = new Map(users.map((u) => [u.uid, u]));

    confirmed.sort(
      (a, b) => a.teamCode.localeCompare(b.teamCode) || a.rank - b.rank
    );

    const header = ["Team Code", "Team Name", "Name", "idName", "Phone", "Email"];
    const lines = [csvRow(header)];
    let missingUsers = 0;

    for (const c of confirmed) {
      const user = userByUid.get(c.uid);
      if (!user) missingUsers++;
      lines.push(
        csvRow([
          c.teamCode,
          c.teamName,
          (user && user.name) || c.name,
          (user && user.idName) || "",
          (user && user.phone) || "",
          (user && user.email) || "",
        ])
      );
    }

    const csv = lines.join("\n") + "\n";

    if (outPath) {
      fs.writeFileSync(outPath, csv);
      console.error(
        `Wrote ${confirmed.length} confirmed member(s) from ${teams.length} team(s) to ${outPath}`
      );
    } else {
      process.stdout.write(csv);
      console.error(
        `\nExported ${confirmed.length} confirmed member(s) from ${teams.length} team(s)`
      );
    }
    if (missingUsers > 0) {
      console.error(
        `Warning: ${missingUsers} confirmed member(s) had no matching User doc (blank idName/phone/email).`
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
