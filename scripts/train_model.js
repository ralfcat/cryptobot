import fs from "fs/promises";
import path from "path";

const DEFAULT_FEATURES = [
  "rsi",
  "emaFast",
  "emaSlow",
  "volumeSpike",
  "valley",
  "trend",
  "trigger",
  "price",
  "volume",
  "emaFastMinusSlow",
];

const RESERVED_KEYS = new Set(["label", "y", "target", "timestamp", "t", "time", "features"]);

function parseFeatureList(envValue, rows) {
  if (envValue) {
    return envValue
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const sample = rows.find((row) => row && typeof row === "object");
  if (!sample) return DEFAULT_FEATURES;
  const features = sample.features;
  if (features && typeof features === "object") {
    return Object.keys(features);
  }
  const keys = Object.keys(sample).filter((key) => !RESERVED_KEYS.has(key));
  return keys.length ? keys : DEFAULT_FEATURES;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function getTimestamp(row) {
  const ts = row?.timestamp ?? row?.t ?? row?.time;
  if (ts === undefined || ts === null) return null;
  const num = Number(ts);
  if (Number.isFinite(num)) return num;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function getLabel(row) {
  const raw = row?.label ?? row?.y ?? row?.target;
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n >= 0.5 ? 1 : 0;
}

function buildFeatureVector(row, featureList) {
  const source = row.features && typeof row.features === "object" ? row.features : row;
  return featureList.map((key) => toNumber(source?.[key], 0));
}

function computeNormalization(rows, featureList) {
  const sums = new Array(featureList.length).fill(0);
  const sumsSq = new Array(featureList.length).fill(0);
  const count = rows.length || 1;
  for (const row of rows) {
    const vector = buildFeatureVector(row, featureList);
    vector.forEach((value, idx) => {
      sums[idx] += value;
      sumsSq[idx] += value * value;
    });
  }
  const normalization = {};
  featureList.forEach((feature, idx) => {
    const mean = sums[idx] / count;
    const variance = sumsSq[idx] / count - mean * mean;
    const std = variance > 0 ? Math.sqrt(variance) : 1;
    normalization[feature] = { mean, std };
  });
  return normalization;
}

function normalizeVector(vector, featureList, normalization) {
  return vector.map((value, idx) => {
    const feature = featureList[idx];
    const stats = normalization?.[feature];
    if (!stats) return value;
    return (value - stats.mean) / (stats.std || 1);
  });
}

function trainLogistic(rows, featureList, normalization, options) {
  const iterations = options.iterations;
  const learningRate = options.learningRate;
  const l2 = options.l2;
  const weights = new Array(featureList.length).fill(0);
  let bias = 0;
  const count = rows.length || 1;

  for (let iter = 0; iter < iterations; iter += 1) {
    const grad = new Array(featureList.length).fill(0);
    let gradBias = 0;
    for (const row of rows) {
      const label = getLabel(row);
      if (label === null) continue;
      const vector = normalizeVector(buildFeatureVector(row, featureList), featureList, normalization);
      let score = bias;
      for (let i = 0; i < vector.length; i += 1) {
        score += weights[i] * vector[i];
      }
      const prediction = sigmoid(score);
      const error = prediction - label;
      gradBias += error;
      for (let i = 0; i < vector.length; i += 1) {
        grad[i] += error * vector[i];
      }
    }
    for (let i = 0; i < weights.length; i += 1) {
      const reg = l2 > 0 ? l2 * weights[i] : 0;
      weights[i] -= learningRate * (grad[i] / count + reg);
    }
    bias -= learningRate * (gradBias / count);
  }

  return { weights, bias };
}

function evaluate(rows, featureList, normalization, weights, bias, threshold) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  let total = 0;
  let lossSum = 0;
  for (const row of rows) {
    const label = getLabel(row);
    if (label === null) continue;
    const vector = normalizeVector(buildFeatureVector(row, featureList), featureList, normalization);
    let score = bias;
    for (let i = 0; i < vector.length; i += 1) {
      score += weights[i] * vector[i];
    }
    const prob = sigmoid(score);
    const prediction = prob >= threshold ? 1 : 0;
    if (prediction === 1 && label === 1) tp += 1;
    if (prediction === 0 && label === 0) tn += 1;
    if (prediction === 1 && label === 0) fp += 1;
    if (prediction === 0 && label === 1) fn += 1;
    lossSum += -(label * Math.log(prob + 1e-9) + (1 - label) * Math.log(1 - prob + 1e-9));
    total += 1;
  }
  const accuracy = total ? (tp + tn) / total : 0;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const logLoss = total ? lossSum / total : 0;
  return { total, accuracy, precision, recall, f1, logLoss };
}

async function readDataset(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const datasetPath = process.env.DATASET_PATH || "data/training_dataset.json";
  const resolvedDatasetPath = path.resolve(process.cwd(), datasetPath);
  const rows = await readDataset(resolvedDatasetPath);
  if (!rows.length) {
    throw new Error(`Dataset is empty: ${resolvedDatasetPath}`);
  }

  const featureList = parseFeatureList(process.env.FEATURE_LIST, rows);
  const validationSplit = Number(process.env.VALIDATION_SPLIT ?? 0.2);
  const threshold = Number(process.env.MODEL_THRESHOLD ?? 0.6);
  const iterations = Number(process.env.TRAINING_ITERATIONS ?? 300);
  const learningRate = Number(process.env.LEARNING_RATE ?? 0.1);
  const l2 = Number(process.env.L2 ?? 0);

  const rowsWithTs = rows
    .map((row, index) => ({ row, ts: getTimestamp(row) ?? index }))
    .sort((a, b) => a.ts - b.ts);
  const ordered = rowsWithTs.map((item) => item.row);
  const total = ordered.length;
  const validationCount = Math.max(1, Math.floor(total * validationSplit));
  const trainingRows = ordered.slice(0, total - validationCount);
  const validationRows = ordered.slice(total - validationCount);

  const normalization = computeNormalization(trainingRows, featureList);
  const { weights, bias } = trainLogistic(trainingRows, featureList, normalization, {
    iterations,
    learningRate,
    l2,
  });

  const trainingMetrics = evaluate(trainingRows, featureList, normalization, weights, bias, threshold);
  const validationMetrics = evaluate(validationRows, featureList, normalization, weights, bias, threshold);

  const trainingTimestamps = trainingRows.map((row, index) => getTimestamp(row) ?? index);
  const windowStart = trainingTimestamps.length ? Math.min(...trainingTimestamps) : null;
  const windowEnd = trainingTimestamps.length ? Math.max(...trainingTimestamps) : null;

  const model = {
    version: 1,
    createdAt: new Date().toISOString(),
    featureList,
    weights: Object.fromEntries(featureList.map((feature, idx) => [feature, weights[idx]])),
    bias,
    normalization,
    metrics: {
      training: trainingMetrics,
      validation: validationMetrics,
    },
    trainingWindow: {
      start: windowStart ? new Date(windowStart).toISOString() : null,
      end: windowEnd ? new Date(windowEnd).toISOString() : null,
    },
    dataset: {
      path: datasetPath,
      total,
      training: trainingRows.length,
      validation: validationRows.length,
    },
    hyperparameters: {
      iterations,
      learningRate,
      l2,
      threshold,
    },
  };

  const stamp = model.createdAt.replace(/[:.]/g, "-");
  const modelsDir = path.resolve(process.cwd(), "models");
  await fs.mkdir(modelsDir, { recursive: true });
  const modelFilename = `model-${stamp}.json`;
  const metadataFilename = `model-${stamp}.metadata.json`;
  const modelPath = path.join(modelsDir, modelFilename);
  const metadataPath = path.join(modelsDir, metadataFilename);

  const metadata = {
    createdAt: model.createdAt,
    featureList: model.featureList,
    metrics: model.metrics,
    trainingWindow: model.trainingWindow,
    dataset: model.dataset,
    hyperparameters: model.hyperparameters,
    modelPath: modelFilename,
  };

  await fs.writeFile(modelPath, JSON.stringify(model, null, 2));
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  await fs.writeFile(path.join(modelsDir, "latest.json"), JSON.stringify(model, null, 2));
  await fs.writeFile(path.join(modelsDir, "latest.metadata.json"), JSON.stringify(metadata, null, 2));

  console.log(`Model saved: ${modelPath}`);
  console.log(`Metadata saved: ${metadataPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
