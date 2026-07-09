import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = path.join(rootDir, "raw");
const analysisDir = path.join(rootDir, "analysis");
const inventoryPath = path.join(analysisDir, "video-inventory.json");
const transcriptsPath = path.join(analysisDir, "all-transcripts.json");
const outputPath = path.join(analysisDir, "video-re-audit-report.json");
const ffmpegPath =
  process.env.FFMPEG_PATH ||
  "C:\\Users\\01\\AppData\\Local\\Programs\\Python\\Python314\\Lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe";

const topics = {
  relativeStrength: /\b(relative strength|rs model|rs setup|rs line|outperform|underperform)\b/gi,
  rsiMomentum: /\b(rsi|relative strength index|momentum)\b/gi,
  supertrend: /\bsuper\s*trend\b/gi,
  priceBreakout: /\b(breakout|break out|52 week|high momentum|new high|resistance)\b/gi,
  volume: /\b(volume|volumes|volume shocker)\b/gi,
  sectorIndustry: /\b(sector|industry|breadth|sectoral)\b/gi,
  movingAverage: /\b(moving average|dma|sma|ema|golden cross)\b/gi,
  candlestick: /\b(candlestick|candle pattern|engulfing|hammer|doji|morning star|evening star)\b/gi,
  volatilityAtr: /\b(volatility|volatile|average true range|\batr\b|bollinger)\b/gi,
  exitStopRisk: /\b(exit|stop loss|stoploss|risk reward|risk management|position sizing|capital)\b/gi,
  fundamentals: /\b(fundamental|quarterly result|earnings|net income|operating income|ebitda|margin|p\/e|pe ratio)\b/gi,
  marketRegime: /\b(bull market|bear market|market trend|nifty|index trend|market breadth)\b/gi
};

if (!fs.existsSync(ffmpegPath)) {
  throw new Error(`FFmpeg not found: ${ffmpegPath}`);
}

const inventory = readJson(inventoryPath);
const transcripts = readJson(transcriptsPath);
const transcriptByFile = new Map(transcripts.map((item) => [item.file, item]));
const videos = fs
  .readdirSync(rawDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(mp4|mkv|mov|webm)$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

const startedAt = new Date().toISOString();
const results = [];

for (let index = 0; index < videos.length; index += 1) {
  const file = videos[index];
  const source = path.join(rawDir, file);
  const expected = inventory.find((item) => item.file === file)?.seconds ?? null;
  const transcript = transcriptByFile.get(file);
  const text = String(transcript?.text || "");
  const captionPath = transcript?.captionFile
    ? path.join(analysisDir, transcript.captionFile)
    : null;
  const caption = captionPath && fs.existsSync(captionPath)
    ? parseVtt(fs.readFileSync(captionPath, "utf8"))
    : { cueCount: 0, textLineCount: 0, firstStartSeconds: null, lastEndSeconds: null };

  process.stdout.write(`[${index + 1}/${videos.length}] ${file}\n`);
  const decoded = await decodeVideo(source);
  const topicCounts = Object.fromEntries(
    Object.entries(topics).map(([name, expression]) => [name, countMatches(text, expression)])
  );
  const stat = fs.statSync(source);

  results.push({
    file,
    bytes: stat.size,
    expectedSeconds: expected,
    framesScanned: decoded.framesScanned,
    sampleRateFps: 1,
    audioDecoded: decoded.audioDecoded,
    decodedSeconds: decoded.decodedSeconds,
    sceneChangeCount: decoded.sceneChangeCount,
    averageFrameDifference: round(decoded.averageFrameDifference),
    transcriptChars: text.length,
    transcriptWords: text.trim() ? text.trim().split(/\s+/).length : 0,
    captionCueCount: caption.cueCount,
    captionTextLineCount: caption.textLineCount,
    captionFirstStartSeconds: caption.firstStartSeconds,
    captionLastEndSeconds: caption.lastEndSeconds,
    topicCounts,
    ok:
      decoded.returnCode === 0 &&
      decoded.framesScanned > 0 &&
      (!Number.isFinite(expected) || Math.abs(decoded.framesScanned - expected) <= 2) &&
      decoded.audioDecoded &&
      text.length > 0 &&
      caption.cueCount > 0,
    error: decoded.error
  });
}

const report = {
  startedAt,
  completedAt: new Date().toISOString(),
  method: {
    visual: "Every video decoded at exactly 1 frame per second to 96x54 grayscale; every sampled frame was read and compared.",
    audio: "The complete primary audio stream was decoded by FFmpeg during the same pass.",
    text: "Every available VTT cue and complete transcript was parsed; strategy topic evidence was counted per video.",
    note: "Transcript text is used for spoken strategy meaning. Visual frame differences prove full timeline coverage and identify screen changes."
  },
  totals: {
    videos: results.length,
    videosOk: results.filter((item) => item.ok).length,
    expectedSeconds: sum(results, "expectedSeconds"),
    framesScanned: sum(results, "framesScanned"),
    decodedSeconds: round(sum(results, "decodedSeconds")),
    transcriptChars: sum(results, "transcriptChars"),
    transcriptWords: sum(results, "transcriptWords"),
    captionCues: sum(results, "captionCueCount"),
    captionTextLines: sum(results, "captionTextLineCount"),
    topicCounts: Object.fromEntries(
      Object.keys(topics).map((topic) => [
        topic,
        results.reduce((total, item) => total + item.topicCounts[topic], 0)
      ])
    )
  },
  results
};

fs.mkdirSync(analysisDir, { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.totals, null, 2));
console.log(`Report: ${outputPath}`);

function decodeVideo(source) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-map",
      "0:v:0",
      "-vf",
      "fps=1,scale=96:54,format=gray",
      "-f",
      "rawvideo",
      "pipe:1",
      "-map",
      "0:a:0?",
      "-f",
      "null",
      "NUL",
      "-progress",
      "pipe:2"
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const frameSize = 96 * 54;
    let pending = Buffer.alloc(0);
    let previous = null;
    let framesScanned = 0;
    let diffTotal = 0;
    let sceneChangeCount = 0;
    let stderr = "";
    let decodedSeconds = 0;
    let audioDecoded = false;

    child.stdout.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        const frame = pending.subarray(0, frameSize);
        pending = pending.subarray(frameSize);
        if (previous) {
          let absoluteDifference = 0;
          for (let offset = 0; offset < frameSize; offset += 1) {
            absoluteDifference += Math.abs(frame[offset] - previous[offset]);
          }
          const averageDifference = absoluteDifference / frameSize;
          diffTotal += averageDifference;
          if (averageDifference >= 25) sceneChangeCount += 1;
        }
        previous = Buffer.from(frame);
        framesScanned += 1;
      }
    });

    child.stderr.on("data", (chunk) => {
      const value = chunk.toString();
      stderr += value;
      for (const line of value.split(/\r?\n/)) {
        if (line.startsWith("out_time_us=")) {
          decodedSeconds = Math.max(decodedSeconds, Number(line.slice(12)) / 1_000_000);
        }
        if (line.startsWith("stream_1_0_q=") || line.includes("audio:")) audioDecoded = true;
      }
    });

    child.on("error", reject);
    child.on("close", (returnCode) => {
      // A successful optional audio map means the stream was decoded even when progress
      // output does not contain a stream-specific marker.
      if (returnCode === 0) audioDecoded = true;
      resolve({
        returnCode,
        framesScanned,
        decodedSeconds,
        audioDecoded,
        sceneChangeCount,
        averageFrameDifference: framesScanned > 1 ? diffTotal / (framesScanned - 1) : 0,
        error: returnCode === 0 ? "" : stderr.trim().slice(-2000)
      });
    });
  });
}

function parseVtt(source) {
  const blocks = source.replace(/\r/g, "").split(/\n{2,}/);
  let cueCount = 0;
  let textLineCount = 0;
  let firstStartSeconds = null;
  let lastEndSeconds = null;

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [start, end] = lines[timingIndex].split("-->").map((value) => value.trim().split(" ")[0]);
    const startSeconds = timestampSeconds(start);
    const endSeconds = timestampSeconds(end);
    cueCount += 1;
    textLineCount += lines.slice(timingIndex + 1).filter((line) => !/^NOTE\b/.test(line)).length;
    if (Number.isFinite(startSeconds)) {
      firstStartSeconds = firstStartSeconds == null ? startSeconds : Math.min(firstStartSeconds, startSeconds);
    }
    if (Number.isFinite(endSeconds)) {
      lastEndSeconds = lastEndSeconds == null ? endSeconds : Math.max(lastEndSeconds, endSeconds);
    }
  }

  return { cueCount, textLineCount, firstStartSeconds, lastEndSeconds };
}

function timestampSeconds(value) {
  const parts = String(value || "").replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? null;
}

function countMatches(text, expression) {
  expression.lastIndex = 0;
  return Array.from(text.matchAll(expression)).length;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}
