import fs from "fs/promises";
import path from "path";

const ROOT_DIR = process.cwd();
const MODELS_DIR = path.join(ROOT_DIR, "models");
const DATA_DIR = path.join(ROOT_DIR, "data", "etl");
const CURRENT_POINTER_PATH = path.join(MODELS_DIR, "latest.json");

const ORCHESTRATION_INTERVAL_MINUTES = Number(
  process.env.ORCHESTRATION_INTERVAL_MINUTES ?? "360"
);
const MIN_WIN_RATE = Number(process.env.MIN_WIN_RATE ?? "0.55");
const MAX_DRAWDOWN = Number(process.env.MAX_DRAWDOWN ?? "0.2");
const MIN_PNL_PER_TRADE = Number(process.env.MIN_PNL_PER_TRADE ?? "0");

const DEFAULT_EVAL_METRICS = {
  winRate: Number(process.env.EVAL_WIN_RATE ?? "0"),
  maxDrawdown: Number(process.env.EVAL_MAX_DRAWDOWN ?? "1"),
  pnlPerTrade: Number(process.env.EVAL_PNL_PER_TRADE ?? "0"),
};

const ensureDir = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const timestampId = () => new Date().toISOString().replace(/[:.]/g, "-");

const readJsonIfExists = async (filePath) => {
  try {
    const contents = await fs.readFile(filePath, "utf-8");
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const writeJson = async (filePath, payload) => {
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(filePath, contents, "utf-8");
};

const runETL = async (runId) => {
  await ensureDir(DATA_DIR);
  const etlOutput = {
    runId,
    collectedAt: new Date().toISOString(),
    source: "placeholder",
  };
  const etlPath = path.join(DATA_DIR, `etl-${runId}.json`);
  await writeJson(etlPath, etlOutput);
  return etlPath;
};

const runTraining = async ({ runId, etlPath }) => {
  await ensureDir(MODELS_DIR);
  const modelId = `model-${runId}`;
  const modelDir = path.join(MODELS_DIR, modelId);
  await ensureDir(modelDir);
  const metadataPath = path.join(modelDir, "metadata.json");
  const metadata = {
    modelId,
    runId,
    status: "trained",
    createdAt: new Date().toISOString(),
    etlPath,
    metrics: null,
    promoted: false,
  };
  await writeJson(metadataPath, metadata);
  return { modelId, modelDir, metadataPath };
};

const loadEvaluationMetrics = async () => {
  if (process.env.EVAL_METRICS_PATH) {
    const metrics = await readJsonIfExists(process.env.EVAL_METRICS_PATH);
    if (metrics) {
      return metrics;
    }
  }
  return DEFAULT_EVAL_METRICS;
};

const runEvaluation = async ({ metadataPath }) => {
  const metadata = await readJsonIfExists(metadataPath);
  if (!metadata) {
    throw new Error(`Missing metadata at ${metadataPath}`);
  }
  const metrics = await loadEvaluationMetrics();
  const evaluatedAt = new Date().toISOString();
  const updated = {
    ...metadata,
    status: "evaluated",
    evaluatedAt,
    metrics: {
      winRate: Number(metrics.winRate ?? 0),
      maxDrawdown: Number(metrics.maxDrawdown ?? 1),
      pnlPerTrade: Number(metrics.pnlPerTrade ?? 0),
    },
  };
  await writeJson(metadataPath, updated);
  return updated;
};

const meetsGate = (metrics) => {
  if ([MIN_WIN_RATE, MAX_DRAWDOWN, MIN_PNL_PER_TRADE].some((value) => Number.isNaN(value))) {
    throw new Error("Promotion thresholds must be valid numbers.");
  }
  return (
    metrics.winRate >= MIN_WIN_RATE &&
    metrics.maxDrawdown <= MAX_DRAWDOWN &&
    metrics.pnlPerTrade >= MIN_PNL_PER_TRADE
  );
};

const promoteIfEligible = async ({ metadata, metadataPath }) => {
  if (!metadata.metrics) {
    throw new Error("Missing metrics for promotion gate.");
  }
  const eligible = meetsGate(metadata.metrics);
  const promotedAt = eligible ? new Date().toISOString() : null;
  const updated = {
    ...metadata,
    status: eligible ? "promoted" : "rejected",
    promoted: eligible,
    promotedAt,
    promotionGate: {
      minWinRate: MIN_WIN_RATE,
      maxDrawdown: MAX_DRAWDOWN,
      minPnlPerTrade: MIN_PNL_PER_TRADE,
    },
  };
  await writeJson(metadataPath, updated);

  if (eligible) {
    const pointer = {
      modelId: metadata.modelId,
      metadataPath,
      promotedAt,
      metrics: metadata.metrics,
    };
    await writeJson(CURRENT_POINTER_PATH, pointer);
  }

  return { eligible, metadata: updated };
};

const runPipeline = async () => {
  const runId = timestampId();
  console.log(`[orchestrator] Starting run ${runId}`);
  const etlPath = await runETL(runId);
  console.log(`[orchestrator] ETL output: ${etlPath}`);
  const training = await runTraining({ runId, etlPath });
  console.log(`[orchestrator] Trained model: ${training.modelId}`);
  const evaluated = await runEvaluation({ metadataPath: training.metadataPath });
  console.log(`[orchestrator] Evaluation metrics`, evaluated.metrics);
  const promotion = await promoteIfEligible({
    metadata: evaluated,
    metadataPath: training.metadataPath,
  });
  console.log(
    `[orchestrator] Promotion result: ${promotion.eligible ? "promoted" : "rejected"}`
  );
};

const shouldRunOnce = process.argv.includes("--once") || process.env.ORCHESTRATION_MODE === "once";

const runWithErrorHandling = () =>
  runPipeline().catch((error) => console.error("[orchestrator] Scheduled run failed", error));

if (shouldRunOnce) {
  runPipeline().catch((error) => {
    console.error("[orchestrator] Failed run", error);
    process.exitCode = 1;
  });
} else if (Number.isNaN(ORCHESTRATION_INTERVAL_MINUTES) || ORCHESTRATION_INTERVAL_MINUTES <= 0) {
  console.error("[orchestrator] Invalid ORCHESTRATION_INTERVAL_MINUTES value.");
  process.exitCode = 1;
} else {
  const intervalMs = ORCHESTRATION_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[orchestrator] Scheduling every ${ORCHESTRATION_INTERVAL_MINUTES} minutes (setInterval)`
  );
  runWithErrorHandling();
  setInterval(runWithErrorHandling, intervalMs);
}
