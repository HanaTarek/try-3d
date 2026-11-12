import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

// Open the page with ?calibrate (example: http://localhost:5173/?calibrate)
// to see the setup sliders. Visitors never see them.
const CALIBRATE = new URLSearchParams(window.location.search).has("calibrate");

const CDN_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const SHOULDER_CM = 37; // average distance between the two shoulder points
const NECK_BASE_UP = 0.1; // collar center above the shoulder line (x shoulder width)

// Default settings. Each product can override them with its own "fit".
const DEFAULT_FIT = {
  widthCm: 14, // real width of the necklace, left to right
  rotation: [0, 0, 0], // degrees, to turn the 3D file upright and facing you
  anchor: [0.5, 0.95, 0.5], // center of the collar ring inside the 3D file (0 to 1)
  upCm: 0, // move the necklace up or down (cm)
  tiltDeg: 14, // collars lean forward a little when worn
  neckRatio: 0.88, // size of the invisible neck compared with the collar
};

const rad = THREE.MathUtils.degToRad;

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const e = new Error("no camera api");
    e.name = "SecurityError";
    throw e;
  }
  const tries = [
    {
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    },
    { video: true, audio: false },
  ];
  let lastErr;
  for (const constraints of tries) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
      if (e.name !== "OverconstrainedError") break;
    }
  }
  throw lastErr;
}

function explainError(err) {
  switch (err && err.name) {
    case "NotAllowedError":
      return "Camera permission is blocked. Click the lock icon next to the address bar, choose Allow for the camera, then press Retry.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
      return "The camera is being used by another app or browser tab. Close it (or restart the browser), then press Retry.";
    case "SecurityError":
      return "The camera only works on https:// links or on localhost.";
    default:
      return (err && err.message) || "Could not start the camera.";
  }
}

async function loadModel(url) {
  const decoderPaths = [
    "/draco/",
    "https://www.gstatic.com/draco/versioned/decoders/1.5.6/",
  ];
  let lastErr;
  for (const path of decoderPaths) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(path);
    loader.setDRACOLoader(draco);
    loader.setMeshoptDecoder(MeshoptDecoder);
    try {
      return await loader.loadAsync(url);
    } catch (e) {
      lastErr = e;
    } finally {
      draco.dispose();
    }
  }
  throw lastErr;
}

async function createLandmarker() {
  const sources = [
    { wasm: "/mediapipe/wasm", model: "/models/pose_landmarker_lite.task" },
    { wasm: CDN_WASM, model: CDN_MODEL },
  ];
  let lastErr;
  for (const s of sources) {
    try {
      const fileset = await FilesetResolver.forVisionTasks(s.wasm);
      for (const delegate of ["GPU", "CPU"]) {
        try {
          return await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: s.model, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
        } catch (e) {
          lastErr = e;
          console.warn("Tracking start failed (" + delegate + ")", e);
        }
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Tracking model could not be loaded");
}

function Slider({ label, value, min, max, step, onChange }) {
  return (
    <label
      style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}
    >
      <span style={{ width: 100 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={{ width: 44 }}>{value}</span>
    </label>
  );
}

export default function TryOn({ modelUrl, fit: fitProp, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  const [status, setStatus] = useState("Starting camera...");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [debug, setDebug] = useState(false);
  const [fit, setFit] = useState({ ...DEFAULT_FIT, ...fitProp });

  // The animation loop reads the latest values from these refs
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const debugRef = useRef(debug);
  debugRef.current = debug;

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream = null;
    let landmarker = null;
    let renderer = null;

    const run = async () => {
      setError("");
      setHint("");
      setStatus("Starting camera...");

      // 1) Camera first, so you always see yourself
      try {
        stream = await openCamera();
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setStatus("");
          setError(explainError(err));
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      video.srcObject = stream;
      try {
        await video.play();
      } catch (e) {
        console.warn("video.play()", e);
      }
      if (!video.videoWidth) {
        await new Promise((r) =>
          video.addEventListener("loadedmetadata", r, { once: true }),
        );
      }
      if (cancelled) return;

      try {
        const w = video.videoWidth;
        const h = video.videoHeight;

        // 2) 3D scene. 1 unit = 1 pixel of the video
        renderer = new THREE.WebGLRenderer({
          canvas: canvasRef.current,
          alpha: true,
          antialias: true,
        });
        renderer.setPixelRatio(1);
        renderer.setSize(w, h, false);
        renderer.setClearColor(0x000000, 0);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;

        const scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(
          new RoomEnvironment(),
          0.04,
        ).texture;
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(0.3, 0.8, 1);
        scene.add(key);

        const camera = new THREE.OrthographicCamera(
          -w / 2,
          w / 2,
          h / 2,
          -h / 2,
          -3000,
          3000,
        );
        camera.position.z = 1500;

        // pivot: follows the neck. Inside it, 1 unit = 1 cm.
        const pivot = new THREE.Group();
        scene.add(pivot);

        // Invisible neck: it hides whatever is behind it (the back of the collar)
        const neckMat = new THREE.MeshBasicMaterial({ colorWrite: false });
        const neck = new THREE.Mesh(
          new THREE.CylinderGeometry(1, 1, 1, 48),
          neckMat,
        );
        neck.renderOrder = -1;
        pivot.add(neck);

        // Debug helpers (only in calibrate mode)
        const neckDebug = new THREE.Mesh(
          neck.geometry,
          new THREE.MeshBasicMaterial({
            color: 0x3399ff,
            wireframe: true,
            depthTest: false,
          }),
        );
        neckDebug.renderOrder = 998;
        neckDebug.visible = false;
        neck.add(neckDebug);
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false }),
        );
        dot.renderOrder = 999;
        dot.visible = false;
        pivot.add(dot);

        const tiltGroup = new THREE.Group();
        const rotGroup = new THREE.Group();
        const fitGroup = new THREE.Group();
        pivot.add(tiltGroup);
        tiltGroup.add(rotGroup);
        rotGroup.add(fitGroup);

        // 3) Necklace
        setStatus("Loading necklace...");
        let gltf;
        try {
          gltf = await loadModel(modelUrl);
        } catch (e) {
          console.error(e);
          throw new Error(
            "Could not load the necklace file (" +
              modelUrl +
              "). Check that it is inside public/models/ and the name is correct.",
          );
        }
        if (cancelled) return;
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const min = box.min.clone();
        const baseW = size.x || 1;
        fitGroup.add(model);

        const applyFit = (f) => {
          tiltGroup.rotation.x = rad(f.tiltDeg);
          rotGroup.rotation.set(
            rad(f.rotation[0]),
            rad(f.rotation[1]),
            rad(f.rotation[2]),
          );
          fitGroup.scale.setScalar(f.widthCm / baseW); // model units -> cm
          model.position.set(
            -(min.x + size.x * f.anchor[0]),
            -(min.y + size.y * f.anchor[1]),
            -(min.z + size.z * f.anchor[2]),
          );
          const r = (f.widthCm / 2) * f.neckRatio;
          neck.scale.set(r, 13.5, r);
          neck.position.set(0, 5.25, 0); // from 1.5 cm below to 12 cm above the collar
        };

        // 4) Body tracking
        setStatus("Loading tracking...");
        landmarker = await createLandmarker();
        if (cancelled) return;
        setStatus("");

        const target = { x: 0, y: 0, s: 1, a: 0 };
        const state = { x: 0, y: 0, s: 1, a: 0, init: false, lastSeen: -1e9 };
        let lastFit = null;
        let lastVideoTime = -1;
        let lastTs = performance.now();
        let lastHint = "";
        const say = (t) => {
          if (t !== lastHint) {
            lastHint = t;
            setHint(t);
          }
        };

        const loop = () => {
          if (cancelled) return;
          raf = requestAnimationFrame(loop);
          const now = performance.now();

          const f = fitRef.current;
          if (f !== lastFit) {
            lastFit = f;
            applyFit(f);
          }
          neckDebug.visible = debugRef.current;
          dot.visible = debugRef.current;

          // Detect on every new video frame
          if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
            lastVideoTime = video.currentTime;
            const res = landmarker.detectForVideo(video, now);
            const lm = res.landmarks && res.landmarks[0];
            let ok = false;
            let msg =
              "Stand 1 to 2 meters from the screen. Show your face and both shoulders.";

            if (
              lm &&
              (lm[11].visibility ?? 1) > 0.5 &&
              (lm[12].visibility ?? 1) > 0.5
            ) {
              let L = lm[11];
              let R = lm[12];
              if (L.x > R.x) {
                const t = L;
                L = R;
                R = t;
              }
              const lx = L.x * w,
                ly = L.y * h,
                rx = R.x * w,
                ry = R.y * h;
              const vx = rx - lx,
                vy = ry - ly;
              const sw = Math.hypot(vx, vy); // shoulder width in pixels

              if (sw > w * 0.12) {
                const ux = vy / sw; // "up" for the body, perpendicular to the shoulders
                const uy = -vx / sw;
                const pxPerCm = sw / SHOULDER_CM;
                const lift = NECK_BASE_UP * sw + f.upCm * pxPerCm;
                target.x = (lx + rx) / 2 + ux * lift;
                target.y = (ly + ry) / 2 + uy * lift;
                target.s = pxPerCm;
                target.a = Math.atan2(vy, vx);
                state.lastSeen = now;
                ok = true;
              } else {
                msg = "Come a little closer.";
              }
            }
            if (ok) say("");
            else if (now - state.lastSeen > 400) say(msg);
          }

          // Smooth the movement so the necklace does not shake
          const dt = Math.min(0.1, (now - lastTs) / 1000);
          lastTs = now;
          if (state.lastSeen > 0) {
            if (!state.init) {
              Object.assign(state, target, { init: true });
            } else {
              const k = 1 - Math.exp(-dt / 0.07);
              state.x += (target.x - state.x) * k;
              state.y += (target.y - state.y) * k;
              state.s += (target.s - state.s) * k;
              state.a += (target.a - state.a) * k;
            }
          }

          const visible = state.init && now - state.lastSeen < 400;
          pivot.visible = visible;
          if (visible) {
            pivot.position.set(state.x - w / 2, h / 2 - state.y, 0);
            pivot.rotation.z = -state.a;
            pivot.scale.setScalar(state.s);
          }
          renderer.render(scene, camera);
        };
        loop();
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setStatus("");
          setError(err.message || "Something went wrong.");
        }
      }
    };

    // The small delay avoids a double start in React dev mode
    const timer = setTimeout(run, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      try {
        if (landmarker) landmarker.close();
      } catch (e) {
        /* ignore */
      }
      if (renderer) renderer.dispose();
    };
  }, [modelUrl, attempt]);

  const setField = (k, v) => setFit((f) => ({ ...f, [k]: v }));
  const setArr = (k, i, v) =>
    setFit((f) => ({ ...f, [k]: f[k].map((x, j) => (j === i ? v : x)) }));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10,
      }}
    >
      <div
        style={{
          background: "white",
          padding: 12,
          borderRadius: 12,
          width: "min(900px, 95vw)",
          maxHeight: "95vh",
          overflow: "auto",
        }}
      >
        <div
          style={{ position: "relative", background: "#000", minHeight: 300 }}
        >
          {/* Mirror video and necklace together, like a real mirror */}
          <div style={{ transform: "scaleX(-1)", position: "relative" }}>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              style={{ width: "100%", display: "block" }}
            />
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
              }}
            />
          </div>

          {status && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                background: "rgba(0,0,0,0.45)",
                textAlign: "center",
                padding: 16,
              }}
            >
              {status}
            </div>
          )}

          {!error && !status && hint && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                color: "white",
                background: "rgba(0,0,0,0.65)",
                textAlign: "center",
                padding: 10,
              }}
            >
              {hint}
            </div>
          )}

          {error && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                color: "white",
                background: "rgba(170,0,0,0.9)",
                padding: 12,
                textAlign: "center",
              }}
            >
              <div style={{ marginBottom: 8 }}>{error}</div>
              <button onClick={() => setAttempt((a) => a + 1)}>Retry</button>
            </div>
          )}
        </div>

        {CALIBRATE && (
          <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
            <label>
              <input
                type="checkbox"
                checked={debug}
                onChange={(e) => setDebug(e.target.checked)}
              />{" "}
              Show invisible neck (blue) and collar center (red dot)
            </label>
            <Slider
              label="Width (cm)"
              value={fit.widthCm}
              min={6}
              max={30}
              step={0.5}
              onChange={(v) => setField("widthCm", v)}
            />
            <Slider
              label="Up / down (cm)"
              value={fit.upCm}
              min={-6}
              max={6}
              step={0.25}
              onChange={(v) => setField("upCm", v)}
            />
            <Slider
              label="Tilt (deg)"
              value={fit.tiltDeg}
              min={-20}
              max={45}
              step={1}
              onChange={(v) => setField("tiltDeg", v)}
            />
            <Slider
              label="Neck size"
              value={fit.neckRatio}
              min={0.5}
              max={1}
              step={0.01}
              onChange={(v) => setField("neckRatio", v)}
            />
            {["X", "Y", "Z"].map((ax, i) => (
              <Slider
                key={"r" + ax}
                label={"Rotate " + ax}
                value={fit.rotation[i]}
                min={-180}
                max={180}
                step={5}
                onChange={(v) => setArr("rotation", i, v)}
              />
            ))}
            {["X", "Y", "Z"].map((ax, i) => (
              <Slider
                key={"a" + ax}
                label={"Center " + ax}
                value={fit.anchor[i]}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setArr("anchor", i, v)}
              />
            ))}
            <div style={{ fontSize: 12 }}>
              Copy this into your product in App.jsx:
            </div>
            <pre
              style={{
                background: "#f4f4f4",
                padding: 8,
                whiteSpace: "pre-wrap",
                fontSize: 12,
              }}
            >
              {"fit: " + JSON.stringify(fit)}
            </pre>
          </div>
        )}

        <div style={{ display: "flex", marginTop: 12 }}>
          <button onClick={onClose} style={{ marginLeft: "auto" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
