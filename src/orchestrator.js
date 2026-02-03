import fs from "fs/promises";
import { spawn } from "child_process";
import path from "path";

const ROOT_DIR = process.cwd();
const MODELS_DIR = path.join(ROOT_DIR, "models");
const DATA_DIR = path.join(ROOT_DIR, "data", "etl");
const CURRENT_POINTER_PATH = path.join(MODELS_DIR, "latest.json");
const TRAINING_SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "train_model.js");
const DATASET_BUILDER_PATH = path.join(ROOT_DIR, "training", "build_dataset.js");
const TRAINING_EVENTS_PATH = path.join(ROOT_DIR, "training_events.jsonl");
const TRADES_PATH = path.join(ROOT_DIR, "trades.jsonl");

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

const runCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit ${code})`));
    });
  });

const readJsonl = async (filePath) => {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const readParquet = async (filePath) => {
  const parquet = await import("parquetjs-lite");
  const reader = await parquet.ParquetReader.openFile(filePath);
  const cursor = reader.getCursor();
  const rows = [];
  while (true) {
    const record = await cursor.next();
    if (!record) break;
    rows.push(record);
  }
  await reader.close();
  return rows;
};

const resolveDatasetRows = async (datasetPath) => {
  if (datasetPath.endsWith(".jsonl")) {
    return readJsonl(datasetPath);
  }
  if (datasetPath.endsWith(".parquet")) {
    return readParquet(datasetPath);
  }
  throw new Error(`Unsupported dataset format: ${datasetPath}`);
};

const buildTrainingRows = (rows) =>
  rows
    .map((row) => {
      const features =
        row?.features_json && typeof row.features_json === "string"
          ? JSON.parse(row.features_json)
          : row?.features ?? {};
      const labelSource =
        row?.label_realized_pnl_pct ??
        row?.label_return_15m ??
        row?.label_return_5m ??
        row?.label_return_60m;
      if (labelSource === null || labelSource === undefined) return null;
      const label = Number(labelSource) > 0 ? 1 : 0;
      return {
        timestamp: row?.event_time_ms ?? null,
        label,
        features,
      };
    })
    .filter(Boolean);

const runETL = async (runId) => {
  await ensureDir(DATA_DIR);
  const runDir = path.join(DATA_DIR, runId);
  await ensureDir(runDir);

  await runCommand(process.execPath, [
    DATASET_BUILDER_PATH,
    "--events",
    TRAINING_EVENTS_PATH,
    "--trades",
    TRADES_PATH,
    "--out",
    DATA_DIR,
    "--date",
    runId,
  ]);

  const parquetPath = path.join(runDir, "train.parquet");
  const jsonlPath = path.join(runDir, "train.jsonl");
  let datasetPath = null;
  try {
    await fs.access(parquetPath);
    datasetPath = parquetPath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!datasetPath) {
    try {
      await fs.access(jsonlPath);
      datasetPath = jsonlPath;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Missing dataset output in ${runDir}`);
      }
      throw error;
    }
  }

  const datasetRows = await resolveDatasetRows(datasetPath);
  const trainingRows = buildTrainingRows(datasetRows);
  const trainingDatasetPath = path.join(runDir, "training_dataset.json");
  await writeJson(trainingDatasetPath, trainingRows);

  const etlOutput = {
    runId,
    collectedAt: new Date().toISOString(),
    source: "training/build_dataset.js",
    datasetPath,
    trainingDatasetPath,
    rows: trainingRows.length,
  };
  const etlPath = path.join(runDir, "etl-summary.json");
  await writeJson(etlPath, etlOutput);
  return { etlPath, trainingDatasetPath };
};

const runTraining = async ({ runId, etlPath, trainingDatasetPath }) => {
  await ensureDir(MODELS_DIR);
  await runCommand(process.execPath, [TRAINING_SCRIPT_PATH], {
    env: {
      ...process.env,
      DATASET_PATH: trainingDatasetPath,
    },
  });

  const latestMetadataPath = path.join(MODELS_DIR, "latest.metadata.json");
  const latestMetadata = await readJsonIfExists(latestMetadataPath);
  if (!latestMetadata?.modelPath) {
    throw new Error("Training did not produce models/latest.metadata.json");
  }
  const modelPath = path.join(MODELS_DIR, latestMetadata.modelPath);
  const modelId = path.basename(latestMetadata.modelPath, path.extname(latestMetadata.modelPath));
  const runMetadataPath = path.join(MODELS_DIR, `run-${runId}.metadata.json`);
  const metadata = {
    modelId,
    runId,
    status: "trained",
    createdAt: new Date().toISOString(),
    etlPath,
    trainingDatasetPath,
    modelPath,
    trainingMetadataPath: latestMetadataPath,
    metrics: null,
    promoted: false,
  };
  await writeJson(runMetadataPath, metadata);
  return { modelId, modelPath, metadataPath: runMetadataPath };
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
      modelPath: metadata.modelPath,
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
  const { etlPath, trainingDatasetPath } = await runETL(runId);
  console.log(`[orchestrator] ETL output: ${etlPath}`);
  const training = await runTraining({ runId, etlPath, trainingDatasetPath });
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
