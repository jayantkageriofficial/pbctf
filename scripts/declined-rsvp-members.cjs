/**
 * Report: every member who DECLINED the RSVP, across all teams.
 *
 * RSVP responses live in team.memberRSVPs[] ({ uid, name, rsvpStatus,
 * rsvpedAt }); this lists entries with rsvpStatus === "declined", joined with
 * users (by uid) for email/phone context.
 *
 * Usage:
 *   node --env-file=.env.local scripts/declined-rsvp-members.cjs         # table + count
 *   node --env-file=.env.local scripts/declined-rsvp-members.cjs --csv   # CSV to stdout
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

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const asCsv = process.argv.includes("--csv");

  await mongoose.connect(MONGODB_URI);

  try {
    const teams = await Team.find(
      { "memberRSVPs.rsvpStatus": "declined" },
      { teamCode: 1, teamName: 1, teamStatus: 1, isShortlisted: 1, memberRSVPs: 1 }
    ).lean();

    // Flatten to one row per declined member.
    const declined = teams.flatMap((t) =>
      (t.memberRSVPs || [])
        .filter((r) => r && r.rsvpStatus === "declined")
        .map((r) => ({
          uid: r.uid,
          name: r.name || "",
          rsvpedAt: r.rsvpedAt ? new Date(r.rsvpedAt).toISOString() : "",
          teamCode: t.teamCode,
          teamName: t.teamName || "",
          teamStatus: t.teamStatus || "",
          isShortlisted: Boolean(t.isShortlisted),
        }))
    );

    // Join with users for contact details.
    const users = await User.find(
      { uid: { $in: declined.map((d) => d.uid) } },
      { uid: 1, email: 1, phone: 1, organisation: 1 }
    ).lean();
    const userByUid = new Map(users.map((u) => [u.uid, u]));
    for (const d of declined) {
      const u = userByUid.get(d.uid) || {};
      d.email = u.email || "";
      d.phone = u.phone || "";
      d.organisation = u.organisation || "";
    }

    declined.sort((a, b) => a.teamCode.localeCompare(b.teamCode));

    if (asCsv) {
      console.log(
        "teamCode,teamName,teamStatus,isShortlisted,uid,name,email,phone,organisation,rsvpedAt"
      );
      for (const d of declined) {
        console.log(
          [
            d.teamCode, d.teamName, d.teamStatus, d.isShortlisted,
            d.uid, d.name, d.email, d.phone, d.organisation, d.rsvpedAt,
          ].map(csvEscape).join(",")
        );
      }
      return;
    }

    for (const d of declined) {
      console.log(
        `✗ ${d.name} <${d.email}> — team ${d.teamCode} (${d.teamName})` +
        `${d.isShortlisted ? "" : " [not shortlisted]"} — declined at ${d.rsvpedAt}`
      );
    }

    console.log(
      `\n${declined.length} member(s) declined the RSVP across ${teams.length} team(s).`
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
