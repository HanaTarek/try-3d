import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/* ------------------------------------------------------------------ */
/*  AUTO-FIT SETTINGS (everything below is computed automatically;     */
/*  these numbers only change the "look", you rarely need to touch).   */
/* ------------------------------------------------------------------ */
// "auto" = detect how the model was exported, "front" = model already faces
// the camera (U shape), "flat" = model is a ring lying flat (like on a table)
const ORIENT_MODE = "auto";
// For flat rings: tilt forward so the front hangs on the chest (degrees)
const RING_TILT = 40;
// Necklace width compared with shoulder width
const WIDTH_RATIO = 0.45;
// A very long necklace is never taller than this (x shoulder width)
const MAX_HEIGHT_RATIO = 0.9;
// Where the necklace attaches: 0 = shoulders, 1 = mouth
const NECK_HEIGHT = 0.3;
// Neck thickness (radius) compared with shoulder width
const NECK_RADIUS = 0.15;
// 0 = very smooth but laggy, 1 = no smoothing
const FOLLOW = 0.5;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const overlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 10,
};

async function makeLandmarker(fileset) {
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    } catch (e) {
      console.warn("Tracking failed with " + delegate, e);
    }
  }
  throw new Error("Could not load the tracking model");
}

/**
 * Looks at the model's shape and rotates it so it faces the camera.
 * Returns a group (with the rotation) and where on the model's height the
 * neck should be (1 = top of the model, 0.5 = middle).
 */
function autoOrient(model) {
  const holder = new THREE.Group();
  holder.add(model);
  let anchorFrac = 1;

  const size = new THREE.Box3()
    .setFromObject(model)
    .getSize(new THREE.Vector3());
  let mode = ORIENT_MODE;
  if (mode === "auto") {
    // the thinnest direction of the model is its "thickness"
    if (size.y < size.x && size.y < size.z) mode = "flat";
    else if (size.x < size.y && size.x < size.z) mode = "side";
    else mode = "front";
  }

  if (mode === "flat") {
    holder.rotation.x = THREE.MathUtils.degToRad(RING_TILT);
    anchorFrac = 0.5; // neck goes through the middle of the ring
  } else if (mode === "side") {
    holder.rotation.y = Math.PI / 2;
  }
  return { holder, anchorFrac };
}

export default function TryOn({ modelUrl, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("Starting camera...");
  const [tracking, setTracking] = useState(false);

  // Fine-tuning on top of the automatic fit
  const [size, setSize] = useState(1);
  const [lift, setLift] = useState(0);
  const [hide, setHide] = useState(0);
  const [rot, setRot] = useState({ x: 0, y: 0, z: 0 });
  const [debug, setDebug] = useState(false);

  const tune = useRef({});
  tune.current = { size, lift, hide, rot, debug };

  useEffect(() => {
    let stop = false;
    let raf = 0;
    let stream;
    let landmarker;
    let renderer;
    let draco;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 1280, height: 720 },
          audio: false,
        });
        if (stop) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        if (!video.videoWidth) {
          await new Promise((r) => (video.onloadedmetadata = r));
        }
        const w = video.videoWidth;
        const h = video.videoHeight;

        const canvas = canvasRef.current;
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
        });
        renderer.setSize(w, h, false);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        const scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(
          new RoomEnvironment(),
          0.04,
        ).texture;
        const key = new THREE.DirectionalLight(0xffffff, 1.2);
        key.position.set(0.3, 1, 1);
        scene.add(key);

        // 1 unit = 1 pixel of the video. Camera looks down the -Z axis.
        const camera = new THREE.OrthographicCamera(
          -w / 2,
          w / 2,
          h / 2,
          -h / 2,
          1,
          2000,
        );
        camera.position.z = 1000;

        // ---- necklace: pivot (follows neck) -> rotGroup (sliders) -> model
        const pivot = new THREE.Group();
        pivot.rotation.order = "ZYX"; // yaw first, then roll
        const rotGroup = new THREE.Group();
        pivot.add(rotGroup);
        scene.add(pivot);

        setStatus("Loading necklace...");
        const loader = new GLTFLoader();
        draco = new DRACOLoader();
        draco.setDecoderPath(
          "https://www.gstatic.com/draco/versioned/decoders/1.5.6/",
        );
        loader.setDRACOLoader(draco);
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(modelUrl);
        if (stop) return;

        // 1) auto-rotate, 2) measure, 3) move the neck-point to the pivot
        const { holder, anchorFrac } = autoOrient(gltf.scene);
        holder.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(holder);
        const center = box.getCenter(new THREE.Vector3());
        const dims = box.getSize(new THREE.Vector3());
        const baseW = dims.x || 1;
        const baseH = dims.y || 1;
        const baseD = dims.z || 0;
        holder.position.set(
          -center.x,
          -(box.min.y + anchorFrac * dims.y),
          -center.z,
        );
        rotGroup.add(holder);

        // ---- invisible "body": writes depth only, so anything of the
        // necklace that is behind the neck / chest is hidden (real occlusion)
        const body = new THREE.Group();
        body.rotation.order = "ZYX";
        scene.add(body);
        const occMat = new THREE.MeshBasicMaterial({ colorWrite: false });
        const lineMat = new THREE.LineBasicMaterial({
          color: 0xff0000,
          depthTest: false,
        });
        const makeOccluder = (geo) => {
          const m = new THREE.Mesh(geo, occMat);
          m.renderOrder = -1; // drawn before the necklace
          m.frustumCulled = false;
          const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            lineMat,
          );
          edges.visible = false;
          edges.renderOrder = 998;
          m.add(edges);
          body.add(m);
          return m;
        };
        const neckMesh = makeOccluder(
          new THREE.CylinderGeometry(0.85, 1, 1, 24),
        );
        const torsoMesh = makeOccluder(new THREE.BoxGeometry(1, 1, 1));

        // Red dot = the point where the necklace is attached
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(5, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false }),
        );
        dot.renderOrder = 999;
        dot.visible = false;
        scene.add(dot);

        setStatus("Loading tracking model...");
        const fileset = await FilesetResolver.forVisionTasks(WASM);
        landmarker = await makeLandmarker(fileset);
        if (stop) return;
        setStatus("");

        let lastTime = -1;
        let wasTracking = null;
        const setTrack = (v) => {
          if (v !== wasTracking) {
            wasTracking = v;
            setTracking(v);
          }
        };
        const sm = { init: false, x: 0, y: 0, sw: 1, len: 1, roll: 0, yaw: 0 };

        const loop = () => {
          if (stop) return;
          raf = requestAnimationFrame(loop);
          if (video.currentTime === lastTime) return;
          lastTime = video.currentTime;

          const t = tune.current;
          rotGroup.rotation.set(
            THREE.MathUtils.degToRad(t.rot.x),
            THREE.MathUtils.degToRad(t.rot.y),
            THREE.MathUtils.degToRad(t.rot.z),
          );
          dot.visible = t.debug;
          neckMesh.children[0].visible = t.debug;
          torsoMesh.children[0].visible = t.debug;

          const res = landmarker.detectForVideo(video, performance.now());
          const lm = res.landmarks && res.landmarks[0];

          // 11/12 = shoulders, 9/10 = mouth corners
          const ls = lm && lm[11];
          const rs = lm && lm[12];
          const ml = lm && lm[9];
          const mr = lm && lm[10];
          const ok =
            lm && (ls.visibility ?? 1) > 0.5 && (rs.visibility ?? 1) > 0.5;

          if (!ok) {
            setTrack(false);
            pivot.visible = false;
            body.visible = false;
            dot.visible = false;
            renderer.render(scene, camera);
            return;
          }
          setTrack(true);

          // ---------- measure the person (all in video pixels) ----------
          const dx = (ls.x - rs.x) * w;
          const dy = (ls.y - rs.y) * h;
          const dz = (ls.z - rs.z) * w; // pose z uses roughly the same scale as x
          const shoulder3D = Math.hypot(dx, dy, dz * 0.7); // stays stable when turning
          const sx = ((ls.x + rs.x) / 2) * w;
          const sy = ((ls.y + rs.y) / 2) * h;
          const mx = ((ml.x + mr.x) / 2) * w;
          const my = ((ml.y + mr.y) / 2) * h;
          const neckLen = clamp(
            Math.hypot(mx - sx, my - sy),
            shoulder3D * 0.25,
            shoulder3D * 0.8,
          );

          const roll = Math.atan2(dy, dx); // tilt of the shoulders
          const yaw = clamp(Math.atan2(dz * 0.8, dx), -0.9, 0.9); // body turning

          if (!sm.init) {
            sm.x = sx;
            sm.y = sy;
            sm.sw = shoulder3D;
            sm.len = neckLen;
            sm.roll = roll;
            sm.yaw = yaw;
            sm.init = true;
          } else {
            const k = FOLLOW;
            sm.x += (sx - sm.x) * k;
            sm.y += (sy - sm.y) * k;
            sm.sw += (shoulder3D - sm.sw) * k;
            sm.len += (neckLen - sm.len) * k;
            sm.roll += (roll - sm.roll) * k;
            sm.yaw += (yaw - sm.yaw) * (k * 0.5); // z is noisy, smooth more
          }
          const sW = sm.sw;
          const L = sm.len;

          // neck point: from the shoulder line up toward the mouth, along the
          // tilt of the shoulders (so it works when you lean your head too)
          const up = { x: Math.sin(sm.roll), y: -Math.cos(sm.roll) }; // image coords
          const ax = sm.x + (mx - sx) * NECK_HEIGHT;
          const ay = sm.y + (my - sy) * NECK_HEIGHT;
          const bodyX = ax - w / 2;
          const bodyY = h / 2 - ay;

          // ---------- necklace: size + position ----------
          const fit =
            Math.min(
              (sW * WIDTH_RATIO) / baseW,
              (sW * MAX_HEIGHT_RATIO) / baseH,
            ) * t.size;

          pivot.visible = true;
          pivot.position.set(bodyX, bodyY - t.lift * sW, 0);
          pivot.rotation.set(0, sm.yaw, -sm.roll);
          pivot.scale.setScalar(fit);

          dot.position.copy(pivot.position);

          // ---------- body occluder: size + position ----------
          // Front surface of the body sits at the middle of the necklace's
          // depth (+ the "Hide depth" slider). Anything behind it is hidden.
          const depthPx = baseD * fit;
          const zFront = depthPx * t.hide - 3;
          const R = NECK_RADIUS * sW;
          const torsoD = sW * 0.5;

          body.visible = true;
          body.position.set(bodyX, bodyY, 0);
          body.rotation.set(0, sm.yaw, -sm.roll);

          // neck: from the shoulder line up to the mouth
          neckMesh.scale.set(R, L, R);
          neckMesh.position.set(0, (1 - 2 * NECK_HEIGHT) * L * 0.5, zFront - R);

          // chest + shoulders: starts at the shoulder line, goes down
          const torsoTop = -NECK_HEIGHT * L + 0.05 * L;
          const torsoH = sW * 1.6;
          torsoMesh.scale.set(sW * 1.1, torsoH, torsoD);
          torsoMesh.position.set(0, torsoTop - torsoH / 2, zFront - torsoD / 2);

          void up; // (kept for readability; roll is applied through rotation)
          renderer.render(scene, camera);
        };
        loop();
      } catch (err) {
        console.error(err);
        setStatus(
          err.name === "NotAllowedError"
            ? "Camera permission was blocked. Allow the camera and try again."
            : "Could not start: " + err.message,
        );
      }
    }

    start();

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (landmarker) landmarker.close();
      if (draco) draco.dispose();
      if (renderer) renderer.dispose();
    };
  }, [modelUrl]);

  const slider = (label, value, onChange, min, max, step) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span style={{ width: 40 }}>{value}</span>
    </label>
  );

  const reset = () => {
    setSize(1);
    setLift(0);
    setHide(0);
    setRot({ x: 0, y: 0, z: 0 });
  };

  return (
    <div style={overlay}>
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
        <div style={{ position: "relative", background: "#000" }}>
          {/* Mirror the video and the necklace together, like a real mirror */}
          <div style={{ transform: "scaleX(-1)", position: "relative" }}>
            <video
              ref={videoRef}
              playsInline
              muted
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
                background: "rgba(0,0,0,0.5)",
                textAlign: "center",
                padding: 16,
              }}
            >
              {status}
            </div>
          )}

          {!status && !tracking && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                color: "white",
                background: "rgba(200,0,0,0.75)",
                textAlign: "center",
                padding: 8,
              }}
            >
              Can't see your shoulders. Step back, face the camera, and use good
              light.
            </div>
          )}
        </div>

        <p style={{ fontSize: 12, color: "#555", margin: "8px 0 0" }}>
          Size, position and angle are automatic. Use the sliders only to fine
          tune.
        </p>

        <div
          style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}
        >
          {slider("Size", size, setSize, 0.5, 2, 0.05)}
          {slider("Up / Down", lift, setLift, -0.5, 0.5, 0.01)}
          {slider("Hide depth", hide, setHide, -0.5, 0.5, 0.05)}
        </div>
        <div
          style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}
        >
          {slider(
            "Rotate X",
            rot.x,
            (v) => setRot({ ...rot, x: v }),
            -180,
            180,
            5,
          )}
          {slider(
            "Rotate Y",
            rot.y,
            (v) => setRot({ ...rot, y: v }),
            -180,
            180,
            5,
          )}
          {slider(
            "Rotate Z",
            rot.z,
            (v) => setRot({ ...rot, z: v }),
            -180,
            180,
            5,
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={debug}
              onChange={(e) => setDebug(e.target.checked)}
            />{" "}
            Show anchor and hiding area
          </label>
          <button onClick={reset}>Reset</button>
          <button onClick={onClose} style={{ marginLeft: "auto" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
