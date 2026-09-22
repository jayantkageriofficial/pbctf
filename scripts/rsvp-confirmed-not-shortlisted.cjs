/**
 * Read-only admin script: export every member who RSVPed (rsvpStatus ===
 * "confirmed" in team.memberRSVPs[] OR a non-empty idName on their User doc —
 * the field the RSVP flow fills in) but whose team is NOT shortlisted
 * (isShortlisted !== true) to a CSV.
 *
 * Columns:
 *   Team Code, Team Name, Name, idName, Phone, Email, RSVP Status
 *
 * Usage:
 *   node --env-file=.env.local scripts/rsvp-confirmed-not-shortlisted.cjs > rsvp-confirmed-not-shortlisted.csv
 *   node --env-file=.env.local scripts/rsvp-confirmed-not-shortlisted.cjs --out rsvp-confirmed-not-shortlisted.csv
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
      { isShortlisted: { $ne: true } },
      { teamCode: 1, teamName: 1, teamMembers: 1, memberRSVPs: 1 }
    ).lean();

    // Flatten to one row per member, in teamMembers[] order (Team Lead first,
    // then other members) — same as export-members.cjs.
    const candidates = teams.flatMap((t) => {
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

    // Join with users for idName + contact details.
    const users = await User.find(
      { uid: { $in: candidates.map((c) => c.uid) } },
      { uid: 1, name: 1, idName: 1, phone: 1, email: 1 }
    ).lean();
    const userByUid = new Map(users.map((u) => [u.uid, u]));

    // RSVPed = explicitly confirmed OR idName filled in (the RSVP flow sets it).
    const confirmed = candidates.filter((c) => {
      const user = userByUid.get(c.uid);
      const idName = user && typeof user.idName === "string" ? user.idName.trim() : "";
      return c.rsvpStatus === "confirmed" || idName !== "";
    });

    confirmed.sort(
      (a, b) => a.teamCode.localeCompare(b.teamCode) || a.rank - b.rank
    );

    const header = ["Team Code", "Team Name", "Name", "idName", "Phone", "Email", "RSVP Status"];
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
          c.rsvpStatus,
        ])
      );
    }

    const csv = lines.join("\n") + "\n";

    if (outPath) {
      fs.writeFileSync(outPath, csv);
      console.error(
        `Wrote ${confirmed.length} RSVPed-but-not-shortlisted member(s) to ${outPath}`
      );
    } else {
      process.stdout.write(csv);
      console.error(
        `\nExported ${confirmed.length} RSVPed-but-not-shortlisted member(s)`
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
