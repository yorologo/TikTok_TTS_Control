import test from "node:test";
import assert from "node:assert/strict";
import path from "path";

import {
  buildRuntimeSnapshot,
  normalizePiperModelPath
} from "../modules/runtime.js";

function createFakeFs(existingPaths = []) {
  const known = new Set(existingPaths);
  return {
    constants: {
      F_OK: 0,
      X_OK: 1
    },
    accessSync(candidate) {
      if (!known.has(candidate)) {
        throw new Error(`missing: ${candidate}`);
      }
    }
  };
}

test("normalizePiperModelPath rejects Windows paths on non-Windows platforms", () => {
  const result = normalizePiperModelPath(path, "/repo", "C:\\voices\\es.onnx", "android");
  assert.equal(result, "");
});

test("runtime snapshot reports Piper unavailable when python or model is missing", () => {
  const snapshot = buildRuntimeSnapshot({
    fs: createFakeFs(),
    path,
    rootDir: "/repo",
    settings: {
      piper: {
        pythonCmd: "./.venv/bin/python",
        modelPath: "./data/piper/es_MX.onnx"
      }
    },
    runtimeCaps: {
      platform: "android",
      isTermux: true,
      hasTermuxTts: true,
      hasTermuxTtsEngines: true,
      hasTermuxMediaPlayer: true
    },
    defaultPythonCmd: "python",
    commandExists: () => false
  });

  assert.deepEqual(snapshot.availableTtsEngines, ["termux"]);
  assert.equal(snapshot.recommendedTtsEngine, "termux");
  assert.equal(snapshot.piper.ready, false);
  assert.deepEqual(snapshot.piper.issues, ["python_not_found", "piper_model_not_found"]);
});

test("runtime snapshot reports Piper ready when python, model and player exist", () => {
  const modelPath = "/repo/data/piper/es_MX.onnx";
  const snapshot = buildRuntimeSnapshot({
    fs: createFakeFs([modelPath]),
    path,
    rootDir: "/repo",
    settings: {
      piper: {
        pythonCmd: "./.venv/bin/python",
        modelPath: "./data/piper/es_MX.onnx"
      }
    },
    runtimeCaps: {
      platform: "android",
      isTermux: true,
      hasTermuxTts: false,
      hasTermuxTtsEngines: false,
      hasTermuxMediaPlayer: true
    },
    defaultPythonCmd: "python",
    commandExists: (cmd) => cmd === "./.venv/bin/python"
  });

  assert.deepEqual(snapshot.availableTtsEngines, ["piper"]);
  assert.equal(snapshot.recommendedTtsEngine, "piper");
  assert.equal(snapshot.piper.ready, true);
  assert.equal(snapshot.piper.audioPlayer, "termux-media-player");
  assert.deepEqual(snapshot.piper.issues, []);
});
