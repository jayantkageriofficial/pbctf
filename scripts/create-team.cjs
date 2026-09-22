/**
 * One-off admin script: create a team from a fixed list of user UIDs.
 *
 * The first UID in USERS becomes the Team Lead; any remaining UIDs join as
 * Members. Teams may be single (1 UID) or duo (2 UIDs) — matching the app's
 * MAX_TEAM_MEMBERS = 2 rule.
 *
 * Usage (config at the top of this file):
 *   node --env-file=.env.local scripts/create-team.cjs
 *
 * Usage (CLI overrides — team name first, then UIDs):
 *   node --env-file=.env.local scripts/create-team.cjs "XYZ" UID_LEAD UID_MEMBER
 *
 * Mirrors POST /api/team/create + PUT /api/team/join:
 *   - generates a unique 6-8 char alphanumeric team code
 *   - enforces case-insensitive unique team name (2-50 chars)
 *   - refuses UIDs that don't exist or are already in a team
 *   - sets each user's teamCode and isLooking = false
 *   - cancels each user's pending join requests/invites
 *
 * Safe to re-run only if it previously failed before creating the team; once a
 * team exists this will refuse (users already in a team / name taken).
 */

const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// CONFIG — edit these, or pass CLI args (see usage above).
// ---------------------------------------------------------------------------
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "";

// Index 0 = Team Lead. Single UID => solo team, two UIDs => duo team.
let TEAM_NAME = "XYZ";
let USERS = [
  // "LEAD_UID",
  // "MEMBER_UID",
];

// CLI overrides: node ... create-team.cjs "<teamName>" <leadUid> [memberUid]
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  TEAM_NAME = cliArgs[0];
  USERS = cliArgs.slice(1);
}

const MAX_TEAM_MEMBERS = 2;

// ---------------------------------------------------------------------------
// Minimal schemas (standalone; mirror models/Team.ts, models/User.ts, etc.)
// ---------------------------------------------------------------------------
const TeamMemberSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
    role: { type: String, enum: ["Team Lead", "Member"], default: "Member" },
  },
  { _id: false }
);

const TeamSchema = new mongoose.Schema(
  {
    teamCode: { type: String, required: true, unique: true },
    teamName: { type: String, required: true, unique: true },
    teamLead: { type: String, required: true },
    isLooking: { type: Boolean, default: true },
    teamMembers: [TeamMemberSchema],
    memberCount: { type: Number, default: 1 },
    teamStatus: {
      type: String,
      enum: [
        "pending",
        "submitted",
        "withdrawn",
        "shortlisted",
        "rsvped",
        "rsvp_declined",
      ],
      default: "pending",
    },
  },
  { timestamps: true, autoIndex: false }
);

const UserSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true },
    name: { type: String },
    email: { type: String },
    isLooking: { type: Boolean, default: false },
    teamCode: { type: String },
  },
  { timestamps: true, autoIndex: false, strict: false }
);

const TeamJoinRequestSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    status: { type: String },
    respondedAt: { type: Date },
  },
  { autoIndex: false, strict: false }
);

const Team = mongoose.models.Team || mongoose.model("Team", TeamSchema);
const User = mongoose.models.User || mongoose.model("User", UserSchema);
const TeamJoinRequest =
  mongoose.models.TeamJoinRequest ||
  mongoose.model("TeamJoinRequest", TeamJoinRequestSchema);

// ---------------------------------------------------------------------------
// Helpers (mirror app/api/team/create/route.ts)
// ---------------------------------------------------------------------------
async function generateTeamCode() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = Math.floor(Math.random() * 3) + 6; // 6-8 characters
  const maxAttempts = 10;

  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    let code = "";
    for (let i = 0; i < length; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    const existing = await Team.findOne({ teamCode: code }).lean();
    if (!existing) return code;
  }
  throw new Error("Failed to generate unique team code");
}

async function isTeamNameUnique(teamName) {
  const escaped = teamName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await Team.findOne({
    teamName: { $regex: new RegExp(`^${escaped}$`, "i") },
  }).lean();
  return !existing;
}

// ---------------------------------------------------------------------------
async function main() {
  // Validate config
  const name = (TEAM_NAME || "").trim();
  if (!name) throw new Error("TEAM_NAME is required.");
  if (name.length < 2 || name.length > 50) {
    throw new Error("Team name must be 2-50 characters.");
  }

  const uids = [...new Set(USERS.map((u) => (u || "").trim()).filter(Boolean))];
  if (uids.length !== USERS.length) {
    throw new Error("USERS contains empty or duplicate UIDs.");
  }
  if (uids.length < 1 || uids.length > MAX_TEAM_MEMBERS) {
    throw new Error(
      `USERS must contain 1-${MAX_TEAM_MEMBERS} UID(s). Got ${uids.length}.`
    );
  }

  await mongoose.connect(MONGODB_URI);

  try {
    // All users must exist and be free
    const users = await User.find({ uid: { $in: uids } })
      .select("uid name email teamCode")
      .lean();
    const byUid = new Map(users.map((u) => [u.uid, u]));

    const missing = uids.filter((u) => !byUid.has(u));
    if (missing.length) {
      throw new Error(`No user found for UID(s): ${missing.join(", ")}`);
    }

    const alreadyTeamed = uids.filter((u) => byUid.get(u).teamCode);
    if (alreadyTeamed.length) {
      throw new Error(
        `UID(s) already in a team: ${alreadyTeamed
          .map((u) => `${u} (${byUid.get(u).teamCode})`)
          .join(", ")}`
      );
    }

    // Team name must be unique (case-insensitive)
    if (!(await isTeamNameUnique(name))) {
      throw new Error(`Team name "${name}" already exists.`);
    }

    const teamCode = await generateTeamCode();

    const teamMembers = uids.map((uid, i) => ({
      uid,
      joinedAt: new Date(),
      role: i === 0 ? "Team Lead" : "Member",
    }));

    const newTeam = new Team({
      teamCode,
      teamName: name,
      teamLead: uids[0],
      isLooking: false,
      teamMembers,
      memberCount: teamMembers.length,
      teamStatus: "pending",
    });
    await newTeam.save();

    // Point each user at the team
    await User.updateMany(
      { uid: { $in: uids } },
      { teamCode, isLooking: false }
    );

    // Cancel pending join requests/invites for these users
    const cancelled = await TeamJoinRequest.updateMany(
      { userId: { $in: uids }, status: "pending" },
      { status: "cancelled", respondedAt: new Date() }
    );

    console.log("Team created successfully:");
    console.log(`  teamName : ${newTeam.teamName}`);
    console.log(`  teamCode : ${newTeam.teamCode}`);
    console.log(`  teamLead : ${uids[0]} (${byUid.get(uids[0]).name || "?"})`);
    teamMembers.forEach((m) =>
      console.log(`  member   : ${m.uid} — ${m.role} (${byUid.get(m.uid).name || "?"})`)
    );
    console.log(`  cancelled ${cancelled.modifiedCount || 0} pending join request(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
