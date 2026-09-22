/**
 * One-off admin script: assign a fixed list of team codes to one or more evaluators.
 *
 * Usage:
 *   node --env-file=.env.local scripts/assign-teams-to-evaluator.cjs
 *
 * Safe to re-run: team codes already present on the evaluator are skipped,
 * and codes that don't match a Team document are skipped (and reported).
 */

const mongoose = require("mongoose");

const MONGODB_URI = ""
const EVALUATOR_UIDS = [""];

const TEAM_CODES = []

const AssignedTeamSchema = new mongoose.Schema(
  {
    teamCode: { type: String, required: true },
    assignedAt: { type: Date, default: Date.now },
    isEvaluated: { type: Boolean, default: false },
  },
  { _id: false }
);

const StatsSchema = new mongoose.Schema(
  {
    evaluationsCompleted: { type: Number, default: 0 },
    evaluationsPending: { type: Number, default: 0 },
  },
  { _id: false }
);

const EvaluatorSchema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    role: { type: String, default: "evaluator" },
    assignedTeams: [AssignedTeamSchema],
    assignedCount: { type: Number, default: 0 },
    evaluatedCount: { type: Number, default: 0 },
    stats: {
      type: StatsSchema,
      default: () => ({ evaluationsCompleted: 0, evaluationsPending: 0 }),
    },
    lastLoginAt: { type: Date },
    lastEvaluationAt: { type: Date },
  },
  { timestamps: true, autoIndex: false }
);

EvaluatorSchema.pre("save", function () {
  this.assignedCount = this.assignedTeams.length;
  this.evaluatedCount = this.assignedTeams.filter((t) => t.isEvaluated).length;
  this.stats.evaluationsCompleted = this.evaluatedCount;
  this.stats.evaluationsPending = this.assignedCount - this.evaluatedCount;
});

const Evaluator =
  mongoose.models.Evaluator || mongoose.model("Evaluator", EvaluatorSchema);

const Team =
  mongoose.models.Team ||
  mongoose.model(
    "Team",
    new mongoose.Schema(
      { teamCode: { type: String, required: true, unique: true } },
      { autoIndex: false }
    )
  );

async function main() {
  if (!MONGODB_URI) {
    throw new Error(
      "MONGODB_URI is not set. Run with: node --env-file=.env.local scripts/assign-teams-to-evaluator.cjs"
    );
  }

  await mongoose.connect(MONGODB_URI);

  const uniqueCodes = [...new Set(TEAM_CODES)];

  const existingTeams = await Team.find({ teamCode: { $in: uniqueCodes } })
    .select("teamCode")
    .lean();
  const existingCodes = new Set(existingTeams.map((t) => t.teamCode));
  const missingCodes = uniqueCodes.filter((c) => !existingCodes.has(c));
  if (missingCodes.length) {
    console.warn(
      `Skipping ${missingCodes.length} team code(s) with no matching Team document:`,
      missingCodes
    );
  }

  for (const evaluatorUid of EVALUATOR_UIDS) {
    const evaluator = await Evaluator.findOne({ uid: evaluatorUid });
    if (!evaluator) {
      console.warn(`No evaluator found with uid ${evaluatorUid}; skipping.`);
      continue;
    }

    let added = 0;
    for (const teamCode of uniqueCodes) {
      if (!existingCodes.has(teamCode)) continue;

      const alreadyAssigned = evaluator.assignedTeams.some(
        (t) => t.teamCode === teamCode
      );
      if (!alreadyAssigned) {
        evaluator.assignedTeams.push({
          teamCode,
          assignedAt: new Date(),
          isEvaluated: false,
        });
        added++;
      }
    }

    await evaluator.save();

    console.log(
      `Added ${added} new team(s). Evaluator ${evaluator.uid} now has ${evaluator.assignedCount} assigned team(s).`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
