const fs = require("fs");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");
const { exec } = require("child_process");

const TEST_LINES = [
  ["short_confirmation", "Sure, one medium pepperoni pizza, thin crust."],
  ["menu_answer", "We've got Margherita and Pepperoni pizzas, a classic burrito, a lunch combo, and cola. Want details on any of those?"],
  ["cart_readback", "So that's one medium stuffed crust Margherita pizza and one regular cola, for a total of sixteen fifty. Shall I place the order?"],
  ["clarifying_question", "What size would you like -- small, medium, or large?"],
  ["goodbye", "Thanks for calling, your order's on its way. Have a great day!"],
];

const PRESET_VOICES = [
  "alloy", "ash", "ballad", "cedar", "coral", "echo",
  "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"
];

const TTFB_BUDGET_S = 0.8;

function formatRow(label, value) {
  if (value === undefined || value === null) {
    return `  ${label.padEnd(25)} n/a`;
  }
  return `  ${label.padEnd(25)} ${value.toFixed(3)}s`;
}

function playAudioFile(filePath) {
  // Returns a promise that resolves once playback finishes (or fails silently).
  return new Promise((resolve) => {
    const platform = os.platform();
    let cmd;

    if (platform === "darwin") {
      cmd = `afplay "${filePath}"`;
    } else if (platform === "win32") {
      cmd = `powershell -c (New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
    } else {
      // Linux/other: try a few common players, first one that exists wins.
      cmd = `aplay "${filePath}" || paplay "${filePath}" || ffplay -nodisp -autoexit "${filePath}"`;
    }

    exec(cmd, (err) => {
      if (err) {
        console.log(`  (couldn't auto-play: ${err.message.split("\n")[0]})`);
      }
      resolve();
    });
  });
}

async function main() {
  const args = {
    baseUrl: process.argv.includes("--base-url") ? process.argv[process.argv.indexOf("--base-url") + 1] : "http://127.0.0.1:8880",
    voice: process.argv.includes("--voice") ? process.argv[process.argv.indexOf("--voice") + 1] : "nova",
    outDir: process.argv.includes("--out-dir") ? process.argv[process.argv.indexOf("--out-dir") + 1] : "omnivoice_demo_output",
    play: process.argv.includes("--play"),
  };

  if (!PRESET_VOICES.includes(args.voice) && args.voice !== "auto") {
    console.log(`Note: "${args.voice}" isn't one of OmniVoice's presets (${PRESET_VOICES.join(", ")}, auto) -- assuming it's a voice name for whatever server is at --base-url.\n`);
  }

  console.log(`Checking OmniVoice server at ${args.baseUrl} ...`);
  try {
    const healthResp = await fetch(`${args.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!healthResp.ok) throw new Error(`HTTP ${healthResp.status}`);
    const health = await healthResp.json();
    console.log(`  ok: ${JSON.stringify(health)}\n`);
  } catch (err) {
    console.error(`  FAILED to reach the server: ${err.message}`);
    console.error(`\n  Is it running? Start it in another terminal with:`);
    console.error(`    pip install omnivoice-server`);
    console.error(`    omnivoice-server`);
    process.exit(1);
  }

  const outDir = path.resolve(args.outDir);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results = [];

  for (const [name, text] of TEST_LINES) {
    console.log(`--- ${name} ---`);
    console.log(`  text: "${text}"`);

    let wavResult;
    try {
      const payload = {
        model: "omnivoice",
        input: text,
        voice: args.voice,
        response_format: "wav",
        speed: 1.0,
      };

      const started = performance.now();
      const resp = await fetch(`${args.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();
      const wallClockS = (performance.now() - started) / 1000;
      const audioBytes = Buffer.from(arrayBuffer);

      const wavPath = path.join(outDir, `${name}.wav`);
      fs.writeFileSync(wavPath, audioBytes);

      const serverLatencyHeader = resp.headers.get("X-Synthesis-Latency-S");
      const audioDurationHeader = resp.headers.get("X-Audio-Duration-S");

      wavResult = {
        wallClockS,
        serverLatencyS: serverLatencyHeader ? parseFloat(serverLatencyHeader) : null,
        audioDurationS: audioDurationHeader ? parseFloat(audioDurationHeader) : null,
        wavPath,
      };

      console.log(formatRow("wall-clock (non-stream)", wavResult.wallClockS));
      console.log(formatRow("server-reported latency", wavResult.serverLatencyS));
      console.log(formatRow("audio duration", wavResult.audioDurationS));
    } catch (err) {
      console.error(`  Non-streaming synthesis failed: ${err.message}`);
      continue;
    }

    let pcmResult = null;
    try {
      const payload = {
        model: "omnivoice",
        input: text,
        voice: args.voice,
        response_format: "pcm",
        speed: 1.0,
        stream: true,
      };

      const started = performance.now();
      const resp = await fetch(`${args.baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();

      // Read the first chunk to measure TTFB
      const { value, done } = await reader.read();
      const ttfb = (performance.now() - started) / 1000;

      // Read the rest of the stream to consume it
      let totalBytes = value ? value.length : 0;
      while (true) {
        const { value: nextVal, done: nextDone } = await reader.read();
        if (nextDone) break;
        if (nextVal) totalBytes += nextVal.length;
      }

      pcmResult = {
        timeToFirstByteS: ttfb,
      };
      console.log(formatRow("time-to-first-byte (stream)", pcmResult.timeToFirstByteS));
    } catch (err) {
      console.log(`  streaming request failed (${err.message}) -- falling back to non-stream only`);
    }

    console.log(`  saved: ${wavResult.wavPath}`);

    if (args.play) {
      console.log(`  playing...`);
      await playAudioFile(wavResult.wavPath);
    }

    console.log("");
    results.push({ name, wavResult, pcmResult });
  }

  // Summary + verdict
  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));

  const ttfbValues = results
    .map(r => r.pcmResult?.timeToFirstByteS)
    .filter(val => val !== undefined && val !== null);
  const wallValues = results.map(r => r.wavResult.wallClockS);

  if (ttfbValues.length > 0) {
    const avgTtfb = ttfbValues.reduce((a, b) => a + b, 0) / ttfbValues.length;
    const worstTtfb = Math.max(...ttfbValues);
    console.log(`Avg streaming TTFB: ${avgTtfb.toFixed(3)}s   Worst: ${worstTtfb.toFixed(3)}s`);
    if (worstTtfb <= TTFB_BUDGET_S) {
      console.log(`VERDICT: within the ~${TTFB_BUDGET_S.toFixed(0)}s budget -- viable for a live call on this hardware.`);
    } else {
      console.log(`VERDICT: over the ~${TTFB_BUDGET_S.toFixed(0)}s budget -- caller would notice the pause.`);
      console.log("  Options: run on a GPU if you're on CPU now, lower num_step for faster/");
      console.log("  lower-quality synthesis, or fall back to Kokoro/Piper for the live demo.");
    }
  } else {
    const avgWall = wallValues.reduce((a, b) => a + b, 0) / wallValues.length;
    console.log(`Streaming didn't return usable TTFB; non-streaming avg wall-clock: ${avgWall.toFixed(3)}s`);
    console.log("Use this as a rough upper bound and re-run with streaming once that's working.");
  }

  console.log(`\nGenerated clips saved in ./${args.outDir}/ -- listen to a couple before judging quality.`);
  if (!args.play) {
    console.log(`Tip: pass --play to have this script auto-play each clip as it's generated.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
