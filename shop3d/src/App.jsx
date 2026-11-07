import { useState } from "react";
import "@google/model-viewer";

const products = [
  {
    id: 1,
    name: "My Chair",
    image: "/images/chair.png",
    model: "/models/3DModel.glb",
  },
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

  return (
    <div style={{ padding: 20 }}>
      <h1>My Shop</h1>

      <div style={{ display: "flex", gap: 16 }}>
        {products.map((p) => (
          <div
            key={p.id}
            onClick={() => setSelected(p)}
            style={{
              cursor: "pointer",
              border: "1px solid #ccc",
              borderRadius: 12,
              padding: 12,
              width: 220,
            }}
          >
            <img src={p.image} alt={p.name} style={{ width: "100%" }} />
            <h3>{p.name}</h3>
            <button>View in 3D</button>
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
              ar
              shadow-intensity="1"
              environment-image="/rooms/room.hdr"
              skybox-image="/rooms/room.hdr"
              skybox-height="1.5m"
              poster={selected.image}
              style={{ width: "100%", height: "400px" }}
            >
              <div slot="progress-bar" style={{ padding: 8 }}>
                Loading 3D model...
              </div>
            </model-viewer>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
