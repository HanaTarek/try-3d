import { useState } from "react";
import "@google/model-viewer";
import TryOn from "./TryOn";

// "fit" is the one-time setup of each necklace (see below).
// widthCm = real width of the necklace. Ask the jeweler for it.
const products = [
  {
    id: 1,
    name: "Necklace (Zahra)",
    image: "/images/jw.webp",
    model: "/models/meshy_.glb",
    fit: { widthCm: 15, anchor: [0.5, 0.8, 0.5] },
  },
  // {
  //   id: 2,
  //   name: "Necklace (Blender)",
  //   image: "/images/jw.webp",
  //   model: "/models/necklace.glb",
  //   fit: { widthCm: 14, anchor: [0.5, 0.97, 0.5] },
  // },
];

const overlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const box = {
  background: "white",
  padding: 16,
  borderRadius: 12,
  width: "min(600px, 90vw)",
};

export default function App() {
  const [selected, setSelected] = useState(null);
  const [tryOn, setTryOn] = useState(null);

  return (
    <div style={{ padding: 20 }}>
      <h1>My Shop</h1>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {products.map((p) => (
          <div
            key={p.id}
            style={{
              border: "1px solid #ccc",
              borderRadius: 12,
              padding: 12,
              width: 220,
            }}
          >
            <img src={p.image} alt={p.name} style={{ width: "100%" }} />
            <h3>{p.name}</h3>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setSelected(p)}>View in 3D</button>
              <button onClick={() => setTryOn(p)}>📷 Try on</button>
            </div>
          </div>
        ))}
      </div>

      {selected && (
        <div style={overlay} onClick={() => setSelected(null)}>
          <div style={box} onClick={(e) => e.stopPropagation()}>
            <model-viewer
              src={selected.model}
              alt={selected.name}
              camera-controls
              auto-rotate
              shadow-intensity="1"
              environment-image="/rooms/room.hdr"
              poster={selected.image}
              style={{ width: "100%", height: "400px", background: "#f4f1ec" }}
            >
              <div slot="progress-bar" style={{ padding: 8 }}>
                Loading 3D model...
              </div>
            </model-viewer>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={() => {
                  setTryOn(selected);
                  setSelected(null);
                }}
              >
                📷 Try on
              </button>
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {tryOn && (
        <TryOn
          key={tryOn.id}
          modelUrl={tryOn.model}
          fit={tryOn.fit}
          onClose={() => setTryOn(null)}
        />
      )}
    </div>
  );
}
